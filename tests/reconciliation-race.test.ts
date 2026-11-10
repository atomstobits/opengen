import { privateStorageFixture } from './helpers/private-storage';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEngine } from '@media-router/engine';
import type { GenerateInput } from '@media-router/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  operation: 'text-to-video',
  input: { resolution: '720p', duration: 5, prompt: 'A synthetic reconciliation fixture.' },
};
const evidence = {
  action: 'reject' as const,
  reference: 'verified-rejection-evidence',
  note: 'Synthetic operator evidence for the reconciliation race regression.',
  evidenceUrl: 'https://provider.example/fixture-audit',
};

describe.skipIf(!databaseUrl)('reconciliation races preserve accepted work and money', () => {
  async function fixture(expire: boolean) {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'reconciliation_race');
    let entered!: () => void;
    let release!: () => void;
    const submitting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submissions = 0;
    let polls = 0;
    const engine = isolated.bind(
      createEngine({
        storage: privateStorageFixture(),
        databaseUrl: isolated.databaseUrl,
        adapters: [
          {
            id: 'alibaba',
            isConfigured: (route) => route.id === input.routeId,
            submit: async () => {
              submissions++;
              entered();
              await response;
              if (expire) return { upstreamId: 'accepted-during-race' };
              throw new Error('Synthetic provider response lost after intent.');
            },
            poll: async () => {
              polls++;
              throw new Error('This fixture must not poll a provider.');
            },
          },
        ],
      }),
    );
    let work: Promise<boolean> | undefined;
    const close = async () => {
      release();
      await work?.catch(() => {});
      await engine.close();
      await isolated.close();
    };
    try {
      await engine.initialize();
      const workspaceId = `reconcile-${randomUUID()}`;
      await engine.ensureWorkspace(workspaceId, 5_000_000);
      const job = await engine.submit({
        workspaceId,
        idempotencyKey: 'original-accepted-request',
        input,
      });
      work = engine.workOnce();
      await Promise.race([
        submitting,
        work.then(() => {
          throw new Error('Worker never reached the fixture provider.');
        }),
      ]);
      expect(
        (await engine.pool.query('SELECT state FROM mr_attempts WHERE job_id=$1', [job.id])).rows,
      ).toEqual([{ state: 'submitting' }]);
      expect(
        (await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [job.id]))
          .rows,
      ).toEqual([{ state: 'occupied' }]);
      if (expire) {
        await engine.pool.query(
          "UPDATE mr_jobs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",
          [job.id],
        );
        await engine.workOnce();
        expect((await engine.getJob(workspaceId, job.id))?.status).toBe('submission-unknown');
        expect(
          (await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [job.id]))
            .rows,
        ).toEqual([{ state: 'unknown' }]);
      }
      return {
        engine,
        workspaceId,
        job,
        close,
        counts: () => ({ submissions, polls }),
        finish: async () => {
          release();
          await work;
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  it('rechecks rejection eligibility under lock after a worker records upstream acceptance', async () => {
    const f = await fixture(true);
    const { engine, workspaceId, job } = f;
    const apply = engine.applyProviderResult.bind(engine);
    try {
      const before = await engine.getBalance(workspaceId);
      engine.applyProviderResult = async (...args) => {
        // Reconcile's pre-read was unknown. The original worker receives its
        // delayed acceptance before the evidence transaction obtains its lock.
        await f.finish();
        return apply(...args);
      };
      await expect(engine.reconcile(workspaceId, job.id, evidence)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await engine.getJob(workspaceId, job.id)).toMatchObject({
        status: 'running',
        upstreamId: null,
        settledMicros: null,
        attemptCount: 1,
      });
      expect(
        (
          await engine.pool.query(
            'SELECT upstream_id FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
            [workspaceId, job.id],
          )
        ).rows[0].upstream_id,
      ).toBe('accepted-during-race');
      expect(await engine.getBalance(workspaceId)).toEqual(before);
      expect(await engine.reconciliations(workspaceId, job.id)).toEqual([]);
      expect(f.counts()).toEqual({ submissions: 1, polls: 0 });
      expect(
        (await engine.ledger(workspaceId)).filter((row) => row.kind === 'settle'),
      ).toHaveLength(0);
    } finally {
      engine.applyProviderResult = apply;
      await f.close();
    }
  });
  it('never treats an active submitting lease as confirmed nonacceptance', async () => {
    const f = await fixture(false);
    const { engine, workspaceId, job } = f;
    try {
      const before = await engine.getBalance(workspaceId);
      expect((await engine.getJob(workspaceId, job.id))?.status).toBe('submitting');
      await expect(engine.reconcile(workspaceId, job.id, evidence)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await engine.getBalance(workspaceId)).toEqual(before);
      expect(await engine.reconciliations(workspaceId, job.id)).toEqual([]);
      await f.finish();
      expect(await engine.getJob(workspaceId, job.id)).toMatchObject({
        status: 'submission-unknown',
        attemptCount: 1,
        settledMicros: null,
      });
      expect(await engine.getBalance(workspaceId)).toEqual(before);
      expect(f.counts()).toEqual({ submissions: 1, polls: 0 });
      expect(
        (await engine.ledger(workspaceId)).filter((row) => row.kind === 'settle'),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
