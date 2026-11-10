import type { FastifyInstance, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { z } from 'zod';
import type { Principal } from '@media-router/engine';
import { requireBillingBrowserRecovery } from './billing.js';
import {
  MIN_TOPUP_CENTS,
  MAX_TOPUP_CENTS,
  PaymentError,
  type CheckoutOrder,
  type CheckoutSession,
  type PaymentAuthority,
  type PaymentStore,
  type PaymentTransport,
  type VerifiedPaymentEvent,
} from '../../../packages/engine/src/payments.js';

// Verified against Stripe's official SDK and API documentation on 2026-11-03.
export const STRIPE_API_VERSION = '2026-10-28.endive' as const;

export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    // The persisted order owns retry identity and the retry window.
    maxNetworkRetries: 0,
    timeout: 10_000,
  });
}

function publicOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Payment publicUrl must be an HTTPS origin (HTTP loopback is allowed locally).',
    );
  return url.origin;
}

export class StripeCheckoutTransport implements PaymentTransport {
  private readonly origin: string;
  constructor(
    private readonly stripe: Stripe,
    publicUrl: string,
  ) {
    this.origin = publicOrigin(publicUrl);
  }

  async createSession(order: CheckoutOrder): Promise<CheckoutSession> {
    if (
      order.requestVersion !== 'checkout_hosted_page_v2' ||
      order.apiVersion !== STRIPE_API_VERSION
    )
      throw new PaymentError(
        'unsupported_checkout_request',
        'This historical Checkout request requires operator review.',
        409,
      );
    const result = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        ui_mode: 'hosted_page',
        client_reference_id: order.id,
        success_url: `${this.origin}/billing?checkout=success&order=${encodeURIComponent(order.id)}`,
        cancel_url: `${this.origin}/billing?checkout=cancel&order=${encodeURIComponent(order.id)}`,
        expires_at: order.expiresAt,
        integration_identifier: order.integrationIdentifier,
        adaptive_pricing: { enabled: false },
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
        // Dynamic payment methods are the documented default. No saved-card,
        // subscription, discount or automatic-tax configuration is enabled.
      },
      { idempotencyKey: order.stripeIdempotencyKey, apiVersion: order.apiVersion },
    );
    return result;
  }

  async retrieveSession(id: string): Promise<CheckoutSession> {
    return this.stripe.checkout.sessions.retrieve(id);
  }
}

type BillingStore = Pick<
  PaymentStore,
  'createOrder' | 'getOrder' | 'listOrders' | 'hasBillingHold' | 'checkout' | 'reconcile'
>;
export interface PaymentsOptions {
  store?: BillingStore;
  authenticate(request: Pick<FastifyRequest, 'headers' | 'cookies'>): Promise<Principal>;
  stripe?: Stripe;
  webhookSecret?: string;
  publicUrl: string;
  livemode: boolean;
  checkoutTransport?: PaymentTransport;
  /** Pause new customer Checkout writes while verified fulfillment stays available. */
  checkoutWritesEnabled?: boolean;
  webhookVerifier?: Pick<Stripe['webhooks'], 'constructEvent'>;
  reconcileVerifiedEvent?(event: VerifiedPaymentEvent): ReturnType<PaymentStore['reconcile']>;
  scoped?: {
    access(principal: Principal): Promise<{
      read: boolean;
      manual: boolean;
      newFunding?: { allowed: boolean; reason?: 'terms-required' | 'terms-inactive' };
    }>;
    authorize(principal: Principal, action: 'read' | 'mutate'): Promise<PaymentAuthority>;
  };
}

function denied(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

const orderInput = z
  .object({
    amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
  })
  .strict();
const orderId = z.uuid();
const emptyBody = z.object({}).strict();

/** HTTP-only human billing: never register these operations in MCP/agent allowlists. */
export async function registerPayments(
  app: FastifyInstance,
  options: PaymentsOptions,
): Promise<void> {
  const origin = publicOrigin(options.publicUrl);
  const transport =
    options.checkoutTransport ??
    (options.stripe ? new StripeCheckoutTransport(options.stripe, origin) : undefined);
  const webhookVerifier = options.webhookVerifier ?? options.stripe?.webhooks;
  const enabled = Boolean(options.store && transport && webhookVerifier && options.webhookSecret);
  const store = () => {
    if (!options.store) throw denied('payments_unavailable', 'Billing is not configured.', 503);
    return options.store;
  };
  const activeTransport = () => {
    if (!enabled || !transport)
      throw denied('payments_unavailable', 'Top-ups are not configured.', 503);
    if (options.checkoutWritesEnabled === false)
      throw denied('checkout_paused', 'New Checkout requests are paused.', 503);
    return transport;
  };
  const browser = async (request: FastifyRequest, mutate = false) => {
    // Authenticate the session alone. A bearer key/OAuth grant is never billing authority.
    if (request.headers.authorization || !request.cookies?.og_session)
      throw denied('browser_session_required', 'Sign in in your browser to manage billing.', 401);
    const principal = await options.authenticate({ headers: {}, cookies: request.cookies });
    if (principal.bootstrap || !['browser', 'api'].includes(principal.keyKind ?? ''))
      throw denied('billing_access_denied', 'A customer browser session is required.', 403);
    if (!principal.scopes.includes('read'))
      throw denied('insufficient_scope', 'This session requires the read scope.', 403);
    if (options.scoped) requireBillingBrowserRecovery(principal, request.headers);
    else if (request.headers['x-opengen-workspace'] !== principal.workspaceId)
      throw denied(
        'workspace_changed',
        'The selected workspace changed. Refresh billing before continuing.',
        409,
      );
    if (mutate && request.headers.origin !== origin)
      throw denied(
        'origin_denied',
        'Billing mutations require the configured website origin.',
        403,
      );
    return principal;
  };

  await app.register(async (billing) => {
    billing.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store');
      return payload;
    });
    billing.get('/v1/billing', async (request) => {
      const p = await browser(request);
      const access = await options.scoped?.access(p);
      const orders = access
        ? access.read && options.scoped && options.store
          ? await options.store.listOrders(p.workspaceId, await options.scoped.authorize(p, 'read'))
          : []
        : ((await options.store?.listOrders(p.workspaceId)) ?? []);
      const enabledForWorkspace =
        enabled && options.checkoutWritesEnabled !== false && (access?.manual ?? true);
      const billingHold = options.store ? await options.store.hasBillingHold(p.workspaceId) : false;
      return {
        enabled: enabledForWorkspace,
        newFunding: {
          allowed: enabledForWorkspace && !billingHold && (access?.newFunding?.allowed ?? true),
          ...(access?.newFunding?.reason ? { reason: access.newFunding.reason } : {}),
        },
        workspaceId: p.workspaceId,
        currency: 'USD' as const,
        minAmountCents: MIN_TOPUP_CENTS,
        maxAmountCents: MAX_TOPUP_CENTS,
        billingHold,
        orders,
      };
    });
    billing.post('/v1/billing/orders', async (request, reply) => {
      const p = await browser(request, true);
      activeTransport();
      const input = orderInput.parse(request.body);
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
        throw denied(
          'invalid_idempotency_key',
          'Supply an Idempotency-Key of 8–128 safe characters.',
          400,
        );
      const order = options.scoped
        ? await store().createOrder(
            p.workspaceId,
            input.amountCents,
            key,
            await options.scoped.authorize(p, 'mutate'),
          )
        : await store().createOrder(p.workspaceId, input.amountCents, key);
      return reply.code(201).send(order);
    });
    billing.get<{ Params: { id: string } }>('/v1/billing/orders/:id', async (request) => {
      const p = await browser(request);
      const id = orderId.parse(request.params.id);
      return options.scoped
        ? store().getOrder(p.workspaceId, id, await options.scoped.authorize(p, 'read'))
        : store().getOrder(p.workspaceId, id);
    });
    billing.post<{ Params: { id: string } }>('/v1/billing/orders/:id/checkout', async (request) => {
      const p = await browser(request, true);
      emptyBody.parse(request.body ?? {});
      const id = orderId.parse(request.params.id);
      if (!options.scoped) return store().checkout(p.workspaceId, id, activeTransport());
      await store().checkout(
        p.workspaceId,
        id,
        activeTransport(),
        await options.scoped.authorize(p, 'mutate'),
      );
      // Keep the original external binding durable if billing read was revoked in flight.
      return store().getOrder(p.workspaceId, id, await options.scoped.authorize(p, 'read'));
    });
  });

  // Fastify parsers are encapsulated: other JSON routes retain their usual parser.
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1_000_000 },
      (_request, raw, done) => done(null, raw),
    );
    webhook.post('/webhooks/stripe', async (request, reply) => {
      if (!options.webhookSecret || !webhookVerifier || !transport || !options.store)
        throw denied('webhook_not_configured', 'Payment webhook is not configured.', 503);
      const signature = request.headers['stripe-signature'];
      if (
        typeof signature !== 'string' ||
        signature.length > 4096 ||
        !Buffer.isBuffer(request.body)
      )
        throw denied('invalid_signature', 'Invalid payment webhook signature.', 400);
      let event: Stripe.Event;
      try {
        event = webhookVerifier.constructEvent(request.body, signature, options.webhookSecret);
      } catch {
        throw denied('invalid_signature', 'Invalid payment webhook signature.', 400);
      }
      if (event.livemode !== options.livemode || event.account || (options.scoped && event.context))
        throw denied(
          'wrong_payment_environment',
          'Payment event does not belong to this environment.',
          400,
        );
      const verified = event as unknown as VerifiedPaymentEvent;
      const result = options.reconcileVerifiedEvent
        ? await options.reconcileVerifiedEvent(verified)
        : await options.store.reconcile(verified, transport);
      return reply.header('Cache-Control', 'no-store').send(result);
    });
  });
}
