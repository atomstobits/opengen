import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyBudgetStore, utcAdmissionMonth } from '../packages/engine/src/key-budgets.js';
import { governanceFixture } from './governance-fixture.js';

it('uses UTC rather than local month at offset boundaries', () => {
  expect(utcAdmissionMonth(new Date('2026-02-28T23:30:00-02:00'))).toBe('2026-03-01');
  expect(utcAdmissionMonth(new Date('2026-03-01T00:30:00+02:00'))).toBe('2026-02-01');
});
const sql = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!sql)('managed stable-key monthly exposure', () => {
  it('reserves once; late settlement stays in admission month; credits do not restore quota', async () => {
    const f = await governanceFixture();
    let now = new Date('2026-01-31T23:59:59Z');
    const store = new KeyBudgetStore(() => now);
    try {
      await f.tx((c) => store.setCapInTransaction(c, f.workspaceId, f.key.id, 100));
      const id = await f.tx(async (c) => {
        const id = await f.job(c, 80);
        await store.reserveInTransaction(c, {
          workspaceId: f.workspaceId,
          jobId: id,
          keyId: f.key.id,
          billing: 'managed',
          reservedMicros: 80,
        });
        return id;
      });
      now = new Date('2026-02-01T00:00:01Z');
      const replay = await f.tx((c) =>
        store.reserveInTransaction(c, {
          workspaceId: f.workspaceId,
          jobId: id,
          keyId: f.key.id,
          billing: 'managed',
          reservedMicros: 80,
        }),
      );
      expect(replay?.admissionMonth).toBe('2026-01-01');
      await f.tx((c) => store.settleInTransaction(c, f.workspaceId, id, 70));
      await f.tx((c) => store.settleInTransaction(c, f.workspaceId, id, 70));
      await expect(
        f.tx((c) => store.settleInTransaction(c, f.workspaceId, id, 60)),
      ).rejects.toMatchObject({ code: 'budget_settlement_conflict' });
      await f.pool.query(
        'UPDATE mr_workspaces SET available_micros=available_micros+1000 WHERE id=$1',
        [f.workspaceId],
      );
      const bucket = (
        await f.pool.query(
          'SELECT gross_debit_micros,held_micros FROM mr_key_months WHERE key_id=$1',
          [f.key.id],
        )
      ).rows[0];
      expect(bucket).toEqual({ gross_debit_micros: '70', held_micros: '0' });
      const feb = await f.tx(async (c) => {
        const jobId = await f.job(c, 100);
        return store.reserveInTransaction(c, {
          workspaceId: f.workspaceId,
          jobId,
          keyId: f.key.id,
          billing: 'managed',
          reservedMicros: 100,
        });
      });
      expect(feb?.admissionMonth).toBe('2026-02-01');
      expect((await f.pool.query('SELECT count(*) FROM mr_key_reservations')).rows[0].count).toBe(
        '2',
      );
    } finally {
      await f.close();
    }
  });
  it('holds unknown costs, fails new reserve after cap lowering, and never counts BYOK external charges', async () => {
    const f = await governanceFixture();
    const store = new KeyBudgetStore(() => new Date('2026-02-01T00:00:00Z'));
    try {
      const reserve = (amount: number, billing: 'managed' | 'byok' = 'managed') =>
        f.tx(async (c) => {
          const jobId = await f.job(c, amount);
          const r = await store.reserveInTransaction(c, {
            workspaceId: f.workspaceId,
            jobId,
            keyId: f.key.id,
            billing,
            reservedMicros: amount,
          });
          await c.query(
            'UPDATE mr_workspaces SET available_micros=available_micros-$2,reserved_micros=reserved_micros+$2 WHERE id=$1',
            [f.workspaceId, billing === 'byok' ? 0 : amount],
          );
          return r;
        });
      await reserve(80); // track even when no cap yet
      await f.tx((c) => store.setCapInTransaction(c, f.workspaceId, f.key.id, 70));
      await expect(reserve(1)).rejects.toMatchObject({ code: 'key_monthly_cap_exceeded' });
      expect(await reserve(10000, 'byok')).toBeNull();
      expect(
        (await f.pool.query('SELECT held_micros FROM mr_key_months')).rows[0].held_micros,
      ).toBe('80');
      expect(
        (
          await f.pool.query(
            'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1',
            [f.workspaceId],
          )
        ).rows[0],
      ).toEqual({ available_micros: '920', reserved_micros: '80' });
      expect((await f.pool.query('SELECT count(*) FROM mr_jobs')).rows[0].count).toBe('2'); // rejected job rolled back
    } finally {
      await f.close();
    }
  });
  it('keeps tenant ownership and legacy coverage explicit', async () => {
    const f = await governanceFixture();
    const store = new KeyBudgetStore(() => new Date('2024-12-31T23:59:59Z'));
    try {
      await expect(
        f.tx(async (c) => {
          const jobId = await f.job(c, 1);
          return store.reserveInTransaction(c, {
            workspaceId: f.workspaceId,
            jobId,
            keyId: f.key.id,
            billing: 'managed',
            reservedMicros: 1,
          });
        }),
      ).rejects.toMatchObject({ code: 'budget_coverage_unknown' });
      expect(
        await f.tx((c) => store.settleInTransaction(c, f.workspaceId, randomUUID(), 0)),
      ).toBeNull();
      await expect(
        f.tx((c) => store.setCapInTransaction(c, 'foreign', f.key.id, 1)),
      ).rejects.toMatchObject({ code: 'workspace_not_found' });
      const other = `ws_${randomUUID()}`;
      await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,100)', [other]);
      await expect(
        f.tx((c) => store.setCapInTransaction(c, other, f.key.id, 1)),
      ).rejects.toMatchObject({ code: 'key_unavailable' });
      expect((await f.pool.query('SELECT count(*) FROM mr_key_months')).rows[0].count).toBe('0');
    } finally {
      await f.close();
    }
  });
});

describe.skipIf(!sql || process.env.TEST_NATIVE_POSTGRES !== '1')(
  'native PostgreSQL key admission races',
  () => {
    it('reads a concurrently lowered cap after the workspace lock and rolls back new job money', async () => {
      const f = await governanceFixture(3);
      const store = new KeyBudgetStore();
      const lowering = await f.pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await f.tx((c) => store.setCapInTransaction(c, f.workspaceId, f.key.id, 100));
        await lowering.query('BEGIN');
        await store.setCapInTransaction(lowering, f.workspaceId, f.key.id, 10);
        pending = f.tx(async (c) => {
          const jobId = await f.job(c, 70);
          return store.reserveInTransaction(c, {
            workspaceId: f.workspaceId,
            jobId,
            keyId: f.key.id,
            billing: 'managed',
            reservedMicros: 70,
          });
        });
        const denied = expect(pending).rejects.toMatchObject({ code: 'key_monthly_cap_exceeded' });
        await lowering.query('COMMIT');
        await denied;
        expect((await f.pool.query('SELECT count(*) FROM mr_jobs')).rows[0].count).toBe('0');
        expect((await f.pool.query('SELECT count(*) FROM mr_key_reservations')).rows[0].count).toBe(
          '0',
        );
      } finally {
        await lowering.query('ROLLBACK');
        lowering.release();
        await Promise.allSettled([pending]);
        await f.close();
      }
    });
    it('atomically admits only one concurrent key/workspace reserve and settles once', async () => {
      const f = await governanceFixture(6);
      const store = new KeyBudgetStore();
      try {
        await f.tx((c) => store.setCapInTransaction(c, f.workspaceId, f.key.id, 100));
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            f.tx(async (c) => {
              const jobId = await f.job(c, 70);
              await store.reserveInTransaction(c, {
                workspaceId: f.workspaceId,
                jobId,
                keyId: f.key.id,
                billing: 'managed',
                reservedMicros: 70,
              });
              await c.query(
                'UPDATE mr_workspaces SET available_micros=available_micros-70,reserved_micros=reserved_micros+70 WHERE id=$1',
                [f.workspaceId],
              );
              return jobId;
            }),
          ),
        );
        const winners = results.filter(
          (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
        );
        expect(winners).toHaveLength(1);
        for (const result of results)
          if (result.status === 'rejected')
            expect(result.reason.code).toBe('key_monthly_cap_exceeded');
        await Promise.all(
          Array.from({ length: 6 }, () =>
            f.tx((c) => store.settleInTransaction(c, f.workspaceId, winners[0]!.value, 50)),
          ),
        );
        expect(
          (await f.pool.query('SELECT gross_debit_micros,held_micros FROM mr_key_months')).rows[0],
        ).toEqual({ gross_debit_micros: '50', held_micros: '0' });
        expect((await f.pool.query('SELECT count(*) FROM mr_jobs')).rows[0].count).toBe('1');
      } finally {
        await f.close();
      }
    });
  },
);
