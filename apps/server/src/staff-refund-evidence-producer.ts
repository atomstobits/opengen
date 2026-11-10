import Stripe from 'stripe';
import {
  assertBillingProcessorTransport,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
  type BillingProcessorTransport,
} from '../../../packages/engine/src/billing-customer.js';
import {
  normalizeStaffRefundEvidence,
  type StaffRefundEvidenceResult,
  type StaffRefundPaymentBinding,
} from '../../../packages/engine/src/staff-refund-evidence.js';

export interface StaffRefundEvidenceProducerOptions {
  /** Explicit matching mode only. This module never activates or issues refunds. */
  activation?: 'sandbox' | 'manual';
  processorEnvironment: BillingProcessorEnvironment;
  /** Bootstrap must already have verified this exact account/environment. */
  processorTransport: BillingProcessorTransport;
  /** Trusted configuration for that environment's own-account destination. */
  webhookSecret: string;
}
export interface StaffRefundEvidenceProducer {
  verifyRaw(
    input: { rawBody: Buffer; signature: string },
    target: { payment: StaffRefundPaymentBinding; refundId: string },
  ): StaffRefundEvidenceResult;
}

const toleranceSeconds = 300;
const refundEvents = new Set(['refund.created', 'refund.updated', 'refund.failed']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const review = (reason: string): StaffRefundEvidenceResult =>
  Object.freeze({ kind: 'review', reason });

/** Internal producer, not an HTTP handler or a JSON-to-proof adapter. The
 * controller must load the canonical credited payment and pin the selected
 * already-issued refund identity independently of body/metadata claims. The
 * signing secret's account association is trusted configuration, checked against
 * the bootstrap-verified processor transport; a signature alone names no account.
 * No SDK client, external request, refund issuance or financial mutation occurs. */
export function createStaffRefundEvidenceProducer(
  options: StaffRefundEvidenceProducerOptions,
): StaffRefundEvidenceProducer {
  let environment: Readonly<BillingProcessorEnvironment>;
  try {
    environment = validatedBillingProcessorEnvironment(options.processorEnvironment);
    if (
      !(
        (options.activation === 'sandbox' && environment.livemode === false) ||
        (options.activation === 'manual' && environment.livemode === true)
      ) ||
      typeof options.webhookSecret !== 'string' ||
      options.webhookSecret.length === 0 ||
      options.webhookSecret.length > 4096 ||
      /[\s\x00-\x1f\x7f]/.test(options.webhookSecret)
    )
      throw new Error('Invalid configuration.');
    assertBillingProcessorTransport(environment, options.processorTransport);
  } catch {
    // Never propagate SDK/transport messages or configuration values containing
    // keys, signing secrets or private account details.
    throw new Error(
      'Refund evidence requires verified matching configuration and explicit mode activation.',
    );
  }
  const secret = options.webhookSecret;
  const transport = options.processorTransport;
  const producer: StaffRefundEvidenceProducer = {
    verifyRaw(input, target): StaffRefundEvidenceResult {
      try {
        assertBillingProcessorTransport(environment, transport);
      } catch {
        return review('processor_environment_unverified');
      }
      if (
        !input ||
        !Buffer.isBuffer(input.rawBody) ||
        input.rawBody.length === 0 ||
        input.rawBody.length > 1_000_000 ||
        typeof input.signature !== 'string' ||
        input.signature.length === 0 ||
        input.signature.length > 4096
      )
        return review('invalid_raw_signature_input');
      const rawBody = Buffer.from(input.rawBody);
      const signature = input.signature;
      // Stripe's SDK23.1 bounds old signatures only. Require exactly one strict
      // integer delivery timestamp and bound future skew too. Event.created is
      // intentionally separate: a genuine fresh redelivery can carry an old event.
      const timestamps = signature.split(',').filter((item) => item.split('=')[0]?.trim() === 't');
      if (timestamps.length !== 1 || !/^t=[1-9][0-9]*$/.test(timestamps[0]!))
        return review('invalid_signature_timestamp');
      const deliveredAt = Number(timestamps[0]!.slice(2));
      if (
        !Number.isSafeInteger(deliveredAt) ||
        Math.abs(Math.floor(Date.now() / 1000) - deliveredAt) > toleranceSeconds
      )
        return review('signature_timestamp_out_of_range');
      let event: Stripe.Event;
      try {
        event = Stripe.webhooks.constructEvent(rawBody, signature, secret, toleranceSeconds);
      } catch {
        return review('invalid_signature');
      }
      if (!record(event) || event.object !== 'event') return review('invalid_processor_event');
      if (event.type === 'charge.refunded') return review('aggregate_charge_evidence');
      if (!refundEvents.has(event.type)) return review('unsupported_processor_event');
      if (
        !target ||
        !record(target.payment) ||
        typeof target.refundId !== 'string' ||
        !/^re_[A-Za-z0-9_]{1,240}$/.test(target.refundId)
      )
        return review('invalid_refund_target');
      // Copy the server-owned target before normalization; no mutable target or
      // caller-supplied processor namespace is retained in the sealed evidence.
      const payment = Object.freeze({ ...target.payment });
      const refundId = target.refundId;
      if (!record(event.data) || !record(event.data.object))
        return review('invalid_processor_object');
      if (event.data.object.id !== refundId) return review('refund_identity_mismatch');
      const result = normalizeStaffRefundEvidence(
        {
          id: event.id,
          type: event.type,
          created: event.created,
          livemode: event.livemode,
          account: event.account,
          context: event.context,
          processorEnvironment: environment,
          data: { object: event.data.object },
        },
        environment,
        payment,
      );
      // Return the normalizer's original WeakSet-sealed object, never a clone.
      return result.kind === 'charge' ? review('aggregate_charge_evidence') : result;
    },
  };
  return Object.freeze(producer);
}
