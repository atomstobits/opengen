import type { Pool, PoolClient } from 'pg';
import {
  assertBillingProcessorTransport,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
  type BillingProcessorTransport,
} from '../../../packages/engine/src/billing-customer.js';
import type {
  StaffRefundPaymentBinding,
  VerifiedStaffRefundEvidence,
} from '../../../packages/engine/src/staff-refund-evidence.js';
import {
  StaffRefundError,
  StaffRefundStore,
  STAFF_REFUND_REQUEST_VERSION,
  STAFF_REFUND_CONVERSION_VERSION,
  type StaffRefundAction,
  type StaffRefundActor,
  type StaffRefundCase,
  type StaffRefundReviewEvidence,
  type StaffRefundSnapshot,
  type StaffRefundStoreOptions,
  type StaffRefundWorksheet,
} from '../../../packages/engine/src/staff-refunds.js';
import {
  createStaffRefundEvidenceProducer,
  type StaffRefundEvidenceProducer,
} from './staff-refund-evidence-producer.js';

export interface ExistingStaffRefundTarget {
  workspaceId: string;
  orderId: string;
  paymentIntentId: string;
  chargeId: string | null;
  refundId: string;
  originalAmountCents: number;
  refundAmountCents: number;
  eligibleMicros: number;
}
export interface ExistingStaffRefundControllerOptions {
  /** Explicit server composition only; no environment-variable auto-activation. */
  activation?: 'sandbox' | 'manual';
  processorEnvironment: BillingProcessorEnvironment;
  processorTransport: BillingProcessorTransport;
  webhookSecret: string;
  /** One reviewed target, never selected by a request or event metadata. */
  target: Readonly<ExistingStaffRefundTarget>;
  authorize: StaffRefundStoreOptions['authorize'];
  approveAllocation?: StaffRefundStoreOptions['approveAllocation'];
}
export interface StaffRefundRawDelivery {
  rawBody: Buffer;
  signature: string;
}
interface WorksheetInput {
  worksheet: StaffRefundWorksheet;
  worksheetHash: string;
}
export interface PrepareExistingStaffRefundInput extends WorksheetInput {
  delivery: StaffRefundRawDelivery;
  reference: string;
}
export interface ObserveExistingStaffRefundInput extends StaffRefundAction {
  delivery: StaffRefundRawDelivery;
}
export interface ApplyExistingStaffRefundInput extends StaffRefundAction, WorksheetInput {
  /** Optional explicit current success reaffirmation, verified anew from raw bytes. */
  delivery?: StaffRefundRawDelivery;
}
export interface ExistingStaffRefundRehearsal {
  applyAllowed: false;
  target: Readonly<ExistingStaffRefundTarget>;
  snapshot: StaffRefundSnapshot;
  processor:
    | {
        kind: 'refund';
        eventId: string;
        eventCreated: number;
        payloadFingerprint: string;
        status: VerifiedStaffRefundEvidence['status'];
        amountCents: number;
      }
    | { kind: 'review'; reason: string };
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value: unknown, allowed: readonly string[]) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new StaffRefundError('invalid_staff_refund', 'Use the explicit existing-refund input.');
}
function denied(): never {
  throw new StaffRefundError(
    'staff_refund_authority_required',
    'Current installation staff authority is required.',
    403,
  );
}
function currentWorksheet(input: WorksheetInput) {
  if (!record(input.worksheet) || typeof input.worksheetHash !== 'string')
    throw new StaffRefundError(
      'invalid_staff_refund',
      'Supply the current approved worksheet and hash.',
    );
}

/** Unmounted, existing-return-only server controller. It has no issuer, dispatch,
 * generic hold resolver, customer route or runtime registration. Raw signature
 * verification grants observation evidence, never wallet adjustment authority.
 * An eventual invocation needs separate exact-resource/financial admission. */
export class ExistingStaffRefundController {
  private readonly environment: Readonly<BillingProcessorEnvironment>;
  private readonly target: Readonly<ExistingStaffRefundTarget>;
  private readonly store: StaffRefundStore;
  private readonly producer?: StaffRefundEvidenceProducer;
  private readonly authorize: StaffRefundStoreOptions['authorize'];
  private readonly canMutate: boolean;
  private readonly transport: BillingProcessorTransport;
  private readonly authorizedStaff = new WeakMap<PoolClient, string>();

  constructor(
    private readonly pool: Pool,
    options: ExistingStaffRefundControllerOptions,
  ) {
    this.environment = validatedBillingProcessorEnvironment(options.processorEnvironment);
    keys(options.target, [
      'workspaceId',
      'orderId',
      'paymentIntentId',
      'chargeId',
      'refundId',
      'originalAmountCents',
      'refundAmountCents',
      'eligibleMicros',
    ]);
    const target = { ...options.target };
    if (
      (options.activation !== undefined && !['sandbox', 'manual'].includes(options.activation)) ||
      this.environment.livemode !== (options.activation === 'manual') ||
      typeof options.authorize !== 'function' ||
      typeof target.workspaceId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(target.workspaceId) ||
      typeof target.orderId !== 'string' ||
      !uuid.test(target.orderId) ||
      typeof target.paymentIntentId !== 'string' ||
      !/^pi_[A-Za-z0-9_]{1,240}$/.test(target.paymentIntentId) ||
      (target.chargeId !== null &&
        (typeof target.chargeId !== 'string' ||
          !/^ch_[A-Za-z0-9_]{1,240}$/.test(target.chargeId))) ||
      typeof target.refundId !== 'string' ||
      !/^re_[A-Za-z0-9_]{1,240}$/.test(target.refundId) ||
      !Number.isSafeInteger(target.originalAmountCents) ||
      target.originalAmountCents < 500 ||
      target.originalAmountCents > 100000 ||
      !Number.isSafeInteger(target.refundAmountCents) ||
      target.refundAmountCents < 1 ||
      target.refundAmountCents > target.originalAmountCents ||
      !Number.isSafeInteger(target.eligibleMicros) ||
      target.eligibleMicros < 1 ||
      Math.ceil(target.eligibleMicros / 10000) !== target.refundAmountCents
    )
      throw new StaffRefundError(
        'staff_refunds_disabled',
        'Use a reviewed refund target with explicit matching mode.',
        403,
      );
    this.target = Object.freeze({ ...target });
    this.transport = options.processorTransport;
    const authorize = options.authorize;
    this.authorize = async (client, context) => {
      this.assertProcessor();
      let actor: StaffRefundActor;
      try {
        actor = await authorize(client, context);
      } catch {
        return denied();
      }
      this.assertProcessor();
      if (
        !actor ||
        actor.kind !== 'installation-operator' ||
        typeof actor.id !== 'string' ||
        actor.id.length < 1 ||
        actor.id.length > 200 ||
        actor.id.trim() !== actor.id ||
        /[\x00-\x1f\x7f]/.test(actor.id)
      )
        denied();
      this.authorizedStaff.set(client, actor.id);
      return { kind: 'installation-operator', id: actor.id };
    };
    this.canMutate = typeof options.approveAllocation === 'function';
    const approval = options.approveAllocation;
    this.store = new StaffRefundStore(pool, {
      activation: options.activation,
      processorEnvironment: this.environment,
      authorize: this.authorize,
      ...(approval
        ? {
            approveAllocation: async (client, context, request) => {
              // The domain has authorized this transaction client and pinned its
              // audit actor. Capture that identity before another awaited check;
              // a different currently valid actor cannot inherit this phase.
              const expectedActor = this.authorizedStaff.get(client);
              if (!expectedActor) denied();
              if ((await this.authorize(client, context)).id !== expectedActor) denied();
              this.assertProcessor();
              let result;
              try {
                result = await approval(client, context, request);
              } catch {
                throw new StaffRefundError(
                  'staff_refund_allocation_unapproved',
                  'Current independent paid-allocation approval is required.',
                  403,
                );
              }
              if ((await this.authorize(client, context)).id !== expectedActor) denied();
              this.assertProcessor();
              return result;
            },
          }
        : {}),
    });
    if (options.activation !== undefined)
      this.producer = createStaffRefundEvidenceProducer({
        activation: options.activation,
        processorEnvironment: this.environment,
        processorTransport: options.processorTransport,
        webhookSecret: options.webhookSecret,
      });
  }

  private assertProcessor(): void {
    try {
      assertBillingProcessorTransport(this.environment, this.transport);
    } catch {
      throw new StaffRefundError(
        'processor_environment_unverified',
        'Current matching processor verification is required.',
        503,
      );
    }
  }

  private ready(mutate = false): StaffRefundEvidenceProducer {
    if (!this.producer)
      throw new StaffRefundError(
        'staff_refunds_disabled',
        'Staff refunds are closed by default.',
        503,
      );
    this.assertProcessor();
    if (mutate && !this.canMutate)
      throw new StaffRefundError(
        'staff_refund_allocation_unapproved',
        'This controller is configured for review reads only.',
        403,
      );
    return this.producer;
  }

  /** A consistent, staff-authorized, read-only projection; no claim, binding,
   * initializer, migration or legacy-environment backfill occurs here. The store
   * independently revalidates all funding/ownership under its mutation locks. */
  private async binding(context: unknown, caseId?: string): Promise<StaffRefundPaymentBinding> {
    if (caseId !== undefined && (typeof caseId !== 'string' || !uuid.test(caseId)))
      throw new StaffRefundError('invalid_staff_refund', 'Use the original case UUID.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const actor = await this.authorize(client, context);
      const t = this.target,
        e = this.environment;
      const row = (
        await client.query<{
          workspace_id: string;
          id: string;
          payment_intent_id: string;
          amount_cents: number;
          processor_environment_id: string;
          processor_account_id: string;
          livemode: boolean;
        }>(
          `SELECT o.workspace_id,o.id,o.payment_intent_id,o.amount_cents,
          o.processor_environment_id,o.processor_account_id,o.livemode
        FROM mr_payment_orders o
        JOIN mr_billing_processor_environments e ON e.id=o.processor_environment_id
        JOIN mr_billing_payment_ownership p ON p.processor_environment_id=e.id
          AND p.payment_intent_id=o.payment_intent_id
        JOIN mr_ledger l ON l.workspace_id=o.workspace_id AND l.reference='stripe-topup:'||o.id::text
        WHERE o.workspace_id=$1 AND o.id=$2 AND o.payment_intent_id=$3
          AND o.processor_environment_id=$4 AND o.processor_account_id=$5
          AND e.account_id=$5 AND e.livemode=$7 AND o.livemode=$7
          AND o.amount_cents=$6 AND o.credit_micros=o.amount_cents::bigint*10000
          AND o.status='credited' AND o.credited_at IS NOT NULL
          AND p.kind='manual' AND p.local_id=o.id AND p.workspace_id=o.workspace_id
          AND p.livemode=$7 AND p.amount_cents=o.amount_cents AND p.currency='USD'
          AND p.credit_reference='stripe-topup:'||o.id::text
          AND l.kind='credit' AND l.job_id IS NULL AND l.amount_micros=o.amount_cents::bigint*10000
          AND l.available_delta_micros=l.amount_micros AND l.reserved_delta_micros=0`,
          [
            t.workspaceId,
            t.orderId,
            t.paymentIntentId,
            e.id,
            e.accountId,
            t.originalAmountCents,
            e.livemode,
          ],
        )
      ).rows[0];
      if (!row)
        throw new StaffRefundError(
          'staff_refund_payment_mismatch',
          'The pinned original credited payment and ownership require review.',
        );
      if (caseId !== undefined) {
        const found = await client.query(
          `SELECT id FROM mr_staff_refund_cases
          WHERE id=$1 AND workspace_id=$2 AND order_id=$3 AND payment_intent_id=$4
            AND processor_environment_id=$5 AND processor_account_id=$6 AND livemode=$14
            AND origin='reconcile-existing' AND refund_id=$7 AND eligible_micros=$8 AND cash_cents=$9
            AND original_amount_cents=$10 AND credit_reference='stripe-topup:'||order_id::text
            AND request_version=$11 AND conversion_version=$12
            AND ($13::text IS NULL OR charge_id=$13)`,
          [
            caseId,
            t.workspaceId,
            t.orderId,
            t.paymentIntentId,
            e.id,
            e.accountId,
            t.refundId,
            t.eligibleMicros,
            t.refundAmountCents,
            t.originalAmountCents,
            STAFF_REFUND_REQUEST_VERSION,
            STAFF_REFUND_CONVERSION_VERSION,
            t.chargeId,
            e.livemode,
          ],
        );
        if (!found.rowCount)
          throw new StaffRefundError(
            'staff_refund_payment_mismatch',
            'Only the pinned already-issued refund case may be reconciled.',
          );
      }
      if ((await this.authorize(client, context)).id !== actor.id) denied();
      await client.query('COMMIT');
      return Object.freeze({
        workspaceId: row.workspace_id,
        orderId: row.id,
        processorEnvironmentId: row.processor_environment_id,
        processorAccountId: row.processor_account_id,
        livemode: row.livemode,
        paymentIntentId: row.payment_intent_id,
        chargeId: t.chargeId,
        amountCents: row.amount_cents,
        currency: 'USD',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private verified(delivery: StaffRefundRawDelivery, payment: StaffRefundPaymentBinding) {
    keys(delivery, ['rawBody', 'signature']);
    const result = this.ready().verifyRaw(delivery, { payment, refundId: this.target.refundId });
    if (result.kind !== 'refund' || result.evidence.amountCents !== this.target.refundAmountCents)
      throw new StaffRefundError(
        'staff_refund_evidence_unverified',
        'Use verified individual evidence matching the pinned existing refund.',
        403,
      );
    return result.evidence;
  }

  async review(context: unknown): Promise<StaffRefundReviewEvidence> {
    this.ready();
    await this.binding(context);
    return this.store.reviewEvidence(this.target.workspaceId, context);
  }

  async rehearse(
    delivery: StaffRefundRawDelivery,
    context: unknown,
  ): Promise<ExistingStaffRefundRehearsal> {
    const producer = this.ready();
    keys(delivery, ['rawBody', 'signature']);
    const payment = await this.binding(context);
    const result = producer.verifyRaw(delivery, { payment, refundId: this.target.refundId });
    const review = await this.store.reviewEvidence(this.target.workspaceId, context);
    // Intentionally return a plain report, never a serialized/reloadable seal.
    const processor =
      result.kind === 'refund' && result.evidence.amountCents === this.target.refundAmountCents
        ? {
            kind: 'refund' as const,
            eventId: result.evidence.eventId,
            eventCreated: result.evidence.eventCreated,
            payloadFingerprint: result.evidence.payloadFingerprint,
            status: result.evidence.status,
            amountCents: result.evidence.amountCents,
          }
        : {
            kind: 'review' as const,
            reason: result.kind === 'review' ? result.reason : 'refund_amount_mismatch',
          };
    return { applyAllowed: false, target: this.target, snapshot: review.snapshot, processor };
  }

  async prepareExisting(
    input: PrepareExistingStaffRefundInput,
    context: unknown,
  ): Promise<StaffRefundCase> {
    this.ready(true);
    keys(input, ['delivery', 'reference', 'worksheet', 'worksheetHash']);
    currentWorksheet(input);
    const payment = await this.binding(context);
    const evidence = this.verified(input.delivery, payment);
    return this.store.prepare(
      {
        workspaceId: this.target.workspaceId,
        orderId: this.target.orderId,
        reference: input.reference,
        origin: 'reconcile-existing',
        eligibleMicros: this.target.eligibleMicros,
        worksheet: input.worksheet,
        worksheetHash: input.worksheetHash,
        existingRefundEvidence: evidence,
      },
      context,
    );
  }

  async observeExisting(
    caseId: string,
    input: ObserveExistingStaffRefundInput,
    context: unknown,
  ): Promise<StaffRefundCase> {
    this.ready(true);
    keys(input, ['delivery', 'reference', 'note', 'evidenceReference']);
    const payment = await this.binding(context, caseId);
    const evidence = this.verified(input.delivery, payment);
    return this.store.observeVerifiedProcessorEvidence(
      caseId,
      evidence,
      { reference: input.reference, note: input.note, evidenceReference: input.evidenceReference },
      context,
    );
  }

  async applyExisting(
    caseId: string,
    input: ApplyExistingStaffRefundInput,
    context: unknown,
  ): Promise<StaffRefundCase> {
    this.ready(true);
    keys(input, [
      'delivery',
      'reference',
      'note',
      'evidenceReference',
      'worksheet',
      'worksheetHash',
    ]);
    currentWorksheet(input);
    const payment = await this.binding(context, caseId);
    const evidence =
      input.delivery === undefined ? undefined : this.verified(input.delivery, payment);
    if (evidence && evidence.status !== 'succeeded')
      throw new StaffRefundError(
        'staff_refund_review',
        'Current individual success proof is required.',
      );
    return this.store.reconcile(
      caseId,
      {
        action: 'apply-success',
        reference: input.reference,
        note: input.note,
        evidenceReference: input.evidenceReference,
        worksheet: input.worksheet,
        worksheetHash: input.worksheetHash,
        resolveHoldIds: [],
        ...(evidence ? { reaffirmLatestEvidence: evidence } : {}),
      },
      context,
    );
  }
}
