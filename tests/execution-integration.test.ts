import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import { createEngine } from '../packages/engine/src/index.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('integrated execution admission and worker boundaries', () => {
  it('holds unknown supply, rolls back backlog admission, and preserves accepted recovery and once-only release', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'execution_wiring');
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
      operations: ['text-to-video'],
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
    const input: any = {
      modelId: 'fixture/video',
      operation: 'text-to-video',
      input: { prompt: 'Synthetic private fixture', duration: 5, resolution: '720p' },
    };
    let submits = 0,
      polls = 0;
    const options: any = {
      databaseUrl: isolated.databaseUrl,
      publicUrl: 'https://fixture.invalid',
      catalog,
      poolSize: 4,
      pollIntervalMs: 200,
      leaseMs: 100,
      vaultKey: '0'.repeat(64),
      storage: {},
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
          submit: async ({ jobId }: any) => {
            submits++;
            return { upstreamId: 'fixture-' + jobId };
          },
          poll: async ({ upstreamId }: any) => {
            polls++;
            return upstreamId === 'legacy-original'
              ? { status: 'failed', billedCostMicros: 0, failureCategory: 'technical' }
              : { status: 'running' };
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
    };
    const engine = isolated.bind(createEngine(options));
    let paused: any;
    const checks: string[] = [];
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
      await engine.ensureWorkspace('a', 100);
      await engine.ensureWorkspace('b', 100);
      const a = await engine.submit({ workspaceId: 'a', idempotencyKey: 'first', input });
      const b = await engine.submit({ workspaceId: 'b', idempotencyKey: 'second', input });
      assert.equal(await engine.workOnce(), true);
      assert.equal(submits, 1);
      await engine.pool.query(
        "UPDATE mr_jobs SET next_poll_at=now()+interval '1 hour' WHERE id=$1",
        [a.id],
      );
      assert.equal(await engine.workOnce(), false);
      assert.equal(submits, 1);
      let slots = (
        await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [a.id])
      ).rows;
      assert.equal(slots[0].state, 'occupied');
      await engine.applyProviderResult('a', a.id, { status: 'unknown' });
      assert.equal(
        (await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [a.id]))
          .rows[0].state,
        'unknown',
      );
      await engine.pool.query('UPDATE mr_jobs SET next_poll_at=now() WHERE id=$1', [b.id]);
      assert.equal(await engine.workOnce(), false);
      assert.equal(submits, 1);
      await engine.applyProviderResult('a', a.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 0,
      });
      await engine.pool.query('UPDATE mr_jobs SET next_poll_at=now() WHERE id=$1', [b.id]);
      assert.equal(await engine.workOnce(), true);
      assert.equal(submits, 2);
      checks.push(
        'cross-workspace-shared-supply',
        'unknown-retains-occupancy',
        'terminal-releases-once',
      );
      await engine.pool.query(
        "UPDATE mr_jobs SET next_poll_at=now()+interval '1 hour' WHERE id=$1",
        [b.id],
      );
      const c = await engine.submit({
        workspaceId: 'a',
        idempotencyKey: 'deadline',
        input: { ...input, queueStartDeadlineAt: new Date(Date.now() + 1000).toISOString() },
      });
      await engine.pool.query(
        "UPDATE mr_dispatch_slots SET start_deadline_at=now()-interval '1 second' WHERE job_id=$1",
        [c.id],
      );
      assert.equal(await engine.workOnce(), true);
      assert.equal(submits, 2);
      assert.equal((await engine.getJob('a', c.id))?.status, 'failed');
      assert.equal(
        (
          await engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_ledger WHERE job_id=$1 AND kind='settle'",
            [c.id],
          )
        ).rows[0].n,
        1,
      );
      const d = await engine.submit({ workspaceId: 'a', idempotencyKey: 'cancel', input });
      await engine.cancel('a', d.id);
      await engine.cancel('a', d.id);
      assert.deepEqual(
        (
          await engine.pool.query(
            'SELECT state,release_evidence FROM mr_dispatch_slots WHERE job_id=$1',
            [d.id],
          )
        ).rows[0],
        { state: 'released', release_evidence: 'never_submitted_cancelled' },
      );
      checks.push('full-capacity-deadline-no-submit', 'never-submitted-cancel-receipt');
      paused = isolated.bind(
        createEngine({
          ...options,
          execution: { ...options.execution, workspaceMaxQueued: 0 },
        }),
      );
      const before = await engine.getBalance('a');
      await assert.rejects(
        paused.submit({ workspaceId: 'a', idempotencyKey: 'backpressure', input }),
        { code: 'dispatch_backpressure' },
      );
      assert.deepEqual(await engine.getBalance('a'), before);
      assert.equal(
        (
          await engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_jobs WHERE workspace_id='a' AND idempotency_key='backpressure'",
          )
        ).rows[0].n,
        0,
      );
      checks.push('backpressure-rolls-back-job-and-money');
      const legacy = randomUUID();
      await engine.pool.query(
        `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,upstream_id,reserved_micros,attempt_count) VALUES($1,'a','legacy','legacy',$2,$3,$4,'running','legacy-original',0,1)`,
        [legacy, JSON.stringify(input), JSON.stringify(route), JSON.stringify(deployment)],
      );
      await engine.pool.query(
        "INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,1,$3,$4,'running')",
        [randomUUID(), legacy, route.id, deployment.id],
      );
      await assert.rejects(
        engine.submit({ workspaceId: 'a', idempotencyKey: 'legacy-fenced', input }),
        { code: 'legacy_capacity_unreconciled' },
      );
      assert.equal(await engine.workOnce(), true);
      assert.equal((await engine.getJob('a', legacy))?.status, 'failed');
      assert.equal(submits, 2);
      assert.equal(polls, 1);
      checks.push('legacy-occupancy-fences-new-admission', 'legacy-accepted-poll-still-runs');
      await engine.pool.query(
        "UPDATE mr_jobs SET status='submitting',lease_until=now()-interval '1 second' WHERE id=$1",
        [b.id],
      );
      await engine.pool.query("UPDATE mr_attempts SET state='submitting' WHERE job_id=$1", [b.id]);
      assert.equal(await engine.workOnce(), true);
      assert.equal((await engine.getJob('b', b.id))?.status, 'submission-unknown');
      assert.equal(
        (await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [b.id]))
          .rows[0].state,
        'unknown',
      );
      assert.equal(submits, 2);
      checks.push('crashed-submit-holds-capacity-without-retry');
      assert.equal(checks.length, 9);
    } finally {
      await paused?.close();
      await engine.close();
      await isolated.close();
    }
  }, 60000);
});
