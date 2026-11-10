import { privateInputBytesFixture, privateStorageFixture } from './helpers/private-storage';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import { createEngine, type ProviderAdapter } from '@media-router/engine';

const databaseUrl = process.env.TEST_DATABASE_URL;
const route = catalog.routes.find((route) => route.id === 'alibaba/ap-southeast-1/wan-3.0')!;
const deployment = catalog.deployments.find((deployment) => deployment.id === route.deploymentId)!;
const request = {
  modelId: route.modelId,
  routeId: route.id,
  operation: 'text-to-video' as const,
  input: { prompt: 'Synthetic ownership regression.', resolution: '720p', duration: 5 },
};
type ProviderCall = { method: string; url: string; authorization: string | null };
function successfulProvider(calls: ProviderCall[]): typeof fetch {
  return async (url, options) => {
    calls.push({
      method: options?.method ?? 'GET',
      url: String(url),
      authorization: new Headers(options?.headers).get('authorization'),
    });
    if (options?.method === 'POST')
      return Response.json({ output: { task_id: 'synthetic-owned-task' } });
    return Response.json({
      output: { task_status: 'SUCCEEDED', video_url: 'https://provider.invalid/synthetic.mp4' },
      usage: { duration: 5 },
    });
  };
}

describe.skipIf(!databaseUrl)('managed and BYOK credential ownership', () => {
  async function fixture(
    operation: (
      engine: ReturnType<typeof createEngine>,
      workspaceId: string,
      operatorCalls: () => number,
    ) => Promise<void>,
    providerFetch?: typeof fetch,
  ) {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'billing_ownership');
    let calls = 0;
    const operator: ProviderAdapter = {
      id: 'alibaba',
      isConfigured: () => true,
      submit: async () => {
        calls++;
        return {
          immediateResult: {
            status: 'failed',
            billedCostMicros: 0,
            error: 'Synthetic operator adapter completed.',
          },
        };
      },
      poll: async () => {
        throw new Error('No operator polling expected.');
      },
    };
    const engine = isolated.bind(
      createEngine({
        storage: privateStorageFixture(),
        databaseUrl: isolated.databaseUrl,
        vaultKey: 'ab'.repeat(32),
        adapters: [operator],
        pollIntervalMs: 0,
        // This is a synthetic byte transport, not an upstream media request.
        delivery: { download: async () => privateInputBytesFixture('video/mp4').bytes },
      }),
    );
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(
      providerFetch ??
        (async () => {
          throw new Error('Network disabled in ownership regression.');
        }),
    );
    try {
      await engine.initialize();
      expect((await engine.pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(
        isolated.schema,
      );
      const workspaceId = `ownership-${randomUUID()}`;
      await engine.ensureWorkspace(workspaceId, 1_000_000);
      await engine.accounts.putConnection(workspaceId, deployment.id, {
        apiKey: 'synthetic-owner-key',
        workspaceId: 'synthetic-workspace',
      });
      await operation(engine, workspaceId, () => calls);
      if (!providerFetch) expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      await engine.close();
      await isolated.close();
    }
  }
  it('never substitutes a workspace BYOK connection for operator-funded managed execution', async () => {
    await fixture(async (engine, workspaceId, calls) => {
      const job = await engine.submit({
        workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...request, billing: 'managed' },
      });
      await workUntilJob(engine, workspaceId, job.id, (value) => value.status === 'failed');
      expect(calls()).toBe(1);
      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(1_000_000);
      const kinds = (
        await engine.pool.query(
          'SELECT kind,count(*)::integer AS count FROM mr_ledger WHERE job_id=$1 GROUP BY kind',
          [job.id],
        )
      ).rows;
      expect(Object.fromEntries(kinds.map((row) => [row.kind, row.count]))).toEqual({
        reserve: 1,
        settle: 1,
        release: 1,
      });
    });
  });
  it('dispatches accepted BYOK work with its original encrypted payer after the mutable connection is deleted', async () => {
    const requests: ProviderCall[] = [];
    await fixture(async (engine, workspaceId, calls) => {
      const job = await engine.submit({
        workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...request, billing: 'byok' },
      });
      expect(job.reservedMicros).toBe(0);
      await engine.accounts.deleteConnection(workspaceId, deployment.id);
      const completed = await workUntilJob(
        engine,
        workspaceId,
        job.id,
        (value) => value.status === 'succeeded' && value.deliveryStatus === 'available',
      );
      expect(completed).toMatchObject({ settledMicros: 0, upstreamId: null });
      expect(completed.outputs).toHaveLength(1);
      expect(completed.outputs[0]).not.toHaveProperty('storageKey');
      expect(calls()).toBe(0);
      expect(requests.filter((value) => value.method === 'POST')).toHaveLength(1);
      expect(requests.every((value) => value.authorization === 'Bearer synthetic-owner-key')).toBe(
        true,
      );
      expect(
        requests.every((value) =>
          value.url.includes('synthetic-workspace.ap-southeast-1.maas.aliyuncs.com'),
        ),
      ).toBe(true);
      expect(await engine.getBalance(workspaceId)).toMatchObject({
        availableMicros: 1_000_000,
        reservedMicros: 0,
      });
    }, successfulProvider(requests));
  });
  it('polls and delivers only the original accepted BYOK task after replacement, with one zero managed settlement', async () => {
    const requests: ProviderCall[] = [];
    await fixture(async (engine, workspaceId, calls) => {
      const job = await engine.submit({
        workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...request, billing: 'byok' },
      });
      await engine.workOnce();
      expect(await engine.getJob(workspaceId, job.id)).toMatchObject({
        status: 'running',
        upstreamId: null,
      });
      expect(
        (await engine.pool.query('SELECT upstream_id FROM mr_jobs WHERE id=$1', [job.id])).rows[0]
          .upstream_id,
      ).toBe('synthetic-owned-task');
      await engine.accounts.putConnection(workspaceId, deployment.id, {
        apiKey: 'synthetic-replacement-key',
        workspaceId: 'synthetic-replacement-workspace',
      });
      const completed = await workUntilJob(
        engine,
        workspaceId,
        job.id,
        (value) => value.status === 'succeeded' && value.deliveryStatus === 'available',
      );
      expect(completed.settledMicros).toBe(0);
      await engine.applyProviderResult(workspaceId, job.id, {
        status: 'succeeded',
        billedCostMicros: 12345,
      });
      await engine.workOnce();
      expect(requests.filter((value) => value.method === 'POST')).toHaveLength(1);
      expect(requests.filter((value) => value.method === 'GET').length).toBeGreaterThanOrEqual(1);
      expect(
        requests
          .filter((value) => value.method === 'GET')
          .every((value) => value.url.endsWith('/tasks/synthetic-owned-task')),
      ).toBe(true);
      expect(requests.every((value) => value.authorization === 'Bearer synthetic-owner-key')).toBe(
        true,
      );
      expect(requests.every((value) => !value.url.includes('replacement'))).toBe(true);
      expect(calls()).toBe(0);
      const settlements = (
        await engine.pool.query(
          "SELECT amount_micros FROM mr_ledger WHERE job_id=$1 AND kind='settle'",
          [job.id],
        )
      ).rows;
      expect(settlements).toHaveLength(1);
      expect(Number(settlements[0].amount_micros)).toBe(0);
      expect(await engine.getBalance(workspaceId)).toMatchObject({
        availableMicros: 1_000_000,
        reservedMicros: 0,
      });
    }, successfulProvider(requests));
  });
  it('rejects new BYOK admission after deletion instead of falling back to operator funding', async () => {
    await fixture(async (engine, workspaceId, calls) => {
      await engine.accounts.deleteConnection(workspaceId, deployment.id);
      await expect(
        engine.submit({
          workspaceId,
          idempotencyKey: randomUUID(),
          input: { ...request, billing: 'byok' },
        }),
      ).rejects.toMatchObject({ code: 'no_executable_route' });
      expect(calls()).toBe(0);
      expect(
        (
          await engine.pool.query(
            'SELECT count(*)::integer AS count FROM mr_jobs WHERE workspace_id=$1',
            [workspaceId],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(await engine.getBalance(workspaceId)).toMatchObject({
        availableMicros: 1_000_000,
        reservedMicros: 0,
      });
    });
  });
});
