import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import { createEngine, type Principal, type ProviderAdapter } from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine';
import { privateOutputFixture, privateStorageFixture } from './helpers/private-storage';

const databaseUrl = process.env.TEST_DATABASE_URL;
const routeIds: [string, string] = [
  'xai-undisclosed/xai-grok-imagine-image-2.0',
  'byteplus-modelark-ap-southeast-1/bytedance-seedream-5.0-pro',
];
const privatePrompt = 'A small stone sculpture, lit by the morning sun.';
const principal: Principal = {
  workspaceId: 'comparison-owner',
  scopes: ['read', 'generate'],
  bootstrap: true,
};
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe.skipIf(!databaseUrl)('Private comparison admission and recovery', () => {
  async function setup(balance: number) {
    const database = await isolatedEngineDatabase(databaseUrl!, 'comparison');
    const storage = privateStorageFixture();
    const submit = vi.fn(async ({ jobId }) => ({ upstreamId: `provider-${jobId}` }));
    const adapters: ProviderAdapter[] = [
      {
        id: 'xai',
        isConfigured: () => true,
        submit,
        poll: async ({ jobId }) => ({
          status: 'succeeded',
          billedCostMicros: 33_000,
          outputs: [await privateOutputFixture(storage, jobId, 'image/png')],
        }),
      },
      {
        id: 'byteplus',
        isConfigured: () => true,
        submit,
        poll: async () => ({
          status: 'failed',
          failureCategory: 'technical',
          billedCostMicros: 0,
          error: 'Synthetic provider failure.',
        }),
      },
    ];
    const options = {
      databaseUrl: database.databaseUrl,
      storage,
      adapters,
      pollIntervalMs: 0,
    };
    const engine = database.bind(createEngine(options));
    const app = await buildApp({
      engine,
      apiToken: 'comparison-fixture-token',
      workspaceId: principal.workspaceId,
    });
    close = async () => {
      await app.close();
      await engine.close();
      await database.close();
    };
    await engine.initialize();
    await engine.ensureWorkspace(principal.workspaceId, balance);
    return { engine, app, submit, database, options };
  }

  it('adds comparisons after the immutable billing migration prefix', async () => {
    const { engine } = await setup(100_000);
    const originalComparisonMigration = (
      await engine.pool.query("SELECT name,checksum FROM mr_migrations WHERE name='026.sql'")
    ).rows[0];
    await engine.pool.query('DROP TABLE mr_comparison_runs');
    await engine.pool.query("DELETE FROM mr_migrations WHERE name='026.sql'");
    const before = (
      await engine.pool.query('SELECT name,checksum FROM mr_migrations ORDER BY name')
    ).rows;
    const immutablePrefix = Array.from(
      { length: 25 },
      (_, index) => `${String(index + 1).padStart(3, '0')}.sql`,
    );
    expect(
      before.filter((row) => immutablePrefix.includes(row.name)).map((row) => row.name),
    ).toEqual(immutablePrefix);
    expect(before.map((row) => row.name)).toEqual([
      ...immutablePrefix,
      '027.sql',
      '028.sql',
      '029.sql',
      '030.sql',
      '031.sql',
    ]);
    const serializerMigration = before.find((row) => row.name === '027.sql');
    expect(serializerMigration).toBeDefined();
    await engine.initialize();
    const after = (await engine.pool.query('SELECT name,checksum FROM mr_migrations ORDER BY name'))
      .rows;
    expect(after.filter((row) => row.name !== '026.sql')).toEqual(before);
    expect(after.find((row) => row.name === '026.sql')).toEqual(originalComparisonMigration);
    expect(after.find((row) => row.name === '027.sql')).toEqual(serializerMigration);
    expect(await engine.listComparisons(principal.workspaceId)).toEqual([]);
    expect((await engine.getBalance(principal.workspaceId)).availableMicros).toBe(100_000);
  });

  it('refuses an unaffordable pair atomically, even when the first child alone is affordable', async () => {
    const { engine, submit } = await setup(60_000);
    const quote = await engine.quoteComparison(principal, privatePrompt, routeIds);
    expect(quote).toMatchObject({
      estimatedMicros: 85_000,
      ceilingMicros: 85_000,
      admittedAt: null,
      jobs: [],
    });
    await expect(engine.submitComparison(principal, quote.id)).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
    expect(await engine.getBalance(principal.workspaceId)).toMatchObject({
      availableMicros: 60_000,
      reservedMicros: 0,
    });
    expect(await engine.listJobs(principal.workspaceId)).toEqual([]);
    expect(await engine.ledger(principal.workspaceId)).toHaveLength(1);
    expect((await engine.getComparison(principal.workspaceId, quote.id))?.admittedAt).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.TEST_NATIVE_POSTGRES !== '1')(
    'admits reversed route pairs concurrently across workspaces without a supply-lock deadlock',
    async () => {
      const { engine, database, options, submit } = await setup(150_000);
      const other = { ...principal, workspaceId: 'comparison-other-owner' };
      await engine.ensureWorkspace(other.workspaceId, 150_000);
      const replica = database.bind(createEngine({ ...options, poolSize: 1 }));
      try {
        const first = await engine.quoteComparison(principal, privatePrompt, routeIds);
        const second = await replica.quoteComparison(other, privatePrompt, [
          routeIds[1],
          routeIds[0],
        ]);
        // Widen the native lock overlap. Without union ordering, the opposite
        // first-child pools are both retained before either takes its second.
        await engine.pool.query(`
          CREATE FUNCTION slow_provider_pool_configuration() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$;
          CREATE TRIGGER slow_provider_pool_configuration
          AFTER INSERT OR UPDATE ON mr_execution_pools
          FOR EACH ROW WHEN (NEW.kind='provider')
          EXECUTE FUNCTION slow_provider_pool_configuration();
        `);
        const accepted = await Promise.all([
          engine.submitComparison(principal, first.id),
          replica.submitComparison(other, second.id),
        ]);
        expect(accepted.map((value) => value.children.map((child) => child.input.routeId))).toEqual(
          [routeIds, [routeIds[1], routeIds[0]]],
        );
        for (const [index, owner] of [principal, other].entries()) {
          expect(accepted[index]!.jobs).toHaveLength(2);
          expect(accepted[index]!.admittedAt).not.toBeNull();
          expect(await engine.getBalance(owner.workspaceId)).toMatchObject({
            availableMicros: 65_000,
            reservedMicros: 85_000,
          });
          expect(await engine.listJobs(owner.workspaceId)).toHaveLength(2);
        }
        expect(submit).not.toHaveBeenCalled();
      } finally {
        await replica.close();
      }
    },
  );

  it('approves once, keeps original child IDs across restart, and settles and delivers each independently', async () => {
    const { app, engine, submit, database, options } = await setup(150_000);
    const headers = { authorization: 'Bearer comparison-fixture-token' };
    const quoteResponse = await app.inject({
      method: 'POST',
      url: '/v1/comparisons/quote',
      headers,
      payload: { prompt: privatePrompt, routeIds },
    });
    expect(quoteResponse.statusCode).toBe(201);
    expect(quoteResponse.headers['cache-control']).toBe('no-store');
    const quote = quoteResponse.json();
    expect(await engine.listJobs(principal.workspaceId)).toEqual([]);
    expect(await engine.getComparison('other-workspace', quote.id)).toBeNull();
    await expect(
      engine.submitComparison({ ...principal, workspaceId: 'other-workspace' }, quote.id),
    ).rejects.toMatchObject({ code: 'not_found' });

    const approve = () =>
      app.inject({
        method: 'POST',
        url: `/v1/comparisons/${quote.id}/approve`,
        headers,
      });
    const accepted = await approve();
    expect(accepted.statusCode).toBe(202);
    const ids = accepted.json().jobs.map((job: { id: string }) => job.id);
    expect(ids).toHaveLength(2);
    expect((await approve()).json().jobs.map((job: { id: string }) => job.id)).toEqual(ids);
    expect(await engine.getBalance(principal.workspaceId)).toMatchObject({
      availableMicros: 65_000,
      reservedMicros: 85_000,
    });
    expect(submit).not.toHaveBeenCalled();

    const restarted = database.bind(createEngine(options));
    try {
      await workUntilJob(
        restarted,
        principal.workspaceId,
        ids[0],
        (job) => job.status === 'succeeded',
      );
      await workUntilJob(
        restarted,
        principal.workspaceId,
        ids[1],
        (job) => job.status === 'failed',
      );
      await workUntilJob(
        restarted,
        principal.workspaceId,
        ids[0],
        (job) => job.deliveryStatus === 'available',
      );
      const read = await restarted.getComparison(principal.workspaceId, quote.id);
      expect(read?.jobs).toMatchObject([
        {
          id: ids[0],
          status: 'succeeded',
          settledMicros: 33_000,
          upstreamId: null,
          deliveryStatus: 'available',
          outputs: [
            { mediaType: 'image/png', url: expect.stringContaining('private-storage.example') },
          ],
        },
        {
          id: ids[1],
          status: 'failed',
          settledMicros: 0,
          upstreamId: null,
          outputs: [],
        },
      ]);
      expect(JSON.stringify(read)).not.toContain('storageKey');
      expect(await restarted.listComparisons(principal.workspaceId)).toMatchObject([
        { id: quote.id, routeIds },
      ]);
      expect(submit).toHaveBeenCalledTimes(2);
    } finally {
      await restarted.close();
    }
  });

  it('requires two distinct routes with known pricing and prevents approval after expiration', async () => {
    const { engine } = await setup(150_000);
    await expect(
      engine.quoteComparison(principal, privatePrompt, [routeIds[0], routeIds[0]]),
    ).rejects.toMatchObject({ code: 'incompatible_comparison' });
    const unknownPrice = catalog.routes.find((route) => route.modelId === 'openai/gpt-image-2')!;
    await expect(
      engine.quoteComparison(principal, privatePrompt, [routeIds[0], unknownPrice.id]),
    ).rejects.toMatchObject({ code: 'comparison_route_unavailable' });
    const quote = await engine.quoteComparison(principal, privatePrompt, routeIds);
    await engine.pool.query(
      'UPDATE mr_comparison_runs SET expires_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
      [principal.workspaceId, quote.id],
    );
    await expect(engine.submitComparison(principal, quote.id)).rejects.toMatchObject({
      code: 'comparison_quote_expired',
    });
    expect(await engine.getComparison(principal.workspaceId, quote.id)).toBeNull();
  });
});
