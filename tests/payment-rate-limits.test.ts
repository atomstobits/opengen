import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PAYMENT_RATE_LIMITS as limits, PaymentStore } from '../packages/engine/src/payments.js';
import { fixtureCredit, paymentFixture } from './payment-fixture.js';

// These schedules intentionally use one DB connection. Native parallel sessions
// are covered separately in payment-concurrency.test.ts.
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'durable payment admission limits with pool size one',
  () => {
    it('caps new orders, preserves existing-key replay/status, and reuses fixed counter rows across windows', async () => {
      let now = 1800000000000;
      const f = await paymentFixture({ now: () => now });
      try {
        const keys = Array.from({ length: limits.ordersPerWorkspace + 3 }, () => randomUUID());
        const results = await Promise.allSettled(
          keys.map((key) => f.store.createOrder(f.workspace, 1000, key)),
        );
        const admitted = results.filter((result) => result.status === 'fulfilled');
        expect(admitted).toHaveLength(limits.ordersPerWorkspace);
        for (const result of results.filter((result) => result.status === 'rejected')) {
          expect(result.reason).toMatchObject({ statusCode: 429, code: 'payment_rate_limited' });
          expect(result.reason.retryAfterSeconds).toBeGreaterThan(0);
          expect(result.reason.message).toMatch(/Try again in \d+ seconds/);
        }
        const first = await f.store.createOrder(f.workspace, 1000, keys[0]!);
        expect((await f.store.getOrder(f.workspace, first.id)).id).toBe(first.id);
        expect(await f.store.listOrders(f.workspace)).toHaveLength(limits.ordersPerWorkspace);
        expect(
          (
            await f.pool.query('SELECT payment_order_count FROM mr_workspaces WHERE id=$1', [
              f.workspace,
            ])
          ).rows[0].payment_order_count,
        ).toBe(limits.ordersPerWorkspace);
        expect(
          (await f.pool.query('SELECT payment_order_count FROM mr_payment_rate_limits')).rows[0]
            .payment_order_count,
        ).toBe(limits.ordersPerWorkspace);
        // Backwards clock changes cannot reopen an exhausted window.
        now -= limits.windowMs;
        await expect(f.store.createOrder(f.workspace, 1000, randomUUID())).rejects.toMatchObject({
          statusCode: 429,
        });
        now += 2 * limits.windowMs;
        await f.store.createOrder(f.workspace, 1000, randomUUID());
        expect(
          (await f.pool.query('SELECT payment_order_count FROM mr_payment_rate_limits')).rows[0]
            .payment_order_count,
        ).toBe(1);
        expect(
          (await f.pool.query('SELECT count(*) FROM mr_payment_rate_limits')).rows[0].count,
        ).toBe('1');
      } finally {
        await f.close();
      }
    });

    it('caps installation-wide new orders across fresh workspaces without charging replay quota', async () => {
      const now = 1800000000000;
      const f = await paymentFixture({ now: () => now });
      try {
        await f.pool.query(
          'UPDATE mr_payment_rate_limits SET payment_order_window=$1,payment_order_count=$2',
          [Math.floor(now / limits.windowMs), limits.ordersPerInstallation - 1],
        );
        const key = randomUUID();
        const order = await f.store.createOrder(f.workspace, 1000, key);
        const other = `ws_${randomUUID()}`;
        await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [other]);
        await expect(f.store.createOrder(other, 1000, randomUUID())).rejects.toMatchObject({
          statusCode: 429,
        });
        expect((await f.store.createOrder(f.workspace, 1000, key)).id).toBe(order.id);
        expect(
          (await f.pool.query('SELECT payment_order_count FROM mr_workspaces WHERE id=$1', [other]))
            .rows[0].payment_order_count,
        ).toBe(0);
        expect((await f.pool.query('SELECT count(*) FROM mr_payment_orders')).rows[0].count).toBe(
          '1',
        );
        expect(
          (await f.pool.query('SELECT payment_order_count FROM mr_payment_rate_limits')).rows[0]
            .payment_order_count,
        ).toBe(limits.ordersPerInstallation);
      } finally {
        await f.close();
      }
    });

    it('counts every uncertain external attempt durably and never clears cooldown/counters on timeout, retry, or webhook', async () => {
      let now = 1800000000000;
      const f = await paymentFixture({ now: () => now });
      try {
        const order = await f.store.createOrder(f.workspace, 1000, randomUUID());
        const transport = {
          ...f.transport,
          async createSession(input: Parameters<typeof f.transport.createSession>[0]) {
            await f.transport.createSession(input);
            throw new Error('fixture timeout');
          },
        };
        for (let index = 0; index < limits.checkoutPerWorkspace; index++) {
          await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
            code: 'checkout_uncertain',
          });
          for (let retry = 0; retry < 3; retry++)
            await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
              statusCode: 429,
              retryAfterSeconds: 60,
            });
          now += limits.checkoutCooldownMs;
        }
        expect(f.requests).toHaveLength(limits.checkoutPerWorkspace);
        await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
          statusCode: 429,
        });
        expect(f.requests).toHaveLength(limits.checkoutPerWorkspace);
        expect(
          (
            await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
              f.workspace,
            ])
          ).rows[0].payment_checkout_count,
        ).toBe(limits.checkoutPerWorkspace);
        expect(
          (await f.pool.query('SELECT payment_checkout_count FROM mr_payment_rate_limits')).rows[0]
            .payment_checkout_count,
        ).toBe(limits.checkoutPerWorkspace);
        expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('checkout_pending');
        // The next window permits the same unresolved order, with identical create
        // identity/expiry/amount, even from a restarted PaymentStore instance.
        now += limits.windowMs;
        const restarted = new PaymentStore(f.pool, {
          livemode: false,
          creditInTransaction: fixtureCredit,
          now: () => now,
        });
        await restarted.checkout(f.workspace, order.id, f.transport);
        const last = f.requests.at(-1)!;
        expect(last).toMatchObject({
          stripeIdempotencyKey: f.requests[0]!.stripeIdempotencyKey,
          expiresAt: f.requests[0]!.expiresAt,
          amountCents: 1000,
          integrationIdentifier: f.requests[0]!.integrationIdentifier,
        });
        const cooldown = (
          await f.pool.query('SELECT checkout_next_request_at FROM mr_payment_orders WHERE id=$1', [
            order.id,
          ])
        ).rows[0].checkout_next_request_at;
        await f.paid();
        await f.store.reconcile(f.event(), f.transport);
        expect(
          (
            await f.pool.query(
              'SELECT checkout_next_request_at FROM mr_payment_orders WHERE id=$1',
              [order.id],
            )
          ).rows[0].checkout_next_request_at,
        ).toEqual(cooldown);
        expect(
          (await f.pool.query('SELECT payment_checkout_count FROM mr_payment_rate_limits')).rows[0]
            .payment_checkout_count,
        ).toBe(1);
      } finally {
        await f.close();
      }
    });

    it('caches known sessions and bounds later retrievals, preserving free authenticated status/history', async () => {
      let now = 1800000000000;
      const f = await paymentFixture({ now: () => now });
      try {
        const order = await f.order();
        let retrieves = 0;
        const transport = {
          ...f.transport,
          async retrieveSession(id: string) {
            retrieves++;
            return f.transport.retrieveSession(id);
          },
        };
        for (let retry = 0; retry < 10; retry++)
          expect((await f.store.checkout(f.workspace, order.id, transport)).status).toBe(
            'checkout_open',
          );
        expect(retrieves).toBe(0);
        now += limits.checkoutCooldownMs;
        await f.store.checkout(f.workspace, order.id, transport);
        expect(retrieves).toBe(1);
        await f.pool.query('UPDATE mr_workspaces SET payment_checkout_count=$2 WHERE id=$1', [
          f.workspace,
          limits.checkoutPerWorkspace,
        ]);
        // The cache remains readable even at cap; after cooldown there is no call.
        await f.store.checkout(f.workspace, order.id, transport);
        expect(retrieves).toBe(1);
        now += limits.checkoutCooldownMs;
        await expect(f.store.checkout(f.workspace, order.id, transport)).rejects.toMatchObject({
          statusCode: 429,
        });
        expect(retrieves).toBe(1);
        expect((await f.store.getOrder(f.workspace, order.id)).id).toBe(order.id);
        expect(await f.store.listOrders(f.workspace)).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it('installation external-call cap leaves a legitimate new order unstarted and retryable next window', async () => {
      let now = 1800000000000;
      const f = await paymentFixture({ now: () => now });
      try {
        const order = await f.store.createOrder(f.workspace, 1000, randomUUID());
        await f.pool.query(
          'UPDATE mr_payment_rate_limits SET payment_checkout_window=$1,payment_checkout_count=$2',
          [Math.floor(now / limits.windowMs), limits.checkoutPerInstallation],
        );
        await expect(f.store.checkout(f.workspace, order.id, f.transport)).rejects.toMatchObject({
          statusCode: 429,
        });
        expect(f.requests).toHaveLength(0);
        const before = (
          await f.pool.query('SELECT * FROM mr_payment_orders WHERE id=$1', [order.id])
        ).rows[0];
        expect(before).toMatchObject({
          status: 'created',
          checkout_started_at: null,
          checkout_next_request_at: null,
        });
        now += limits.windowMs;
        expect((await f.store.checkout(f.workspace, order.id, f.transport)).status).toBe(
          'checkout_open',
        );
        expect(f.requests).toHaveLength(1);
        expect(
          (await f.pool.query('SELECT payment_checkout_count FROM mr_payment_rate_limits')).rows[0]
            .payment_checkout_count,
        ).toBe(1);
      } finally {
        await f.close();
      }
    });
  },
);
