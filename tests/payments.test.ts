import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { centsToMicros, type VerifiedPaymentEvent } from '../packages/engine/src/payments.js';
import { fixtureCredit, paymentFixture } from './payment-fixture.js';

it('converts only bounded whole USD cents to safe integer microUSD', () => {
  expect(centsToMicros(500)).toBe(5000000);
  expect(centsToMicros(100000)).toBe(1000000000);
  for (const amount of [0, -1, 499, 100001, 1000.1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => centsToMicros(amount)).toThrow();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('customer prepaid ledger reconciliation', () => {
  it('persists bounded workspace-scoped orders before Checkout; rejects cross-workspace and changed retry amount', async () => {
    const f = await paymentFixture();
    try {
      const key = randomUUID();
      const a = await f.store.createOrder(f.workspace, 1000, key);
      expect(await f.store.createOrder(f.workspace, 1000, key)).toEqual(a);
      await expect(f.store.createOrder(f.workspace, 2000, key)).rejects.toMatchObject({
        code: 'idempotency_conflict',
      });
      expect(f.requests).toHaveLength(0);
      await expect(f.store.getOrder('other', a.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.store.checkout('other', a.id, f.transport)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        f.pool.query('UPDATE mr_payment_orders SET amount_cents=1 WHERE id=$1', [a.id]),
      ).rejects.toThrow();
      await expect(
        f.pool.query("UPDATE mr_payment_orders SET currency='EUR' WHERE id=$1", [a.id]),
      ).rejects.toThrow();
      await expect(
        f.pool.query('UPDATE mr_payment_orders SET credit_micros=1 WHERE id=$1', [a.id]),
      ).rejects.toThrow();
      expect(await f.store.listOrders('other')).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each(['created', 'checkout_pending'] as const)(
    'refuses an unbound legacy %s request before POST, quotas or immutable checkpoints change',
    async (status) => {
      const now = Date.now();
      const f = await paymentFixture({ now: () => now });
      try {
        const id = randomUUID();
        const started = status === 'checkout_pending' ? new Date(now - 120_000) : null;
        const expires = started ? new Date(now + 23 * 3_600_000) : null;
        // Old writers omit the new columns: the forward schema must retain the
        // historical serializer default, never silently select the new payload.
        await f.pool.query(
          `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,
            status,stripe_idempotency_key,integration_identifier,checkout_started_at,checkout_expires_at,
            checkout_next_request_at)
           VALUES($1,$2,$3,500,5000000,false,$4,$5,'legacy_fixture',$6,$7,$8)`,
          [
            id,
            f.workspace,
            randomUUID(),
            status,
            `legacy-${id}`,
            started,
            expires,
            started ? new Date(now - 60_000) : null,
          ],
        );
        const snapshot = async () => ({
          order: (await f.pool.query('SELECT * FROM mr_payment_orders WHERE id=$1', [id])).rows[0],
          workspace: (await f.pool.query('SELECT * FROM mr_workspaces WHERE id=$1', [f.workspace]))
            .rows[0],
          installation: (await f.pool.query('SELECT * FROM mr_payment_rate_limits')).rows,
          ledger: (await f.pool.query('SELECT * FROM mr_ledger')).rows,
        });
        const before = await snapshot();
        expect(before.order).toMatchObject({
          checkout_request_version: 'checkout_hosted_v1',
          checkout_api_version: '2026-10-28.endive',
        });
        const create = vi.fn(f.transport.createSession);
        const retrieve = vi.fn(f.transport.retrieveSession);
        await expect(
          f.store.checkout(f.workspace, id, {
            ...f.transport,
            createSession: create,
            retrieveSession: retrieve,
          }),
        ).rejects.toMatchObject({ code: 'unsupported_checkout_request', statusCode: 409 });
        expect(create).not.toHaveBeenCalled();
        expect(retrieve).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
      } finally {
        await f.close();
      }
    },
  );

  it('keeps a known historical Checkout readable and signed-event credit exactly once after serializer upgrade', async () => {
    let now = Date.now();
    const f = await paymentFixture({ now: () => now });
    try {
      const id = randomUUID();
      const expires = new Date(now + 23 * 3_600_000);
      const historical = await f.transport.createSession({
        id,
        workspaceId: f.workspace,
        amountCents: 1000,
        creditMicros: 10000000,
        currency: 'USD',
        status: 'created',
        checkoutUrl: null,
        createdAt: '',
        updatedAt: '',
        creditedAt: null,
        stripeIdempotencyKey: `legacy-${id}`,
        integrationIdentifier: 'legacy_known_fixture',
        expiresAt: Math.floor(expires.getTime() / 1000),
        requestVersion: 'checkout_hosted_v1',
        apiVersion: '2026-10-28.endive',
      });
      const legacyResponse = { ...historical, ui_mode: 'hosted' };
      f.setSession(legacyResponse);
      expect(f.session()).toHaveProperty('ui_mode', 'hosted');
      // Populate a historical bound session directly, using the legacy DB
      // default. No new-version order is rewritten into a historical request.
      await f.pool.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,status,
          stripe_idempotency_key,integration_identifier,session_id,checkout_url,checkout_started_at,checkout_expires_at)
         VALUES($1,$2,$3,1000,10000000,false,'checkout_open',$4,'legacy_known_fixture',$5,$6,$7,$8)`,
        [
          id,
          f.workspace,
          randomUUID(),
          `legacy-${id}`,
          historical.id,
          historical.url,
          new Date(now - 120_000),
          expires,
        ],
      );
      const order = await f.store.getOrder(f.workspace, id);
      const frozen = async () =>
        (
          await f.pool.query(
            `SELECT checkout_request_version,checkout_api_version,stripe_idempotency_key,integration_identifier,
         checkout_started_at,checkout_expires_at,session_id FROM mr_payment_orders WHERE id=$1`,
            [order.id],
          )
        ).rows[0];
      const before = await frozen();
      now += 60_000;
      const create = vi.fn(f.transport.createSession);
      const retrieve = vi.fn(f.transport.retrieveSession);
      expect(
        (
          await f.store.checkout(f.workspace, order.id, {
            ...f.transport,
            createSession: create,
            retrieveSession: retrieve,
          })
        ).id,
      ).toBe(order.id);
      expect(create).not.toHaveBeenCalled();
      expect(retrieve).toHaveBeenCalledExactlyOnceWith(before.session_id);
      expect(await frozen()).toEqual(before);
      expect((await f.store.getOrder(f.workspace, order.id)).creditedAt).toBeNull();
      await f.paid();
      // PaymentStore receives only already signature-verified events; raw-byte
      // signature acceptance remains covered by the API webhook tests.
      const sdk = new Stripe('fixture-signature-verification-only');
      const payload = JSON.stringify(f.event());
      const secret = 'fixture-webhook-signing-secret';
      const signature = sdk.webhooks.generateTestHeaderString({ payload, secret });
      const signed = sdk.webhooks.constructEvent(
        payload,
        signature,
        secret,
      ) as unknown as VerifiedPaymentEvent;
      await f.store.reconcile(signed, f.transport);
      await f.store.reconcile(signed, f.transport);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
      expect(await frozen()).toEqual(before);
      expect(
        (await f.pool.query("SELECT amount_micros FROM mr_ledger WHERE kind='credit'")).rows,
      ).toEqual([{ amount_micros: '10000000' }]);
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

  it('replays identical Checkout parameters/key after timeout; binds only original session and never credits from GET', async () => {
    let now = Date.now();
    const f = await paymentFixture({ now: () => now });
    try {
      const order = await f.store.createOrder(f.workspace, 1000, randomUUID());
      let fail = true;
      const transport = {
        ...f.transport,
        async createSession(input: Parameters<typeof f.transport.createSession>[0]) {
          const session = await f.transport.createSession(input);
          if (fail) {
            fail = false;
            throw new Error('Socket closed after acceptance');
          }
          return session;
        },
      };
      await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
        code: 'checkout_uncertain',
      });
      // Even a signed webhook with the original local reference cannot bind an
      // unknown session. Recover using the original create idempotency key first.
      await f.paid();
      await expect(f.store.reconcile(f.event(), f.transport)).rejects.toMatchObject({
        code: 'unmatched_payment',
      });
      now += 60000;
      await f.store.checkout(f.workspace, order.id, transport);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[0]).toMatchObject({
        stripeIdempotencyKey: f.requests[1]!.stripeIdempotencyKey,
        expiresAt: f.requests[1]!.expiresAt,
        integrationIdentifier: f.requests[1]!.integrationIdentifier,
        requestVersion: 'checkout_hosted_page_v2',
        apiVersion: '2026-10-28.endive',
      });
      expect(f.requests[1]).toMatchObject({
        requestVersion: 'checkout_hosted_page_v2',
        apiVersion: '2026-10-28.endive',
      });
      const frozenRequest = (request: (typeof f.requests)[number]) => ({
        id: request.id,
        workspaceId: request.workspaceId,
        amountCents: request.amountCents,
        creditMicros: request.creditMicros,
        currency: request.currency,
        stripeIdempotencyKey: request.stripeIdempotencyKey,
        expiresAt: request.expiresAt,
        integrationIdentifier: request.integrationIdentifier,
        requestVersion: request.requestVersion,
        apiVersion: request.apiVersion,
      });
      expect(frozenRequest(f.requests[1]!)).toEqual(frozenRequest(f.requests[0]!));
      expect(
        (
          await f.pool.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].available_micros,
      ).toBe('0');
      await f.store.reconcile(f.event(), f.transport);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
    } finally {
      await f.close();
    }
  });
  it('serializes concurrent Checkout creation and persists review on a mismatched response', async () => {
    const f = await paymentFixture();
    try {
      const order = await f.store.createOrder(f.workspace, 1000, randomUUID());
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>((done) => {
        started = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const transport = {
        ...f.transport,
        async createSession(input: Parameters<typeof f.transport.createSession>[0]) {
          const session = await f.transport.createSession(input);
          started();
          await gate;
          return { ...session, amount_subtotal: 2000 };
        },
      };
      const first = f.store.checkout(f.workspace, order.id, transport);
      void first.catch(() => {});
      await entered;
      try {
        await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
          code: 'payment_rate_limited',
          statusCode: 429,
        });
      } finally {
        release();
      }
      await expect(first).rejects.toMatchObject({ code: 'session_mismatch' });
      expect(f.requests).toHaveLength(1);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('review');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('never creates a second external Checkout after retry retention safety window', async () => {
    let now = Date.now();
    const f = await paymentFixture({ now: () => now });
    try {
      const order = await f.store.createOrder(f.workspace, 1000, randomUUID());
      const transport = {
        ...f.transport,
        async createSession(input: Parameters<typeof f.transport.createSession>[0]) {
          await f.transport.createSession(input);
          throw new Error('timeout');
        },
      };
      await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toThrow();
      now += 21 * 3600000;
      expect((await f.store.checkout(f.workspace, order.id, transport)).status).toBe('review');
      expect(f.requests).toHaveLength(1);
      await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
        code: 'payment_review',
      });
    } finally {
      await f.close();
    }
  });
  it('requires correct stored session/currency/mode/face value/environment and paid state', async () => {
    const f = await paymentFixture();
    try {
      const order = await f.order();
      await f.store.reconcile(f.event(), f.transport);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('payment_pending');
      await f.paid();
      for (const patch of [
        { currency: 'eur' },
        { amount_subtotal: 999 },
        { amount_total: 999 },
        { mode: 'subscription' },
        { client_reference_id: randomUUID() },
        { payment_intent: 'pi_wrong' },
        { livemode: true },
      ]) {
        await expect(
          f.store.reconcile(f.event(undefined, patch), f.transport),
        ).rejects.toMatchObject({ code: 'session_mismatch' });
      }
      await expect(
        f.store.reconcile(f.event(undefined, { id: 'cs_test_wrong' }), f.transport),
      ).rejects.toMatchObject({ code: 'unmatched_payment' });
      const live = f.event();
      live.livemode = true;
      await expect(f.store.reconcile(live, f.transport)).rejects.toMatchObject({
        code: 'environment_mismatch',
      });
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('credits delayed success once despite concurrent duplicates, stale completion/failure and expired events', async () => {
    const f = await paymentFixture();
    try {
      const order = await f.order();
      f.setSession({ status: 'complete', payment_intent: `pi_${f.workspace}` });
      const stale = f.event();
      await f.store.reconcile(stale, f.transport);
      await f.store.reconcile(f.event('checkout.session.async_payment_failed'), f.transport);
      await f.store.reconcile({ ...stale, id: `evt_${randomUUID()}` }, f.transport);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('payment_failed');
      expect((await f.store.checkout(f.workspace, order.id, f.transport)).status).toBe(
        'payment_failed',
      );
      await f.paid();
      const paid = f.event('checkout.session.async_payment_succeeded');
      await Promise.all([
        f.store.reconcile(paid, f.transport),
        f.store.reconcile(paid, f.transport),
        f.store.reconcile(f.event(), f.transport),
      ]);
      await f.store.reconcile({ ...stale, id: `evt_${randomUUID()}` }, f.transport);
      await f.store.reconcile(f.event('checkout.session.expired'), f.transport);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('1');
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
  it('rolls balance/ledger/event/order back together if transactional credit fails; retry succeeds with pool size one', async () => {
    let broken = true;
    const f = await paymentFixture({
      credit: async (...args) => {
        await fixtureCredit(...args);
        if (broken) throw new Error('crash after ledger write');
      },
    });
    try {
      const order = await f.order();
      await f.paid();
      const event = f.event();
      await expect(f.store.reconcile(event, f.transport)).rejects.toThrow('crash');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('0');
      expect((await f.store.getOrder(f.workspace, order.id)).creditedAt).toBeNull();
      expect(
        (
          await f.pool.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].available_micros,
      ).toBe('0');
      broken = false;
      await f.store.reconcile(event, f.transport);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
    } finally {
      await f.close();
    }
  });
  it('records unmatched refund before binding, imposes hold before credit, preserves ledger and never auto-clears', async () => {
    const f = await paymentFixture();
    try {
      const order = await f.order();
      await f.paid();
      const risk = {
        id: `evt_${randomUUID()}`,
        type: 'refund.created',
        livemode: false,
        data: { object: { id: 're_test_refund', payment_intent: f.session().payment_intent } },
      };
      await expect(f.store.reconcile(risk, f.transport)).rejects.toMatchObject({
        code: 'unmatched_payment',
      });
      await f.store.reconcile(f.event(), f.transport);
      expect(await f.store.hasBillingHold(f.workspace)).toBe(true);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
      await expect(f.store.createOrder(f.workspace, 1000, randomUUID())).rejects.toMatchObject({
        code: 'billing_hold',
      });
      const dispute = {
        ...risk,
        id: `evt_${randomUUID()}`,
        type: 'charge.dispute.closed',
        data: { object: { ...risk.data.object, id: 'dp_test' } },
      };
      await f.store.reconcile(dispute, f.transport);
      await f.store.reconcile(dispute, f.transport);
      expect((await f.pool.query('SELECT count(*) FROM mr_billing_holds')).rows[0].count).toBe('2');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('1');
      expect(await f.store.hasBillingHold(f.workspace)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
