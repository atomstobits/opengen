import {
  PaymentError,
  paymentIntentId,
  isPaymentRiskEvent,
} from '../../../packages/engine/src/payments.js';
import type {
  VerifiedPaymentEvent,
  PaymentStore,
  PaymentTransport,
} from '../../../packages/engine/src/payments.js';
import {
  assertBillingProcessorTransport,
  validatedBillingProcessorEnvironment,
} from '../../../packages/engine/src/billing-customer.js';
import type {
  BillingCustomerStore,
  BillingProcessorTransport,
  CustomerTransport,
  RechargeTransport,
} from '../../../packages/engine/src/billing-customer.js';
import type { RechargeStore } from '../../../packages/engine/src/billing-recharge.js';

const manualEvents = new Set([
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
]);
const setupEvents = new Set(['checkout.session.completed', 'checkout.session.expired']);

/** Call only after raw-byte signature and processor environment verification. */
export function createBillingWebhookDispatcher(options: {
  payments: Pick<PaymentStore, 'reconcile'>;
  legacyTransport: PaymentTransport & BillingProcessorTransport;
  customers: Pick<BillingCustomerStore, 'reconcileSetup'>;
  customerTransport: CustomerTransport;
  recharge: Pick<RechargeStore, 'reconcile' | 'reconcileRisk'>;
  rechargeTransport: RechargeTransport;
  routeIntent(
    event: VerifiedPaymentEvent,
    intentId: string,
  ): Promise<'manual' | 'automatic' | 'unmatched'>;
}) {
  const environment = validatedBillingProcessorEnvironment(
    options.customerTransport.processorEnvironment,
  );
  return async (
    verified: VerifiedPaymentEvent,
  ): Promise<{ received: true; ignored?: boolean; duplicate?: boolean }> => {
    assertBillingProcessorTransport(environment, options.customerTransport);
    assertBillingProcessorTransport(environment, options.legacyTransport);
    assertBillingProcessorTransport(environment, options.rechargeTransport);
    if (verified.livemode !== environment.livemode)
      throw new PaymentError('environment_mismatch', 'Unexpected payment environment.', 409);
    const event = { ...verified, processorEnvironment: environment };
    const object = event.data.object;
    if (event.type === 'payment_method.detached')
      return options.customers.reconcileSetup(event, options.customerTransport);
    if (event.type.startsWith('checkout.session.')) {
      if (object.mode === 'setup' && setupEvents.has(event.type))
        return options.customers.reconcileSetup(event, options.customerTransport);
      if (object.mode === 'payment' && manualEvents.has(event.type))
        return options.payments.reconcile(event, options.legacyTransport);
      return { received: true, ignored: true };
    }
    const isIntent = event.type.startsWith('payment_intent.');
    const isRisk = isPaymentRiskEvent(event.type);
    const intent = isIntent
      ? paymentIntentId(object.id)
      : isRisk
        ? paymentIntentId(object.payment_intent)
        : null;
    if (isIntent && !intent)
      throw new PaymentError('invalid_event', 'PaymentIntent identity is missing.');
    if (intent) {
      // Resolution also writes the receipt. An unknown event never falls through
      // to a different funding flow, even if its Stripe metadata names a local ID.
      const owner = await options.routeIntent(event, intent);
      if (owner === 'unmatched')
        throw new PaymentError(
          'unmatched_payment_intent',
          'Payment awaits verified ownership.',
          503,
        );
      if (owner === 'automatic') {
        if (isIntent) return options.recharge.reconcile(event, options.rechargeTransport);
        if (await options.recharge.reconcileRisk(event)) return { received: true };
        throw new PaymentError('payment_ownership_changed', 'Payment ownership needs review.', 503);
      }
      if (isIntent) return { received: true, ignored: true };
    }
    return options.payments.reconcile(event, options.legacyTransport);
  };
}
