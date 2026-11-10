import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { StripeBillingTransport } from '../apps/server/src/billing-stripe.js';
import { StripeCheckoutTransport, STRIPE_API_VERSION } from '../apps/server/src/payments.js';
import type { CheckoutOrder } from '../packages/engine/src/payments.js';

const processorEnvironment = {
  id: 'fixture-environment',
  accountId: 'acct_fixture',
  livemode: false,
};
const publicUrl = 'https://opengen.example';
const order: CheckoutOrder = {
  id: 'fixture-order',
  workspaceId: 'fixture-workspace',
  amountCents: 500,
  creditMicros: 5000000,
  currency: 'USD',
  status: 'created',
  checkoutUrl: null,
  createdAt: '',
  updatedAt: '',
  creditedAt: null,
  requestVersion: 'checkout_hosted_page_v2',
  apiVersion: STRIPE_API_VERSION,
  stripeIdempotencyKey: 'fixture-new-checkout-v2',
  expiresAt: 2000000000,
  integrationIdentifier: 'opengen_topup_abcdefgh',
};

function wireFixture() {
  const requests: { body: string; headers: Headers }[] = [];
  // Versioned API boundary fixture, independent of SDK enum typing (which permits OtherString).
  // https://docs.stripe.com/api/checkout/sessions/create?api-version=2026-10-28.endive
  const documentedUiModes = new Set(['elements', 'embedded_page', 'form', 'hosted_page']);
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/account' && options?.method === 'GET')
      return Response.json({ id: processorEnvironment.accountId });
    if (url.pathname !== '/v1/checkout/sessions' || options?.method !== 'POST')
      throw new Error('Unexpected request in the offline Stripe contract fixture.');
    const body = String(options.body);
    const params = new URLSearchParams(body);
    requests.push({ body, headers: new Headers(options.headers) });
    if (!documentedUiModes.has(params.get('ui_mode') ?? 'hosted_page'))
      return Response.json(
        {
          error: {
            type: 'invalid_request_error',
            param: 'ui_mode',
            code: 'parameter_invalid_enum',
            message: 'Unsupported UI mode for the pinned API.',
          },
        },
        { status: 400 },
      );
    return Response.json({
      id: 'cs_test_fixture',
      mode: params.get('mode'),
      ui_mode: params.get('ui_mode') ?? 'hosted_page',
      currency: 'usd',
      amount_subtotal: 500,
      amount_total: 500,
      payment_status: 'unpaid',
      status: 'open',
      client_reference_id: params.get('client_reference_id'),
      payment_intent: null,
      livemode: false,
      url: 'https://checkout.stripe.com/c/pay/cs_test_fixture',
      customer: 'cus_fixture',
      invoice: 'in_fixture',
      setup_intent: 'seti_fixture',
    });
  };
  const sdk = new Stripe('fixture-only-no-credential', {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(fetcher),
  });
  const billing = new StripeBillingTransport(sdk, {
    enabled: true,
    processorEnvironment,
    publicUrl,
  });
  return { sdk, billing, requests };
}

describe('pinned Stripe hosted Checkout wire contract', () => {
  it.each(['manual', 'setup', 'invoice'] as const)(
    'serializes the documented hosted page enum for new %s requests',
    async (journey) => {
      const f = wireFixture();
      await f.billing.verifyProcessorEnvironment(() => {});
      const send = () =>
        journey === 'manual'
          ? new StripeCheckoutTransport(f.sdk, publicUrl).createSession(order)
          : journey === 'setup'
            ? f.billing.createSetup({
                processorEnvironment,
                requestVersion: 'setup_checkout_v2',
                apiVersion: STRIPE_API_VERSION,
                id: 'fixture-setup',
                customerId: 'cus_fixture',
                stripeIdempotencyKey: 'fixture-new-setup-v2',
                expiresAt: order.expiresAt,
                integrationIdentifier: 'opengen_setup_abcdefgh',
              })
            : f.billing.createManualInvoiceSession({
                ...order,
                processorEnvironment,
                requestVersion: 'customer_invoice_v3',
                id: 'fixture-invoice-order',
                stripeIdempotencyKey: 'fixture-new-invoice-v3',
                customerId: 'cus_fixture',
              });
      await send();
      await send();
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.body).toBe(f.requests[0]!.body);
      for (const request of f.requests) {
        const params = new URLSearchParams(request.body);
        expect(request.headers.get('Stripe-Version')).toBe('2026-10-28.endive');
        expect(params.get('ui_mode')).toBe('hosted_page');
        expect(params.get('mode')).toBe(journey === 'setup' ? 'setup' : 'payment');
        expect(request.headers.get('Idempotency-Key')).toBe(
          journey === 'setup'
            ? 'fixture-new-setup-v2'
            : journey === 'invoice'
              ? 'fixture-new-invoice-v3'
              : order.stripeIdempotencyKey,
        );
        expect(params.get('payment_method_types[0]')).toBeNull();
      }
    },
  );
  it('rejects historical or unknown serializer identities before any Checkout POST', async () => {
    const f = wireFixture();
    await f.billing.verifyProcessorEnvironment(() => {});
    await expect(
      new StripeCheckoutTransport(f.sdk, publicUrl).createSession({
        ...order,
        requestVersion: 'checkout_hosted_v1',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_checkout_request', statusCode: 409 });
    await expect(
      new StripeCheckoutTransport(f.sdk, publicUrl).createSession({
        ...order,
        requestVersion: 'future',
      } as never),
    ).rejects.toMatchObject({ code: 'unsupported_checkout_request' });
    await expect(
      f.billing.createSetup({
        processorEnvironment,
        requestVersion: 'setup_checkout_v1',
        apiVersion: STRIPE_API_VERSION,
      } as never),
    ).rejects.toMatchObject({ code: 'unsupported_billing_request' });
    await expect(
      f.billing.createManualInvoiceSession({
        ...order,
        processorEnvironment,
        requestVersion: 'customer_invoice_v2',
        customerId: 'cus_fixture',
      }),
    ).rejects.toMatchObject({ code: 'legacy_order_immutable' });
    expect(f.requests).toEqual([]);
  });
});
