import { createHash } from 'node:crypto';
import type { BillingProcessorEnvironment } from './billing-customer.js';

/** Internal input from the existing raw-signature verifier and trusted account
 * context. This structural TypeScript name does not authenticate arbitrary JSON.
 * Never expose normalization as a staff/body-to-verified-evidence endpoint. */
export interface VerifiedProcessorEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly processorEnvironment: Readonly<BillingProcessorEnvironment>;
  readonly account?: string | null;
  readonly context?: string | null;
  readonly data: { readonly object: Readonly<Record<string, unknown>> };
}

/** Load from the owned original payment, not event metadata or staff claims. */
export interface StaffRefundPaymentBinding {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly processorEnvironmentId: string;
  readonly processorAccountId: string;
  readonly livemode: boolean;
  readonly paymentIntentId: string;
  readonly chargeId: string | null;
  /** Original paid principal; the store separately checks approved refund cents. */
  readonly amountCents: number;
  readonly currency: 'USD';
  /** Optional method proof requirement for a particular binding, not a default. */
  readonly expectedPaymentMethodType?: string;
}

export type StaffRefundProcessorStatus =
  'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
interface EvidenceIdentity {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly processorEnvironmentId: string;
  readonly processorAccountId: string;
  readonly livemode: boolean;
  readonly paymentIntentId: string;
  readonly chargeId: string;
  readonly currency: 'USD';
  readonly eventId: string;
  readonly eventType: string;
  readonly eventCreated: number;
  readonly observedAt: string;
  readonly evidenceReference: string;
  /** SHA-256 of canonical signed identity and object fields; no raw payload retained. */
  readonly payloadFingerprint: string;
}
export interface VerifiedStaffRefundEvidence extends EvidenceIdentity {
  readonly kind: 'refund';
  readonly refundId: string;
  readonly amountCents: number;
  /** Processor state only: succeeded does not attest bank receipt or ledger correction. */
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly processorStatus: StaffRefundProcessorStatus;
  readonly failureBalanceTransactionId: string | null;
  /** Signed failed/canceled snapshot carries a failure balance transaction.
   * The store must still require explicit latest-evidence restoration authority. */
  readonly definitiveFailureBalanceReturned: boolean;
}
export interface VerifiedStaffChargeEvidence extends EvidenceIdentity {
  readonly kind: 'charge';
  readonly originalAmountCents: number;
  readonly amountRefundedCents: number;
  readonly paymentMethodType: string | null;
}
export type StaffRefundEvidenceResult =
  | Readonly<{ kind: 'refund'; evidence: VerifiedStaffRefundEvidence }>
  | Readonly<{ kind: 'charge'; evidence: VerifiedStaffChargeEvidence }>
  | Readonly<{ kind: 'review'; reason: string }>;

const refundSeal = new WeakSet<object>();
const chargeSeal = new WeakSet<object>();
export class StaffRefundEvidenceError extends Error {
  readonly code = 'staff_refund_evidence_unverified';
  readonly statusCode = 403;
  constructor() {
    super('Use normalized evidence from the trusted processor-verification boundary.');
  }
}
export function assertVerifiedStaffRefundEvidence(
  value: unknown,
): asserts value is VerifiedStaffRefundEvidence {
  if (!value || typeof value !== 'object' || !refundSeal.has(value))
    throw new StaffRefundEvidenceError();
}
export function assertVerifiedStaffChargeEvidence(
  value: unknown,
): asserts value is VerifiedStaffChargeEvidence {
  if (!value || typeof value !== 'object' || !chargeSeal.has(value))
    throw new StaffRefundEvidenceError();
}

const envPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const localPattern = /^[A-Za-z0-9_-]{1,200}$/;
const reference = (prefix: string, value: unknown): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`).test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number =>
  integer(value) && value > 0 && value <= 253402300799;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function objectId(value: unknown, prefix: string): string | null {
  const id = typeof value === 'string' ? value : record(value) ? value.id : null;
  return reference(prefix, id) ? id : null;
}
const review = (reason: string): StaffRefundEvidenceResult =>
  Object.freeze({ kind: 'review', reason });

/** Canonical bounded JSON hashing, so key ordering does not change replay identity. */
function fingerprint(event: VerifiedProcessorEvent): string | null {
  let nodes = 0;
  const active = new WeakSet<object>();
  const canonical = (value: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 32) throw new Error('Unsupported processor payload.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || active.has(value))
      throw new Error('Unsupported processor payload.');
    active.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new Error('Unsupported processor payload.');
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]),
      );
    } finally {
      active.delete(value);
    }
  };
  try {
    const payload = JSON.stringify(
      canonical(
        {
          id: event.id,
          type: event.type,
          created: event.created,
          livemode: event.livemode,
          account: event.account ?? null,
          context: event.context ?? null,
          data: event.data,
        },
        0,
      ),
    );
    return payload.length <= 1_000_000 ? createHash('sha256').update(payload).digest('hex') : null;
  } catch {
    return null;
  }
}

/** Pure normalization, not signature verification. Only already verified ingress
 * may call this. The seals prevent plain JSON/clones from being presented to the
 * store as normalized evidence; they do not authenticate a fabricated input event.
 * No processor client, request, refund issuance, lifecycle reduction or ledger I/O. */
export function normalizeStaffRefundEvidence(
  event: VerifiedProcessorEvent,
  trustedEnvironment: Readonly<BillingProcessorEnvironment>,
  original: StaffRefundPaymentBinding,
): StaffRefundEvidenceResult {
  if (
    !trustedEnvironment ||
    typeof trustedEnvironment.id !== 'string' ||
    !envPattern.test(trustedEnvironment.id) ||
    !reference('acct', trustedEnvironment.accountId) ||
    typeof trustedEnvironment.livemode !== 'boolean'
  )
    return review('invalid_trusted_environment');
  if (
    !original ||
    typeof original.workspaceId !== 'string' ||
    !localPattern.test(original.workspaceId) ||
    typeof original.orderId !== 'string' ||
    !localPattern.test(original.orderId) ||
    original.processorEnvironmentId !== trustedEnvironment.id ||
    original.processorAccountId !== trustedEnvironment.accountId ||
    original.livemode !== trustedEnvironment.livemode ||
    original.currency !== 'USD' ||
    !reference('pi', original.paymentIntentId) ||
    !integer(original.amountCents) ||
    original.amountCents === 0 ||
    (original.chargeId !== null && !reference('ch', original.chargeId)) ||
    (original.expectedPaymentMethodType !== undefined &&
      (typeof original.expectedPaymentMethodType !== 'string' ||
        !/^[a-z][a-z0-9_]{0,79}$/.test(original.expectedPaymentMethodType)))
  )
    return review('invalid_original_payment_binding');
  if (
    !event ||
    !event.processorEnvironment ||
    event.processorEnvironment.id !== trustedEnvironment.id ||
    event.processorEnvironment.accountId !== trustedEnvironment.accountId ||
    event.processorEnvironment.livemode !== trustedEnvironment.livemode ||
    event.livemode !== trustedEnvironment.livemode
  )
    return review('processor_environment_mismatch');
  if (event.account != null || event.context != null) return review('unsupported_account_context');
  if (!/^evt_[A-Za-z0-9_]{1,180}$/.test(event.id) || !timestamp(event.created))
    return review('invalid_event_identity_or_time');
  if (
    !['refund.created', 'refund.updated', 'refund.failed', 'charge.refunded'].includes(event.type)
  )
    return review('unsupported_processor_event');
  const object = event.data?.object;
  if (!record(object)) return review('invalid_processor_object');
  if (object.livemode !== undefined && object.livemode !== trustedEnvironment.livemode)
    return review('processor_object_mode_mismatch');
  const paymentIntentId = objectId(object.payment_intent, 'pi');
  if (!paymentIntentId) return review('missing_payment_intent');
  if (paymentIntentId !== original.paymentIntentId) return review('payment_intent_mismatch');
  if (object.currency !== 'usd') return review('currency_mismatch');
  if (!integer(object.amount) || object.amount === 0) return review('invalid_processor_amount');
  const chargeId = objectId(event.type === 'charge.refunded' ? object.id : object.charge, 'ch');
  if (!chargeId) return review('missing_charge_identity');
  if (original.chargeId !== null && original.chargeId !== chargeId)
    return review('charge_mismatch');
  const identity = (payloadFingerprint: string): EvidenceIdentity => ({
    workspaceId: original.workspaceId,
    orderId: original.orderId,
    processorEnvironmentId: trustedEnvironment.id,
    processorAccountId: trustedEnvironment.accountId,
    livemode: trustedEnvironment.livemode,
    paymentIntentId,
    chargeId,
    currency: 'USD',
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    observedAt: new Date(event.created * 1000).toISOString(),
    evidenceReference: `stripe-event:${event.id}`,
    payloadFingerprint,
  });
  if (event.type === 'charge.refunded') {
    if (object.object !== undefined && object.object !== 'charge')
      return review('processor_object_kind_mismatch');
    if (
      object.amount !== original.amountCents ||
      !integer(object.amount_refunded) ||
      object.amount_refunded > original.amountCents
    )
      return review('invalid_charge_refund_total');
    const method = record(object.payment_method_details)
      ? object.payment_method_details.type
      : null;
    const paymentMethodType =
      typeof method === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(method) ? method : null;
    if (
      original.expectedPaymentMethodType !== undefined &&
      paymentMethodType !== original.expectedPaymentMethodType
    )
      return review('payment_method_proof_mismatch');
    const payloadFingerprint = fingerprint(event);
    if (!payloadFingerprint) return review('unusable_payload_fingerprint');
    const evidence: VerifiedStaffChargeEvidence = Object.freeze({
      ...identity(payloadFingerprint),
      kind: 'charge',
      originalAmountCents: object.amount,
      amountRefundedCents: object.amount_refunded,
      paymentMethodType,
    });
    chargeSeal.add(evidence);
    return Object.freeze({ kind: 'charge', evidence });
  }
  if (object.object !== undefined && object.object !== 'refund')
    return review('processor_object_kind_mismatch');
  if (original.expectedPaymentMethodType !== undefined && original.chargeId === null)
    return review('missing_original_method_binding');
  const refundId = objectId(object.id, 're');
  if (!refundId) return review('missing_refund_identity');
  if (object.amount > original.amountCents) return review('refund_exceeds_original_payment');
  const rawStatus = object.status;
  if (
    !['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(rawStatus as string)
  )
    return review('missing_or_unknown_refund_status');
  const processorStatus = rawStatus as StaffRefundProcessorStatus;
  if (
    event.type === 'refund.failed' &&
    processorStatus !== 'failed' &&
    processorStatus !== 'canceled'
  )
    return review('refund_event_status_conflict');
  const rawFailureTransaction = object.failure_balance_transaction;
  const failureBalanceTransactionId =
    rawFailureTransaction == null ? null : objectId(rawFailureTransaction, 'txn');
  if (rawFailureTransaction != null && !failureBalanceTransactionId)
    return review('invalid_failure_balance_transaction');
  const status =
    processorStatus === 'succeeded'
      ? 'succeeded'
      : processorStatus === 'failed' || processorStatus === 'canceled'
        ? 'failed'
        : 'pending';
  const payloadFingerprint = fingerprint(event);
  if (!payloadFingerprint) return review('unusable_payload_fingerprint');
  const evidence: VerifiedStaffRefundEvidence = Object.freeze({
    ...identity(payloadFingerprint),
    kind: 'refund',
    refundId,
    amountCents: object.amount,
    status,
    processorStatus,
    failureBalanceTransactionId,
    definitiveFailureBalanceReturned: status === 'failed' && failureBalanceTransactionId !== null,
  });
  refundSeal.add(evidence);
  return Object.freeze({ kind: 'refund', evidence });
}
