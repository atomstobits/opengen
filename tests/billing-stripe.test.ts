import { BILLING_STRIPE_API_VERSION } from '../packages/engine/src/billing-customer.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StripeBillingTransport,
  type ManualInvoiceOrderV2,
  type BillingStripeGate,
} from '../apps/server/src/billing-stripe.js';
import { createStripeClient, StripeCheckoutTransport } from '../apps/server/src/payments.js';

const stripe = () => createStripeClient('fixture-server-only-credential');
const processorEnvironment = {
  id: 'fixture-stripe-environment',
  accountId: 'acct_fixture',
  livemode: false,
};
const gate = {
  enabled: true,
  processorEnvironment,
  publicUrl: 'https://opengen.example',
  portalConfigurationId: 'bpc_fixture',
};
afterEach(() => vi.restoreAllMocks());
async function verifiedTransport(
  sdk: ReturnType<typeof stripe>,
  options: BillingStripeGate = gate,
) {
  vi.spyOn(sdk.accounts, 'retrieve').mockResolvedValue({
    id: options.processorEnvironment.accountId,
  } as never);
  const transport = new StripeBillingTransport(sdk, options);
  await transport.verifyProcessorEnvironment(() => {}); // Explicit synthetic trusted context.
  return transport;
}

describe('injectable Stripe billing lifecycle transport', () => {
  it('fails closed without the explicit integration gate', async () => {
    const sdk = stripe();
    const create = vi.spyOn(sdk.customers, 'create');
    const transport = new StripeBillingTransport(sdk, { ...gate, enabled: false });
    await expect(
      transport.createCustomer({
        processorEnvironment,
        requestVersion: 'customer_v1',
        apiVersion: BILLING_STRIPE_API_VERSION,
        id: 'local-fixture',
        stripeIdempotencyKey: 'customer-fixture',
      }),
    ).rejects.toMatchObject({ code: 'billing_integration_disabled' });
    await expect(
      transport.createRecharge({
        processorEnvironment,
        requestVersion: 'recharge_pi_v1',
        apiVersion: BILLING_STRIPE_API_VERSION,
        id: 'r',
        customerId: 'cus_fixture',
        paymentMethodId: 'pm_fixture',
        amountCents: 1000,
        stripeIdempotencyKey: 'retry',
      }),
    ).rejects.toMatchObject({ code: 'billing_integration_disabled' });
    expect(create).not.toHaveBeenCalled();
  });
  it('wraps the existing Checkout serializer with proof from the same SDK instance', async () => {
    const sdk = stripe();
    const account = vi
      .spyOn(sdk.accounts, 'retrieve')
      .mockResolvedValue({ id: processorEnvironment.accountId } as never);
    const create = vi
      .spyOn(sdk.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_fixture' } as never);
    const retrieve = vi
      .spyOn(sdk.checkout.sessions, 'retrieve')
      .mockResolvedValue({ id: 'cs_fixture' } as never);
    const transport = new StripeBillingTransport(sdk, gate);
    const legacy = transport.verifiedLegacyCheckoutTransport();
    const order = {
      id: 'legacy-fixture',
      workspaceId: 'workspace-fixture',
      amountCents: 500,
      creditMicros: 5000000,
      currency: 'USD' as const,
      status: 'created' as const,
      checkoutUrl: null,
      createdAt: '',
      updatedAt: '',
      creditedAt: null,
      requestVersion: 'checkout_hosted_page_v2' as const,
      apiVersion: BILLING_STRIPE_API_VERSION,
      stripeIdempotencyKey: 'legacy-fixture-key',
      expiresAt: 2000000000,
      integrationIdentifier: 'opengen_fixture',
    };
    expect(legacy.processorEnvironment).toEqual(processorEnvironment);
    expect(account).not.toHaveBeenCalled();
    await expect(legacy.createSession(order)).rejects.toMatchObject({
      code: 'processor_environment_unverified',
    });
    await expect(legacy.retrieveSession('cs_fixture')).rejects.toMatchObject({
      code: 'processor_environment_unverified',
    });
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    await transport.verifyProcessorEnvironment(() => {});
    legacy.assertProcessorEnvironment();
    await legacy.createSession(order);
    await new StripeCheckoutTransport(sdk, gate.publicUrl).createSession(order);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(await legacy.retrieveSession('cs_fixture')).toMatchObject({ id: 'cs_fixture' });
    expect(account).toHaveBeenCalledTimes(1);
  });
  it('requires live charges readiness from the same verified account read', async () => {
    const sdk = stripe();
    const account = vi
      .spyOn(sdk.accounts, 'retrieve')
      .mockRejectedValue(new Error('Unexpected mocked account request'));
    const create = vi
      .spyOn(sdk.checkout.sessions, 'create')
      .mockRejectedValue(new Error('Unexpected mocked Checkout write'));
    const live = new StripeBillingTransport(sdk, {
      ...gate,
      processorEnvironment: { ...processorEnvironment, livemode: true },
    });
    account.mockResolvedValueOnce({
      id: processorEnvironment.accountId,
      charges_enabled: false,
    } as never);
    await expect(live.verifyProcessorEnvironment(() => {})).rejects.toMatchObject({
      code: 'processor_account_not_ready',
    });
    expect(() => live.assertProcessorEnvironment()).toThrow();
    account.mockResolvedValueOnce({ id: processorEnvironment.accountId } as never);
    await expect(live.verifyProcessorEnvironment(() => {})).rejects.toMatchObject({
      code: 'processor_account_not_ready',
    });
    account.mockResolvedValueOnce({
      id: processorEnvironment.accountId,
      charges_enabled: true,
    } as never);
    await live.verifyProcessorEnvironment(() => {});
    expect(() => live.assertProcessorEnvironment()).not.toThrow();
    expect(account).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
  });

  it('requires explicit trusted context and an exact account read before outbound billing', async () => {
    const sdk = stripe();
    const account = vi
      .spyOn(sdk.accounts, 'retrieve')
      .mockResolvedValue({ id: 'acct_other' } as never);
    const retrieve = vi.spyOn(sdk.customers, 'retrieve');
    const transport = new StripeBillingTransport(sdk, gate);
    await expect(transport.retrieveCustomer('cus_fixture')).rejects.toMatchObject({
      code: 'processor_environment_unverified',
    });
    expect(account).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    await expect(
      transport.verifyProcessorEnvironment(() => {
        throw new Error('untrusted configuration');
      }),
    ).rejects.toMatchObject({ code: 'processor_environment_unverified' });
    expect(account).not.toHaveBeenCalled();
    await expect(transport.verifyProcessorEnvironment(() => {})).rejects.toMatchObject({
      code: 'processor_environment_mismatch',
    });
    expect(account).toHaveBeenCalledWith(
      null,
      {},
      { apiVersion: BILLING_STRIPE_API_VERSION, maxNetworkRetries: 0 },
    );
    await expect(transport.retrieveCustomer('cus_fixture')).rejects.toMatchObject({
      code: 'processor_environment_unverified',
    });
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('rejects same-mode foreign sandbox requests and preserves the original serializer after verified key rotation', async () => {
    const firstSdk = stripe(),
      secondSdk = stripe();
    const first = await verifiedTransport(firstSdk),
      second = await verifiedTransport(secondSdk);
    const oldCreate = vi
      .spyOn(firstSdk.customers, 'create')
      .mockResolvedValue({ id: 'cus_fixture', livemode: false } as never);
    const newCreate = vi
      .spyOn(secondSdk.customers, 'create')
      .mockResolvedValue({ id: 'cus_fixture', livemode: false } as never);
    const request = {
      processorEnvironment,
      requestVersion: 'customer_v1' as const,
      apiVersion: BILLING_STRIPE_API_VERSION,
      id: 'local-fixture',
      stripeIdempotencyKey: 'stable-original-key',
    };
    await expect(
      first.createCustomer({
        ...request,
        processorEnvironment: { ...processorEnvironment, id: 'fixture-other-sandbox' },
      }),
    ).rejects.toMatchObject({ code: 'processor_environment_mismatch' });
    expect(oldCreate).not.toHaveBeenCalled();
    await first.createCustomer(request);
    await second.createCustomer(request);
    expect(newCreate.mock.calls[0]).toEqual(oldCreate.mock.calls[0]);
  });
  it('uses owned Customer creation and stable request identity without customer PII', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const create = vi
      .spyOn(sdk.customers, 'create')
      .mockResolvedValue({ id: 'cus_fixture', livemode: false } as never);
    const request = {
      processorEnvironment,
      requestVersion: 'customer_v1' as const,
      apiVersion: BILLING_STRIPE_API_VERSION,
      id: 'binding_fixture',
      stripeIdempotencyKey: 'customer_fixture_stable',
    };
    await transport.createCustomer(request);
    await transport.createCustomer(request);
    expect(create).toHaveBeenNthCalledWith(
      1,
      { metadata: { opengen_billing_reference: request.id } },
      { idempotencyKey: request.stripeIdempotencyKey, apiVersion: BILLING_STRIPE_API_VERSION },
    );
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });
  it('creates hosted setup with customer, USD/dynamic defaults and fixed return URLs', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const create = vi.spyOn(sdk.checkout.sessions, 'create').mockResolvedValue({
      id: 'cs_fixture',
      customer: { id: 'cus_fixture' },
      setup_intent: { id: 'seti_fixture' },
      livemode: false,
      mode: 'setup',
      status: 'open',
      client_reference_id: 'setup_fixture',
      url: 'https://checkout.stripe.com/c/setup/fixture',
    } as never);
    const result = await transport.createSetup({
      processorEnvironment,
      requestVersion: 'setup_checkout_v2',
      apiVersion: BILLING_STRIPE_API_VERSION,
      id: 'setup_fixture',
      customerId: 'cus_fixture',
      stripeIdempotencyKey: 'setup_stable',
      expiresAt: 2000000000,
      integrationIdentifier: 'opengen_setup_abcdefgh',
    });
    expect(create).toHaveBeenCalledWith(
      {
        mode: 'setup',
        ui_mode: 'hosted_page',
        customer: 'cus_fixture',
        currency: 'usd',
        client_reference_id: 'setup_fixture',
        expires_at: 2000000000,
        integration_identifier: 'opengen_setup_abcdefgh',
        success_url: `${gate.publicUrl}/billing?setup=success&request=setup_fixture`,
        cancel_url: `${gate.publicUrl}/billing?setup=cancel&request=setup_fixture`,
      },
      { idempotencyKey: 'setup_stable', apiVersion: BILLING_STRIPE_API_VERSION },
    );
    expect(result).toMatchObject({ customer: 'cus_fixture', setup_intent: 'seti_fixture' });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('setup_intent_data.usage');
    expect(create.mock.calls[0]![0]).not.toHaveProperty('payment_method_types');
  });
  it('rejects unsupported persisted request or API versions before any SDK POST', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const create = vi.spyOn(sdk.customers, 'create');
    const setup = vi.spyOn(sdk.checkout.sessions, 'create');
    const recharge = vi.spyOn(sdk.paymentIntents, 'create');
    await expect(
      transport.createCustomer({
        processorEnvironment,
        requestVersion: 'future_version',
        apiVersion: BILLING_STRIPE_API_VERSION,
        id: 'local',
        stripeIdempotencyKey: 'stable',
      } as never),
    ).rejects.toMatchObject({ code: 'unsupported_billing_request' });
    await expect(
      transport.createSetup({
        processorEnvironment,
        requestVersion: 'setup_checkout_v2',
        apiVersion: 'unknown-version',
      } as never),
    ).rejects.toMatchObject({ code: 'unsupported_billing_request' });
    await expect(
      transport.createRecharge({
        processorEnvironment,
        requestVersion: 'recharge_pi_v2',
        apiVersion: BILLING_STRIPE_API_VERSION,
      } as never),
    ).rejects.toMatchObject({ code: 'unsupported_billing_request' });
    expect(create).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(recharge).not.toHaveBeenCalled();
  });
  it('requires a reviewed portal configuration and pins the return URL', async () => {
    const sdk = stripe();
    const create = vi.spyOn(sdk.billingPortal.sessions, 'create').mockResolvedValue({
      customer: 'cus_fixture',
      url: 'https://billing.stripe.com/p/session/fixture',
    } as never);
    await expect(
      (await verifiedTransport(sdk, { ...gate, portalConfigurationId: undefined })).createPortal(
        'cus_fixture',
      ),
    ).rejects.toMatchObject({ code: 'portal_not_configured' });
    expect(create).not.toHaveBeenCalled();
    await (await verifiedTransport(sdk)).createPortal('cus_fixture');
    expect(create).toHaveBeenCalledWith({
      customer: 'cus_fixture',
      configuration: 'bpc_fixture',
      return_url: `${gate.publicUrl}/billing`,
    });
  });
  it('keeps paginated invoice and receipt documents distinct and strips raw payment data', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const invoices = vi.spyOn(sdk.invoices, 'list').mockResolvedValue({
      has_more: true,
      data: [
        {
          id: 'in_fixture',
          customer: 'cus_fixture',
          livemode: false,
          total: 1000,
          currency: 'usd',
          status: 'paid',
          created: 1700000000,
          hosted_invoice_url: 'https://invoice.stripe.com/i/fixture',
          invoice_pdf: null,
          private_fixture: 'not-returned',
        },
      ],
    } as never);
    const charges = vi.spyOn(sdk.charges, 'list').mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'ch_fixture',
          customer: 'cus_fixture',
          livemode: false,
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          refunded: false,
          created: 1700000000,
          receipt_url: 'https://pay.stripe.com/receipts/fixture',
          billing_details: { name: 'not-returned' },
        },
      ],
    } as never);
    const invoicePage = await transport.listDocuments('cus_fixture', {
      type: 'invoice',
      cursor: 'in_previous',
      limit: 10,
    });
    expect(invoices).toHaveBeenCalledWith({
      customer: 'cus_fixture',
      starting_after: 'in_previous',
      limit: 10,
    });
    expect(invoicePage).toMatchObject({
      hasMore: true,
      nextCursor: 'in_fixture',
      data: [{ type: 'invoice', id: 'in_fixture' }],
    });
    const receiptPage = await transport.listDocuments('cus_fixture', {
      type: 'receipt',
      limit: 10,
    });
    expect(charges).toHaveBeenCalledWith({
      customer: 'cus_fixture',
      starting_after: undefined,
      limit: 10,
    });
    expect(receiptPage.data[0]).toMatchObject({ type: 'receipt', id: 'ch_fixture', pdfUrl: null });
    expect(JSON.stringify([invoicePage, receiptPage])).not.toContain('not-returned');
  });
  it('adds invoices only for the explicitly versioned manual request and leaves legacy shape unchanged', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const create = vi
      .spyOn(sdk.checkout.sessions, 'create')
      .mockResolvedValue({ customer: 'cus_fixture', invoice: 'in_fixture' } as never);
    const base = {
      id: 'order_fixture',
      workspaceId: 'ws',
      amountCents: 1000,
      creditMicros: 10000000,
      currency: 'USD' as const,
      status: 'created' as const,
      checkoutUrl: null,
      createdAt: '',
      updatedAt: '',
      creditedAt: null,
      requestVersion: 'checkout_hosted_page_v2' as const,
      apiVersion: BILLING_STRIPE_API_VERSION,
      stripeIdempotencyKey: 'original_stable_key',
      expiresAt: 2000000000,
      integrationIdentifier: 'opengen_topup_abcdefgh',
    };
    await new StripeCheckoutTransport(sdk, gate.publicUrl).createSession(base);
    expect(create.mock.calls[0]![0]).not.toHaveProperty('customer');
    expect(create.mock.calls[0]![0]).not.toHaveProperty('invoice_creation');
    await expect(
      transport.createManualInvoiceSession(base as ManualInvoiceOrderV2),
    ).rejects.toMatchObject({ code: 'legacy_order_immutable' });
    await expect(
      transport.createManualInvoiceSession({
        ...base,
        processorEnvironment,
        requestVersion: 'customer_invoice_v2',
        customerId: 'cus_fixture',
      }),
    ).rejects.toMatchObject({ code: 'legacy_order_immutable' });
    expect(create).toHaveBeenCalledTimes(1);
    await transport.createManualInvoiceSession({
      ...base,
      processorEnvironment,
      requestVersion: 'customer_invoice_v3',
      id: 'fresh-invoice-order',
      stripeIdempotencyKey: 'invoice_v3',
      customerId: 'cus_fixture',
    });
    expect(create.mock.calls[1]![1]).toEqual({
      idempotencyKey: 'invoice_v3',
      apiVersion: BILLING_STRIPE_API_VERSION,
    });
    expect(create.mock.calls[1]![0]).toMatchObject({
      customer: 'cus_fixture',
      invoice_creation: { enabled: true },
      adaptive_pricing: { enabled: false },
    });
    expect(create.mock.calls[1]![0]).not.toHaveProperty('automatic_tax');
    expect(create.mock.calls[1]![0]).not.toHaveProperty('allow_promotion_codes');
  });
  it('confirms off-session USD PaymentIntents with the immutable method/customer/idempotency identity', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const payment = {
      id: 'pi_fixture',
      customer: 'cus_fixture',
      payment_method: 'pm_fixture',
      amount: 2500,
      amount_received: 2500,
      currency: 'usd',
      status: 'succeeded',
      livemode: false,
    };
    const create = vi
      .spyOn(sdk.paymentIntents, 'create')
      .mockResolvedValue({ ...payment, client_secret: 'not-returned' } as never);
    const attempt = {
      processorEnvironment,
      requestVersion: 'recharge_pi_v1' as const,
      apiVersion: BILLING_STRIPE_API_VERSION,
      id: 'attempt_fixture',
      customerId: 'cus_fixture',
      paymentMethodId: 'pm_fixture',
      amountCents: 2500,
      stripeIdempotencyKey: 'recharge_stable',
    };
    expect(await transport.createRecharge(attempt)).toEqual(payment);
    expect(create).toHaveBeenCalledWith(
      {
        amount: 2500,
        currency: 'usd',
        customer: 'cus_fixture',
        payment_method: 'pm_fixture',
        confirm: true,
        off_session: true,
        metadata: { opengen_recharge_reference: 'attempt_fixture' },
      },
      { idempotencyKey: 'recharge_stable', apiVersion: BILLING_STRIPE_API_VERSION },
    );
  });
  it('preserves authentication-required intent identity while redacting secrets and handles uncertainty safely', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const attempt = {
      processorEnvironment,
      requestVersion: 'recharge_pi_v1' as const,
      apiVersion: BILLING_STRIPE_API_VERSION,
      id: 'a',
      customerId: 'cus_fixture',
      paymentMethodId: 'pm_fixture',
      amountCents: 1000,
      stripeIdempotencyKey: 'stable',
    };
    vi.spyOn(sdk.paymentIntents, 'create')
      .mockRejectedValueOnce({
        code: 'authentication_required',
        payment_intent: {
          id: 'pi_fixture',
          customer: 'cus_fixture',
          payment_method: 'pm_fixture',
          amount: 1000,
          amount_received: 0,
          currency: 'usd',
          status: 'requires_action',
          livemode: false,
          client_secret: 'private-fixture',
        },
      })
      .mockRejectedValueOnce(new Error('private-api-response'));
    const result = await transport.createRecharge(attempt);
    expect(result).toMatchObject({ id: 'pi_fixture', status: 'requires_action' });
    expect(JSON.stringify(result)).not.toContain('private-fixture');
    await expect(transport.createRecharge(attempt)).rejects.toMatchObject({
      code: 'recharge_uncertain',
      statusCode: 503,
    });
  });
  it('retrieves only the original card PaymentIntent for ephemeral authentication recovery', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const create = vi.spyOn(sdk.paymentIntents, 'create');
    const original = {
      id: 'pi_original',
      customer: 'cus_fixture',
      payment_method: { id: 'pm_fixture', type: 'card', customer: 'cus_fixture', livemode: false },
      amount: 1000,
      amount_received: 0,
      currency: 'usd',
      status: 'requires_action',
      livemode: false,
      client_secret: 'pi_original_secret_synthetic',
    };
    const retrieve = vi.spyOn(sdk.paymentIntents, 'retrieve').mockResolvedValue(original as never);
    const recovery = await transport.retrieveRechargeRecovery('pi_original');
    expect(retrieve).toHaveBeenCalledWith(
      'pi_original',
      { expand: ['payment_method'] },
      { apiVersion: BILLING_STRIPE_API_VERSION },
    );
    expect(recovery).toMatchObject({
      clientSecret: 'pi_original_secret_synthetic',
      methodType: 'card',
      payment: { id: 'pi_original', payment_method: 'pm_fixture' },
    });
    expect(recovery.payment).not.toHaveProperty('clientSecret');
    expect(recovery.payment).not.toHaveProperty('client_secret');
    expect(create).not.toHaveBeenCalled();
  });
  it('fails closed for recovery of missing/deleted/unsupported methods and wrong secret or environment', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const original = {
      id: 'pi_original',
      customer: 'cus_fixture',
      payment_method: { id: 'pm_fixture', type: 'card', customer: 'cus_fixture', livemode: false },
      amount: 1000,
      amount_received: 0,
      currency: 'usd',
      status: 'requires_action',
      livemode: false,
      client_secret: 'pi_original_secret_synthetic',
    };
    const retrieve = vi.spyOn(sdk.paymentIntents, 'retrieve');
    for (const patch of [
      { payment_method: null },
      { payment_method: 'pm_unexpanded' },
      { payment_method: { ...original.payment_method, deleted: true } },
      { payment_method: { ...original.payment_method, type: 'sepa_debit' } },
      { payment_method: { ...original.payment_method, customer: 'cus_other' } },
      { client_secret: 'pi_other_secret_synthetic' },
      { livemode: true },
      { status: 'requires_payment_method' },
    ]) {
      retrieve.mockResolvedValueOnce({ ...original, ...patch } as never);
      await expect(transport.retrieveRechargeRecovery('pi_original')).rejects.toMatchObject({
        code: 'recharge_recovery_unavailable',
      });
    }
  });
  it('preserves authentication-required as a separate signal on real requires_payment_method state and reuses that PI for recovery', async () => {
    const sdk = stripe(),
      transport = await verifiedTransport(sdk);
    const original = {
      id: 'pi_original',
      customer: 'cus_fixture',
      payment_method: { id: 'pm_fixture', type: 'card', customer: 'cus_fixture', livemode: false },
      amount: 1000,
      amount_received: 0,
      currency: 'usd',
      status: 'requires_payment_method',
      livemode: false,
      client_secret: 'pi_original_secret_synthetic',
      last_payment_error: { code: 'authentication_required' },
    };
    const create = vi
      .spyOn(sdk.paymentIntents, 'create')
      .mockRejectedValue({ code: 'authentication_required', payment_intent: original });
    vi.spyOn(sdk.paymentIntents, 'retrieve').mockResolvedValue(original as never);
    const result = await transport.createRecharge({
      processorEnvironment,
      requestVersion: 'recharge_pi_v1',
      apiVersion: BILLING_STRIPE_API_VERSION,
      id: 'attempt',
      customerId: 'cus_fixture',
      paymentMethodId: 'pm_fixture',
      amountCents: 1000,
      stripeIdempotencyKey: 'same_original',
    });
    expect(result).toMatchObject({
      id: 'pi_original',
      status: 'requires_payment_method',
      authentication_required: true,
    });
    const recovery = await transport.retrieveRechargeRecovery('pi_original');
    expect(recovery.payment).toMatchObject({
      id: 'pi_original',
      status: 'requires_payment_method',
      authentication_required: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
