import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBillingWebhookDispatcher } from '../apps/server/src/billing-webhook.js';
import {
  createStripeClient,
  registerPayments,
  STRIPE_API_VERSION,
} from '../apps/server/src/payments.js';
import type { VerifiedPaymentEvent } from '../packages/engine/src/payments.js';

const signingSecret = 'synthetic-billing-webhook-signing-secret';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
async function fixture(
  options: { webhookSecret?: string; livemode?: boolean; foreignRechargeTransport?: boolean } = {},
) {
  const sdk = createStripeClient('fixture-server-only-credential');
  const calls = {
    manual: vi.fn(async (event: VerifiedPaymentEvent) => ({
      received: true as const,
      ...(event.type.startsWith('invoice.') ? { ignored: true } : {}),
    })),
    setup: vi.fn(async () => ({ received: true as const })),
    recharge: vi.fn(async () => ({ received: true as const })),
    risk: vi.fn(async () => true),
    routeIntent: vi.fn(
      async (
        _event: VerifiedPaymentEvent,
        intentId: string,
      ): Promise<'manual' | 'automatic' | 'unmatched'> => {
        if (intentId === 'pi_ownedrecharge') return 'automatic';
        if (intentId === 'pi_manual') return 'manual';
        return 'unmatched';
      },
    ),
  };
  const processorEnvironment = {
    id: 'fixture-processor',
    accountId: 'acct_fixture',
    livemode: false,
  };
  const legacyTransport = {
    processorEnvironment,
    assertProcessorEnvironment: vi.fn(),
    createSession: vi.fn(),
    retrieveSession: vi.fn(),
  };
  const customerTransport = {
    processorEnvironment,
    assertProcessorEnvironment: vi.fn(),
    createCustomer: vi.fn(),
    retrieveCustomer: vi.fn(),
    createSetup: vi.fn(),
    retrieveSetup: vi.fn(),
    retrieveSetupIntent: vi.fn(),
    retrievePaymentMethod: vi.fn(),
    createPortal: vi.fn(),
    listDocuments: vi.fn(),
  };
  const rechargeTransport = {
    processorEnvironment: options.foreignRechargeTransport
      ? { ...processorEnvironment, accountId: 'acct_foreign' }
      : processorEnvironment,
    assertProcessorEnvironment: vi.fn(),
    createRecharge: vi.fn(),
    retrieveRecharge: vi.fn(),
  };
  const dispatch = createBillingWebhookDispatcher({
    payments: { reconcile: calls.manual },
    legacyTransport,
    customers: { reconcileSetup: calls.setup },
    customerTransport,
    recharge: { reconcile: calls.recharge, reconcileRisk: calls.risk },
    rechargeTransport,
    routeIntent: calls.routeIntent,
  });
  const boundary = vi.fn(async (event: VerifiedPaymentEvent) => dispatch(event));
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.setErrorHandler((cause, _request, reply) => {
    const e = cause as { statusCode?: number; code?: string; message: string };
    const status = e.statusCode ?? 500;
    return reply.code(status).send({
      error: {
        code: e.code,
        message: status >= 500 ? 'Payment reconciliation is pending.' : e.message,
      },
    });
  });
  await registerPayments(app, {
    publicUrl: 'https://opengen.example',
    livemode: options.livemode ?? false,
    stripe: sdk,
    webhookSecret: Object.prototype.hasOwnProperty.call(options, 'webhookSecret')
      ? options.webhookSecret
      : signingSecret,
    authenticate: async () => {
      throw new Error('The Stripe webhook must not use browser authority.');
    },
    store: {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      listOrders: vi.fn(),
      hasBillingHold: vi.fn(),
      checkout: vi.fn(),
      reconcile: boundary,
    },
  });
  const payload = (
    type: string,
    object: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    JSON.stringify(
      {
        id: `evt_fixture_${type.replaceAll('.', '_')}`,
        object: 'event',
        type,
        livemode: false,
        api_version: STRIPE_API_VERSION,
        data: { object },
        ...extra,
      },
      null,
      2,
    ) + '\n';
  const send = (raw: string, overrideHeaders: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sdk.webhooks.generateTestHeaderString({
          payload: raw,
          secret: signingSecret,
        }),
        ...overrideHeaders,
      },
    });
  return {
    app,
    processorEnvironment,
    sdk,
    calls,
    boundary,
    dispatch,
    legacyTransport,
    customerTransport,
    rechargeTransport,
    payload,
    send,
  };
}

describe('billing event dispatch behind the existing raw-byte signature boundary', () => {
  it('does not dispatch missing/wrong/tampered signatures or wrong account/environment', async () => {
    const f = await fixture();
    const raw = f.payload('payment_intent.succeeded', {
      id: 'pi_ownedrecharge',
      amount_received: 2500,
    });
    const rejected: { raw: string; header: Record<string, string> }[] = [
      { raw, header: { 'stripe-signature': '' } },
      {
        raw,
        header: {
          'stripe-signature': f.sdk.webhooks.generateTestHeaderString({
            payload: raw,
            secret: 'wrong-synthetic-secret',
          }),
        },
      },
      {
        raw: raw + ' ',
        header: {
          'stripe-signature': f.sdk.webhooks.generateTestHeaderString({
            payload: raw,
            secret: signingSecret,
          }),
        },
      },
      {
        raw: f.payload('payment_intent.succeeded', { id: 'pi_ownedrecharge' }, { livemode: true }),
        header: {},
      },
      {
        raw: f.payload(
          'payment_intent.succeeded',
          { id: 'pi_ownedrecharge' },
          { account: 'acct_unrelated' },
        ),
        header: {},
      },
    ];
    for (const request of rejected)
      expect((await f.send(request.raw, request.header)).statusCode).toBe(400);
    expect(f.boundary).not.toHaveBeenCalled();
    for (const call of Object.values(f.calls)) expect(call).not.toHaveBeenCalled();
  });
  it('requires matching trusted processor proofs before routing a valid signed event', async () => {
    const valid = await fixture();
    const spoofed = { id: 'payload-environment', accountId: 'acct_foreign', livemode: false };
    expect(
      (
        await valid.send(
          valid.payload(
            'payment_intent.succeeded',
            { id: 'pi_manual' },
            { processorEnvironment: spoofed },
          ),
        )
      ).statusCode,
    ).toBe(200);
    expect(valid.calls.routeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ processorEnvironment: valid.processorEnvironment }),
      'pi_manual',
    );
    expect(valid.customerTransport.assertProcessorEnvironment).toHaveBeenCalled();
    expect(valid.legacyTransport.assertProcessorEnvironment).toHaveBeenCalled();
    expect(valid.rechargeTransport.assertProcessorEnvironment).toHaveBeenCalled();
    const wrong = await fixture({ foreignRechargeTransport: true });
    expect(
      (await wrong.send(wrong.payload('payment_intent.succeeded', { id: 'pi_ownedrecharge' })))
        .statusCode,
    ).toBe(409);
    expect(wrong.calls.routeIntent).not.toHaveBeenCalled();
    expect(wrong.calls.recharge).not.toHaveBeenCalled();
  });
  it('fails closed before dispatch when the signing configuration is absent', async () => {
    const f = await fixture({ webhookSecret: undefined });
    expect(
      (await f.send(f.payload('checkout.session.completed', { id: 'cs_fixture', mode: 'setup' })))
        .statusCode,
    ).toBe(503);
    expect(f.boundary).not.toHaveBeenCalled();
  });
  it('routes only bound setup lifecycle/method events to CustomerStore after verifying exact UTF-8 bytes', async () => {
    const f = await fixture(),
      construct = vi.spyOn(f.sdk.webhooks, 'constructEvent');
    const raw = f.payload('checkout.session.completed', {
      id: 'cs_fixture',
      mode: 'setup',
      client_reference_id: 'local-setup-fixture',
      description: '雪 — preserve bytes',
    });
    expect((await f.send(raw)).statusCode).toBe(200);
    expect(construct.mock.calls[0]![0]).toEqual(Buffer.from(raw));
    expect(f.calls.setup).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'checkout.session.completed',
        data: { object: expect.objectContaining({ mode: 'setup' }) },
      }),
      f.customerTransport,
    );
    expect(
      (await f.send(f.payload('payment_method.detached', { id: 'pm_fixture' }))).statusCode,
    ).toBe(200);
    expect(f.calls.setup).toHaveBeenCalledTimes(2);
    expect(f.calls.manual).not.toHaveBeenCalled();
    expect(f.calls.recharge).not.toHaveBeenCalled();
    expect(f.calls.risk).not.toHaveBeenCalled();
    expect(f.calls.routeIntent).not.toHaveBeenCalled();
  });
  it('routes payment-intent success/failure to the existing automatic attempt reconciler without creating a payment', async () => {
    const f = await fixture();
    for (const type of [
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
      'payment_intent.processing',
    ]) {
      const response = await f.send(
        f.payload(type, { id: 'pi_ownedrecharge', amount: 2500, currency: 'usd' }),
      );
      expect(response.statusCode).toBe(200);
    }
    expect(f.calls.routeIntent).toHaveBeenCalledTimes(3);
    expect(f.calls.recharge).toHaveBeenCalledTimes(3);
    expect(f.calls.recharge).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'payment_intent.processing' }),
      f.rechargeTransport,
    );
    expect(f.calls.manual).not.toHaveBeenCalled();
    expect(f.calls.setup).not.toHaveBeenCalled();
    expect(f.rechargeTransport.createRecharge).not.toHaveBeenCalled();
    expect(f.legacyTransport.createSession).not.toHaveBeenCalled();
  });
  it('acknowledges a bound manual PI without invoking any funding reconciler', async () => {
    const f = await fixture();
    const response = await f.send(
      f.payload('payment_intent.succeeded', {
        id: 'pi_manual',
        amount_received: 2500,
        metadata: { kind: 'automatic', workspaceId: 'untrusted-workspace' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, ignored: true });
    expect(f.calls.routeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment_intent.succeeded' }),
      'pi_manual',
    );
    expect(f.calls.recharge).not.toHaveBeenCalled();
    expect(f.calls.manual).not.toHaveBeenCalled();
    expect(f.calls.setup).not.toHaveBeenCalled();
    expect(f.calls.risk).not.toHaveBeenCalled();
  });
  it('routes shared risk by bound ownership and leaves a no-PI receipt with legacy journaling', async () => {
    const f = await fixture();
    for (const [type, paymentIntent] of [
      ['charge.refunded', 'pi_ownedrecharge'],
      ['charge.dispute.created', { id: 'pi_ownedrecharge' }],
      ['refund.created', 'pi_ownedrecharge'],
      ['refund.updated', 'pi_ownedrecharge'],
      ['refund.failed', 'pi_ownedrecharge'],
    ] as const) {
      const response = await f.send(
        f.payload(type, { id: 'risk_fixture', payment_intent: paymentIntent }),
      );
      expect(response.statusCode).toBe(200);
      expect(f.calls.routeIntent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type }),
        'pi_ownedrecharge',
      );
    }
    expect(f.calls.risk).toHaveBeenCalledTimes(5);
    expect(f.calls.manual).not.toHaveBeenCalled();
    expect(
      (await f.send(f.payload('charge.refunded', { id: 'ch_manual', payment_intent: 'pi_manual' })))
        .statusCode,
    ).toBe(200);
    expect(f.calls.manual).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { object: { id: 'ch_manual', payment_intent: 'pi_manual' } },
      }),
      expect.objectContaining({ processorEnvironment: f.processorEnvironment }),
    );
    f.calls.routeIntent.mockClear();
    f.calls.manual.mockRejectedValueOnce(
      Object.assign(new Error('Unmatched risk receipt'), {
        code: 'unmatched_payment',
        statusCode: 503,
      }),
    );
    expect(
      (
        await f.send(
          f.payload('charge.dispute.created', { id: 'dp_missing_pi', payment_intent: null }),
        )
      ).statusCode,
    ).toBe(503);
    expect(f.calls.manual).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { object: { id: 'dp_missing_pi', payment_intent: null } } }),
      expect.objectContaining({ processorEnvironment: f.processorEnvironment }),
    );
    expect(f.calls.routeIntent).not.toHaveBeenCalled();
    expect(f.calls.recharge).not.toHaveBeenCalled();
    expect(f.calls.risk).toHaveBeenCalledTimes(5);
  });
  it('keeps an automatic risk receipt retryable if its owned hold target cannot reconcile', async () => {
    const f = await fixture();
    f.calls.risk.mockResolvedValueOnce(false);
    const response = await f.send(
      f.payload('charge.refunded', { id: 'ch_risk_pending', payment_intent: 'pi_ownedrecharge' }),
    );
    expect(response.statusCode).toBe(503);
    expect(f.calls.routeIntent).toHaveBeenCalledOnce();
    expect(f.calls.risk).toHaveBeenCalledOnce();
    expect(f.calls.manual).not.toHaveBeenCalled();
    expect(f.calls.recharge).not.toHaveBeenCalled();
  });
  it('does not interpret unsupported Checkout modes or event families as payment or setup', async () => {
    const f = await fixture();
    for (const [type, mode] of [
      ['checkout.session.completed', 'subscription'],
      ['checkout.session.completed', 'future_mode'],
      ['checkout.session.completed', undefined],
      ['checkout.session.async_payment_succeeded', 'setup'],
      ['checkout.session.unrecognized', 'payment'],
    ] as const) {
      const response = await f.send(
        f.payload(type, {
          id: 'cs_unsupported',
          mode,
          payment_status: 'paid',
          status: 'complete',
          payment_intent: 'pi_ownedrecharge',
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true, ignored: true });
    }
    for (const call of Object.values(f.calls)) expect(call).not.toHaveBeenCalled();
  });
  it('retains manual Checkout routing and never turns an invoice/document event into an automatic credit path', async () => {
    const f = await fixture();
    expect(
      (await f.send(f.payload('checkout.session.completed', { id: 'cs_manual', mode: 'payment' })))
        .statusCode,
    ).toBe(200);
    expect(f.calls.manual).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'checkout.session.completed' }),
      expect.objectContaining({ processorEnvironment: f.processorEnvironment }),
    );
    f.calls.manual.mockClear();
    for (const type of ['invoice.paid', 'invoice.payment_succeeded', 'invoice.finalized']) {
      const response = await f.send(
        f.payload(type, { id: 'in_fixture', payment_intent: 'pi_ownedrecharge', status: 'paid' }),
      );
      expect(response.json()).toEqual({ received: true, ignored: true });
    }
    expect(f.calls.recharge).not.toHaveBeenCalled();
    expect(f.calls.setup).not.toHaveBeenCalled();
    expect(f.calls.routeIntent).not.toHaveBeenCalled();
    expect(f.rechargeTransport.createRecharge).not.toHaveBeenCalled();
  });
  it('preserves duplicate acknowledgements from an already bound automatic payment', async () => {
    const f = await fixture();
    f.calls.recharge.mockResolvedValueOnce({ received: true, duplicate: true } as never);
    expect(
      (await f.send(f.payload('payment_intent.succeeded', { id: 'pi_ownedrecharge' }))).json(),
    ).toEqual({ received: true, duplicate: true });
    expect(f.calls.manual).not.toHaveBeenCalled();
  });
  it('keeps unmatched PI and risk retryable even with plausible local metadata', async () => {
    const f = await fixture();
    const metadata = {
      workspaceId: 'workspace-a',
      kind: 'automatic',
      attemptId: 'recharge-a',
      orderId: 'order-a',
    };
    for (const [type, object] of [
      ['payment_intent.succeeded', { id: 'pi_unknown', metadata }],
      ['charge.refunded', { id: 'ch_unknown', payment_intent: 'pi_unknown', metadata }],
    ] as const) {
      const response = await f.send(f.payload(type, object));
      expect(response.statusCode).toBe(503);
      expect(f.calls.routeIntent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type }),
        'pi_unknown',
      );
    }
    f.calls.routeIntent.mockRejectedValueOnce(
      Object.assign(new Error('Private external fixture payload'), {
        code: 'unmatched_payment_intent',
        statusCode: 503,
      }),
    );
    const pending = await f.send(
      f.payload('payment_intent.succeeded', { id: 'pi_unbound_pending', metadata }),
    );
    expect(pending.statusCode).toBe(503);
    expect(pending.body).not.toContain('Private external fixture');
    expect(f.calls.manual).not.toHaveBeenCalled();
    expect(f.calls.recharge).not.toHaveBeenCalled();
    expect(f.calls.risk).not.toHaveBeenCalled();
    expect(f.rechargeTransport.createRecharge).not.toHaveBeenCalled();
  });
  it('leaves a genuine but unbound setup session retryable instead of treating it as paid Checkout', async () => {
    const f = await fixture();
    f.calls.setup.mockRejectedValueOnce(
      Object.assign(new Error('Unknown original setup'), {
        code: 'setup_unmatched',
        statusCode: 503,
      }),
    );
    const response = await f.send(
      f.payload('checkout.session.completed', {
        id: 'cs_unknown',
        mode: 'setup',
        payment_status: 'paid',
        client_reference_id: 'local-setup-fixture',
      }),
    );
    expect(response.statusCode).toBe(503);
    expect(f.calls.setup).toHaveBeenCalledOnce();
    expect(f.calls.routeIntent).not.toHaveBeenCalled();
    expect(f.calls.manual).not.toHaveBeenCalled();
  });
});
