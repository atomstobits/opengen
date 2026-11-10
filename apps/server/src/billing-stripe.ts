import type Stripe from 'stripe';
import type {
  CheckoutOrder,
  CheckoutSession,
  PaymentTransport,
} from '../../../packages/engine/src/payments.js';
import { StripeCheckoutTransport } from './payments.js';
import {
  BillingCustomerError,
  BILLING_STRIPE_API_VERSION,
  sameBillingProcessorEnvironment,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
  type BillingProcessorTransport,
  type BillingDocument,
  type CustomerRequest,
  type CustomerTransport,
  type DocumentPage,
  type PaymentMethodReference,
  type RechargeAttemptRequest,
  type RechargePayment,
  type RechargeTransport,
  type RechargeRecoveryTransport,
  type RechargeRecovery,
  type SetupIntentReference,
  type SetupRequest,
  type SetupSession,
  type StripeCustomerReference,
} from '../../../packages/engine/src/billing-customer.js';

const objectId = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);
function origin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Billing requires a canonical HTTPS public origin (HTTP loopback is allowed locally).',
    );
  return url.origin;
}
export interface BillingStripeGate {
  /** Explicit integration gate; this module never reads credentials or activates itself. */
  enabled: boolean;
  processorEnvironment: BillingProcessorEnvironment;
  publicUrl: string;
  /** Operator-reviewed portal configuration: disable unsupported subscription/tax features. */
  portalConfigurationId?: string;
}
export interface ManualInvoiceOrderV2 extends Omit<CheckoutOrder, 'requestVersion'> {
  requestVersion: 'customer_invoice_v2';
  processorEnvironment: BillingProcessorEnvironment;
  customerId: string;
}
export interface ManualInvoiceOrderV3 extends Omit<ManualInvoiceOrderV2, 'requestVersion'> {
  requestVersion: 'customer_invoice_v3';
}
export interface ManualInvoiceSessionV2 extends CheckoutSession {
  customer: string | null;
  invoice: string | null;
}

/** Inject an instance of the existing pinned Stripe 23.1.0 / 2026-10-28.endive SDK. */
export class StripeBillingTransport
  implements CustomerTransport, RechargeTransport, RechargeRecoveryTransport
{
  private readonly publicOrigin: string;
  readonly processorEnvironment: Readonly<BillingProcessorEnvironment>;
  private environmentVerified = false;
  constructor(
    private readonly stripe: Stripe,
    private readonly gate: BillingStripeGate,
  ) {
    this.publicOrigin = origin(gate.publicUrl);
    this.processorEnvironment = validatedBillingProcessorEnvironment(gate.processorEnvironment);
  }
  /** Explicit server bootstrap check. Callers must admit this single outbound GET
   * before invocation. The trusted callback verifies the configured namespace and
   * key mode because the Stripe Account object carries no livemode field. */
  async verifyProcessorEnvironment(
    assertTrustedContext: (
      environment: Readonly<BillingProcessorEnvironment>,
    ) => void | Promise<void>,
  ): Promise<void> {
    this.environmentVerified = false;
    this.enabled();
    try {
      await assertTrustedContext(this.processorEnvironment);
    } catch {
      throw new BillingCustomerError(
        'processor_environment_unverified',
        'Stripe environment verification requires trusted server configuration.',
        503,
      );
    }
    let account: Stripe.Account;
    try {
      account = await this.stripe.accounts.retrieve(
        null,
        {},
        { apiVersion: BILLING_STRIPE_API_VERSION, maxNetworkRetries: 0 },
      );
    } catch {
      throw new BillingCustomerError(
        'processor_environment_unverified',
        'Stripe account verification is unavailable.',
        503,
      );
    }
    if (account.id !== this.processorEnvironment.accountId)
      throw new BillingCustomerError(
        'processor_environment_mismatch',
        'Stripe account does not match the configured processor environment.',
        409,
      );
    if (this.processorEnvironment.livemode && account.charges_enabled !== true)
      throw new BillingCustomerError(
        'processor_account_not_ready',
        'The configured Stripe account must have charges enabled before live manual billing.',
        409,
      );
    this.environmentVerified = true;
  }
  assertProcessorEnvironment(): void {
    this.enabled();
    if (!this.environmentVerified)
      throw new BillingCustomerError(
        'processor_environment_unverified',
        'Verify the Stripe processor environment before billing requests.',
        503,
      );
  }
  private assertRequestEnvironment(environment: BillingProcessorEnvironment): void {
    this.assertProcessorEnvironment();
    if (!sameBillingProcessorEnvironment(this.processorEnvironment, environment))
      throw new BillingCustomerError(
        'processor_environment_mismatch',
        'The original billing request belongs to a different processor environment.',
        409,
      );
  }
  private enabled() {
    if (!this.gate.enabled)
      throw new BillingCustomerError(
        'billing_integration_disabled',
        'The billing integration has not been enabled.',
        503,
      );
  }
  /** Reuse the legacy request serializer on this adapter's verified SDK instance. */
  verifiedLegacyCheckoutTransport(): PaymentTransport & BillingProcessorTransport {
    const legacy = new StripeCheckoutTransport(this.stripe, this.publicOrigin);
    return {
      processorEnvironment: this.processorEnvironment,
      assertProcessorEnvironment: () => this.assertProcessorEnvironment(),
      createSession: async (order) => {
        this.assertProcessorEnvironment();
        return legacy.createSession(order);
      },
      retrieveSession: async (id) => {
        this.assertProcessorEnvironment();
        return legacy.retrieveSession(id);
      },
    };
  }
  async createCustomer(request: CustomerRequest): Promise<StripeCustomerReference> {
    this.assertRequestEnvironment(request.processorEnvironment);
    if (
      request.requestVersion !== 'customer_v1' ||
      request.apiVersion !== BILLING_STRIPE_API_VERSION
    )
      throw new BillingCustomerError(
        'unsupported_billing_request',
        'Recover this customer with its original request version.',
        409,
      );
    const customer = await this.stripe.customers.create(
      { metadata: { opengen_billing_reference: request.id } },
      { idempotencyKey: request.stripeIdempotencyKey, apiVersion: request.apiVersion },
    );
    return { id: customer.id, livemode: customer.livemode };
  }
  async retrieveCustomer(id: string): Promise<StripeCustomerReference> {
    this.assertProcessorEnvironment();
    const customer = await this.stripe.customers.retrieve(id);
    return customer.deleted
      ? { id: customer.id, deleted: true, livemode: this.processorEnvironment.livemode }
      : { id: customer.id, livemode: customer.livemode };
  }
  private setup(session: Stripe.Checkout.Session): SetupSession {
    return {
      id: session.id,
      mode: session.mode,
      customer: objectId(session.customer),
      livemode: session.livemode,
      status: session.status,
      client_reference_id: session.client_reference_id,
      setup_intent: objectId(session.setup_intent),
      url: session.url,
    };
  }
  async createSetup(request: SetupRequest): Promise<SetupSession> {
    this.assertRequestEnvironment(request.processorEnvironment);
    if (
      request.requestVersion !== 'setup_checkout_v2' ||
      request.apiVersion !== BILLING_STRIPE_API_VERSION
    )
      throw new BillingCustomerError(
        'unsupported_billing_request',
        'Recover this setup with its original request version.',
        409,
      );
    return this.setup(
      await this.stripe.checkout.sessions.create(
        {
          mode: 'setup',
          ui_mode: 'hosted_page',
          customer: request.customerId,
          currency: 'usd',
          // Checkout's generated SetupIntent uses the documented off_session default;
          // this API does not accept setup_intent_data.usage. Reconciliation verifies usage.
          client_reference_id: request.id,
          expires_at: request.expiresAt,
          integration_identifier: request.integrationIdentifier,
          success_url: `${this.publicOrigin}/billing?setup=success&request=${encodeURIComponent(request.id)}`,
          cancel_url: `${this.publicOrigin}/billing?setup=cancel&request=${encodeURIComponent(request.id)}`,
          // Omit payment_method_types: Dashboard-managed dynamic selection is the default.
        },
        { idempotencyKey: request.stripeIdempotencyKey, apiVersion: request.apiVersion },
      ),
    );
  }
  async retrieveSetup(id: string): Promise<SetupSession> {
    this.assertProcessorEnvironment();
    return this.setup(await this.stripe.checkout.sessions.retrieve(id));
  }
  async retrieveSetupIntent(id: string): Promise<SetupIntentReference> {
    this.assertProcessorEnvironment();
    const intent = await this.stripe.setupIntents.retrieve(id);
    return {
      id: intent.id,
      customer: objectId(intent.customer),
      payment_method: objectId(intent.payment_method),
      livemode: intent.livemode,
      status: intent.status,
      usage: intent.usage,
    };
  }
  async retrievePaymentMethod(id: string): Promise<PaymentMethodReference> {
    this.assertProcessorEnvironment();
    const method = await this.stripe.paymentMethods.retrieve(id);
    return { id: method.id, customer: objectId(method.customer), livemode: method.livemode };
  }
  async createPortal(customerId: string): Promise<{ customerId: string; url: string }> {
    this.assertProcessorEnvironment();
    if (!this.gate.portalConfigurationId)
      throw new BillingCustomerError(
        'portal_not_configured',
        'A reviewed billing portal configuration is required.',
        503,
      );
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: this.gate.portalConfigurationId,
      return_url: `${this.publicOrigin}/billing`,
    });
    return { customerId: session.customer, url: session.url };
  }
  async listDocuments(
    customerId: string,
    input: { type: 'receipt' | 'invoice'; cursor?: string; limit: number },
  ): Promise<DocumentPage> {
    this.assertProcessorEnvironment();
    if (input.type === 'invoice') {
      const page = await this.stripe.invoices.list({
        customer: customerId,
        limit: input.limit,
        starting_after: input.cursor,
      });
      const data: BillingDocument[] = page.data.map((invoice) => ({
        type: 'invoice',
        id: invoice.id,
        customerId: objectId(invoice.customer) ?? '',
        livemode: invoice.livemode,
        amountCents: invoice.total,
        currency: invoice.currency,
        status: invoice.status ?? 'unknown',
        createdAt: new Date(invoice.created * 1000).toISOString(),
        url: invoice.hosted_invoice_url ?? null,
        pdfUrl: invoice.invoice_pdf ?? null,
      }));
      return {
        data,
        hasMore: page.has_more,
        nextCursor: page.has_more ? (page.data.at(-1)?.id ?? null) : null,
      };
    }
    const page = await this.stripe.charges.list({
      customer: customerId,
      limit: input.limit,
      starting_after: input.cursor,
    });
    const data: BillingDocument[] = page.data.map((charge) => ({
      type: 'receipt',
      id: charge.id,
      customerId: objectId(charge.customer) ?? '',
      livemode: charge.livemode,
      amountCents: charge.amount,
      currency: charge.currency,
      status: charge.refunded ? 'refunded' : charge.status,
      createdAt: new Date(charge.created * 1000).toISOString(),
      url: charge.receipt_url,
      pdfUrl: null,
    }));
    return {
      data,
      hasMore: page.has_more,
      nextCursor: page.has_more ? (page.data.at(-1)?.id ?? null) : null,
    };
  }
  /** Additive request version. Never send these parameters for an existing legacy order. */
  async createManualInvoiceSession(
    order: ManualInvoiceOrderV2 | ManualInvoiceOrderV3,
  ): Promise<ManualInvoiceSessionV2> {
    if (
      order.requestVersion !== 'customer_invoice_v3' ||
      order.apiVersion !== BILLING_STRIPE_API_VERSION
    )
      throw new BillingCustomerError(
        'legacy_order_immutable',
        'The existing payment order request must remain unchanged.',
        409,
      );
    this.assertRequestEnvironment(order.processorEnvironment);
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        ui_mode: 'hosted_page',
        customer: order.customerId,
        client_reference_id: order.id,
        expires_at: order.expiresAt,
        integration_identifier: order.integrationIdentifier,
        success_url: `${this.publicOrigin}/billing?checkout=success&order=${encodeURIComponent(order.id)}`,
        cancel_url: `${this.publicOrigin}/billing?checkout=cancel&order=${encodeURIComponent(order.id)}`,
        adaptive_pricing: { enabled: false },
        invoice_creation: { enabled: true },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: order.amountCents,
              product_data: { name: 'OpenGen prepaid service credit' },
            },
          },
        ],
      },
      { idempotencyKey: order.stripeIdempotencyKey, apiVersion: order.apiVersion },
    );
    return { ...session, customer: objectId(session.customer), invoice: objectId(session.invoice) };
  }
  private recharge(intent: Stripe.PaymentIntent): RechargePayment {
    return {
      id: intent.id,
      customer: objectId(intent.customer),
      payment_method: objectId(intent.payment_method),
      currency: intent.currency,
      amount: intent.amount,
      amount_received: intent.amount_received,
      ...(intent.status === 'requires_action' ||
      (intent.status === 'requires_payment_method' &&
        intent.last_payment_error?.code === 'authentication_required')
        ? { authentication_required: true }
        : {}),
      status: intent.status,
      livemode: intent.livemode,
    };
  }
  async createRecharge(attempt: RechargeAttemptRequest): Promise<RechargePayment> {
    this.assertRequestEnvironment(attempt.processorEnvironment);
    if (
      attempt.requestVersion !== 'recharge_pi_v1' ||
      attempt.apiVersion !== BILLING_STRIPE_API_VERSION
    )
      throw new BillingCustomerError(
        'unsupported_billing_request',
        'Recover this recharge with its original request version.',
        409,
      );
    try {
      return this.recharge(
        await this.stripe.paymentIntents.create(
          {
            amount: attempt.amountCents,
            currency: 'usd',
            customer: attempt.customerId,
            payment_method: attempt.paymentMethodId,
            confirm: true,
            off_session: true,
            metadata: { opengen_recharge_reference: attempt.id },
          },
          { idempotencyKey: attempt.stripeIdempotencyKey, apiVersion: attempt.apiVersion },
        ),
      );
    } catch (error) {
      // Stripe can return an authoritative intent with an authentication/decline
      // error. Preserve its identity and state; do not expose client_secret/raw error.
      const e = error as {
        code?: string;
        payment_intent?: Stripe.PaymentIntent;
        raw?: { code?: string; payment_intent?: Stripe.PaymentIntent };
      };
      const intent = e.payment_intent ?? e.raw?.payment_intent;
      if (
        intent &&
        typeof intent.id === 'string' &&
        typeof intent.status === 'string' &&
        typeof intent.amount === 'number' &&
        typeof intent.amount_received === 'number' &&
        typeof intent.currency === 'string' &&
        typeof intent.livemode === 'boolean'
      ) {
        const payment = this.recharge(intent);
        if (
          intent.status === 'requires_payment_method' &&
          (e.code === 'authentication_required' || e.raw?.code === 'authentication_required')
        )
          payment.authentication_required = true;
        return payment;
      }
      throw new BillingCustomerError(
        'recharge_uncertain',
        'The original recharge requires reconciliation; do not start another charge.',
        503,
      );
    }
  }
  async retrieveRechargeRecovery(id: string): Promise<RechargeRecovery> {
    this.assertProcessorEnvironment();
    if (!/^pi_[A-Za-z0-9_]+$/.test(id))
      throw new BillingCustomerError(
        'recharge_recovery_unavailable',
        'This payment cannot use card authentication recovery.',
        409,
      );
    const intent = await this.stripe.paymentIntents.retrieve(
      id,
      { expand: ['payment_method'] },
      { apiVersion: BILLING_STRIPE_API_VERSION },
    );
    const method = intent.payment_method;
    const customer = objectId(intent.customer);
    const prefix = `${id}_secret_`;
    if (
      intent.id !== id ||
      intent.livemode !== this.processorEnvironment.livemode ||
      !(
        intent.status === 'requires_action' ||
        (intent.status === 'requires_payment_method' &&
          intent.last_payment_error?.code === 'authentication_required')
      ) ||
      typeof intent.client_secret !== 'string' ||
      !intent.client_secret.startsWith(prefix) ||
      intent.client_secret.length <= prefix.length ||
      !customer ||
      !method ||
      typeof method !== 'object' ||
      'deleted' in method ||
      !/^pm_[A-Za-z0-9_]+$/.test(method.id) ||
      method.type !== 'card' ||
      method.livemode !== this.processorEnvironment.livemode ||
      objectId(method.customer) !== customer
    )
      throw new BillingCustomerError(
        'recharge_recovery_unavailable',
        'This payment requires approved billing review or a new method setup.',
        409,
      );
    return {
      payment: this.recharge(intent),
      clientSecret: intent.client_secret,
      methodType: 'card',
    };
  }
  async retrieveRecharge(id: string): Promise<RechargePayment> {
    this.assertProcessorEnvironment();
    return this.recharge(await this.stripe.paymentIntents.retrieve(id));
  }
}
