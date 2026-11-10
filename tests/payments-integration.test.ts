import { privateStorageFixture } from './helpers/private-storage';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEngine,
  creditWorkspaceInTransaction,
  PaymentStore,
  PaymentError,
  type AccountStore,
  type CheckoutSession,
  type PaymentTransport,
  type Principal,
} from '@media-router/engine';
import { operationTargets, type GenerateInput } from '@media-router/contracts';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import { paymentConfiguration } from '../apps/server/src/payment-config';
import {
  createStripeClient,
  STRIPE_API_VERSION,
  type PaymentsOptions,
} from '../apps/server/src/payments';
import { createForwarder } from '../apps/web/app/proxy';
import { nativeRoute, registeredBackendPath } from '../apps/web/app/registered-http';
import { paymentFixture } from './payment-fixture';

const origin = 'https://opengen.example';
const signingSecret = 'fixture-signing-secret';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
function browserEngine(): EngineLike {
  const principal: Principal = { workspaceId: 'customer', keyKind: 'browser', scopes: ['read'] };
  return {
    accounts: { session: vi.fn(async () => principal) } as unknown as AccountStore,
    getExecutableRouteIds: () => [],
    submit: async () => {
      throw new Error('No generation expected.');
    },
    getJob: async () => null,
    listJobs: async () => [],
    cancel: async () => null,
    getBalance: async () => ({}),
    routeMetrics: async () => [],
  };
}
function fakePayments() {
  return {
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    listOrders: vi.fn(async () => []),
    hasBillingHold: vi.fn(async () => false),
    checkout: vi.fn(),
    reconcile: vi.fn(async () => ({ received: true as const })),
  };
}
async function paymentApp(config?: Pick<PaymentsOptions, 'stripe' | 'livemode' | 'webhookSecret'>) {
  const store = fakePayments();
  const app = await buildApp({
    env: {},
    publicUrl: origin,
    engine: browserEngine(),
    payments: store,
    paymentConfig: config ?? { livemode: false },
  });
  apps.push(app);
  return { app, store };
}

describe('payment mounting and server-only configuration', () => {
  it('returns durable rate-limit retry guidance without starting another payment', async () => {
    const { app, store } = await paymentApp({
      stripe: createStripeClient('fixture'),
      webhookSecret: signingSecret,
      livemode: false,
    });
    store.createOrder.mockRejectedValue(
      new PaymentError('payment_rate_limited', 'Wait and resume the same order.', 429, 61),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/billing/orders',
      headers: {
        cookie: 'og_session=fixture-session',
        'x-opengen-workspace': 'customer',
        origin,
        'idempotency-key': 'fixture-topup-key',
      },
      payload: { amountCents: 1000 },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('61');
    expect(response.json().error.code).toBe('payment_rate_limited');
    expect(store.checkout).not.toHaveBeenCalled();
  });
  it('defaults to disabled sandbox and requires an exact live-mode flag with matching server key', () => {
    expect(paymentConfiguration({})).toEqual({ livemode: false });
    const key = ['rk', 'test', 'fixture'].join('_');
    expect(paymentConfiguration({ STRIPE_SECRET_KEY: key })).toEqual({ livemode: false });
    const configured = paymentConfiguration({
      STRIPE_SECRET_KEY: key,
      STRIPE_WEBHOOK_SECRET: signingSecret,
      STRIPE_LIVEMODE: 'false',
    });
    expect(configured.livemode).toBe(false);
    expect(configured.stripe!.getApiField('version')).toBe(STRIPE_API_VERSION);
    for (const value of ['False', '0', '', 'true '])
      expect(() => paymentConfiguration({ STRIPE_LIVEMODE: value })).toThrow(
        'exactly true or false',
      );
    expect(() =>
      paymentConfiguration({
        STRIPE_SECRET_KEY: key,
        STRIPE_WEBHOOK_SECRET: signingSecret,
        STRIPE_LIVEMODE: 'true',
      }),
    ).toThrow('match');
    expect(() =>
      paymentConfiguration({
        STRIPE_SECRET_KEY: ['rk', 'live', 'fixture'].join('_'),
        STRIPE_WEBHOOK_SECRET: signingSecret,
      }),
    ).toThrow('match');
  });
  it('mounts private billing history while checkout and webhooks fail closed without Stripe secrets', async () => {
    const { app, store } = await paymentApp();
    const headers = { cookie: 'og_session=fixture-session', 'x-opengen-workspace': 'customer' };
    expect((await app.inject({ url: '/v1/billing', headers })).json()).toMatchObject({
      enabled: false,
      workspaceId: 'customer',
      orders: [],
    });
    const disabled = await app.inject({
      method: 'POST',
      url: '/v1/billing/orders',
      headers: { ...headers, origin, 'idempotency-key': 'fixture-topup-key' },
      payload: { amountCents: 1000 },
    });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error.code).toBe('payments_unavailable');
    expect(store.createOrder).not.toHaveBeenCalled();
    const webhook = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(webhook.statusCode).toBe(503);
    expect(webhook.json().error.code).toBe('webhook_not_configured');
    expect(store.reconcile).not.toHaveBeenCalled();
  });
  it('authenticates direct raw webhooks by signature independently of cookie Origin checks', async () => {
    const stripe = createStripeClient('fixture-server-only-credential');
    const { app, store } = await paymentApp({
      stripe,
      webhookSecret: signingSecret,
      livemode: false,
    });
    const payload =
      JSON.stringify(
        {
          id: 'evt_fixture_exact_bytes',
          object: 'event',
          api_version: STRIPE_API_VERSION,
          type: 'checkout.session.completed',
          livemode: false,
          data: { object: { id: 'cs_test_fixture' } },
        },
        null,
        2,
      ) + '\n';
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret });
    const headers = {
      'content-type': 'application/json',
      'stripe-signature': signature,
      origin: 'https://unrelated.example',
    };
    const verified = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers,
      payload,
    });
    expect(verified.statusCode).toBe(200);
    expect(store.reconcile).toHaveBeenCalledOnce();
    const tampered = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers,
      payload: payload + ' ',
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe('invalid_signature');
    expect(store.reconcile).toHaveBeenCalledOnce();
    const prefixed = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe/extra',
      headers,
      payload,
    });
    expect(prefixed.statusCode).toBe(403);
    const mutation = await app.inject({
      method: 'POST',
      url: '/v1/billing/orders',
      headers: {
        ...headers,
        cookie: 'og_session=fixture-session',
        'x-opengen-workspace': 'customer',
      },
      payload: { amountCents: 1000 },
    });
    expect(mutation.statusCode).toBe(403);
  });
  it('forwards selected workspace headers through fixed human billing routes and excludes manual funding from MCP targets', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const forward = createForwarder({
      env: { MEDIA_ROUTER_API_URL: 'https://gateway.example' },
      transport: async () => undefined,
      request,
    });
    const response = await forward(
      new Request(`${origin}/api/billing/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'og_session=fixture-session',
          origin,
          'x-opengen-workspace': 'customer',
          'idempotency-key': 'fixture-topup-key',
        },
        body: JSON.stringify({ amountCents: 1000 }),
      }),
      '/v1/billing/orders',
    );
    expect(response.status).toBe(200);
    const headers = new Headers(request.mock.calls[0]![1]!.headers);
    expect(headers.get('x-opengen-workspace')).toBe('customer');
    expect(headers.get('cookie')).toBe('og_session=fixture-session');
    expect(headers.get('origin')).toBe(origin);
    expect(headers.get('idempotency-key')).toBe('fixture-topup-key');
    expect(nativeRoute('/v1/billing/orders')).toMatchObject({ methods: ['POST'] });
    expect(nativeRoute('/v1/billing/orders/fixture/checkout')).toMatchObject({ methods: ['POST'] });
    expect(registeredBackendPath('/webhooks/stripe', 'POST')).toBe(true);
    expect(
      Object.values(operationTargets).some(
        ({ path }) => path === '/v1/billing' || path.startsWith('/v1/billing/orders'),
      ),
    ).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'payments use shared ledger and admission transactions',
  () => {
    it('credits a verified payment once with the real shared helper on a one-connection pool', async () => {
      const f = await paymentFixture({ max: 1, credit: creditWorkspaceInTransaction });
      try {
        const order = await f.order();
        await f.paid();
        const event = f.event();
        await Promise.all([
          f.store.reconcile(event, f.transport),
          f.store.reconcile(event, f.transport),
        ]);
        expect(
          (
            await f.pool.query(
              'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1',
              [f.workspace],
            )
          ).rows[0],
        ).toEqual({ available_micros: String(order.creditMicros), reserved_micros: '0' });
        const ledger = await f.pool.query(
          "SELECT amount_micros,reference FROM mr_ledger WHERE workspace_id=$1 AND kind='credit'",
          [f.workspace],
        );
        expect(ledger.rows).toEqual([
          { amount_micros: String(order.creditMicros), reference: `stripe-topup:${order.id}` },
        ]);
        expect((await f.store.getOrder(f.workspace, order.id)).status).toBe('credited');
      } finally {
        await f.close();
      }
    });
    it('blocks managed and BYOK new admission on a risk hold while replay and accepted workers continue', async () => {
      const routeId = 'alibaba/ap-southeast-1/wan-3.0';
      const submit = vi.fn(async () => ({ upstreamId: 'fixture-accepted' }));
      const poll = vi.fn(async () => ({ status: 'succeeded' as const, billedCostMicros: 150000 }));
      const schema = `payment_admission_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
      databaseUrl.searchParams.set(
        'options',
        `${databaseUrl.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
      );
      const engine = createEngine({
        storage: privateStorageFixture(),
        databaseUrl: databaseUrl.toString(),
        poolSize: 1,
        publicUrl: origin,
        adapters: [{ id: 'alibaba', isConfigured: (route) => route.id === routeId, submit, poll }],
        pollIntervalMs: 0,
      });
      const workspace = `payment-hold-${randomUUID()}`;
      let schemaCreated = false;
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        schemaCreated = true;
        // PGlite ignores startup connection options; one pooled connection keeps this SET scoped.
        await engine.pool.query(`SET search_path TO ${schema}`);
        await engine.initialize();
        await engine.ensureWorkspace(workspace, 10000000);
        const store = new PaymentStore(engine.pool, {
          creditInTransaction: creditWorkspaceInTransaction,
          livemode: false,
        });
        const input: GenerateInput = {
          modelId: 'alibaba/wan-3.0',
          operation: 'text-to-video',
          routeId,
          input: { prompt: 'A calm sea.', resolution: '720p', duration: 2 },
        };
        const accepted = await engine.submit({
          workspaceId: workspace,
          idempotencyKey: 'accepted-before-hold',
          input,
        });
        const order = await store.createOrder(workspace, 1000, 'fixture-order-key');
        let session: CheckoutSession = {
          id: `cs_test_${randomUUID().replaceAll('-', '')}`,
          mode: 'payment',
          currency: 'usd',
          amount_subtotal: 1000,
          amount_total: 1000,
          payment_status: 'unpaid',
          status: 'open',
          client_reference_id: order.id,
          payment_intent: null,
          livemode: false,
          url: 'https://checkout.stripe.com/c/pay/fixture',
        };
        const transport: PaymentTransport = {
          createSession: async () => ({ ...session }),
          retrieveSession: async () => ({ ...session }),
        };
        await store.checkout(workspace, order.id, transport);
        session = {
          ...session,
          payment_status: 'paid',
          status: 'complete',
          payment_intent: `pi_${randomUUID().replaceAll('-', '')}`,
        };
        await store.reconcile(
          {
            id: `evt_${randomUUID()}`,
            type: 'checkout.session.completed',
            livemode: false,
            data: { object: { ...session } },
          },
          transport,
        );
        await store.reconcile(
          {
            id: `evt_${randomUUID()}`,
            type: 'charge.refunded',
            livemode: false,
            data: { object: { id: 'ch_fixture', payment_intent: session.payment_intent } },
          },
          transport,
        );
        expect(await store.hasBillingHold(workspace)).toBe(true);
        for (const billing of ['managed', 'byok'] as const)
          await expect(
            engine.submit({
              workspaceId: workspace,
              idempotencyKey: `new-held-${billing}`,
              input: { ...input, billing },
            }),
          ).rejects.toMatchObject({ code: 'billing_hold', statusCode: 409 });
        expect(
          (
            await engine.submit({
              workspaceId: workspace,
              idempotencyKey: 'accepted-before-hold',
              input,
            })
          ).id,
        ).toBe(accepted.id);
        expect(await engine.listJobs(workspace)).toHaveLength(1);
        await engine.workOnce();
        await engine.workOnce();
        expect(submit).toHaveBeenCalledOnce();
        expect(poll).toHaveBeenCalledOnce();
        expect(await engine.getJob(workspace, accepted.id)).toMatchObject({
          status: 'succeeded',
          settledMicros: 150000,
        });
        expect((await engine.getBalance(workspace)).reservedMicros).toBe(0);
        expect(await store.hasBillingHold(workspace)).toBe(true);
      } finally {
        await engine.close();
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        // PGlite shares backend session settings across wire connections.
        await admin.query('SET search_path TO public');
        await admin.end();
      }
    });
  },
);
