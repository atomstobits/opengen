import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  PaymentStore,
  PAYMENT_RATE_LIMITS,
  type CheckoutOrder,
  type CheckoutSession,
  type VerifiedPaymentEvent,
} from '../packages/engine/src/payments.js';
import { fixtureCredit, paymentFixture } from './payment-fixture.js';

// PGlite uses one backend and cannot establish native PostgreSQL lock-wait
// semantics. Run explicitly against disposable native PostgreSQL in release CI.
const native = process.env.TEST_NATIVE_POSTGRES === '1' && Boolean(process.env.TEST_DATABASE_URL);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Observe real queries without replacing PostgreSQL's locks or transactions. */
function observe(
  pool: Pool,
  before: (sql: string, values: unknown[]) => Promise<void>,
  after?: (sql: string, values: unknown[]) => Promise<void>,
): Pool {
  return {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query')
            return async (sql: string, values: unknown[] = []) => {
              await before(sql, values);
              const result = await target.query(sql, values);
              await after?.(sql, values);
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
}
function risk(intent: string): VerifiedPaymentEvent {
  return {
    id: `evt_${randomUUID()}`,
    type: 'charge.refunded',
    livemode: false,
    data: { object: { id: `ch_${randomUUID()}`, payment_intent: intent } },
  };
}

describe.skipIf(!native)('native PostgreSQL payment reconciliation locks', () => {
  it('rechecks risk ownership after waiting for concurrent payment-intent binding', async () => {
    const creditReached = deferred(),
      releaseCredit = deferred(),
      riskWaiting = deferred();
    const f = await paymentFixture({
      max: 4,
      credit: async (...args) => {
        await fixtureCredit(...args);
        creditReached.resolve();
        await deadline(releaseCredit.promise, 'release paid transaction');
      },
    });
    let paidWork: Promise<unknown> | undefined;
    let riskWork: Promise<unknown> | undefined;
    try {
      const order = await f.order();
      await f.paid();
      const intent = f.session().payment_intent as string;
      paidWork = f.store.reconcile(f.event(), f.transport);
      await deadline(creditReached.promise, 'paid transaction holds intent lock');
      // At this point binding/credit are still uncommitted. A pre-lock lookup
      // cannot see the order's payment_intent_id and must be repeated after wait.
      const riskStore = new PaymentStore(
        observe(f.pool, async (sql) => {
          if (sql.includes('pg_advisory_xact_lock')) riskWaiting.resolve();
        }),
        { livemode: false, creditInTransaction: fixtureCredit },
      );
      riskWork = riskStore.reconcile(risk(intent), f.transport);
      // Attach a rejection handler immediately; assertions below still see it.
      void riskWork.catch(() => {});
      await deadline(riskWaiting.promise, 'risk event attempts the same intent lock');
      releaseCredit.resolve();
      await deadline(paidWork, 'paid reconciliation commits');
      await expect(
        deadline(riskWork, 'risk reconciliation rechecks binding'),
      ).resolves.toMatchObject({ received: true });
      expect(await f.store.hasBillingHold(f.workspace)).toBe(true);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
      ).toBe('1');
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_payment_events WHERE state='pending'")).rows[0]
          .count,
      ).toBe('0');
    } finally {
      releaseCredit.resolve();
      await Promise.allSettled([paidWork, riskWork].filter(Boolean));
      await f.close();
    }
  });

  it('commits an unmatched risk journal before paid reconciliation scans holds and credits', async () => {
    const riskJournaled = deferred(),
      releaseRisk = deferred(),
      paidWaiting = deferred();
    let sawHoldAtCredit = false;
    const f = await paymentFixture({
      max: 4,
      credit: async (client, ...args) => {
        sawHoldAtCredit = Boolean(
          (
            await client.query(
              'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL',
              [args[0]],
            )
          ).rowCount,
        );
        await fixtureCredit(client, ...args);
      },
    });
    let riskWork: Promise<unknown> | undefined;
    let paidWork: Promise<unknown> | undefined;
    try {
      const order = await f.order();
      await f.paid();
      const event = risk(f.session().payment_intent as string);
      const riskStore = new PaymentStore(
        observe(
          f.pool,
          async () => {},
          async (sql, values) => {
            if (sql.includes('INSERT INTO mr_payment_events') && values[0] === event.id) {
              riskJournaled.resolve();
              await deadline(releaseRisk.promise, 'release unmatched risk journal');
            }
          },
        ),
        { livemode: false, creditInTransaction: fixtureCredit },
      );
      riskWork = riskStore.reconcile(event, f.transport);
      void riskWork.catch(() => {});
      await deadline(riskJournaled.promise, 'unmatched risk is journaled under intent lock');
      const paidStore = new PaymentStore(
        observe(f.pool, async (sql) => {
          if (sql.includes('pg_advisory_xact_lock')) paidWaiting.resolve();
        }),
        {
          livemode: false,
          creditInTransaction: async (client, ...args) => {
            sawHoldAtCredit = Boolean(
              (
                await client.query(
                  'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL',
                  [args[0]],
                )
              ).rowCount,
            );
            await fixtureCredit(client, ...args);
          },
        },
      );
      paidWork = paidStore.reconcile(f.event(), f.transport);
      void paidWork.catch(() => {});
      await deadline(paidWaiting.promise, 'paid event waits behind risk journal');
      releaseRisk.resolve();
      await expect(deadline(riskWork, 'unmatched risk commits for retry')).rejects.toMatchObject({
        code: 'unmatched_payment',
      });
      await deadline(paidWork, 'paid event reconciles pending risk');
      expect(sawHoldAtCredit).toBe(true);
      expect(await f.store.hasBillingHold(f.workspace)).toBe(true);
      expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
      expect(
        (await f.pool.query('SELECT state,order_id FROM mr_payment_events WHERE id=$1', [event.id]))
          .rows[0],
      ).toEqual({ state: 'processed', order_id: order.id });
    } finally {
      releaseRisk.resolve();
      await Promise.allSettled([riskWork, paidWork].filter(Boolean));
      await f.close();
    }
  });

  it('serializes same and distinct paid events without duplicate ledger credit', async () => {
    const f = await paymentFixture({ max: 6 });
    try {
      const order = await f.order();
      await f.paid();
      const event = f.event();
      await Promise.all([
        f.store.reconcile(event, f.transport),
        f.store.reconcile(event, f.transport),
        f.store.reconcile(f.event('checkout.session.async_payment_succeeded'), f.transport),
        f.store.reconcile(f.event(), f.transport),
      ]);
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
      expect(
        (await f.pool.query("SELECT count(*) FROM mr_payment_events WHERE state='processed'"))
          .rows[0].count,
      ).toBe('3');
    } finally {
      await f.close();
    }
  });
});

/** Distinct mock Checkout sessions let parallel orders reach their own valid
 * response-binding transactions without calling any payment service. */
function countingTransport() {
  const sessions = new Map<string, CheckoutSession>();
  const created: CheckoutOrder[] = [];
  const retrieved: string[] = [];
  return {
    created,
    retrieved,
    transport: {
      async createSession(order: CheckoutOrder): Promise<CheckoutSession> {
        created.push(order);
        const id = `cs_test_${order.id.replaceAll('-', '')}`;
        const session: CheckoutSession = {
          id,
          mode: 'payment',
          currency: 'usd',
          amount_subtotal: order.amountCents,
          amount_total: order.amountCents,
          payment_status: 'unpaid',
          status: 'open',
          client_reference_id: order.id,
          payment_intent: null,
          livemode: false,
          url: 'https://checkout.stripe.com/c/pay/concurrent_fixture',
        };
        sessions.set(id, session);
        return session;
      },
      async retrieveSession(id: string): Promise<CheckoutSession> {
        retrieved.push(id);
        const session = sessions.get(id);
        if (!session) throw new Error('Unknown fixture session.');
        return { ...session };
      },
    },
  };
}
function limitedResults(results: PromiseSettledResult<unknown>[], successful: number) {
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(successful);
  for (const result of results)
    if (result.status === 'rejected') {
      expect(result.reason).toMatchObject({ code: 'payment_rate_limited', statusCode: 429 });
      expect(result.reason.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.reason.message).toContain('resume the same order and retry key');
    }
}

// These caps use real database row locks across independent pool clients. The
// singleton installation row is intentionally shared across fixture workspaces.
describe.skipIf(!native)('native PostgreSQL customer payment admission limits', () => {
  it('admits only the final workspace order slot and preserves existing-key replay after cap', async () => {
    const now =
      Math.floor(Date.now() / PAYMENT_RATE_LIMITS.windowMs) * PAYMENT_RATE_LIMITS.windowMs + 300000;
    const window = Math.floor(now / PAYMENT_RATE_LIMITS.windowMs);
    const f = await paymentFixture({ max: 6, now: () => now });
    try {
      await f.pool.query(
        'UPDATE mr_workspaces SET payment_order_window=$2,payment_order_count=$3 WHERE id=$1',
        [f.workspace, window, PAYMENT_RATE_LIMITS.ordersPerWorkspace - 1],
      );
      await f.pool.query(
        'UPDATE mr_payment_rate_limits SET payment_order_window=$1,payment_order_count=100 WHERE singleton=true',
        [window],
      );
      const keys = Array.from({ length: 6 }, () => randomUUID());
      const results = await Promise.allSettled(
        keys.map((key) => f.store.createOrder(f.workspace, 1000, key)),
      );
      limitedResults(results, 1);
      const winner = results.findIndex((result) => result.status === 'fulfilled');
      const replay = await f.store.createOrder(f.workspace, 1000, keys[winner]!);
      expect(replay).toEqual((results[winner] as PromiseFulfilledResult<unknown>).value);
      expect(
        (
          await f.pool.query('SELECT payment_order_count FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].payment_order_count,
      ).toBe(PAYMENT_RATE_LIMITS.ordersPerWorkspace);
      expect(
        (await f.pool.query('SELECT payment_order_count FROM mr_payment_rate_limits')).rows[0]
          .payment_order_count,
      ).toBe(101);
      expect((await f.pool.query('SELECT count(*) FROM mr_payment_orders')).rows[0].count).toBe(
        '1',
      );
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_payment_rate_limits')).rows[0].count,
      ).toBe('1');
    } finally {
      await f.close();
    }
  });

  it('admits only the final installation order slot across independently locked workspaces', async () => {
    const now =
      Math.floor(Date.now() / PAYMENT_RATE_LIMITS.windowMs) * PAYMENT_RATE_LIMITS.windowMs + 300000;
    const window = Math.floor(now / PAYMENT_RATE_LIMITS.windowMs);
    const f = await paymentFixture({ max: 6, now: () => now });
    try {
      const workspaces = Array.from({ length: 6 }, () => `ws_${randomUUID()}`);
      for (const workspace of workspaces)
        await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [
          workspace,
        ]);
      await f.pool.query(
        'UPDATE mr_payment_rate_limits SET payment_order_window=$1,payment_order_count=$2 WHERE singleton=true',
        [window, PAYMENT_RATE_LIMITS.ordersPerInstallation - 1],
      );
      const keys = workspaces.map(() => randomUUID());
      const results = await Promise.allSettled(
        workspaces.map((workspace, index) => f.store.createOrder(workspace, 1000, keys[index]!)),
      );
      limitedResults(results, 1);
      const winner = results.findIndex((result) => result.status === 'fulfilled');
      const replay = await f.store.createOrder(workspaces[winner]!, 1000, keys[winner]!);
      expect(replay).toEqual((results[winner] as PromiseFulfilledResult<unknown>).value);
      expect(
        (await f.pool.query('SELECT payment_order_count FROM mr_payment_rate_limits')).rows[0]
          .payment_order_count,
      ).toBe(PAYMENT_RATE_LIMITS.ordersPerInstallation);
      expect(
        Number(
          (await f.pool.query('SELECT sum(payment_order_count) AS total FROM mr_workspaces'))
            .rows[0].total,
        ),
      ).toBe(1);
      expect((await f.pool.query('SELECT count(*) FROM mr_payment_orders')).rows[0].count).toBe(
        '1',
      );
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_payment_rate_limits')).rows[0].count,
      ).toBe('1');
    } finally {
      await f.close();
    }
  });

  it('caps parallel external Checkout calls per workspace and leaves denied orders resumable', async () => {
    let now =
      Math.floor(Date.now() / PAYMENT_RATE_LIMITS.windowMs) * PAYMENT_RATE_LIMITS.windowMs + 300000;
    const window = Math.floor(now / PAYMENT_RATE_LIMITS.windowMs);
    const f = await paymentFixture({ max: 6, now: () => now });
    const calls = countingTransport();
    try {
      const orders = [];
      for (let i = 0; i < 6; i++)
        orders.push(await f.store.createOrder(f.workspace, 1000, randomUUID()));
      await f.pool.query(
        'UPDATE mr_workspaces SET payment_checkout_window=$2,payment_checkout_count=$3 WHERE id=$1',
        [f.workspace, window, PAYMENT_RATE_LIMITS.checkoutPerWorkspace - 1],
      );
      await f.pool.query(
        'UPDATE mr_payment_rate_limits SET payment_checkout_window=$1,payment_checkout_count=100 WHERE singleton=true',
        [window],
      );
      const results = await Promise.allSettled(
        orders.map((order) => f.store.checkout(f.workspace, order.id, calls.transport)),
      );
      limitedResults(results, 1);
      expect(calls.created).toHaveLength(1);
      expect(calls.retrieved).toHaveLength(0);
      expect(
        (
          await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].payment_checkout_count,
      ).toBe(PAYMENT_RATE_LIMITS.checkoutPerWorkspace);
      expect(
        (await f.pool.query('SELECT payment_checkout_count FROM mr_payment_rate_limits')).rows[0]
          .payment_checkout_count,
      ).toBe(101);
      const denied = results.findIndex((result) => result.status === 'rejected');
      expect((await f.store.getOrder(f.workspace, orders[denied]!.id)).status).toBe('created');
      expect(
        (
          await f.pool.query(
            'SELECT checkout_started_at,checkout_next_request_at FROM mr_payment_orders WHERE id=$1',
            [orders[denied]!.id],
          )
        ).rows[0],
      ).toEqual({ checkout_started_at: null, checkout_next_request_at: null });
      const successful = results.findIndex((result) => result.status === 'fulfilled');
      now += PAYMENT_RATE_LIMITS.checkoutCooldownMs + 1;
      await expect(
        f.store.checkout(f.workspace, orders[successful]!.id, calls.transport),
      ).rejects.toMatchObject({ code: 'payment_rate_limited', statusCode: 429 });
      expect(calls.retrieved).toHaveLength(0);
      expect((await f.store.getOrder(f.workspace, orders[successful]!.id)).status).toBe(
        'checkout_open',
      );
    } finally {
      await f.close();
    }
  });

  it('shares the final installation Checkout slot between new creates and known-session retrievals', async () => {
    let now =
      Math.floor(Date.now() / PAYMENT_RATE_LIMITS.windowMs) * PAYMENT_RATE_LIMITS.windowMs + 300000;
    const window = Math.floor(now / PAYMENT_RATE_LIMITS.windowMs);
    const f = await paymentFixture({ max: 6, now: () => now });
    const calls = countingTransport();
    try {
      const known = await f.store.createOrder(f.workspace, 1000, randomUUID());
      await f.store.checkout(f.workspace, known.id, calls.transport);
      const others = [];
      for (let i = 0; i < 5; i++) {
        const workspace = `ws_${randomUUID()}`;
        await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [
          workspace,
        ]);
        others.push(await f.store.createOrder(workspace, 1000, randomUUID()));
      }
      now += PAYMENT_RATE_LIMITS.checkoutCooldownMs + 1;
      await f.pool.query(
        'UPDATE mr_payment_rate_limits SET payment_checkout_window=$1,payment_checkout_count=$2 WHERE singleton=true',
        [window, PAYMENT_RATE_LIMITS.checkoutPerInstallation - 1],
      );
      const before = calls.created.length + calls.retrieved.length;
      const orders = [known, ...others];
      const results = await Promise.allSettled(
        orders.map((order) => f.store.checkout(order.workspaceId, order.id, calls.transport)),
      );
      limitedResults(results, 1);
      expect(calls.created.length + calls.retrieved.length - before).toBe(1);
      expect(
        (await f.pool.query('SELECT payment_checkout_count FROM mr_payment_rate_limits')).rows[0]
          .payment_checkout_count,
      ).toBe(PAYMENT_RATE_LIMITS.checkoutPerInstallation);
      expect(
        Number(
          (await f.pool.query('SELECT sum(payment_checkout_count) AS total FROM mr_workspaces'))
            .rows[0].total,
        ),
      ).toBe(2);
      // Even if the known session won the last slot, wait out its cache and prove
      // a subsequent GET to Stripe cannot bypass the installation cap.
      now += PAYMENT_RATE_LIMITS.checkoutCooldownMs + 1;
      const after = calls.created.length + calls.retrieved.length;
      await expect(f.store.checkout(f.workspace, known.id, calls.transport)).rejects.toMatchObject({
        code: 'payment_rate_limited',
        statusCode: 429,
      });
      expect(calls.created.length + calls.retrieved.length).toBe(after);
      expect((await f.store.getOrder(f.workspace, known.id)).status).toBe('checkout_open');
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_payment_rate_limits')).rows[0].count,
      ).toBe('1');
    } finally {
      await f.close();
    }
  });
});
