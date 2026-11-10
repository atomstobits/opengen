import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBillingWebhookDispatcher } from '../apps/server/src/billing-webhook.js';
import { RechargeStore } from '../packages/engine/src/billing-recharge.js';
import { creditWorkspaceInTransaction } from '../packages/engine/src/index.js';
import { BillingOperationsStore } from '../packages/engine/src/billing-operations.js';
import type { VerifiedPaymentEvent } from '../packages/engine/src/payments.js';
import { billingFixture } from './billing-fixture.js';

type Fixture = Awaited<ReturnType<typeof billingFixture>>;
function dispatch(f: Fixture, legacyTransport = f.manualTransport) {
  const unexpected = async () => {
    throw new Error('Unexpected setup or document call');
  };
  return createBillingWebhookDispatcher({
    payments: f.manual,
    legacyTransport,
    customers: { reconcileSetup: unexpected },
    customerTransport: {
      ...f.processorProof,
      createCustomer: unexpected,
      retrieveCustomer: unexpected,
      createSetup: unexpected,
      retrieveSetup: unexpected,
      retrieveSetupIntent: unexpected,
      retrievePaymentMethod: unexpected,
      createPortal: unexpected,
      listDocuments: unexpected,
    },
    recharge: f.recharge,
    rechargeTransport: f.transport,
    routeIntent: (event, intent) => f.manual.routeIntent(event, intent),
  });
}
function receipt(type: string, object: Record<string, unknown>): VerifiedPaymentEvent {
  return { id: `evt_${randomUUID()}`, type, livemode: false, data: { object } };
}
async function openManual(f: Fixture, scoped = true) {
  const store = scoped ? f.manual : f.store;
  const order = await store.createOrder(f.workspace, 1000, randomUUID());
  await store.checkout(f.workspace, order.id, scoped ? f.manualTransport : f.transportForManual);
  return order;
}
async function ledger(f: Fixture) {
  return (
    await f.pool.query(
      "SELECT reference,amount_micros FROM mr_ledger WHERE workspace_id=$1 AND kind='credit' ORDER BY reference",
      [f.workspace],
    )
  ).rows;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'shared funding ownership and verified webhook dispatch',
  () => {
    it('keeps unbound events pending, credits through Checkout only, and acknowledges PI replay', async () => {
      const f = await billingFixture();
      try {
        const order = await openManual(f);
        const checkoutReads: string[] = [];
        const transport = {
          ...f.manualTransport,
          async retrieveSession(id: string) {
            checkoutReads.push(id);
            return f.manualTransport.retrieveSession(id);
          },
        };
        const webhook = dispatch(f, transport);
        const intent = 'pi_manual_evidence';
        const pi = receipt('payment_intent.succeeded', {
          id: intent,
          metadata: { opengen_recharge_reference: order.id },
        });
        await expect(webhook(pi)).rejects.toMatchObject({
          statusCode: 503,
          code: 'unmatched_payment_intent',
        });
        expect(
          (
            await f.pool.query(
              'SELECT state,processor_environment_id FROM mr_payment_events WHERE id=$1',
              [pi.id],
            )
          ).rows[0],
        ).toEqual({ state: 'pending', processor_environment_id: f.processorEnvironment.id });
        expect(f.retrieves).toEqual([]);
        expect(await ledger(f)).toEqual([]);
        f.setSession({ status: 'complete', payment_status: 'paid', payment_intent: intent });
        const checkout = receipt('checkout.session.completed', { ...f.session() });
        await webhook(checkout);
        await expect(webhook(pi)).resolves.toEqual({ received: true, ignored: true });
        await expect(webhook(checkout)).resolves.toEqual({ received: true, duplicate: true });
        await expect(
          webhook({
            ...checkout,
            data: { object: { ...f.session(), payment_intent: 'pi_conflict' } },
          }),
        ).rejects.toMatchObject({ code: 'event_conflict', statusCode: 409 });
        await expect(f.store.reconcile(checkout, transport)).rejects.toMatchObject({
          code: 'event_conflict',
          statusCode: 409,
        });
        expect(checkoutReads).toEqual([f.session().id]);
        expect(await ledger(f)).toEqual([
          { reference: `stripe-topup:${order.id}`, amount_micros: '10000000' },
        ]);
        expect(
          (
            await f.pool.query(
              'SELECT kind,local_id,credit_reference FROM mr_billing_payment_ownership WHERE payment_intent_id=$1',
              [intent],
            )
          ).rows[0],
        ).toEqual({
          kind: 'manual',
          local_id: order.id,
          credit_reference: `stripe-topup:${order.id}`,
        });
        expect(f.retrieves).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it('retains a refund before original recharge binding and attaches its hold before paid credit', async () => {
      const f = await billingFixture();
      try {
        const webhook = dispatch(f),
          attempt = (await f.recharge.admit(f.workspace))!;
        const intent = `pi_fixture_${attempt.id.replaceAll('-', '')}`;
        const refund = receipt('refund.created', {
          id: 're_fixture',
          payment_intent: { id: intent },
        });
        await expect(webhook(refund)).rejects.toMatchObject({
          statusCode: 503,
          code: 'unmatched_payment_intent',
        });
        const queue = await new BillingOperationsStore(f.pool).queue(async () => {});
        expect(queue).toContainEqual(
          expect.objectContaining({ kind: 'stripe-event', id: refund.id, workspaceId: null }),
        );
        await f.recharge.dispatch(attempt.id, f.transport);
        expect(await f.manual.hasBillingHold(f.workspace)).toBe(true);
        expect(
          (
            await f.pool.query(
              'SELECT order_id,recharge_attempt_id FROM mr_billing_holds WHERE event_id=$1',
              [refund.id],
            )
          ).rows[0],
        ).toEqual({ order_id: null, recharge_attempt_id: attempt.id });
        const payment = await f.paid(intent),
          paid = receipt('payment_intent.succeeded', { ...payment });
        await webhook(paid);
        await webhook(paid);
        await webhook(refund);
        expect(await ledger(f)).toEqual([
          { reference: `stripe-recharge:${attempt.id}`, amount_micros: '10000000' },
        ]);
        expect(await f.recharge.admit(f.workspace)).toBeNull();
      } finally {
        await f.close();
      }
    });

    it('blocks a legacy-only store from crediting a PI already reserved by a scoped recharge', async () => {
      const f = await billingFixture();
      try {
        const order = await openManual(f, false),
          attempt = (await f.recharge.admit(f.workspace))!;
        await f.recharge.dispatch(attempt.id, f.transport);
        const payment = await f.paid(`pi_fixture_${attempt.id.replaceAll('-', '')}`);
        f.setSession({ status: 'complete', payment_status: 'paid', payment_intent: payment.id });
        await expect(
          f.store.reconcile(
            receipt('checkout.session.completed', { ...f.session() }),
            f.transportForManual,
          ),
        ).rejects.toMatchObject({ code: 'payment_ownership_conflict' });
        await dispatch(f)(receipt('payment_intent.succeeded', { ...payment }));
        expect((await f.store.getOrder(f.workspace, order.id)).creditedAt).toBeNull();
        expect(await ledger(f)).toEqual([
          { reference: `stripe-recharge:${attempt.id}`, amount_micros: '10000000' },
        ]);
      } finally {
        await f.close();
      }
    });

    it('qualifies an old stored Checkout with a fresh retrieval and refuses to replay an unproven POST', async () => {
      const f = await billingFixture();
      try {
        const legacy = await openManual(f, false),
          webhook = dispatch(f),
          intent = 'pi_legacy_evidence';
        f.setSession({ status: 'complete', payment_status: 'paid', payment_intent: intent });
        await f.pool.query('UPDATE mr_payment_orders SET payment_intent_id=$2 WHERE id=$1', [
          legacy.id,
          intent,
        ]);
        await expect(
          webhook(receipt('payment_intent.succeeded', { id: intent })),
        ).rejects.toMatchObject({ code: 'unmatched_payment_intent' });
        await webhook(receipt('checkout.session.completed', { ...f.session() }));
        expect(await ledger(f)).toEqual([
          { reference: `stripe-topup:${legacy.id}`, amount_micros: '10000000' },
        ]);
        const uncertain = await f.store.createOrder(f.workspace, 1000, randomUUID());
        await f.pool.query(
          "UPDATE mr_payment_orders SET checkout_started_at=now(),checkout_expires_at=now()+interval '1 hour',status='checkout_pending' WHERE id=$1",
          [uncertain.id],
        );
        const before = f.requests.length;
        expect((await f.manual.checkout(f.workspace, uncertain.id, f.manualTransport)).status).toBe(
          'review',
        );
        expect(f.requests).toHaveLength(before);
      } finally {
        await f.close();
      }
    });

    it('recovers accepted objects with the charge gate off and denies foreign transport proof', async () => {
      const f = await billingFixture();
      try {
        const attempt = (await f.recharge.admit(f.workspace))!;
        await expect(
          f.recharge.dispatch(attempt.id, {
            ...f.transport,
            processorEnvironment: {
              ...f.processorEnvironment,
              id: 'foreign-environment',
              accountId: 'acct_foreign',
            },
          }),
        ).rejects.toMatchObject({ code: 'processor_environment_mismatch' });
        expect(f.creates).toHaveLength(0);
        const off = new RechargeStore(f.pool, {
          processorEnvironment: f.processorEnvironment,
          creditInTransaction: creditWorkspaceInTransaction,
          now: f.now,
          lockExternalInTransaction: (client) => f.store.lockExternalInTransaction(client),
          admitExternalInTransaction: (client, workspaceId) =>
            f.store.admitExternalInTransaction(client, workspaceId),
        });
        await expect(off.dispatch(attempt.id, f.transport)).resolves.toBeNull();
        expect(f.creates).toHaveLength(0);
        await f.recharge.dispatch(attempt.id, f.transport);
        f.advance(60001);
        await off.dispatch(attempt.id, f.transport);
        expect(f.creates).toHaveLength(1);
        expect(f.retrieves).toEqual([`pi_fixture_${attempt.id.replaceAll('-', '')}`]);
        expect(await ledger(f)).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it.skipIf(process.env.TEST_NATIVE_POSTGRES !== '1')(
      'serializes a manual/automatic binding race for one PI and one ledger credit',
      async () => {
        const f = await billingFixture({ max: 5 });
        try {
          const order = await openManual(f),
            attempt = (await f.recharge.admit(f.workspace))!,
            webhook = dispatch(f);
          const intent = `pi_fixture_${attempt.id.replaceAll('-', '')}`;
          f.setSession({ status: 'complete', payment_status: 'paid', payment_intent: intent });
          let entered!: () => void, release!: () => void;
          const posted = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const automatic = f.recharge.dispatch(attempt.id, {
            ...f.transport,
            async createRecharge(request) {
              const payment = await f.transport.createRecharge(request);
              entered();
              await gate;
              return payment;
            },
          });
          void automatic.catch(() => {});
          await Promise.race([
            posted,
            automatic.then(() => {
              throw new Error('Expected an admitted original POST');
            }),
          ]);
          const manual = webhook(receipt('checkout.session.completed', { ...f.session() }));
          release();
          const results = await Promise.allSettled([manual, automatic]);
          expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.find((result) => result.status === 'rejected')).toMatchObject({
            reason: { code: 'payment_ownership_conflict' },
          });
          const { kind, credit_reference } = (
            await f.pool.query(
              'SELECT kind,credit_reference FROM mr_billing_payment_ownership WHERE payment_intent_id=$1',
              [intent],
            )
          ).rows[0];
          await webhook(receipt('payment_intent.succeeded', { ...(await f.paid(intent)) }));
          expect(credit_reference).toBe(
            kind === 'manual' ? `stripe-topup:${order.id}` : `stripe-recharge:${attempt.id}`,
          );
          expect(await ledger(f)).toEqual([
            { reference: credit_reference, amount_micros: '10000000' },
          ]);
        } finally {
          await f.close();
        }
      },
    );
  },
);
