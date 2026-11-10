import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { createEngine } from '../packages/engine/src/index.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import { privateStorageFixture, privateOutputFixture } from './helpers/private-storage';
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('owned delivery route metrics', () => {
  it('keeps provider completion separate from recorded usable delivery and public provenance', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'route_delivery_metrics');
    const source = { url: 'https://fixture.invalid/docs', checkedAt: '2026-11-04' };
    const routeId = 'fixture-public-route',
      deploymentId = 'fixture-public-deployment';
    const catalog: any = {
      providers: [{ id: 'fixture', name: 'Fixture', website: source.url }],
      deployments: [
        {
          id: deploymentId,
          providerId: 'fixture',
          name: 'Fixture',
          endpointRegion: 'fixture-region',
          scope: 'regional',
          processingRegions: ['fixture-region'],
          storageRegions: null,
          endpointTemplate: null,
          credentialEnv: null,
          source,
        },
      ],
      models: [
        {
          id: 'fixture/image',
          name: 'Fixture',
          creator: 'Fixture',
          authorProviderIds: [],
          familyId: 'fixture',
          modality: 'image',
          aliases: [],
          openness: 'closed',
          license: 'Synthetic',
          source,
          description: 'Synthetic',
        },
      ],
      routes: [
        {
          id: routeId,
          modelId: 'fixture/image',
          deploymentId,
          upstreamModelId: 'fixture',
          operations: ['image-edit'],
          resolutions: ['1K'],
          durations: [],
          fidelity: 'unknown',
          adapter: null,
          status: 'documented',
          rates: [],
          pricingSource: source,
          source,
        },
      ],
    };
    const storage = privateStorageFixture();
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        publicUrl: 'https://fixture.invalid',
        catalog,
        adapters: [],
        poolSize: 1,
        providerEnv: {},
        vaultKey: '0'.repeat(64),
        storage,
      }),
    );
    const workspace = 'private-workspace-sentinel';
    const privateKeyId = randomUUID();
    const privatePrompt = 'private-prompt-sentinel';
    const input: any = {
      modelId: 'fixture/image',
      operation: 'image-edit',
      input: {
        prompt: privatePrompt,
        resolution: '1K',
        references: [
          { type: 'image', asset: { url: 'https://private-input.invalid/private-capability' } },
        ],
      },
      metadata: { project: 'private-project-sentinel', tags: { secret: 'private-tag-sentinel' } },
    };
    const created = new Date(Date.now() - 60000);
    const completed = new Date(created.getTime() + 2000);
    const delivered = new Date(created.getTime() + 8000);
    try {
      await engine.initialize();
      await engine.ensureWorkspace(workspace, 0);
      async function seed(
        status: 'succeeded' | 'failed' | 'running',
        deliveryStatus: string | null,
        attemptDuration = 2000,
      ) {
        const id = randomUUID();
        await engine.pool.query(
          `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,upstream_id,reserved_micros,settled_micros,attempt_count,created_at,completed_at,delivery_status,metadata,attribution)
    VALUES($1::uuid,$2,$1::text,'synthetic',$3,$4,$5,$6,'private-upstream-sentinel',0,0,1,$7,$8,$9,$10,$11)`,
          [
            id,
            workspace,
            JSON.stringify(input),
            JSON.stringify(catalog.routes[0]),
            JSON.stringify(catalog.deployments[0]),
            status,
            created,
            status === 'running' ? null : new Date(created.getTime() + attemptDuration),
            deliveryStatus,
            JSON.stringify(input.metadata),
            JSON.stringify({
              kind: 'api',
              keyId: privateKeyId,
              membershipId: null,
              grantId: null,
              clientId: null,
            }),
          ],
        );
        await engine.pool.query(
          'INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state,started_at,completed_at,failure_category) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            id,
            routeId,
            deploymentId,
            status,
            created,
            status === 'running' ? null : new Date(created.getTime() + attemptDuration),
            status === 'failed' ? 'technical' : null,
          ],
        );
        return id;
      }
      const id = await seed('succeeded', 'failed');
      const metrics = async () =>
        (await engine.routeMetrics(input)).find((value) => value.routeId === routeId)!;
      let value = await metrics();
      assert.equal(value.sampleCount, 1);
      assert.equal(value.succeeded, 1);
      assert.equal(value.technicalSuccessRate, 1);
      assert.equal(value.p50CompletionMs, 2000);
      assert.equal(value.p50EndToEndMs, null);
      assert.equal(value.p95EndToEndMs, null);
      assert.equal(value.endToEndSampleCount, 0);
      assert.equal(value.deliveryFailedJobCount, 1);
      assert.equal(value.deliveryAvailableJobCount, 0);
      await engine.pool.query(
        "UPDATE mr_jobs SET delivery_status='pending',delivery_updated_at=$2 WHERE id=$1",
        [id, delivered],
      );
      value = await metrics();
      assert.equal(value.p50EndToEndMs, null);
      assert.equal(value.deliveryUnresolvedJobCount, 1);
      await engine.pool.query("UPDATE mr_jobs SET delivery_status='available' WHERE id=$1", [id]);
      value = await metrics();
      assert.equal(value.p50EndToEndMs, null);
      assert.equal(value.deliveryUnresolvedJobCount, 1);
      const owned = await privateOutputFixture(storage, id, 'image/png');
      await engine.pool.query('UPDATE mr_jobs SET outputs=$2 WHERE id=$1', [
        id,
        JSON.stringify([owned]),
      ]);
      const receiptId = randomUUID();
      await engine.pool.query(
        `INSERT INTO mr_output_receipts(id,workspace_id,job_id,attempt,route_id,deployment_id,upstream_id,slot,kind,media_type,source_key,object_key,source_hash,state,sha256,byte_length)
    VALUES($1,$2,$3,1,$4,$5,'private-upstream-sentinel',0,'owned','image/png',$6,$6,$7,'available',$7,$8)`,
        [
          receiptId,
          workspace,
          id,
          routeId,
          deploymentId,
          owned.storageKey,
          owned.sha256,
          owned.byteLength,
        ],
      );
      value = await metrics();
      assert.equal(value.deliveryAvailableJobCount, 1);
      assert.equal(value.endToEndSampleCount, 1);
      assert.equal(value.p50EndToEndMs, 8000);
      assert.equal(value.p95EndToEndMs, 8000);
      assert.equal(value.p50CompletionMs, 2000);
      for (const timestamp of [
        null,
        new Date(created.getTime() - 1000),
        'infinity',
        new Date(Date.now() + 86400000),
      ]) {
        await engine.pool.query('UPDATE mr_jobs SET delivery_updated_at=$2 WHERE id=$1', [
          id,
          timestamp,
        ]);
        value = await metrics();
        assert.equal(value.deliveryAvailableJobCount, 1);
        assert.equal(value.endToEndSampleCount, 0);
        assert.equal(value.p50EndToEndMs, null);
        assert.equal(value.p95EndToEndMs, null);
        assert.equal(value.p50CompletionMs, 2000);
      }
      await engine.pool.query('UPDATE mr_jobs SET delivery_updated_at=created_at WHERE id=$1', [
        id,
      ]);
      value = await metrics();
      assert.equal(value.endToEndSampleCount, 1);
      assert.equal(value.p50EndToEndMs, 0);
      await engine.pool.query('UPDATE mr_jobs SET delivery_updated_at=$2 WHERE id=$1', [
        id,
        delivered,
      ]);
      await engine.pool.query(
        "UPDATE mr_output_receipts SET route_id='different-public-route' WHERE id=$1",
        [receiptId],
      );
      value = await metrics();
      assert.equal(value.p50EndToEndMs, null);
      assert.equal(value.deliveryUnresolvedJobCount, 1);
      await engine.pool.query('UPDATE mr_output_receipts SET route_id=$2 WHERE id=$1', [
        receiptId,
        routeId,
      ]);
      await seed('failed', 'failed', 4000);
      await seed('running', null);
      value = await metrics();
      assert.equal(value.jobSampleCount, 3);
      assert.equal(value.sampleCount, 3);
      assert.equal(value.succeeded, 1);
      assert.equal(value.failed, 1);
      assert.equal(value.unresolved, 1);
      assert.equal(value.technicalOutcomeCount, 2);
      assert.equal(value.technicalSuccessRate, 0.5);
      assert.equal(value.p50CompletionMs, 2000);
      assert.equal(value.p95CompletionMs, 2000);
      assert.equal(value.deliveryAvailableJobCount, 1);
      assert.equal(value.deliveryFailedJobCount, 0);
      assert.equal(value.deliveryUnresolvedJobCount, 0);
      assert.equal(value.endToEndSampleCount, 1);
      assert.equal(value.p50EndToEndMs, 8000);
      assert.equal(value.trafficProvenance, 'mixed-unclassified');
      const publicJson = JSON.stringify(value);
      for (const secret of [
        id,
        workspace,
        privateKeyId,
        privatePrompt,
        'private-project-sentinel',
        'private-tag-sentinel',
        'private-upstream-sentinel',
        'private-capability',
        owned.storageKey!,
        owned.sha256!,
      ])
        assert.equal(publicJson.includes(secret), false);
      assert.equal(
        (await engine.pool.query('SELECT count(*)::int AS n FROM mr_attempts')).rows[0].n,
        3,
      );
      assert.deepEqual(await engine.getBalance(workspace), {
        availableMicros: 0,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      await engine.close();
      await isolated.close();
    }
  }, 60000);
});
