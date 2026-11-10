import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { RechargeStore } from '../packages/engine/src/billing-recharge.js';
import { creditWorkspaceInTransaction } from '../packages/engine/src/index.js';
import { billingFixture } from './billing-fixture.js';

const native = process.env.TEST_NATIVE_POSTGRES === '1' && Boolean(process.env.TEST_DATABASE_URL);
function secondWorker(f: Awaited<ReturnType<typeof billingFixture>>) {
  return new RechargeStore(f.pool, {
    processorEnvironment: f.processorEnvironment,
    automaticChargesEnabled: true,
    creditInTransaction: creditWorkspaceInTransaction,
    now: f.now,
    lockExternalInTransaction: (client) => f.store.lockExternalInTransaction(client),
    admitExternalInTransaction: (client, workspace) =>
      f.store.admitExternalInTransaction(client, workspace),
  });
}
async function waitForBlocker(pool: Pool, pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const blocked = (
      await pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1',
        [pid],
      )
    ).rowCount;
    if (blocked) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Expected a native workspace-row lock wait.');
}

describe.skipIf(!native)('native PostgreSQL automatic funding races', () => {
  it('two independent workers admit/dispatch the same low balance with one external create', async () => {
    const f = await billingFixture({ max: 6 });
    const other = secondWorker(f);
    try {
      const admitted = await Promise.all([
        f.recharge.admit(f.workspace),
        other.admit(f.workspace),
        f.recharge.admit(f.workspace),
        other.admit(f.workspace),
      ]);
      expect(new Set(admitted.map((row) => row!.id)).size).toBe(1);
      const id = admitted[0]!.id;
      await Promise.all([
        f.recharge.dispatch(id, f.transport),
        other.dispatch(id, f.transport),
        f.recharge.dispatch(id, f.transport),
        other.dispatch(id, f.transport),
      ]);
      expect(f.creates).toHaveLength(1);
      expect(f.retrieves).toHaveLength(0);
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_billing_recharge_attempts')).rows[0].count,
      ).toBe('1');
      expect(
        (
          await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].payment_checkout_count,
      ).toBe(1);
      expect((await f.recharge.get(f.workspace, id)).status).toBe('processing');
    } finally {
      await f.close();
    }
  });
  it('queued dispatch waits for committed manual funding or a reduced versioned policy and cancels safely', async () => {
    for (const change of ['manual-credit', 'reduced-cap'] as const) {
      const f = await billingFixture({ max: 4 });
      const blocker = await f.pool.connect();
      let dispatch: Promise<unknown> | undefined;
      try {
        const attempt = (await f.recharge.admit(f.workspace))!;
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [f.workspace]);
        dispatch = f.recharge.dispatch(attempt.id, f.transport);
        void dispatch.catch(() => {});
        await waitForBlocker(f.pool, pid);
        if (change === 'manual-credit')
          await creditWorkspaceInTransaction(blocker, f.workspace, 5000000, 'native-manual-credit');
        else
          await blocker.query(
            'UPDATE mr_billing_policies SET amount_cents=500,monthly_cap_cents=500,version=version+1 WHERE workspace_id=$1',
            [f.workspace],
          );
        await blocker.query('COMMIT');
        expect(await dispatch).toMatchObject({ status: 'cancelled' });
        expect(f.creates).toHaveLength(0);
        expect(
          (
            await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
              f.workspace,
            ])
          ).rows[0].payment_checkout_count,
        ).toBe(0);
        expect((await f.recharge.get(f.workspace, attempt.id)).creditedAt).toBeNull();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(dispatch ? [dispatch] : []);
        await f.close();
      }
    }
  });
  it('same/distinct concurrent authoritative paid events commit exactly one shared-ledger credit', async () => {
    const f = await billingFixture({ max: 6 });
    const other = secondWorker(f);
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      await f.recharge.dispatch(attempt.id, f.transport);
      const payment = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`),
        event = f.event(payment);
      await Promise.all([
        f.recharge.reconcile(event, f.transport),
        other.reconcile(event, f.transport),
        f.recharge.reconcile(f.event(payment), f.transport),
        other.reconcile(f.event(payment), f.transport),
      ]);
      expect(
        (
          await f.pool.query('SELECT count(*) FROM mr_ledger WHERE reference=$1', [
            `stripe-recharge:${attempt.id}`,
          ])
        ).rows[0].count,
      ).toBe('1');
      expect(
        (
          await f.pool.query(
            'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1',
            [f.workspace],
          )
        ).rows[0],
      ).toMatchObject({ available_micros: '10000000', reserved_micros: '0' });
      expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe('succeeded');
      expect((await f.pool.query('SELECT count(*) FROM mr_key_months')).rows[0].count).toBe('0');
    } finally {
      await f.close();
    }
  });
});
