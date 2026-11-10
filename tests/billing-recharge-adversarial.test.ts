import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { billingFixture } from './billing-fixture.js';

const database = Boolean(process.env.TEST_DATABASE_URL);
const operator = { kind: 'fixture-operator', id: 'reconciliation-fixture' };
const authorize = async () => {}; // Trusted fixture boundary; real routes inject operator revalidation.
const evidence = (patch: Record<string, unknown> = {}) => ({
  action: 'bind' as const,
  reference: randomUUID(),
  note: 'Synthetic authoritative evidence.',
  evidenceUrl: 'https://fixture.example/evidence',
  ...patch,
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!database)('automatic funding adversarial reconciliation', () => {
  it('journals risk before original response binding and installs a durable hold before paid credit', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      const riskId = `evt_${randomUUID()}`;
      const transport = {
        ...f.transport,
        async createRecharge(request: Parameters<typeof f.transport.createRecharge>[0]) {
          const payment = await f.transport.createRecharge(request);
          expect(
            await f.recharge.reconcileRisk({
              id: riskId,
              type: 'charge.dispute.created',
              processorEnvironment: f.processorEnvironment,
              livemode: false,
              data: { object: { id: 'dp_fixture_before_binding', payment_intent: payment.id } },
            }),
          ).toBe(false);
          expect(
            (
              await f.pool.query(
                'SELECT state,payment_intent_id FROM mr_payment_events WHERE id=$1',
                [riskId],
              )
            ).rows[0],
          ).toEqual({ state: 'pending', payment_intent_id: payment.id });
          return payment;
        },
      };
      await f.recharge.dispatch(attempt.id, transport);
      expect(
        (
          await f.pool.query(
            'SELECT recharge_attempt_id,order_id,resolved_at FROM mr_billing_holds WHERE event_id=$1',
            [riskId],
          )
        ).rows[0],
      ).toEqual({ recharge_attempt_id: attempt.id, order_id: null, resolved_at: null });
      const paid = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`);
      await f.recharge.reconcile(f.event(paid), f.transport);
      expect(
        (await f.pool.query('SELECT state FROM mr_payment_events WHERE id=$1', [riskId])).rows[0]
          .state,
      ).toBe('processed');
      expect(
        (
          await f.pool.query('SELECT count(*) FROM mr_ledger WHERE reference=$1', [
            `stripe-recharge:${attempt.id}`,
          ])
        ).rows[0].count,
      ).toBe('1');
      expect(await f.recharge.admit(f.workspace)).toBeNull();
    } finally {
      await f.close();
    }
  });
  it('rejects an operator unpaid resolution while the original POST remains in flight', async () => {
    const f = await billingFixture();
    const entered = gate(),
      release = gate();
    let dispatch: Promise<unknown> | undefined;
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      const transport = {
        ...f.transport,
        async createRecharge(request: Parameters<typeof f.transport.createRecharge>[0]) {
          const payment = await f.transport.createRecharge(request);
          entered.resolve();
          await release.promise;
          return payment;
        },
      };
      dispatch = f.recharge.dispatch(attempt.id, transport);
      void dispatch.catch(() => {});
      await entered.promise;
      await expect(
        f.recharge.resolve(
          f.workspace,
          attempt.id,
          { ...evidence(), action: 'confirmed-unpaid' },
          operator,
          authorize,
          f.transport,
        ),
      ).rejects.toMatchObject({ code: 'request_in_progress', statusCode: 409 });
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_billing_recharge_resolutions')).rows[0].count,
      ).toBe('0');
      expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe('submitting');
      release.resolve();
      await dispatch;
      expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe('processing');
    } finally {
      release.resolve();
      await Promise.allSettled(dispatch ? [dispatch] : []);
      await f.close();
    }
  });
  it('rejects reuse of an existing payment identity and conflicting evidence under a stable resolution reference', async () => {
    const f = await billingFixture();
    try {
      const first = (await f.recharge.admit(f.workspace))!;
      const decline = {
        ...f.transport,
        async createRecharge(request: Parameters<typeof f.transport.createRecharge>[0]) {
          const payment = await f.transport.createRecharge(request);
          f.payments.set(payment.id, { ...payment, status: 'requires_payment_method' });
          return { ...payment, status: 'requires_payment_method' };
        },
      };
      await f.recharge.dispatch(first.id, decline);
      f.advance(60000);
      const second = (await f.recharge.admit(f.workspace))!;
      const timeout = {
        ...f.transport,
        async createRecharge(request: Parameters<typeof f.transport.createRecharge>[0]) {
          await f.transport.createRecharge(request);
          throw new Error('Original response lost');
        },
      };
      await expect(f.recharge.dispatch(second.id, timeout)).rejects.toMatchObject({
        code: 'recharge_uncertain',
      });
      f.advance(60000);
      const firstPI = `pi_fixture_${first.id.replaceAll('-', '')}`,
        secondPI = `pi_fixture_${second.id.replaceAll('-', '')}`;
      await expect(
        f.recharge.resolve(
          f.workspace,
          second.id,
          { ...evidence(), paymentIntentId: firstPI },
          operator,
          authorize,
          f.transport,
        ),
      ).rejects.toThrow();
      expect(
        (
          await f.pool.query(
            'SELECT payment_intent_id FROM mr_billing_recharge_attempts WHERE id=$1',
            [second.id],
          )
        ).rows[0].payment_intent_id,
      ).toBeNull();
      const requested = { ...evidence(), paymentIntentId: secondPI };
      await f.recharge.resolve(f.workspace, second.id, requested, operator, authorize, f.transport);
      await expect(
        f.recharge.resolve(
          f.workspace,
          second.id,
          { ...requested, note: 'Different evidence under the same stable reference.' },
          operator,
          authorize,
          f.transport,
        ),
      ).rejects.toMatchObject({ code: 'resolution_conflict', statusCode: 409 });
      expect(
        (
          await f.pool.query(
            'SELECT payment_intent_id FROM mr_billing_recharge_resolutions WHERE attempt_id=$1',
            [second.id],
          )
        ).rows,
      ).toEqual([{ payment_intent_id: secondPI }]);
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('requires authoritative cancellation for an already-bound processing payment before unpaid resolution', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      await f.recharge.dispatch(attempt.id, f.transport);
      f.advance(60000);
      const requested = { ...evidence(), action: 'confirmed-unpaid' as const };
      await expect(
        f.recharge.resolve(f.workspace, attempt.id, requested, operator, authorize, f.transport),
      ).rejects.toMatchObject({ code: 'payment_not_unpaid', statusCode: 409 });
      const id = `pi_fixture_${attempt.id.replaceAll('-', '')}`;
      f.payments.set(id, { ...f.payments.get(id)!, status: 'canceled' });
      expect(
        await f.recharge.resolve(
          f.workspace,
          attempt.id,
          requested,
          operator,
          authorize,
          f.transport,
        ),
      ).toMatchObject({ status: 'cancelled' });
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('cancels a queued dispatch when current owner approval or a reduced versioned amount/cap is no longer valid', async () => {
    for (const change of ['owner-revoked', 'reduced-policy'] as const) {
      const f = await billingFixture();
      try {
        const attempt = (await f.recharge.admit(f.workspace))!;
        if (change === 'owner-revoked')
          await f.pool.query(
            'UPDATE mr_billing_owners SET revoked_at=clock_timestamp() WHERE workspace_id=$1',
            [f.workspace],
          );
        else
          await f.pool.query(
            'UPDATE mr_billing_policies SET amount_cents=500,monthly_cap_cents=500,version=version+1 WHERE workspace_id=$1',
            [f.workspace],
          );
        expect(await f.recharge.dispatch(attempt.id, f.transport)).toMatchObject({
          status: 'cancelled',
        });
        expect(f.creates).toHaveLength(0);
        expect(
          (
            await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
              f.workspace,
            ])
          ).rows[0].payment_checkout_count,
        ).toBe(0);
        expect((await f.recharge.get(f.workspace, attempt.id)).amountCents).toBe(1000);
      } finally {
        await f.close();
      }
    }
  });
  it('keeps external quotas and identity after timeouts, retries and authoritative paid webhook credit', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      const timeout = {
        ...f.transport,
        async createRecharge(request: Parameters<typeof f.transport.createRecharge>[0]) {
          await f.transport.createRecharge(request);
          throw new Error('Response lost after acceptance');
        },
      };
      await expect(f.recharge.dispatch(attempt.id, timeout)).rejects.toMatchObject({
        code: 'recharge_uncertain',
      });
      const counters = async () => ({
        workspace: (
          await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].payment_checkout_count,
        installation: (
          await f.pool.query('SELECT payment_checkout_count FROM mr_payment_rate_limits')
        ).rows[0].payment_checkout_count,
      });
      expect(await counters()).toEqual({ workspace: 1, installation: 1 });
      await f.recharge.dispatch(attempt.id, timeout);
      expect(await counters()).toEqual({ workspace: 1, installation: 1 });
      expect(f.creates).toHaveLength(1);
      f.advance(60000);
      await f.recharge.dispatch(attempt.id, f.transport);
      expect(f.creates).toHaveLength(2);
      expect(f.creates[0]).toEqual(f.creates[1]);
      expect(await counters()).toEqual({ workspace: 2, installation: 2 });
      const paid = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`);
      const paidEvent = f.event(paid);
      await f.recharge.reconcile(paidEvent, f.transport);
      expect(await counters()).toEqual({ workspace: 3, installation: 3 });
      await f.recharge.reconcile(paidEvent, f.transport);
      expect(await counters()).toEqual({ workspace: 3, installation: 3 });
      expect((await f.recharge.get(f.workspace, attempt.id)).admissionMonth).toBe('2030-01-01');
      expect((await f.pool.query('SELECT count(*) FROM mr_key_months')).rows[0].count).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('still reconciles one accepted payment after funding-owner revocation without admitting new exposure', async () => {
    const f = await billingFixture();
    try {
      const attempt = (await f.recharge.admit(f.workspace))!;
      await f.recharge.dispatch(attempt.id, f.transport);
      await f.pool.query(
        'UPDATE mr_billing_owners SET revoked_at=clock_timestamp() WHERE workspace_id=$1',
        [f.workspace],
      );
      const paid = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`);
      const event = f.event(paid);
      await f.recharge.reconcile(event, f.transport);
      await f.recharge.reconcile(event, f.transport);
      expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe('succeeded');
      expect(
        (
          await f.pool.query('SELECT count(*) FROM mr_ledger WHERE reference=$1', [
            `stripe-recharge:${attempt.id}`,
          ])
        ).rows[0].count,
      ).toBe('1');
      expect(await f.recharge.admit(f.workspace)).toBeNull();
    } finally {
      await f.close();
    }
  });
});
