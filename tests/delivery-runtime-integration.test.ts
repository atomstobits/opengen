import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Catalog, GenerateInput, Job, Quote } from '@media-router/contracts';
import { createEngine, type Engine, type ProviderAdapter } from '@media-router/engine';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine';
import { privateInputBytesFixture, privateStorageFixture } from './helpers/private-storage';

const databaseUrl = process.env.TEST_DATABASE_URL;
const source = { url: 'https://fixture.invalid/docs', checkedAt: '2026-11-04' };
const deployment: Catalog['deployments'][number] = {
  id: 'fixture-private-region',
  providerId: 'fixture',
  name: 'Fixture private region',
  endpointRegion: 'fixture-region',
  scope: 'regional',
  processingRegions: ['fixture-region'],
  storageRegions: null,
  endpointTemplate: null,
  credentialEnv: null,
  source,
};
const route: Catalog['routes'][number] = {
  id: 'fixture-private-image',
  modelId: 'fixture/private-image',
  deploymentId: deployment.id,
  upstreamModelId: 'fixture-only',
  operations: ['text-to-image'],
  resolutions: ['1K'],
  durations: [],
  fidelity: 'unknown',
  adapter: 'alibaba',
  status: 'documented',
  rates: [{ resolution: '1K', unit: 'image', usdMicros: 50 }],
  pricingSource: source,
  source,
};
const catalog: Catalog = {
  providers: [{ id: 'fixture', name: 'Synthetic provider', website: source.url }],
  deployments: [deployment],
  routes: [route],
  models: [
    {
      id: route.modelId,
      name: 'Synthetic image',
      creator: 'Fixture',
      authorProviderIds: [],
      familyId: 'fixture',
      modality: 'image',
      aliases: [],
      openness: 'closed',
      license: 'Fixture only',
      source,
      description: 'No live provider model.',
    },
  ],
};
const quote = (input: GenerateInput, options: { executableRouteIds: string[] }): Quote => ({
  modelId: input.modelId,
  operation: input.operation,
  selectedRouteId: options.executableRouteIds.includes(route.id) ? route.id : null,
  estimateOnly: true,
  notices: [],
  reservationMicros: 100,
  candidates: [
    {
      routeId: route.id,
      deploymentId: deployment.id,
      providerId: deployment.providerId,
      endpointRegion: deployment.endpointRegion,
      scope: deployment.scope,
      estimatedCostMicros: 100,
      currency: 'USD',
      executable: options.executableRouteIds.includes(route.id),
      reason: null,
      source,
      notices: [],
    },
  ],
});
const input: GenerateInput = {
  modelId: route.modelId,
  routeId: route.id,
  operation: 'text-to-image',
  input: { prompt: 'Private synthetic delivery fixture.', count: 2, resolution: '1K' },
  metadata: { project: 'fixture-project', tags: { cohort: 'private-delivery' } },
};
const png = privateInputBytesFixture('image/png').bytes;
const hash = createHash('sha256').update(png).digest('hex');
const urls = [
  'https://provider.invalid/original-0.png?token=fixture-zero',
  'https://provider.invalid/original-1.png?token=fixture-one',
];
const providerOutputs = () =>
  urls.map((url) => ({ url, mediaType: 'image/png', fidelity: 'unverified' as const }));
async function ledgerCounts(engine: Engine, id: string) {
  return Object.fromEntries(
    (
      await engine.pool.query(
        'SELECT kind,count(*)::integer AS count FROM mr_ledger WHERE job_id=$1 GROUP BY kind',
        [id],
      )
    ).rows.map((row) => [row.kind, row.count]),
  );
}
async function assertPrivateJob(engine: Engine, workspaceId: string, job: Job) {
  expect(job.upstreamId).toBeNull();
  expect(
    job.outputs.every((output) => output.url.startsWith('https://private-storage.example/')),
  ).toBe(true);
  expect(job.outputs.every((output) => !Object.hasOwn(output, 'storageKey'))).toBe(true);
  expect(JSON.stringify(job)).not.toContain('provider.invalid');
  expect(JSON.stringify(job)).not.toContain('providerConnectionId');
  expect(await engine.getJob('foreign-workspace', job.id)).toBeNull();
  const compact = await engine.jobStatus.get(
    async () => ({ workspaceId, scopes: ['read'] }),
    job.id,
  );
  expect(compact.id).toBe(job.id); // Separate status pool must inherit this fixture's schema too.
  expect(JSON.stringify(compact)).not.toContain('prompt');
  expect(JSON.stringify(compact)).not.toContain('private-storage.example');
  await expect(
    engine.jobStatus.get(
      async () => ({ workspaceId: 'foreign-workspace', scopes: ['read'] }),
      job.id,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
}

describe.skipIf(!databaseUrl)('integrated private delivery runtime', () => {
  it('keeps generation and settlement complete while partial output recovers from storage outage on the same job', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'delivery_runtime');
    const storage = privateStorageFixture();
    let unavailable = false,
      submits = 0,
      polls = 0,
      downloads = 0;
    const transport = storage.client as unknown as {
      send: (command: unknown, options?: unknown) => Promise<unknown>;
    };
    const originalSend = transport.send.bind(transport);
    transport.send = async (command, options) => {
      if (unavailable) throw new Error('Synthetic private storage outage.');
      return originalSend(command, options);
    };
    const adapter: ProviderAdapter = {
      id: 'alibaba',
      isConfigured: () => true,
      submit: async (context) => {
        submits++;
        expect(context.input).not.toHaveProperty('metadata');
        return { upstreamId: 'original-private-task' };
      },
      poll: async (context) => {
        polls++;
        expect(context.upstreamId).toBe('original-private-task');
        return { status: 'succeeded', billedCostMicros: 40, outputs: providerOutputs() };
      },
    };
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        catalog,
        quote,
        storage,
        adapters: [adapter],
        pollIntervalMs: 0,
        delivery: {
          download: async (source, scope) => {
            downloads++;
            expect(urls).toContain(source.url);
            expect(scope.upstreamId).toBe('original-private-task');
            return Buffer.from(png);
          },
        },
      }),
    );
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Real network is disabled for runtime qualification.');
    });
    try {
      await engine.initialize();
      expect((await engine.pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(
        isolated.schema,
      );
      await engine.ensureWorkspace('owner', 1000);
      const original = await engine.submit({
        workspaceId: 'owner',
        idempotencyKey: 'same-private-render',
        input,
      });
      await engine.workOnce();
      await engine.workOnce();
      const generated = await engine.getJob('owner', original.id);
      expect(generated).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'pending',
        settledMicros: 40,
        outputs: [],
      });
      expect(await engine.getBalance('owner')).toMatchObject({
        availableMicros: 960,
        reservedMicros: 0,
      });
      expect(await ledgerCounts(engine, original.id)).toEqual({
        reserve: 1,
        settle: 1,
        release: 1,
      });
      // Schedule the original slots deterministically; the retry still runs the actual worker/receipt transition.
      await engine.pool.query(
        "UPDATE mr_output_receipts SET next_attempt_at=CASE WHEN slot=0 THEN now()-interval '1 second' ELSE now()+interval '1 day' END WHERE job_id=$1",
        [original.id],
      );
      await engine.workOnce();
      const partial = (await engine.getJob('owner', original.id))!;
      expect(partial).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'partial',
        settledMicros: 40,
      });
      expect(partial.outputs).toHaveLength(1);
      expect(partial.outputs[0]!.sha256).toBe(hash);
      const firstReceipt = (
        await engine.pool.query(
          'SELECT object_key,sha256 FROM mr_output_receipts WHERE job_id=$1 AND slot=0',
          [original.id],
        )
      ).rows[0];
      unavailable = true;
      await engine.pool.query(
        'UPDATE mr_output_receipts SET next_attempt_at=now() WHERE job_id=$1 AND slot=1',
        [original.id],
      );
      await engine.workOnce();
      expect(
        (
          await engine.pool.query(
            'SELECT state,source_url FROM mr_output_receipts WHERE job_id=$1 AND slot=1',
            [original.id],
          )
        ).rows[0],
      ).toMatchObject({ state: 'pending', source_url: urls[1] });
      expect((await engine.getJob('owner', original.id))?.deliveryStatus).toBe('failed'); // No capability is issued while retained-object HEAD is unavailable.
      expect((await engine.getJob('owner', original.id))?.outputs).toEqual([]);
      expect(submits).toBe(1);
      expect(downloads).toBe(1); // Outage is detected before source fetch; retained slot was not fetched again.
      unavailable = false;
      await engine.pool.query(
        'UPDATE mr_output_receipts SET next_attempt_at=now() WHERE job_id=$1 AND slot=1',
        [original.id],
      );
      const completed = await workUntilJob(
        engine,
        'owner',
        original.id,
        (job) => job.deliveryStatus === 'available',
      );
      expect(completed.outputs).toHaveLength(2);
      expect(completed.outputs.map((output) => output.sha256)).toEqual([hash, hash]);
      const receipts = (
        await engine.pool.query(
          'SELECT slot,object_key,sha256,state,source_url,inline_bytes FROM mr_output_receipts WHERE job_id=$1 ORDER BY slot',
          [original.id],
        )
      ).rows;
      expect(receipts).toHaveLength(2);
      expect(receipts[0]).toMatchObject({
        ...firstReceipt,
        state: 'available',
        source_url: null,
        inline_bytes: null,
      });
      expect(new Set(receipts.map((row) => row.object_key)).size).toBe(2);
      expect(submits).toBe(1);
      expect(downloads).toBe(2);
      expect(polls).toBeGreaterThanOrEqual(1); // Same-task refresh reads are allowed, never another submit.
      expect(
        (
          await engine.pool.query(
            'SELECT count(*)::integer AS count FROM mr_attempts WHERE job_id=$1',
            [original.id],
          )
        ).rows[0].count,
      ).toBe(1);
      await engine.applyProviderResult('owner', original.id, {
        status: 'succeeded',
        billedCostMicros: 40,
      });
      expect(
        (
          await engine.submit({
            workspaceId: 'owner',
            idempotencyKey: 'same-private-render',
            input,
          })
        ).id,
      ).toBe(original.id);
      expect(await ledgerCounts(engine, original.id)).toEqual({
        reserve: 1,
        settle: 1,
        release: 1,
      });
      expect(await engine.getBalance('owner')).toMatchObject({
        availableMicros: 960,
        reservedMicros: 0,
      });
      const events = (
        await engine.pool.query(
          "SELECT data FROM mr_events WHERE workspace_id='owner' AND type='generation.completed'",
          [],
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        jobId: original.id,
        status: 'succeeded',
        deliveryStatus: 'pending',
      });
      expect(JSON.stringify(events)).not.toContain('provider.invalid');
      await assertPrivateJob(engine, 'owner', completed);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      await engine.close();
      await isolated.close();
    }
  }, 60_000);

  it('recovers durable inline completion after a lost result boundary and restart without resubmit or premature settlement', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'delivery_inline');
    const storage = privateStorageFixture();
    let submits = 0;
    let engine: Engine;
    const adapter: ProviderAdapter = {
      id: 'alibaba',
      isConfigured: () => true,
      submit: async (context) => {
        submits++;
        await engine.delivery.capture(
          {
            workspaceId: context.workspaceId!,
            jobId: context.jobId,
            attempt: context.attempt!,
            routeId: context.route.id,
            deploymentId: context.deployment.id,
            upstreamId: null,
            providerConnectionId: context.providerConnectionId,
          },
          [{ kind: 'inline', bytes: png, mediaType: 'image/png' }],
        );
        throw new Error(
          'Synthetic process boundary lost after durable terminal output checkpoint.',
        );
      },
      poll: async () => {
        throw new Error('Inline completion has no upstream task to poll.');
      },
    };
    const options = {
      databaseUrl: isolated.databaseUrl,
      catalog,
      quote,
      storage,
      adapters: [adapter],
      pollIntervalMs: 0,
    };
    engine = isolated.bind(createEngine(options));
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Real network is disabled.');
    });
    try {
      await engine.initialize();
      await engine.ensureWorkspace('owner', 1000);
      const original = await engine.submit({
        workspaceId: 'owner',
        idempotencyKey: 'inline-original',
        input: { ...input, input: { ...input.input, count: 1 } },
      });
      await engine.workOnce();
      expect(await engine.getJob('owner', original.id)).toMatchObject({
        status: 'submission-unknown',
        settledMicros: null,
        outputs: [],
      });
      expect(await engine.getBalance('owner')).toMatchObject({
        availableMicros: 900,
        reservedMicros: 100,
      });
      expect(await ledgerCounts(engine, original.id)).toEqual({ reserve: 1 });
      expect(
        (
          await engine.pool.query(
            'SELECT kind,octet_length(inline_bytes)::integer AS bytes FROM mr_output_receipts WHERE job_id=$1',
            [original.id],
          )
        ).rows[0],
      ).toEqual({ kind: 'inline', bytes: png.byteLength });
      await engine.close();
      engine = isolated.bind(createEngine(options));
      await engine.initialize();
      const completed = await workUntilJob(
        engine,
        'owner',
        original.id,
        (job) => job.status === 'succeeded' && job.deliveryStatus === 'available',
      );
      expect(completed.settledMicros).toBeNull();
      expect(completed.outputs).toHaveLength(1);
      expect(completed.outputs[0]!.sha256).toBe(hash);
      expect(await engine.getBalance('owner')).toMatchObject({
        availableMicros: 900,
        reservedMicros: 100,
      });
      expect(await ledgerCounts(engine, original.id)).toEqual({ reserve: 1 });
      expect(submits).toBe(1);
      const receipt = (
        await engine.pool.query(
          'SELECT state,sha256,inline_bytes,source_url FROM mr_output_receipts WHERE job_id=$1',
          [original.id],
        )
      ).rows[0];
      expect(receipt).toEqual({
        state: 'available',
        sha256: hash,
        inline_bytes: null,
        source_url: null,
      });
      // A later trusted usage observation settles the original hold once; redelivery did not.
      await engine.applyProviderResult('owner', original.id, {
        status: 'succeeded',
        billedCostMicros: 40,
      });
      await engine.applyProviderResult('owner', original.id, {
        status: 'succeeded',
        billedCostMicros: 40,
      });
      expect(await ledgerCounts(engine, original.id)).toEqual({
        reserve: 1,
        settle: 1,
        release: 1,
      });
      expect(await engine.getBalance('owner')).toMatchObject({
        availableMicros: 960,
        reservedMicros: 0,
      });
      expect(
        (
          await engine.pool.query(
            'SELECT count(*)::integer AS count FROM mr_attempts WHERE job_id=$1',
            [original.id],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await engine.pool.query(
            "SELECT count(*)::integer AS count FROM mr_events WHERE workspace_id='owner' AND type='generation.completed'",
            [],
          )
        ).rows[0].count,
      ).toBe(1);
      await assertPrivateJob(engine, 'owner', completed);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      if (!engine.pool.ended) await engine.close();
      await isolated.close();
    }
  }, 60_000);
});
