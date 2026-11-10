import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import { randomUUID } from 'node:crypto';
import { createEngine } from '../packages/engine/src/index.js';
import { createInputKey } from '../packages/engine/src/storage.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('pre-intent owned input preparation', () => {
  it('keeps signing outages queued and honours cancellation while signing holds no lock', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'execution_preparation');
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
      modelId: 'fixture/video',
      deploymentId: deployment.id,
      upstreamModelId: 'fixture',
      operations: ['image-to-video'],
      resolutions: ['720p'],
      durations: [5],
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
          id: 'fixture/video',
          name: 'Fixture',
          creator: 'Fixture',
          authorProviderIds: [],
          familyId: 'fixture',
          modality: 'video',
          aliases: [],
          openness: 'closed',
          license: 'Synthetic',
          source,
          description: 'Synthetic',
        },
      ],
    };
    let signCalls = 0;
    let signGate: Promise<void> | undefined;
    let announceSign = () => {};
    let releaseSign = () => {};
    const submissions: any[] = [];
    const storage: any = {
      sign: async (key: string, mediaType: string) => {
        signCalls++;
        if (signCalls === 1) throw new Error('Synthetic temporary signing outage.');
        announceSign();
        await signGate;
        return {
          storageKey: key,
          url: `https://owned.fixture.invalid/input-${signCalls}`,
          mediaType,
          fidelity: 'unverified',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
      },
    };
    const options: any = {
      databaseUrl: isolated.databaseUrl,
      publicUrl: 'https://fixture.invalid',
      catalog,
      poolSize: 4,
      pollIntervalMs: 200,
      leaseMs: 100,
      vaultKey: '0'.repeat(64),
      storage,
      execution: {
        workspaceMaxActive: 1,
        workspaceMaxQueued: 4,
        providerMaxActive: 1,
        providerMaxQueued: 4,
        supplyId: () => 'same-fixture-account',
      },
      adapters: [
        {
          id: 'alibaba',
          isConfigured: () => true,
          submit: async (context: any) => {
            submissions.push(context);
            return { upstreamId: 'fixture-' + context.jobId };
          },
          poll: async () => ({ status: 'running' }),
        },
      ],
      quote: () => ({
        modelId: 'fixture/video',
        operation: 'image-to-video',
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
    };
    const engine = isolated.bind(createEngine(options));
    let work: Promise<boolean> | undefined;
    try {
      await engine.initialize();
      const clients = await Promise.all(Array.from({ length: 4 }, () => engine.pool.connect()));
      try {
        for (const client of clients)
          assert.equal(
            (await client.query('SELECT current_schema() AS schema')).rows[0].schema,
            isolated.schema,
          );
      } finally {
        for (const client of clients) client.release();
      }
      await engine.ensureWorkspace('owner', 100);
      const assetKey = createInputKey('owner', 'image/png');
      await engine.pool.query(
        `INSERT INTO mr_owned_assets(asset_key,workspace_id,state,media_type,byte_length,sha256) VALUES($1,'owner','ready','image/png',100,$2)`,
        [assetKey, '0'.repeat(64)],
      );
      const input: any = {
        modelId: 'fixture/video',
        operation: 'image-to-video',
        input: {
          prompt: 'Synthetic owned input',
          resolution: '720p',
          duration: 5,
          firstFrame: { assetKey },
        },
      };
      const first = await engine.submit({
        workspaceId: 'owner',
        idempotencyKey: 'signing-recovery',
        input,
      });
      const before = await engine.getBalance('owner');
      assert.equal(await engine.workOnce(), false);
      let row = (
        await engine.pool.query(
          'SELECT status,attempt_count,lease_until,settled_micros,execution_error FROM mr_jobs WHERE id=$1',
          [first.id],
        )
      ).rows[0];
      assert.equal(row.status, 'queued');
      assert.equal(row.attempt_count, 0);
      assert.equal(row.lease_until, null);
      assert.equal(row.settled_micros, null);
      assert.equal(row.execution_error.code, 'input_preparation_unavailable');
      assert.equal(
        (
          await engine.pool.query('SELECT count(*)::int AS n FROM mr_attempts WHERE job_id=$1', [
            first.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [first.id]))
          .rows[0].state,
        'queued',
      );
      assert.deepEqual(await engine.getBalance('owner'), before);
      assert.equal(submissions.length, 0);
      await engine.pool.query('UPDATE mr_jobs SET next_poll_at=now() WHERE id=$1', [first.id]);
      assert.equal(await engine.workOnce(), true);
      assert.equal(submissions.length, 1);
      assert.equal(signCalls, 2);
      assert.equal(
        submissions[0].input.input.firstFrame.url,
        'https://owned.fixture.invalid/input-2',
      );
      row = (
        await engine.pool.query(
          'SELECT status,attempt_count,error,execution_error FROM mr_jobs WHERE id=$1',
          [first.id],
        )
      ).rows[0];
      assert.equal(row.status, 'running');
      assert.equal(row.attempt_count, 1);
      assert.equal(row.error, null);
      assert.equal(row.execution_error, null);
      await engine.applyProviderResult('owner', first.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 0,
      });
      const second = await engine.submit({
        workspaceId: 'owner',
        idempotencyKey: 'cancel-during-signing',
        input,
      });
      let signed!: () => void;
      const started = new Promise<void>((resolve) => {
        signed = resolve;
      });
      announceSign = signed;
      signGate = new Promise<void>((resolve) => {
        releaseSign = resolve;
      });
      work = engine.workOnce();
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        started,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Preparation did not reach signing.')), 5000);
        }),
      ]);
      clearTimeout(timer!);
      row = (
        await engine.pool.query('SELECT status,attempt_count FROM mr_jobs WHERE id=$1', [second.id])
      ).rows[0];
      assert.equal(row.status, 'queued');
      assert.equal(row.attempt_count, 0);
      // This must finish while signing remains blocked: no row/financial/pool lock
      // is held across the unpaid preparation operation.
      const cancelled = await engine.cancel('owner', second.id);
      assert.equal(cancelled.status, 'cancelled');
      releaseSign();
      await work;
      work = undefined;
      assert.equal(submissions.length, 1);
      assert.equal((await engine.getJob('owner', second.id))?.status, 'cancelled');
      assert.equal(
        (
          await engine.pool.query('SELECT count(*)::int AS n FROM mr_attempts WHERE job_id=$1', [
            second.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [
            second.id,
          ])
        ).rows[0].state,
        'released',
      );
      assert.equal(
        (
          await engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_dispatch_slots WHERE state IN ('occupied','unknown')",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(signCalls, 3);
    } finally {
      releaseSign();
      await work?.catch(() => {});
      await engine.close();
      await isolated.close();
    }
  }, 60000);
});
