import { describe, expect, it } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import { createEngine } from '@media-router/engine';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import { privateOutputFixture, privateStorageFixture } from './helpers/private-storage';

const databaseUrl = process.env.TEST_DATABASE_URL;
const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  operation: 'text-to-video',
  input: { resolution: '720p', duration: 5, prompt: 'Synthetic worker result race fixture.' },
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// These barriers interleave real engine transactions and provider-result paths.
// PGlite can supplement this case, but only CI supplies native PostgreSQL evidence.
describe.skipIf(!databaseUrl)('worker lease and callback result qualification', () => {
  it('preserves callback success and one settlement when expired poll workers return stale results', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'worker_result');
    const storage = privateStorageFixture();
    const entered = [gate(), gate()];
    const responses = [gate(), gate()];
    const results = [{ status: 'running' }, { status: 'unknown' }] as const;
    let submissions = 0;
    const polls: string[] = [];
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage,
        providerEnv: {},
        vaultKey: '0'.repeat(64),
        poolSize: 3,
        pollIntervalMs: 0,
        leaseMs: 100,
        execution: { workspaceMaxActive: 1, providerMaxActive: 1 },
        adapters: [
          {
            id: 'alibaba',
            isConfigured: (route) => route.id === input.routeId,
            submit: async () => {
              submissions++;
              return { upstreamId: 'fixture-original-task' };
            },
            poll: async ({ upstreamId }) => {
              const index = polls.length;
              polls.push(upstreamId);
              if (index >= entered.length) throw new Error('Unexpected extra fixture poll.');
              entered[index]!.resolve();
              await responses[index]!.promise;
              return results[index]!;
            },
          },
        ],
      }),
    );
    const pending: Promise<boolean>[] = [];
    try {
      await engine.initialize();
      await engine.ensureWorkspace('owner', 5_000_000);
      const original = await engine.submit({
        workspaceId: 'owner',
        idempotencyKey: 'callback-wins-original-task',
        input,
      });
      expect(await engine.workOnce()).toBe(true);
      expect((await engine.getJob('owner', original.id))?.status).toBe('running');
      const held = await engine.getBalance('owner');
      expect(held.reservedMicros).toBeGreaterThan(40);

      const oldPoll = engine.workOnce();
      pending.push(oldPoll);
      await Promise.race([
        entered[0]!.promise,
        oldPoll.then(() => {
          throw new Error('Original fixture poll was not claimed.');
        }),
      ]);
      await expect(engine.cancel('owner', original.id)).rejects.toMatchObject({
        code: 'cancellation_unconfirmed',
      });
      expect(await engine.getBalance('owner')).toEqual(held);

      await engine.pool.query(
        "UPDATE mr_jobs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",
        [original.id],
      );
      const reclaimedPoll = engine.workOnce();
      pending.push(reclaimedPoll);
      await Promise.race([
        entered[1]!.promise,
        reclaimedPoll.then(() => {
          throw new Error('Expired fixture poll lease was not reclaimed.');
        }),
      ]);
      expect(await engine.getBalance('owner')).toEqual(held);
      expect(
        (
          await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [
            original.id,
          ])
        ).rows,
      ).toEqual([{ state: 'occupied' }]);

      const output = await privateOutputFixture(storage, original.id);
      const completed = await engine.applyProviderResult('owner', original.id, {
        status: 'succeeded',
        billedCostMicros: 40,
        outputs: [output],
      });
      expect(completed).toMatchObject({
        status: 'succeeded',
        settledMicros: 40,
        attemptCount: 1,
        upstreamId: null,
      });
      const settledBalance = { availableMicros: 4_999_960, reservedMicros: 0, currency: 'USD' };
      expect(await engine.getBalance('owner')).toEqual(settledBalance);
      expect(await engine.recoverDeliveryOnce()).toBe(true);
      const delivered = await engine.getJob('owner', original.id);
      expect(delivered).toMatchObject({ status: 'succeeded', deliveryStatus: 'available' });
      expect(delivered?.outputs).toHaveLength(1);
      expect(delivered?.outputs[0]?.sha256).toBe(output.sha256);

      // The newer worker first returns unknown, then the original worker returns
      // running. Neither stale observation can reopen a completed generation.
      responses[1]!.resolve();
      await reclaimedPoll;
      responses[0]!.resolve();
      await oldPoll;
      await engine.applyProviderResult('owner', original.id, {
        status: 'succeeded',
        billedCostMicros: 40,
      });
      expect(await engine.workOnce()).toBe(false);
      expect(await engine.getJob('owner', original.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: 40,
        attemptCount: 1,
      });
      expect(await engine.getBalance('owner')).toEqual(settledBalance);
      expect(submissions).toBe(1);
      expect(polls).toEqual(['fixture-original-task', 'fixture-original-task']);
      expect(
        (
          await engine.pool.query('SELECT upstream_id,attempt_count FROM mr_jobs WHERE id=$1', [
            original.id,
          ])
        ).rows,
      ).toEqual([{ upstream_id: 'fixture-original-task', attempt_count: 1 }]);
      expect(
        (
          await engine.pool.query(
            'SELECT state,release_evidence FROM mr_dispatch_slots WHERE job_id=$1',
            [original.id],
          )
        ).rows,
      ).toEqual([{ state: 'released', release_evidence: 'confirmed_terminal' }]);
      expect(
        Object.fromEntries(
          (
            await engine.pool.query(
              'SELECT kind,count(*)::integer AS n FROM mr_ledger WHERE job_id=$1 GROUP BY kind',
              [original.id],
            )
          ).rows.map((row) => [row.kind, row.n]),
        ),
      ).toEqual({ reserve: 1, settle: 1, release: 1 });
      expect(
        (
          await engine.pool.query(
            'SELECT type,count(*)::integer AS n FROM mr_events WHERE workspace_id=$1 GROUP BY type ORDER BY type',
            ['owner'],
          )
        ).rows,
      ).toEqual([
        { type: 'billing.settled', n: 1 },
        { type: 'generation.completed', n: 1 },
      ]);
    } finally {
      for (const response of responses) response.resolve();
      await Promise.allSettled(pending);
      await engine.close();
      await isolated.close();
    }
  });
});
