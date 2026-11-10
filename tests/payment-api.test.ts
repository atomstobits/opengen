import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { Principal } from '@media-router/engine';
import type {
  CheckoutOrder,
  CheckoutSession,
  PaymentOrder,
} from '../packages/engine/src/payments.js';
import {
  createStripeClient,
  registerPayments,
  STRIPE_API_VERSION,
  StripeCheckoutTransport,
  type PaymentsOptions,
} from '../apps/server/src/payments.js';

const origin = 'https://opengen.example';
const workspaceId = 'workspace-a';
const secret = 'fixture-webhook-signing-secret';
const headers = { cookie: 'og_session=fixture-session', 'x-opengen-workspace': workspaceId };
const mutations = { ...headers, origin };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function order(): PaymentOrder {
  return {
    id: randomUUID(),
    workspaceId,
    amountCents: 2500,
    creditMicros: 25_000_000,
    currency: 'USD',
    status: 'created',
    checkoutUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    creditedAt: null,
  };
}
function setupStore() {
  const payment = order();
  const owned = async (workspace: string, id: string) => {
    if (workspace !== payment.workspaceId || id !== payment.id)
      throw Object.assign(new Error('Payment order not found.'), {
        statusCode: 404,
        code: 'not_found',
      });
    return payment;
  };
  const store = {
    createOrder: vi.fn(async () => payment),
    getOrder: vi.fn(owned),
    listOrders: vi.fn(async () => [payment]),
    hasBillingHold: vi.fn(async () => false),
    checkout: vi.fn(owned),
    reconcile: vi.fn(async () => ({ received: true as const })),
  };
  return { store, payment };
}
async function setup(overrides: Partial<PaymentsOptions> = {}) {
  const stripe = createStripeClient('fixture-server-only-credential');
  const { store, payment } = setupStore();
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const e = error as { name?: string; statusCode?: number; code?: string; message: string };
    const status = e.name === 'ZodError' ? 400 : (e.statusCode ?? 500);
    return reply.code(status).send({
      error: {
        code: e.name === 'ZodError' ? 'invalid_input' : e.code,
        message: status >= 500 ? 'Service could not complete this request.' : e.message,
      },
    });
  });
  const principal: Principal = {
    workspaceId,
    keyKind: 'browser',
    scopes: ['read'],
    role: 'member',
  };
  const authenticate = vi.fn(async () => principal);
  await registerPayments(app, {
    store,
    stripe,
    webhookSecret: secret,
    publicUrl: origin,
    livemode: false,
    authenticate,
    ...overrides,
  });
  // Prove that raw parsing is local to the Stripe webhook scope.
  app.post('/ordinary-json', async (request) => ({ parsed: request.body }));
  return { app, stripe, store, payment, authenticate };
}
function eventPayload(extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify(
      {
        id: 'evt_fixture_1',
        object: 'event',
        type: 'checkout.session.completed',
        api_version: STRIPE_API_VERSION,
        livemode: false,
        data: { object: { id: 'cs_test_fixture' } },
        ...extra,
      },
      null,
      2,
    ) + '\n'
  );
}
function signed(stripe: Stripe, payload: string, signingSecret = secret, timestamp?: number) {
  return {
    'content-type': 'application/json',
    'stripe-signature': stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      timestamp,
    }),
  };
}

describe('human billing authorization and request contracts', () => {
  it('requires a customer browser session, read scope and the selected workspace', async () => {
    const { app, authenticate, store } = await setup();
    expect((await app.inject({ url: '/v1/billing' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v1/billing',
          headers: { ...headers, authorization: 'Bearer fixture-agent' },
        })
      ).statusCode,
    ).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          url: '/v1/billing',
          headers: { ...headers, 'x-opengen-workspace': 'different' },
        })
      ).statusCode,
    ).toBe(409);
    expect(store.listOrders).not.toHaveBeenCalled();
    authenticate.mockResolvedValueOnce({
      workspaceId,
      scopes: ['read'],
      keyKind: 'browser',
      bootstrap: true,
    });
    expect((await app.inject({ url: '/v1/billing', headers })).statusCode).toBe(403);
    authenticate.mockResolvedValueOnce({ workspaceId, scopes: ['read'], keyKind: 'oauth' });
    expect((await app.inject({ url: '/v1/billing', headers })).statusCode).toBe(403);
    authenticate.mockResolvedValueOnce({ workspaceId, scopes: [], keyKind: 'browser' });
    expect((await app.inject({ url: '/v1/billing', headers })).statusCode).toBe(403);
    // Existing scoped workspace-key browser sessions remain usable.
    authenticate.mockResolvedValueOnce({ workspaceId, scopes: ['read'], keyKind: 'api' });
    const response = await app.inject({ url: '/v1/billing', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      workspaceId,
      enabled: true,
      billingHold: false,
      currency: 'USD',
      minAmountCents: 500,
      maxAmountCents: 100000,
    });
    expect(store.listOrders).toHaveBeenCalledWith(workspaceId);
  });

  it('shows disabled billing without credentials and refuses mutations before making an order', async () => {
    const { app, store } = await setup({ stripe: undefined, webhookSecret: undefined });
    expect((await app.inject({ url: '/v1/billing', headers })).json().enabled).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: mutations,
          payload: { amountCents: 2500 },
        })
      ).statusCode,
    ).toBe(503);
    expect(store.createOrder).not.toHaveBeenCalled();
    const missing = await setup({ store: undefined });
    expect((await missing.app.inject({ url: '/v1/billing', headers })).json()).toMatchObject({
      enabled: false,
      orders: [],
    });
  });

  it('requires the exact Origin and workspace precondition on mutations', async () => {
    const { app, store } = await setup();
    for (const originValue of [undefined, 'https://other.example', 'null']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/billing/orders',
        headers: {
          ...headers,
          ...(originValue ? { origin: originValue } : {}),
          'idempotency-key': 'fixture_retry_key',
        },
        payload: { amountCents: 2500 },
      });
      expect(response.statusCode).toBe(403);
    }
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/billing/orders',
      headers: {
        ...mutations,
        'x-opengen-workspace': 'other',
        'idempotency-key': 'fixture_retry_key',
      },
      payload: { amountCents: 2500 },
    });
    expect(changed.statusCode).toBe(409);
    expect(store.createOrder).not.toHaveBeenCalled();
  });

  it('rejects unbounded/noninteger amounts, client URLs and missing retry identity', async () => {
    const { app, store } = await setup();
    for (const payload of [
      { amountCents: 499 },
      { amountCents: 100001 },
      { amountCents: 500.5 },
      { amountCents: '2500' },
      { amountCents: Number.MAX_SAFE_INTEGER },
      { amountCents: 2500, successUrl: 'https://other.example' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/billing/orders',
            headers: { ...mutations, 'idempotency-key': 'fixture_retry_key' },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const key of ['', 'short', 'bad/key/identity', 'a'.repeat(129)]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/billing/orders',
            headers: { ...mutations, ...(key ? { 'idempotency-key': key } : {}) },
            payload: { amountCents: 2500 },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(store.createOrder).not.toHaveBeenCalled();
  });

  it('passes only the authenticated workspace to order creation and lookup', async () => {
    const { app, store, payment, authenticate } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/billing/orders',
      headers: { ...mutations, 'idempotency-key': 'fixture_retry_key' },
      payload: { amountCents: 2500 },
    });
    expect(created.statusCode).toBe(201);
    expect(store.createOrder).toHaveBeenCalledWith(workspaceId, 2500, 'fixture_retry_key');
    expect((await app.inject({ url: `/v1/billing/orders/${payment.id}`, headers })).json().id).toBe(
      payment.id,
    );
    authenticate.mockResolvedValueOnce({
      workspaceId: 'workspace-b',
      scopes: ['read'],
      keyKind: 'browser',
    });
    expect(
      (
        await app.inject({
          url: `/v1/billing/orders/${payment.id}`,
          headers: { ...headers, 'x-opengen-workspace': 'workspace-b' },
        })
      ).statusCode,
    ).toBe(404);
    expect(store.getOrder).toHaveBeenLastCalledWith('workspace-b', payment.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/billing/orders/${payment.id}/checkout`,
          headers: mutations,
          payload: { returnUrl: 'https://other.example' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/billing/orders/${payment.id}/checkout`,
          headers: mutations,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(store.checkout).toHaveBeenCalledWith(
      workspaceId,
      payment.id,
      expect.any(StripeCheckoutTransport),
    );
  });
});

describe('Stripe hosted Checkout request transport', () => {
  it('pins the verified API, stable retry key, face value and canonical return URLs', async () => {
    const stripe = createStripeClient('fixture-server-only-credential');
    expect(stripe.getApiField('version')).toBe(STRIPE_API_VERSION);
    const payment: CheckoutOrder = {
      ...order(),
      requestVersion: 'checkout_hosted_page_v2',
      apiVersion: STRIPE_API_VERSION,
      stripeIdempotencyKey: 'opengen-stable-fixture',
      expiresAt: 1_900_000_000,
      integrationIdentifier: 'opengen_topup_abcdefgh',
    };
    const session: CheckoutSession = {
      id: 'cs_test_fixture',
      mode: 'payment',
      currency: 'usd',
      amount_subtotal: payment.amountCents,
      amount_total: payment.amountCents,
      payment_status: 'unpaid',
      status: 'open',
      client_reference_id: payment.id,
      payment_intent: null,
      livemode: false,
      url: 'https://checkout.stripe.com/c/pay/fixture',
    };
    const create = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValue(session as never);
    const retrieve = vi
      .spyOn(stripe.checkout.sessions, 'retrieve')
      .mockResolvedValue(session as never);
    const transport = new StripeCheckoutTransport(stripe, origin);
    await transport.createSession(payment);
    await transport.createSession(payment);
    const expected = {
      mode: 'payment',
      ui_mode: 'hosted_page',
      client_reference_id: payment.id,
      success_url: `${origin}/billing?checkout=success&order=${payment.id}`,
      cancel_url: `${origin}/billing?checkout=cancel&order=${payment.id}`,
      expires_at: payment.expiresAt,
      integration_identifier: payment.integrationIdentifier,
      adaptive_pricing: { enabled: false },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 2500,
            product_data: { name: 'OpenGen prepaid service credit' },
          },
        },
      ],
    };
    expect(create).toHaveBeenNthCalledWith(1, expected, {
      idempotencyKey: payment.stripeIdempotencyKey,
      apiVersion: STRIPE_API_VERSION,
    });
    expect(create).toHaveBeenNthCalledWith(2, expected, {
      idempotencyKey: payment.stripeIdempotencyKey,
      apiVersion: STRIPE_API_VERSION,
    });
    expect(await transport.retrieveSession(session.id)).toBe(session);
    expect(retrieve).toHaveBeenCalledWith(session.id);
  });

  it('refuses noncanonical public URL configuration but permits local HTTP development', () => {
    const stripe = createStripeClient('fixture-server-only-credential');
    for (const url of [
      'http://opengen.example',
      'https://person:password@opengen.example',
      `${origin}/path`,
      `${origin}?return=evil`,
      `${origin}#fragment`,
    ])
      expect(() => new StripeCheckoutTransport(stripe, url)).toThrow('HTTPS origin');
    expect(() => new StripeCheckoutTransport(stripe, 'http://localhost:4320')).not.toThrow();
  });
});

describe('exact raw Stripe webhook signature verification', () => {
  it('fails closed for missing configuration, signature, wrong signature, tampered bytes and old timestamp', async () => {
    const { app, stripe, store } = await setup();
    const payload = eventPayload();
    const absent = await setup({ webhookSecret: undefined });
    expect(
      (
        await absent.app.inject({
          method: 'POST',
          url: '/webhooks/stripe',
          headers: signed(stripe, payload),
          payload,
        })
      ).statusCode,
    ).toBe(503);
    const cases = [
      { headers: { 'content-type': 'application/json' }, payload },
      { headers: signed(stripe, payload, 'different-fixture-secret'), payload },
      { headers: signed(stripe, payload), payload: payload + ' ' },
      { headers: signed(stripe, payload, secret, Math.floor(Date.now() / 1000) - 600), payload },
    ];
    for (const request of cases) {
      const response = await app.inject({ method: 'POST', url: '/webhooks/stripe', ...request });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_signature');
      expect(response.body).not.toContain(secret);
    }
    expect(store.reconcile).not.toHaveBeenCalled();
  });

  it('accepts a signed byte-exact fixture and never treats return URL traffic as credit authority', async () => {
    const { app, stripe, store } = await setup();
    const payload = eventPayload({ description: 'Unicode: 雪; preserve whitespace' });
    const construct = vi.spyOn(stripe.webhooks, 'constructEvent');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: signed(stripe, payload),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(construct.mock.calls[0]![0]).toEqual(Buffer.from(payload));
    expect(store.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt_fixture_1', type: 'checkout.session.completed' }),
      expect.any(StripeCheckoutTransport),
    );
    store.reconcile.mockClear();
    await app.inject({ url: '/v1/billing?checkout=success&order=cs_test_fixture', headers });
    expect(store.reconcile).not.toHaveBeenCalled();
    const ordinary = await app.inject({ method: 'POST', url: '/ordinary-json', payload: { a: 1 } });
    expect(ordinary.json()).toEqual({ parsed: { a: 1 } });
  });

  it('rejects live/Connect events in this isolated account environment', async () => {
    const { app, stripe, store } = await setup();
    for (const extra of [{ livemode: true }, { account: 'acct_fixture_other' }]) {
      const payload = eventPayload(extra);
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: signed(stripe, payload),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(store.reconcile).not.toHaveBeenCalled();
  });

  it('returns a retryable error when reconciliation has not completed and acknowledges duplicates', async () => {
    const { app, stripe, store } = await setup();
    const payload = eventPayload();
    store.reconcile.mockRejectedValueOnce(
      Object.assign(new Error('Upstream private fixture'), {
        statusCode: 503,
        code: 'payment_unresolved',
      }),
    );
    const failed = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: signed(stripe, payload),
      payload,
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('Upstream private fixture');
    store.reconcile.mockResolvedValueOnce({ received: true, duplicate: true } as never);
    const retry = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: signed(stripe, payload),
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ received: true, duplicate: true });
  });
});

it('pauses customer Checkout writes while reading orders and accepting signed fulfillment', async () => {
  const { app, stripe, store, payment } = await setup({ checkoutWritesEnabled: false });
  expect((await app.inject({ url: '/v1/billing', headers })).json()).toMatchObject({
    enabled: false,
    orders: [expect.objectContaining({ id: payment.id })],
  });
  expect((await app.inject({ url: `/v1/billing/orders/${payment.id}`, headers })).statusCode).toBe(
    200,
  );
  const denied = await app.inject({
    method: 'POST',
    url: '/v1/billing/orders',
    headers: { ...mutations, 'idempotency-key': 'pause-fixture' },
    payload: { amountCents: 2500 },
  });
  expect(denied.statusCode).toBe(503);
  expect(denied.json().error.code).toBe('checkout_paused');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/v1/billing/orders/${payment.id}/checkout`,
        headers: mutations,
        payload: {},
      })
    ).statusCode,
  ).toBe(503);
  expect(store.createOrder).not.toHaveBeenCalled();
  expect(store.checkout).not.toHaveBeenCalled();
  const payload = eventPayload();
  const webhook = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: signed(stripe, payload),
    payload,
  });
  expect(webhook.statusCode).toBe(200);
  expect(store.reconcile).toHaveBeenCalledTimes(1);
});
