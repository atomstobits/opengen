import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { Pool } from 'pg';
import { createEngine } from '../packages/engine/src/index.js';
import { privateStorageFixture, privateInputBytesFixture } from './helpers/private-storage';
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('accepted maintenance scheduler fairness', () => {
  it('expires queues, exposes stale intents and drains private delivery under continuously due polling', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'execution_fairness');
    const source = { url: 'https://fixture.invalid/docs', checkedAt: '2026-11-04' };
    const deployment: any = {
      id: 'fixture-deployment',
      providerId: 'fixture',
      name: 'Fixture',
      endpointRegion: 'fixture-region',
      scope: 'regional',
      processingRegions: ['fixture-region'],
      storageRegions: null,
      endpointTemplate: null,
      credentialEnv: null,
      source,
    };
    const route: any = {
      id: 'fixture-route',
      modelId: 'fixture/image',
      deploymentId: deployment.id,
      upstreamModelId: 'fixture',
      operations: ['text-to-image'],
      resolutions: ['1K'],
      durations: [],
      fidelity: 'unknown',
      adapter: 'alibaba',
      status: 'documented',
      rates: [],
      pricingSource: source,
      source,
    };
    const catalog: any = {
      providers: [{ id: 'fixture', name: 'Fixture', website: source.url }],
      deployments: [deployment],
      routes: [route],
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
    };
    const input: any = {
      modelId: 'fixture/image',
      operation: 'text-to-image',
      input: { prompt: 'Synthetic private scheduler fixture', resolution: '1K' },
    };
    let submits = 0,
      polls = 0;
    const engine = createEngine({
      databaseUrl: isolated.databaseUrl,
      publicUrl: 'https://fixture.invalid',
      catalog,
      poolSize: 1,
      pollIntervalMs: 0,
      leaseMs: 100,
      vaultKey: '0'.repeat(64),
      providerEnv: {},
      storage: privateStorageFixture(),
      delivery: { provenance: { toolPath: '/fixture-unconfigured-c2pa', networkIsolated: false } },
      execution: {
        workspaceMaxActive: 1,
        workspaceMaxQueued: 64,
        providerMaxActive: 1,
        providerMaxQueued: 64,
        supplyId: () => 'same-fixture-account',
      },
      adapters: [
        {
          id: 'alibaba',
          isConfigured: () => true,
          submit: async () => {
            submits++;
            throw new Error('No new provider submit may occur in this proof.');
          },
          poll: async () => {
            polls++;
            return { status: 'running' };
          },
        },
      ],
      quote: () => ({
        modelId: input.modelId,
        operation: input.operation,
        candidates: [
          {
            routeId: route.id,
            deploymentId: deployment.id,
            providerId: 'fixture',
            endpointRegion: 'fixture-region',
            scope: 'regional',
            estimatedCostMicros: 10,
            currency: 'USD',
            executable: true,
            reason: null,
            source,
            notices: [],
          },
        ],
        selectedRouteId: route.id,
        estimateOnly: true,
        notices: [],
      }),
    } as any);
    isolated.bind(engine);
    try {
      await engine.initialize();
      await engine.ensureWorkspace('owner', 1000);
      // These are already-accepted synthetic tasks, e.g. after a lowered capacity
      // limit. Their truthful occupancy remains even when it exceeds the new cap.
      async function seedAccepted(key: string, state: 'running' | 'submitting' = 'running') {
        const job = await engine.submit({ workspaceId: 'owner', idempotencyKey: key, input });
        const upstream = state === 'running' ? 'original-' + key : null;
        const client = await engine.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT id FROM mr_workspaces WHERE id='owner' FOR UPDATE");
          await client.query(
            "UPDATE mr_jobs SET status=$2,upstream_id=$3,attempt_count=1,next_poll_at=now()-interval '1 day',lease_until=CASE WHEN $2='submitting' THEN now()-interval '1 second' ELSE NULL END WHERE id=$1",
            [job.id, state, upstream],
          );
          await client.query(
            'INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,1,$3,$4,$5)',
            [randomUUID(), job.id, route.id, deployment.id, state],
          );
          await client.query(
            'INSERT INTO mr_attempt_credentials(job_id,attempt_number,workspace_id,deployment_id,identity) SELECT job_id,1,workspace_id,deployment_id,identity FROM mr_job_credentials WHERE job_id=$1',
            [job.id],
          );
          await client.query(
            "UPDATE mr_dispatch_slots SET state='occupied',submission_intent_at=now()-interval '1 minute' WHERE job_id=$1",
            [job.id],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        return { ...job, upstream };
      }
      const running = [];
      for (let index = 0; index < 8; index++) running.push(await seedAccepted('poll-' + index));
      const stale = await seedAccepted('stale-intent', 'submitting');
      const delivered = await seedAccepted('captured-completion');
      const expiring = await engine.submit({
        workspaceId: 'owner',
        idempotencyKey: 'expired-queue',
        input: { ...input, queueStartDeadlineAt: new Date(Date.now() + 60000).toISOString() },
      });
      // Deterministic database-clock boundary fixture. A retry backoff must not hide
      // an already due local deadline from independent maintenance.
      await engine.pool.query(
        "UPDATE mr_jobs SET queue_start_deadline_at=now()-interval '1 second',next_poll_at=now()+interval '1 day' WHERE id=$1",
        [expiring.id],
      );
      await engine.pool.query(
        "UPDATE mr_dispatch_slots SET start_deadline_at=now()-interval '1 second' WHERE job_id=$1",
        [expiring.id],
      );
      const identity = (
        await engine.pool.query('SELECT identity FROM mr_attempt_credentials WHERE job_id=$1', [
          delivered.id,
        ])
      ).rows[0].identity;
      await engine.delivery.capture(
        {
          workspaceId: 'owner',
          jobId: delivered.id,
          attempt: 1,
          routeId: route.id,
          deploymentId: deployment.id,
          upstreamId: delivered.upstream,
          providerConnectionId: identity,
        },
        [
          {
            kind: 'inline',
            bytes: privateInputBytesFixture('image/png').bytes,
            mediaType: 'image/png',
          },
        ],
      );
      const before = await engine.getBalance('owner');
      for (let turn = 0; turn < 14; turn++) await engine.workOnce();
      const staleRow = (
        await engine.pool.query('SELECT status,settled_micros FROM mr_jobs WHERE id=$1', [stale.id])
      ).rows[0];
      assert.equal(staleRow.status, 'submission-unknown');
      assert.equal(staleRow.settled_micros, null);
      assert.equal(
        (await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [stale.id]))
          .rows[0].state,
        'unknown',
      );
      const expiredRow = (
        await engine.pool.query(
          'SELECT status,settled_micros,attempt_count FROM mr_jobs WHERE id=$1',
          [expiring.id],
        )
      ).rows[0];
      assert.equal(expiredRow.status, 'failed');
      assert.equal(expiredRow.settled_micros, '0');
      assert.equal(expiredRow.attempt_count, 0);
      for (const kind of ['settle', 'release'])
        assert.equal(
          (
            await engine.pool.query(
              'SELECT count(*)::int AS n FROM mr_ledger WHERE job_id=$1 AND kind=$2',
              [expiring.id, kind],
            )
          ).rows[0].n,
          1,
        );
      assert.deepEqual(await engine.getBalance('owner'), {
        availableMicros: before.availableMicros + 10,
        reservedMicros: before.reservedMicros - 10,
        currency: 'USD',
      });
      const deliveredRow = (
        await engine.pool.query(
          'SELECT status,delivery_status,settled_micros FROM mr_jobs WHERE id=$1',
          [delivered.id],
        )
      ).rows[0];
      assert.equal(deliveredRow.status, 'succeeded');
      assert.equal(deliveredRow.delivery_status, 'available');
      assert.equal(deliveredRow.settled_micros, null);
      assert.equal(
        (
          await engine.pool.query('SELECT state FROM mr_output_receipts WHERE job_id=$1', [
            delivered.id,
          ])
        ).rows[0].state,
        'available',
      );
      assert.ok(
        polls >= 8,
        'Accepted polling must continue while maintenance receives bounded turns.',
      );
      assert.equal(submits, 0);
      assert.equal(
        (
          await engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_jobs WHERE status='running' AND id=ANY($1::uuid[])",
            [running.map((job) => job.id)],
          )
        ).rows[0].n,
        8,
      );
    } finally {
      await engine.close();
      await isolated.close();
    }
  }, 60000);
});
