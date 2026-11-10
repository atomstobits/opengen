import { describe, expect, it } from 'vitest';
import { creditWorkspaceInTransaction } from '../packages/engine/src/index.js';
import { billingFixture } from './billing-fixture.js';

const db = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!db)('worker-driven automatic recharge fixtures', () => {
  it('defaults disabled and makes repeated wallet/policy/status reads side-effect free', async () => {
    const f = await billingFixture({ enabled: false });
    try {
      expect(await f.recharge.admit(f.workspace)).toBeNull();
      await f.recharge.workOnce(f.transport);
      for (let i = 0; i < 3; i++) {
        await f.recharge.list(f.workspace);
        await f.store.listOrders(f.workspace);
      }
      expect(f.creates).toHaveLength(0);
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_billing_recharge_attempts')).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('admits one inflight attempt with original funding month; all concurrent triggers reuse it', async () => {
    const f = await billingFixture();
    try {
      const attempts = await Promise.all(
        Array.from({ length: 5 }, () => f.recharge.admit(f.workspace)),
      );
      expect(new Set(attempts.map((a) => a!.id)).size).toBe(1);
      const attempt = attempts[0]!;
      expect(attempt.admissionMonth).toBe('2030-01-01');
      await f.recharge.dispatch(attempt.id, f.transport);
      await f.recharge.dispatch(attempt.id, f.transport);
      expect(f.creates).toHaveLength(1);
      expect(f.retrieves).toHaveLength(0);
      expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe('processing');
    } finally {
      await f.close();
    }
  });
  it('retains uncertainty/exposure and retries the original object/key across process and month boundaries', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      const timeout = {
        ...f.transport,
        async createRecharge(input: Parameters<typeof f.transport.createRecharge>[0]) {
          await f.transport.createRecharge(input);
          throw new Error('lost response');
        },
      };
      await expect(f.recharge.dispatch(attempt.id, timeout)).rejects.toMatchObject({
        code: 'recharge_uncertain',
      });
      await f.recharge.dispatch(attempt.id, timeout);
      expect(f.creates).toHaveLength(1);
      f.advance(60000);
      await f.recharge.dispatch(attempt.id, f.transport);
      expect(f.creates).toHaveLength(2);
      expect(f.creates[0]).toEqual(f.creates[1]);
      f.setNow('2030-02-01T00:00:00.000Z');
      expect((await f.recharge.admit(f.workspace))!.id).toBe(attempt.id);
      const paid = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`);
      await f.recharge.reconcile(f.event(paid), f.transport);
      expect((await f.recharge.get(f.workspace, attempt.id)).admissionMonth).toBe('2030-01-01');
      expect(
        (
          await f.pool.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].available_micros,
      ).toBe('10000000');
    } finally {
      await f.close();
    }
  });
  it('credits exactly once atomically after a verified paid event, including duplicate/out-of-order events', async () => {
    let crash = true;
    const f = await billingFixture({
      credit: async (...args) => {
        await creditWorkspaceInTransaction(...args);
        if (crash) throw new Error('fixture crash');
      },
    });
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      await f.recharge.dispatch(attempt.id, f.transport);
      const payment = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`),
        event = f.event(payment);
      await expect(f.recharge.reconcile(event, f.transport)).rejects.toThrow('fixture crash');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
      crash = false;
      await Promise.all([
        f.recharge.reconcile(event, f.transport),
        f.recharge.reconcile(event, f.transport),
        f.recharge.reconcile(f.event(payment), f.transport),
      ]);
      await f.recharge.reconcile(
        f.event(
          { ...payment, status: 'processing', amount_received: 0 },
          'payment_intent.processing',
        ),
        f.transport,
      );
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('1');
      expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe('succeeded');
      expect((await f.pool.query('SELECT count(*) FROM mr_key_months')).rows[0].count).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('revalidates disable/mandate/manual funding before dispatch without orphaning accepted money', async () => {
    const f = await billingFixture();
    try {
      const first = (await f.recharge.admit(f.workspace))!;
      await f.pool.query('UPDATE mr_workspaces SET available_micros=5000000 WHERE id=$1', [
        f.workspace,
      ]);
      expect((await f.recharge.dispatch(first.id, f.transport))!.status).toBe('cancelled');
      expect(f.creates).toHaveLength(0);
      await f.pool.query('UPDATE mr_workspaces SET available_micros=0 WHERE id=$1', [f.workspace]);
      f.advance(60000);
      const accepted = (await f.recharge.admit(f.workspace))!;
      await f.recharge.dispatch(accepted.id, f.transport);
      await f.pool.query(
        'UPDATE mr_billing_policies SET enabled=false,version=version+1 WHERE workspace_id=$1',
        [f.workspace],
      );
      const paid = await f.paid(`pi_fixture_${accepted.id.replaceAll('-', '')}`);
      await f.recharge.reconcile(f.event(paid), f.transport);
      expect((await f.recharge.get(f.workspace, accepted.id)).status).toBe('succeeded');
      expect(await f.recharge.admit(f.workspace)).toBeNull();
    } finally {
      await f.close();
    }
  });
  it('stops uncertain resubmission after disable and after retention window; never rotates identity', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      const transport = {
        ...f.transport,
        async createRecharge(input: Parameters<typeof f.transport.createRecharge>[0]) {
          await f.transport.createRecharge(input);
          throw new Error('timeout');
        },
      };
      await expect(f.recharge.dispatch(attempt.id, transport)).rejects.toThrow();
      await f.pool.query('UPDATE mr_billing_policies SET enabled=false WHERE workspace_id=$1', [
        f.workspace,
      ]);
      f.advance(60000);
      expect((await f.recharge.dispatch(attempt.id, transport))!.status).toBe('review');
      expect(f.creates).toHaveLength(1);
      expect(await f.recharge.admit(f.workspace)).toBeNull();
    } finally {
      await f.close();
    }
  });
  it('holds authentication-required attempts and never admits another while recovery is needed', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      const transport = {
        ...f.transport,
        async createRecharge(input: Parameters<typeof f.transport.createRecharge>[0]) {
          return { ...(await f.transport.createRecharge(input)), status: 'requires_action' };
        },
      };
      expect((await f.recharge.dispatch(attempt.id, transport))!.status).toBe(
        'requires_authentication',
      );
      f.advance(3600000);
      expect((await f.recharge.admit(f.workspace))!.id).toBe(attempt.id);
      await f.recharge.dispatch(attempt.id, transport);
      expect(f.creates).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('keeps declined attempts in monthly funding limits and stops after failure threshold', async () => {
    const f = await billingFixture();
    try {
      const transport = {
        ...f.transport,
        async createRecharge(input: Parameters<typeof f.transport.createRecharge>[0]) {
          return {
            ...(await f.transport.createRecharge(input)),
            status: 'requires_payment_method',
          };
        },
      };
      for (let i = 0; i < 2; i++) {
        const attempt = (await f.recharge.admit(f.workspace))!;
        await f.recharge.dispatch(attempt.id, transport);
        f.advance(60000);
      }
      expect(await f.recharge.admit(f.workspace)).toBeNull();
      expect(f.creates).toHaveLength(2);
      expect(
        (
          await f.pool.query(
            'SELECT sum(amount_cents)::text AS total FROM mr_billing_recharge_attempts',
          )
        ).rows[0].total,
      ).toBe('2000');
    } finally {
      await f.close();
    }
  });
  it('rejects wrong customer/method/currency/amount/environment and cross-workspace status', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      await f.recharge.dispatch(attempt.id, f.transport);
      await expect(f.recharge.get('foreign', attempt.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      const paid = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`);
      for (const patch of [
        { customer: 'cus_foreign' },
        { payment_method: 'pm_foreign' },
        { currency: 'eur' },
        { amount: 999 },
        { livemode: true },
      ])
        await expect(
          f.recharge.reconcile(f.event({ ...paid, ...patch }), f.transport),
        ).rejects.toMatchObject({ code: 'payment_mismatch' });
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
});
