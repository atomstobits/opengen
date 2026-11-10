import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine';
import type { Catalog, GenerateInput, Quote } from '@media-router/contracts';
import { privateOutputFixture, privateStorageFixture } from './helpers/private-storage';
import {
  createAlibabaAdapter,
  createBytePlusAdapter,
  createEngine,
  creditWorkspaceInTransaction,
  EngineError,
  SubmissionRejected,
  type ProviderAdapter,
} from '@media-router/engine';
const databaseUrl = process.env.TEST_DATABASE_URL;
const databases: Awaited<ReturnType<typeof isolatedEngineDatabase>>[] = [];
const engines: ReturnType<typeof createEngine>[] = [];
const fixtureEngine = (options: Parameters<typeof createEngine>[0]) => {
  const database = databases.find((value) => value.databaseUrl === options.databaseUrl);
  if (!database) throw new Error('Engine fixture requires an isolated database URL.');
  const engine = database.bind(createEngine(options));
  engines.push(engine);
  return engine;
};
async function fixtureDatabase() {
  const value = await isolatedEngineDatabase(databaseUrl!, 'engine_invariants');
  databases.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    engines
      .splice(0)
      .filter((engine) => !engine.pool.ended)
      .map((engine) => engine.close()),
  );
  for (const database of databases.splice(0)) await database.close();
});

const source = { url: 'https://example.com/provider-docs', checkedAt: '2026-11-02' };
const input: GenerateInput = {
  modelId: 'fixture/video',
  operation: 'text-to-video',
  input: {
    prompt: 'A calm sea.',
    resolution: '720p',
    duration: 5,
  },
};
function fixture() {
  const suffix = randomUUID();
  const routeId = `fixture/${suffix}/video`;
  const deploymentId = `fixture/${suffix}/region`;
  const catalog: Catalog = {
    providers: [{ id: 'fixture', name: 'Fixture provider', website: source.url }],
    deployments: [
      {
        id: deploymentId,
        providerId: 'fixture',
        name: 'Fixture region',
        endpointRegion: 'test-region',
        scope: 'global',
        processingRegions: null,
        storageRegions: null,
        endpointTemplate: null,
        credentialEnv: null,
        source,
      },
    ],
    models: [
      {
        id: input.modelId,
        name: 'Fixture video',
        creator: 'Fixture',
        authorProviderIds: [],
        familyId: 'fixture',
        modality: 'video',
        aliases: [],
        openness: 'closed',
        license: 'Fixture only',
        source,
        description: 'Fixture only.',
      },
    ],
    routes: [
      {
        id: routeId,
        modelId: input.modelId,
        deploymentId,
        upstreamModelId: 'fixture-native',
        operations: ['text-to-video'],
        resolutions: ['720p'],
        durations: [5],
        fidelity: 'unknown',
        adapter: 'alibaba',
        status: 'documented',
        rates: [{ resolution: '720p', unit: 'output-second', usdMicros: 12 }],
        pricingSource: source,
        source,
      },
    ],
  };
  const quote = (
    _input: GenerateInput,
    options: {
      executableRouteIds: string[];
    },
  ): Quote => ({
    modelId: input.modelId,
    operation: input.operation,
    selectedRouteId: options.executableRouteIds.includes(routeId) ? routeId : null,
    estimateOnly: true,
    notices: [],
    candidates: [
      {
        routeId,
        deploymentId,
        providerId: 'fixture',
        endpointRegion: 'test-region',
        scope: 'global',
        estimatedCostMicros: 60,
        currency: 'USD',
        executable: options.executableRouteIds.includes(routeId),
        reason: null,
        source,
        notices: [],
      },
    ],
  });
  return { catalog, quote, routeId };
}
const adapter: ProviderAdapter = {
  id: 'alibaba',
  isConfigured: () => true,
  submit: async () => ({ upstreamId: `upstream-${randomUUID()}` }),
  poll: async () => ({ status: 'succeeded', billedCostMicros: 40 }),
};
describe.skipIf(!databaseUrl)('PostgreSQL engine invariants', () => {
  async function setup(overrides: Partial<ProviderAdapter> = {}, balance = 1000) {
    const isolated = await fixtureDatabase();
    const data = fixture();
    const storage = privateStorageFixture();
    const configuredAdapter: ProviderAdapter = {
      ...adapter,
      poll: async (context) => ({
        status: 'succeeded',
        billedCostMicros: 40,
        outputs: [await privateOutputFixture(storage, context.jobId)],
      }),
      ...overrides,
    };
    const options = {
      databaseUrl: isolated.databaseUrl,
      ...data,
      storage,
      adapters: [configuredAdapter],
      pollIntervalMs: 0,
    };
    const engine = fixtureEngine(options);
    await engine.initialize();
    const workspaceId = `test-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, balance);
    return { engine, workspaceId, options, storage, ...data };
  }
  it('diagnoses without reserving and looks up uncertain admissions only inside the paying workspace', async () => {
    let upstreamSubmits = 0;
    const { engine, workspaceId, routeId } = await setup({
      submit: async () => {
        upstreamSubmits++;
        return { upstreamId: 'must-not-submit-during-reads' };
      },
    });
    try {
      const initialBalance = await engine.getBalance(workspaceId);
      const initialLedger = await engine.ledger(workspaceId);
      expect(await engine.workspaceReadiness(workspaceId)).toEqual({
        balance: initialBalance,
        billingHold: false,
        configuredRoutes: { managed: [routeId], byok: [] },
      });
      expect(await engine.getBalance(workspaceId)).toEqual(initialBalance);
      expect(await engine.ledger(workspaceId)).toEqual(initialLedger);
      expect(await engine.lookupJob(workspaceId, 'not-yet-visible')).toBeNull();
      const queued = await engine.submit({ workspaceId, idempotencyKey: 'lookup-only', input });
      const reserved = await engine.getBalance(workspaceId);
      expect(
        await engine.jobStatus.get(async () => ({ workspaceId, scopes: ['read'] }), queued.id),
      ).toMatchObject({ id: queued.id, status: 'queued' });
      expect((await engine.lookupJob(workspaceId, 'lookup-only'))?.id).toBe(queued.id);
      expect(await engine.lookupJob(`other-${randomUUID()}`, 'lookup-only')).toBeNull();
      expect(await engine.getBalance(workspaceId)).toEqual(reserved);
      expect(await engine.listJobs(workspaceId)).toHaveLength(1);
      expect(upstreamSubmits).toBe(0);
    } finally {
      // workOnce claims the global queue. Keep this read-only test's deliberately
      // unsubmitted fixture from being claimed by a later test's provider adapter.
      for (const job of await engine.listJobs(workspaceId))
        if (job.status === 'queued') await engine.cancel(workspaceId, job.id);
      await engine.close();
    }
  });
  it('reserves once under concurrent idempotent submissions and rejects changed requests', async () => {
    const { engine, workspaceId } = await setup();
    try {
      const request = { workspaceId, idempotencyKey: 'same-request', input };
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => engine.submit(request)),
      );
      // Concurrent callers may observe the existing input-preparation claim.
      // Wait for the original admission, then resume only the same request/key.
      expect(outcomes.some((value) => value.status === 'fulfilled')).toBe(true);
      for (const outcome of outcomes)
        if (outcome.status === 'rejected')
          expect(outcome.reason).toMatchObject({
            code: 'input_preparation_in_progress',
            statusCode: 409,
          });
      const jobs = await Promise.all(
        outcomes.map((outcome) =>
          outcome.status === 'fulfilled' ? outcome.value : engine.submit(request),
        ),
      );
      expect(jobs).toHaveLength(8);
      expect(new Set(jobs.map((value) => value.id)).size).toBe(1);
      expect(await engine.listJobs(workspaceId)).toHaveLength(1);
      expect(await engine.getBalance(workspaceId)).toEqual({
        availableMicros: 940,
        reservedMicros: 60,
        currency: 'USD',
      });
      await expect(
        engine.submit({
          workspaceId,
          idempotencyKey: 'same-request',
          input: {
            ...input,
            input: {
              ...input.input,
              prompt: 'Changed request.',
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const cancelled = await engine.cancel(workspaceId, jobs[0]!.id);
      expect(cancelled.status).toBe('cancelled');
      await engine.cancel(workspaceId, jobs[0]!.id);
      expect(await engine.getBalance(workspaceId)).toEqual({
        availableMicros: 1000,
        reservedMicros: 0,
        currency: 'USD',
      });
      expect(
        (await engine.ledger(workspaceId)).filter((value) => value.kind === 'reserve'),
      ).toHaveLength(1);
    } finally {
      await engine.close();
    }
  });
  it('cannot overspend when different requests arrive together', async () => {
    const { engine, workspaceId } = await setup({}, 100);
    try {
      const outcomes = await Promise.allSettled(
        ['first', 'second'].map((idempotencyKey) =>
          engine.submit({ workspaceId, idempotencyKey, input }),
        ),
      );
      expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(40);
      const accepted = outcomes.find((value) => value.status === 'fulfilled');
      if (accepted?.status === 'fulfilled') await engine.cancel(workspaceId, accepted.value.id);
    } finally {
      await engine.close();
    }
  });
  it('recovers persisted jobs with their regional snapshot and settles duplicate results once', async () => {
    let submissions = 0;
    const { engine, workspaceId, options, routeId } = await setup({
      submit: async () => {
        submissions++;
        return { upstreamId: 'preserved-task' };
      },
    });
    const queued = await engine.submit({ workspaceId, idempotencyKey: 'restart', input });
    await engine.workOnce();
    await engine.close();
    const restarted = fixtureEngine(options);
    try {
      await restarted.initialize();
      expect((await restarted.getJob(workspaceId, queued.id))?.upstreamId).toBeNull();
      expect(
        (
          await restarted.pool.query(
            'SELECT upstream_id FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
            [workspaceId, queued.id],
          )
        ).rows[0].upstream_id,
      ).toBe('preserved-task');
      await restarted.workOnce();
      expect((await restarted.getJob(workspaceId, queued.id))?.status).toBe('succeeded');
      await Promise.all(
        Array.from({ length: 4 }, () =>
          restarted.applyProviderResult(workspaceId, queued.id, {
            status: 'succeeded',
            billedCostMicros: 40,
          }),
        ),
      );
      expect(submissions).toBe(1);
      expect((await restarted.getJob(workspaceId, queued.id))?.routeId).toBe(routeId);
      expect(await restarted.getBalance(workspaceId)).toEqual({
        availableMicros: 960,
        reservedMicros: 0,
        currency: 'USD',
      });
      expect(
        (await restarted.ledger(workspaceId)).filter((value) => value.kind === 'settle'),
      ).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
  it('holds ambiguous submissions without automatic resubmission or a false refund', async () => {
    let submissions = 0;
    const { engine, workspaceId } = await setup({
      submit: async () => {
        submissions++;
        throw new Error('Connection closed after request write.');
      },
    });
    try {
      const queued = await engine.submit({ workspaceId, idempotencyKey: 'unknown', input });
      await engine.workOnce();
      expect((await engine.getJob(workspaceId, queued.id))?.status).toBe('submission-unknown');
      await engine.workOnce();
      expect(submissions).toBe(1);
      await expect(engine.cancel(workspaceId, queued.id)).rejects.toMatchObject({
        code: 'cancellation_unconfirmed',
      });
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(60);
    } finally {
      await engine.close();
    }
  });
  it('marks an expired submission lease unknown after a worker crash', async () => {
    let submissions = 0;
    let entered!: () => void;
    let release!: () => void;
    const submitting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine, workspaceId } = await setup({
      submit: async () => {
        submissions++;
        entered();
        await response;
        throw new Error('Synthetic lost provider response after durable intent.');
      },
    });
    let work: Promise<boolean> | undefined;
    try {
      const queued = await engine.submit({
        workspaceId,
        idempotencyKey: 'interrupted-submit',
        input,
      });
      work = engine.workOnce();
      await Promise.race([
        submitting,
        work.then(() => {
          throw new Error('Worker did not reach the synthetic provider.');
        }),
      ]);
      expect(
        (
          await engine.pool.query('SELECT status,attempt_count FROM mr_jobs WHERE id=$1', [
            queued.id,
          ])
        ).rows[0],
      ).toMatchObject({ status: 'submitting', attempt_count: 1 });
      expect(
        (await engine.pool.query('SELECT state FROM mr_attempts WHERE job_id=$1', [queued.id]))
          .rows,
      ).toEqual([{ state: 'submitting' }]);
      expect(
        (
          await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [
            queued.id,
          ])
        ).rows,
      ).toEqual([{ state: 'occupied' }]);
      await engine.pool.query(
        "UPDATE mr_jobs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",
        [queued.id],
      );
      await engine.workOnce();
      expect((await engine.getJob(workspaceId, queued.id))?.status).toBe('submission-unknown');
      expect(
        (
          await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [
            queued.id,
          ])
        ).rows,
      ).toEqual([{ state: 'unknown' }]);
      release();
      await work;
      work = undefined;
      await engine.workOnce();
      expect(submissions).toBe(1);
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(60);
      expect((await engine.getJob(workspaceId, queued.id))?.settledMicros).toBeNull();
    } finally {
      release();
      await work?.catch(() => {});
      await engine.close();
    }
  });
  it('does not expose another workspace’s jobs and refunds a confirmed rejected submission', async () => {
    const { engine, workspaceId } = await setup({
      submit: async () => {
        throw new SubmissionRejected('Provider rejected credentials.');
      },
    });
    try {
      const queued = await engine.submit({ workspaceId, idempotencyKey: 'isolation', input });
      expect(await engine.getJob('another-workspace', queued.id)).toBeNull();
      await expect(engine.cancel('another-workspace', queued.id)).rejects.toBeInstanceOf(
        EngineError,
      );
      await engine.workOnce();
      expect((await engine.getJob(workspaceId, queued.id))?.status).toBe('failed');
      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(1000);
    } finally {
      await engine.close();
    }
  });
  it('keeps settlement pending until actual usage arrives, then caps customer charge at its reservation', async () => {
    const { engine, workspaceId } = await setup();
    try {
      const queued = await engine.submit({ workspaceId, idempotencyKey: 'late-usage', input });
      await engine.workOnce();
      const finished = await engine.applyProviderResult(workspaceId, queued.id, {
        status: 'succeeded',
        outputs: [],
      });
      expect(finished.settledMicros).toBeNull();
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(60);
      const settled = await engine.applyProviderResult(workspaceId, queued.id, {
        status: 'succeeded',
        billedCostMicros: 100,
      });
      expect(settled.settledMicros).toBe(60);
      expect(await engine.getBalance(workspaceId)).toEqual({
        availableMicros: 940,
        reservedMicros: 0,
        currency: 'USD',
      });
      const entry = (await engine.ledger(workspaceId)).find((value) => value.kind === 'settle');
      expect(entry?.details).toMatchObject({ upstreamCostMicros: 100, operatorOverrunMicros: 40 });
    } finally {
      await engine.close();
    }
  });
  it('normalizes immediate provider completion without inventing a pollable upstream ID', async () => {
    let outputStorage: ReturnType<typeof privateStorageFixture>;
    const { engine, workspaceId, storage } = await setup({
      submit: async (context) => ({
        immediateResult: {
          status: 'succeeded',
          billedCostMicros: 40,
          outputs: [await privateOutputFixture(outputStorage, context.jobId)],
        },
      }),
      poll: async () => {
        throw new Error('A synchronous completion must not be polled.');
      },
    });
    outputStorage = storage;
    try {
      const queued = await engine.submit({
        workspaceId,
        idempotencyKey: 'immediate-result',
        input,
      });
      await engine.workOnce();
      const finished = await workUntilJob(
        engine,
        workspaceId,
        queued.id,
        (job) => job.status === 'succeeded' && job.deliveryStatus === 'available',
      );
      expect(finished?.status).toBe('succeeded');
      expect(finished?.upstreamId).toBeNull();
      expect(finished?.settledMicros).toBe(40);
      expect(finished?.deliveryStatus).toBe('available');
      expect(finished?.outputs).toHaveLength(1);
      expect(finished?.outputs[0]?.url).toContain('https://private-storage.example/outputs/');
      expect(finished?.outputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await engine.workOnce()).toBe(false);
    } finally {
      await engine.close();
    }
  });
  it('rejects adapter-incompatible image and video requests before reserving funds', async () => {
    let networkCalls = 0;
    const noNetwork: typeof fetch = async () => {
      networkCalls++;
      throw new Error('Preflight must prevent network calls.');
    };
    const isolated = await fixtureDatabase();
    const engine = fixtureEngine({
      databaseUrl: isolated.databaseUrl,
      storage: privateStorageFixture(),
      adapters: [
        createAlibabaAdapter({
          env: {
            DASHSCOPE_API_KEY: 'fixture',
            ALIBABA_WORKSPACE_ID: 'fixture',
            ALIBABA_REGION: 'ap-southeast-1',
          },
          fetch: noNetwork,
        }),
        createBytePlusAdapter({ env: { BYTEPLUS_API_KEY: 'fixture' }, fetch: noNetwork }),
      ],
    });
    const workspaceId = `preflight-${randomUUID()}`;
    try {
      await engine.initialize();
      await engine.ensureWorkspace(workspaceId, 1000000);
      await expect(
        engine.submit({
          workspaceId,
          idempotencyKey: 'unsupported-layer-decomposition',
          input: {
            modelId: 'bytedance/seedream-5.0-pro',
            operation: 'text-to-image',
            input: {
              prompt: 'A calm sea.',
              resolution: '1K',
              layers: 2,
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'no_executable_route' });
      await expect(
        engine.submit({
          workspaceId,
          idempotencyKey: 'unsupported-document-mode',
          input: {
            modelId: 'alibaba/wan-3.0',
            operation: 'reference-to-video',
            input: {
              prompt: 'A calm sea.',
              resolution: '720p',
              duration: 5,
              references: [{ type: 'document', asset: { url: 'https://example.com/brief.pdf' } }],
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'no_executable_route' });
      expect(await engine.getBalance(workspaceId)).toEqual({
        availableMicros: 1000000,
        reservedMicros: 0,
        currency: 'USD',
      });
      expect(
        (await engine.ledger(workspaceId)).filter((value) => value.kind === 'reserve'),
      ).toHaveLength(0);
      expect(await engine.listJobs(workspaceId)).toHaveLength(0);
      expect(networkCalls).toBe(0);
    } finally {
      await engine.close();
    }
  });
  it('does not report perfect technical success when failed observations are unclassified', async () => {
    const { engine, workspaceId, routeId } = await setup({
      submit: async (context) =>
        context.input.input.prompt === 'success'
          ? { immediateResult: { status: 'succeeded', billedCostMicros: 40 } }
          : {
              immediateResult: {
                status: 'failed',
                failureCategory: 'unknown',
                billedCostMicros: 0,
              },
            },
    });
    try {
      for (let index = 0; index < 10; index++) {
        await engine.submit({
          workspaceId,
          idempotencyKey: `metric-${index}`,
          input: {
            ...input,
            input: {
              ...input.input,
              prompt: index === 0 ? 'success' : 'unknown failure',
            },
          },
        });
        await engine.workOnce();
      }
      const metrics = (await engine.routeMetrics()).find((value) => value.routeId === routeId);
      expect(metrics).toMatchObject({
        sampleCount: 10,
        succeeded: 1,
        failed: 9,
        unclassifiedFailures: 9,
        technicalSuccessRate: null,
      });
    } finally {
      await engine.close();
    }
  });
  it('counts all failures while calculating technical success only for classified technical outcomes', async () => {
    const { engine, workspaceId, routeId } = await setup({
      submit: async (context) =>
        context.input.input.prompt === 'success'
          ? { immediateResult: { status: 'succeeded', billedCostMicros: 40 } }
          : {
              immediateResult: {
                status: 'failed',
                failureCategory:
                  context.input.input.prompt === 'technical' ? 'technical' : 'policy',
                billedCostMicros: 0,
              },
            },
    });
    try {
      for (const prompt of ['success', 'technical', 'policy']) {
        await engine.submit({
          workspaceId,
          idempotencyKey: prompt,
          input: { ...input, input: { ...input.input, prompt } },
        });
        await engine.workOnce();
      }
      const metrics = (await engine.routeMetrics()).find((value) => value.routeId === routeId);
      expect(metrics).toMatchObject({
        sampleCount: 3,
        succeeded: 1,
        failed: 2,
        unclassifiedFailures: 0,
        technicalSuccessRate: 0.5,
      });
    } finally {
      await engine.close();
    }
  });
  it('calculates every advertised completion percentile from observed successful jobs', async () => {
    const { engine, workspaceId, routeId } = await setup({
      submit: async () => ({ immediateResult: { status: 'succeeded', billedCostMicros: 40 } }),
    });
    try {
      for (let index = 1; index <= 5; index++) {
        const job = await engine.submit({
          workspaceId,
          idempotencyKey: `percentile-${index}`,
          input,
        });
        await engine.workOnce();
        await engine.pool.query(
          "UPDATE mr_jobs SET created_at=now()-interval '10 minutes',completed_at=now()-interval '10 minutes'+($2::int*interval '1 second') WHERE id=$1",
          [job.id, index],
        );
        await engine.pool.query(
          'UPDATE mr_attempts a SET started_at=j.created_at,completed_at=j.completed_at FROM mr_jobs j WHERE a.job_id=j.id AND j.id=$1',
          [job.id],
        );
      }
      const metrics = (await engine.routeMetrics()).find((row) => row.routeId === routeId)!;
      expect(metrics.sampleCount).toBe(5);
      expect(metrics.p50CompletionMs).toBeCloseTo(3000, 2);
      expect(metrics.p75CompletionMs).toBeCloseTo(4000, 2);
      expect(metrics.p90CompletionMs).toBeCloseTo(4600, 2);
      expect(metrics.p95CompletionMs).toBeCloseTo(4800, 2);
      expect(metrics.p99CompletionMs).toBeCloseTo(4960, 2);
    } finally {
      await engine.close();
    }
  });
  it('polls explicitly pending terminal billing without repeating the provider submission', async () => {
    let submissions = 0,
      polls = 0;
    const { engine, workspaceId } = await setup({
      submit: async () => {
        submissions++;
        return { upstreamId: 'late-billing-id' };
      },
      poll: async () =>
        ++polls === 1
          ? { status: 'succeeded', outputs: [], billedCostMicros: null, retryAfterMs: 30000 }
          : { status: 'succeeded', billedCostMicros: 40 },
    });
    try {
      const queued = await engine.submit({
        workspaceId,
        idempotencyKey: 'terminal-billing',
        input,
      });
      await engine.workOnce();
      await engine.workOnce();
      expect((await engine.getJob(workspaceId, queued.id))?.status).toBe('succeeded');
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(60);
      await engine.pool.query('UPDATE mr_jobs SET next_poll_at=now() WHERE id=$1', [queued.id]);
      await engine.workOnce();
      expect((await engine.getJob(workspaceId, queued.id))?.settledMicros).toBe(40);
      expect(submissions).toBe(1);
      expect(polls).toBe(2);
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(0);
    } finally {
      await engine.close();
    }
  });
  it('shares the caller transaction for atomic credit rollback and commit with a single-connection pool', async () => {
    const isolated = await fixtureDatabase();
    const engine = fixtureEngine({ databaseUrl: isolated.databaseUrl, poolSize: 1 });
    const workspaceId = `credit-atomic-${randomUUID()}`;
    const relatedWorkspaceId = `credit-related-${randomUUID()}`;
    const reference = 'caller-owned-credit';
    await engine.initialize();
    await engine.ensureWorkspace(workspaceId, 1000);
    try {
      const client = await engine.pool.connect();
      try {
        await client.query('BEGIN');
        // A surrounding service can make its own writes before invoking the shared credit rules.
        await client.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [
          relatedWorkspaceId,
        ]);
        await creditWorkspaceInTransaction(client, workspaceId, 200, reference);
        expect(
          (
            await client.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
              workspaceId,
            ])
          ).rows[0].available_micros,
        ).toBe('1200');
        await client.query('ROLLBACK');
        expect(
          (
            await client.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
              workspaceId,
            ])
          ).rows[0].available_micros,
        ).toBe('1000');
        expect(
          (await client.query('SELECT id FROM mr_workspaces WHERE id=$1', [relatedWorkspaceId]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await client.query('SELECT id FROM mr_ledger WHERE workspace_id=$1 AND reference=$2', [
              workspaceId,
              reference,
            ])
          ).rowCount,
        ).toBe(0);

        await client.query('BEGIN');
        await client.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [
          relatedWorkspaceId,
        ]);
        await creditWorkspaceInTransaction(client, workspaceId, 200, reference);
        await creditWorkspaceInTransaction(client, workspaceId, 200, reference);
        await client.query('COMMIT');
        expect(
          (await client.query('SELECT id FROM mr_workspaces WHERE id=$1', [relatedWorkspaceId]))
            .rowCount,
        ).toBe(1);
        expect(
          (
            await client.query('SELECT id FROM mr_ledger WHERE workspace_id=$1 AND reference=$2', [
              workspaceId,
              reference,
            ])
          ).rowCount,
        ).toBe(1);
        expect(engine.pool.totalCount).toBe(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await engine.getBalance(workspaceId)).toMatchObject({
        availableMicros: 1200,
        reservedMicros: 0,
      });
    } finally {
      await engine.close();
    }
  });
  it('credits once under concurrent operator retries and records replay-safe settlement events', async () => {
    const { engine, workspaceId } = await setup();
    try {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          engine.creditWorkspace(workspaceId, 200, 'fixture-receipt'),
        ),
      );
      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(1200);
      await expect(
        engine.creditWorkspace(workspaceId, 201, 'fixture-receipt'),
      ).rejects.toMatchObject({ code: 'credit_conflict' });
      const queued = await engine.submit({ workspaceId, idempotencyKey: 'credit-event', input });
      await engine.workOnce();
      await engine.workOnce();
      await engine.applyProviderResult(workspaceId, queued.id, {
        status: 'succeeded',
        billedCostMicros: 40,
      });
      await workUntilJob(
        engine,
        workspaceId,
        queued.id,
        (job) => job.status === 'succeeded' && job.deliveryStatus === 'available',
      );
      const events = (
        await engine.pool.query('SELECT type FROM mr_events WHERE workspace_id=$1', [workspaceId])
      ).rows.map((row) => row.type);
      expect(events.filter((type) => type === 'generation.completed')).toHaveLength(1);
      expect(events.filter((type) => type === 'billing.settled')).toHaveLength(1);
      const ledger = await engine.ledger(workspaceId);
      const balance = await engine.getBalance(workspaceId);
      expect(ledger.reduce((total, row) => total + Number(row.available_delta_micros), 0)).toBe(
        balance.availableMicros,
      );
      expect(ledger.reduce((total, row) => total + Number(row.reserved_delta_micros), 0)).toBe(
        balance.reservedMicros,
      );
    } finally {
      await engine.close();
    }
  });
  it('reconciles ambiguous acceptance with evidenced task identity and replay-safe operator audit', async () => {
    const { engine, workspaceId } = await setup({
      submit: async () => {
        throw new Error('Ambiguous connection close.');
      },
    });
    try {
      const queued = await engine.submit({
        workspaceId,
        idempotencyKey: 'reconcile-accepted',
        input,
      });
      await engine.workOnce();
      const audit = {
        action: 'resume' as const,
        upstreamId: 'observed-provider-id',
        reference: 'support-case-1',
        note: 'Verified the regional provider task record before resuming.',
        evidenceUrl: 'https://provider.example/tasks/observed-provider-id',
      };
      const resumed = await engine.reconcile(workspaceId, queued.id, audit);
      expect(resumed.status).toBe('running');
      expect(resumed.upstreamId).toBeNull();
      expect(
        (
          await engine.pool.query(
            'SELECT upstream_id FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
            [workspaceId, queued.id],
          )
        ).rows[0].upstream_id,
      ).toBe('observed-provider-id');
      await engine.workOnce();
      expect((await engine.reconcile(workspaceId, queued.id, audit)).status).toBe('succeeded');
      expect(await engine.reconciliations(workspaceId, queued.id)).toHaveLength(1);
      await expect(
        engine.reconcile(workspaceId, queued.id, {
          ...audit,
          note: 'Different evidence under the same reference.',
        }),
      ).rejects.toMatchObject({ code: 'reconciliation_conflict' });
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(0);
    } finally {
      await engine.close();
    }
  });
  it('records evidenced late cost once and exports ledger pages without duplicate entries', async () => {
    const { engine, workspaceId } = await setup();
    try {
      const queued = await engine.submit({ workspaceId, idempotencyKey: 'reconcile-cost', input });
      await engine.workOnce();
      await engine.applyProviderResult(workspaceId, queued.id, { status: 'succeeded' });
      const audit = {
        action: 'settle' as const,
        billedCostMicros: 40,
        reference: 'invoice-1',
        note: 'Verified final provider invoice for this exact regional job.',
        evidenceUrl: 'https://provider.example/invoices/1',
      };
      await engine.reconcile(workspaceId, queued.id, audit);
      await engine.reconcile(workspaceId, queued.id, audit);
      expect((await engine.getJob(workspaceId, queued.id))?.settledMicros).toBe(40);
      const first = await engine.ledger(workspaceId, { limit: 2 });
      const second = await engine.ledger(workspaceId, {
        limit: 2,
        after: String(first.at(-1)!.id),
      });
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(4);
      expect(
        (await engine.ledger(workspaceId)).filter((row) => row.kind === 'settle'),
      ).toHaveLength(1);
      await expect(
        engine.reconcile(workspaceId, queued.id, { ...audit, reference: 'different-invoice' }),
      ).rejects.toMatchObject({ code: 'already_settled' });
    } finally {
      await engine.close();
    }
  });
});
