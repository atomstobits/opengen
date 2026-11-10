/** Unmounted staff reconciliation. No processor client, automatic paid allocation
 * or provider-cost waiver lives here. Explicit activation must match the trusted mode.
 * Unknown accepted provider exposure remains reserved; a future independently
 * audited customer remedy belongs to the core and must not fabricate zero cost. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockPaymentIntentInTransaction } from './billing-payment-ownership.js';
import type { BillingProcessorEnvironment } from './billing-customer.js';
import {
  assertVerifiedStaffRefundEvidence,
  type VerifiedStaffRefundEvidence,
} from './staff-refund-evidence.js';

export class StaffRefundError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'StaffRefundError';
  }
}
export interface StaffRefundActor {
  id: string;
  kind: 'installation-operator';
}
export const STAFF_REFUND_REQUEST_VERSION = 'staff-refund-original-v1';
export const STAFF_REFUND_CONVERSION_VERSION = 'usd-ceil-cent-v1';
export interface StaffRefundAllocationRequest {
  operation: 'prepare' | 'dispatch' | 'apply-success' | 'release-failed' | 'restore-failed';
  workspaceId: string;
  orderId: string;
  paymentIntentId: string;
  processorEnvironmentId: string;
  processorAccountId: string;
  livemode: boolean;
  creditReference: string;
  originalAmountCents: number;
  caseReference: string;
  caseRequestHash: string;
  eligibleMicros: number;
  cashCents: number;
  roundingExpenseMicros: number;
  requestVersion: typeof STAFF_REFUND_REQUEST_VERSION;
  conversionVersion: typeof STAFF_REFUND_CONVERSION_VERSION;
  worksheet: StaffRefundWorksheet;
  worksheetHash: string;
  requestHash: string;
  reaffirmation: { eventId: string; payloadFingerprint: string; eventCreated: number } | null;
}
export interface StaffRefundAllocationApproval {
  approvalReference: string;
  requestHash: string;
}
export interface StaffRefundStoreOptions {
  activation?: 'fixture' | 'sandbox' | 'manual';
  processorEnvironment: Readonly<BillingProcessorEnvironment>;
  /** Trusted server callback. Only read/revalidate using the supplied client;
   * never commit/rollback, acquire another connection, mutate wallet/funding or
   * perform external I/O while the store owns transaction locks. */
  authorize: (client: PoolClient, context: unknown) => Promise<StaffRefundActor>;
  /** Out-of-band staff approval of actual paid allocation, never a customer JSON
   * assertion. Absence permits authorized review reads but denies mutations.
   * Only read/revalidate through the supplied client; never commit/rollback,
   * acquire another connection, mutate wallet/funding or perform external I/O. */
  approveAllocation?: (
    client: PoolClient,
    context: unknown,
    request: Readonly<StaffRefundAllocationRequest>,
  ) => Promise<StaffRefundAllocationApproval>;
}
export interface StaffRefundSnapshot {
  availableMicros: number;
  reservedMicros: number;
  exposureHash: string;
}
export interface StaffRefundReviewEvidence {
  snapshot: StaffRefundSnapshot;
  financialRows: Record<string, Record<string, unknown>[]>;
}
export interface StaffRefundWorksheet {
  snapshot: StaffRefundSnapshot;
  /** Current itemized processor evidence. Registered refund IDs count once. */
  externalReturns: ReadonlyArray<{
    refundId: string;
    amountCents: number;
    status: 'pending' | 'unknown' | 'succeeded' | 'failed';
    evidenceReference: string;
    definitiveFailureBalanceReturned?: boolean;
  }>;
  allocationReference: string;
  originalPayerReference: string;
  note: string;
  allocation: ReadonlyArray<{
    fundingReference: string;
    disposition: 'eligible-paid' | 'consumed' | 'reserved' | 'noncash' | 'returned';
    amountMicros: number;
    relatedReference?: string;
  }>;
}
export interface PrepareStaffRefund {
  workspaceId: string;
  orderId: string;
  reference: string;
  origin: 'new' | 'reconcile-existing';
  eligibleMicros: number;
  worksheet: StaffRefundWorksheet;
  worksheetHash: string;
  existingRefundEvidence?: VerifiedStaffRefundEvidence;
}
export interface StaffRefundAction {
  reference: string;
  note: string;
  evidenceReference: string;
}
export interface DispatchStaffRefund extends StaffRefundAction {
  worksheet?: StaffRefundWorksheet;
  worksheetHash?: string;
}
export interface ReconcileStaffRefund extends StaffRefundAction {
  action: 'apply-success' | 'release-failed' | 'restore-failed';
  /** Fresh staff approval if accepted work changed since the frozen worksheet. */
  worksheet?: StaffRefundWorksheet;
  worksheetHash?: string;
  resolveHoldIds?: string[];
  holdResolutionEvidenceUrl?: string;
  /** Explicit current processor choice, bound by fresh trusted staff approval.
   * An older pending delivery can never silently erase the later success. */
  reaffirmLatestEvidence?: VerifiedStaffRefundEvidence;
}
export interface StaffRefundCase {
  id: string;
  workspaceId: string;
  orderId: string;
  origin: 'new' | 'reconcile-existing';
  eligibleMicros: number;
  cashCents: number;
  principalClaimCents: number;
  roundingExpenseMicros: number;
  earmarkedMicros: number;
  outstandingMicros: number;
  state: 'prepared' | 'unknown' | 'pending' | 'succeeded' | 'failed' | 'review';
  financialState: 'none' | 'debited' | 'released' | 'restored';
  reviewRequired: boolean;
  refundId: string | null;
  dispatchKey: string;
  /** A replay is readable but never grants a second external dispatch claim. */
  dispatchClaimed?: boolean;
  holdIds: string[];
}
interface CaseRow {
  id: string;
  workspace_id: string;
  order_id: string;
  processor_environment_id: string;
  processor_account_id: string;
  livemode: boolean;
  payment_intent_id: string;
  credit_reference: string;
  original_amount_cents: number;
  origin: StaffRefundCase['origin'];
  reference: string;
  request_hash: string;
  frozen_body: unknown;
  worksheet: StaffRefundWorksheet;
  request_version: string;
  conversion_version: string;
  worksheet_hash: string;
  external_other_returns_cents: number;
  eligible_micros: string;
  cash_cents: number;
  principal_claim_cents: number;
  rounding_expense_micros: number;
  earmark_micros: string;
  outstanding_micros: string;
  state: StaffRefundCase['state'];
  financial_state: StaffRefundCase['financialState'];
  review_required: boolean;
  evidence_conflict: boolean;
  ordering_review: boolean;
  refund_id: string | null;
  charge_id: string | null;
  dispatch_key: string;
  dispatched_at: Date | null;
  latest_status: 'pending' | 'succeeded' | 'failed' | null;
  latest_event_id: string | null;
  latest_event_created: string | null;
  definitive_failure_balance_returned: boolean;
}
interface FundingRow {
  id: string;
  workspace_id: string;
  payment_intent_id: string | null;
  amount_cents: number;
  credit_micros: string;
  credited_at: Date | null;
  status: string;
  livemode: boolean;
  processor_environment_id: string | null;
  processor_account_id: string | null;
}
function fail(code: string, message: string, statusCode = 409): never {
  throw new StaffRefundError(code, message, statusCode);
}
function bounded(value: unknown, max = 200): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail('invalid_staff_refund', 'Use a bounded nonempty audit reference.');
}
function money(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail('invalid_staff_refund', 'Use nonnegative safe integer money.');
  return value as number;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return fail('invalid_staff_refund', 'Use a finite JSON audit snapshot.');
}
export function staffRefundHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function evidenceBody(evidence: VerifiedStaffRefundEvidence): Record<string, unknown> {
  // Receipt identity is stable across a fresh verification of the same event.
  const { observedAt: _observedAt, ...body } = evidence;
  return body;
}
function uuid(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    fail('invalid_staff_refund', 'Use an original case or payment UUID.');
}
function action(input: StaffRefundAction) {
  bounded(input.reference);
  bounded(input.note, 2000);
  bounded(input.evidenceReference);
}
function worksheet(input: StaffRefundWorksheet, hash: string) {
  money(input.snapshot.availableMicros);
  money(input.snapshot.reservedMicros);
  if (!Array.isArray(input.externalReturns) || input.externalReturns.length > 10000)
    fail('invalid_staff_refund', 'Use bounded itemized processor returns.');
  const returnIds = new Set<string>();
  for (const returned of input.externalReturns) {
    if (
      !/^re_[A-Za-z0-9_]{1,240}$/.test(returned.refundId) ||
      returnIds.has(returned.refundId) ||
      !money(returned.amountCents) ||
      returned.amountCents > 100000 ||
      !['pending', 'unknown', 'succeeded', 'failed'].includes(returned.status)
    )
      fail(
        'staff_refund_conflict',
        'Use distinct original refund IDs and bounded positive cent amounts.',
      );
    returnIds.add(returned.refundId);
    bounded(returned.evidenceReference);
    if (
      returned.definitiveFailureBalanceReturned !== undefined &&
      typeof returned.definitiveFailureBalanceReturned !== 'boolean'
    )
      fail('invalid_staff_refund', 'Use explicit failure balance-return evidence.');
  }
  bounded(input.allocationReference);
  bounded(input.originalPayerReference);
  bounded(input.note, 2000);
  if (
    !Array.isArray(input.allocation) ||
    input.allocation.length < 1 ||
    input.allocation.length > 10000
  )
    fail('invalid_staff_refund', 'A bounded manual allocation worksheet is required.');
  for (const row of input.allocation) {
    bounded(row.fundingReference);
    money(row.amountMicros);
    if (!['eligible-paid', 'consumed', 'reserved', 'noncash', 'returned'].includes(row.disposition))
      fail('invalid_staff_refund', 'Unknown manual allocation disposition.');
    if (row.relatedReference !== undefined) bounded(row.relatedReference);
  }
  if (!/^[a-f0-9]{64}$/.test(input.snapshot.exposureHash) || staffRefundHash(input) !== hash)
    fail('staff_refund_conflict', 'The approved worksheet hash does not match.');
}

export class StaffRefundStore {
  private readonly environment: Readonly<BillingProcessorEnvironment>;
  private readonly activation: StaffRefundStoreOptions['activation'];
  private readonly authorize: StaffRefundStoreOptions['authorize'];
  private readonly approveAllocation: StaffRefundStoreOptions['approveAllocation'];
  constructor(
    private readonly pool: Pool,
    options: StaffRefundStoreOptions,
  ) {
    if (!options || typeof options.authorize !== 'function')
      fail(
        'staff_refund_authority_required',
        'A trusted staff authority callback is required.',
        403,
      );
    const env = options.processorEnvironment;
    if (
      options.activation !== undefined &&
      !['fixture', 'sandbox', 'manual'].includes(options.activation)
    )
      fail('staff_refunds_disabled', 'Staff refunds are not activated.', 403);
    if (
      !env ||
      env.livemode !== (options.activation === 'manual') ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(env.id) ||
      !/^acct_[A-Za-z0-9]+$/.test(env.accountId)
    )
      fail(
        'staff_refunds_disabled',
        'Staff refund activation must match the trusted processor mode.',
        403,
      );
    this.environment = Object.freeze({ ...env });
    this.activation = options.activation;
    this.authorize = options.authorize;
    this.approveAllocation = options.approveAllocation;
  }
  private async authority(client: PoolClient, context: unknown): Promise<StaffRefundActor> {
    const actor = await this.authorize(client, context);
    if (!actor || actor.kind !== 'installation-operator')
      fail(
        'staff_refund_authority_required',
        'Current installation staff authority is required.',
        403,
      );
    bounded(actor.id);
    return { id: actor.id, kind: actor.kind };
  }
  private async tx<T>(
    context: unknown,
    fn: (client: PoolClient, actor: StaffRefundActor) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    if (!this.activation)
      fail('staff_refunds_disabled', 'Staff refunds are closed by default.', 503);
    if (!readOnly && !this.approveAllocation)
      fail(
        'staff_refund_allocation_unapproved',
        'This staff store is configured for review reads only.',
        403,
      );
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const result = await fn(client, await this.authority(client, context));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async workspace(
    client: PoolClient,
    id: string,
    context: unknown,
    actor: StaffRefundActor,
  ) {
    const row = (
      await client.query(
        'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row) fail('staff_refund_not_found', 'Workspace not found.', 404);
    const current = await this.authority(client, context);
    if (current.id !== actor.id)
      fail('staff_refund_authority_required', 'Staff authority changed.', 403);
    return row as { available_micros: string; reserved_micros: string };
  }
  private async funding(
    client: PoolClient,
    workspaceId: string,
    orderId: string,
  ): Promise<FundingRow> {
    const row = (
      await client.query<FundingRow>(
        'SELECT * FROM mr_payment_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, orderId],
      )
    ).rows[0];
    const env = this.environment;
    if (
      !row ||
      !row.credited_at ||
      row.status !== 'credited' ||
      !row.payment_intent_id ||
      row.livemode !== env.livemode ||
      row.processor_environment_id !== env.id ||
      row.processor_account_id !== env.accountId
    )
      fail(
        'staff_refund_payment_mismatch',
        'An original credited payment in the configured environment is required.',
      );
    const registry = await client.query(
      'SELECT id FROM mr_billing_processor_environments WHERE id=$1 AND account_id=$2 AND livemode=$3 FOR SHARE',
      [env.id, env.accountId, env.livemode],
    );
    const owner = (
      await client.query(
        'SELECT * FROM mr_billing_payment_ownership WHERE processor_environment_id=$1 AND payment_intent_id=$2 FOR UPDATE',
        [env.id, row.payment_intent_id],
      )
    ).rows[0];
    const ref = `stripe-topup:${row.id}`;
    const credit = (
      await client.query(
        'SELECT kind,amount_micros,available_delta_micros,reserved_delta_micros,job_id FROM mr_ledger WHERE workspace_id=$1 AND reference=$2 FOR SHARE',
        [workspaceId, ref],
      )
    ).rows[0];
    if (
      !registry.rowCount ||
      !owner ||
      owner.kind !== 'manual' ||
      owner.local_id !== row.id ||
      owner.workspace_id !== workspaceId ||
      owner.livemode !== env.livemode ||
      owner.amount_cents !== row.amount_cents ||
      owner.currency !== 'USD' ||
      owner.credit_reference !== ref ||
      !credit ||
      credit.kind !== 'credit' ||
      credit.job_id !== null ||
      Number(credit.amount_micros) !== row.amount_cents * 10000 ||
      Number(credit.available_delta_micros) !== row.amount_cents * 10000 ||
      Number(credit.reserved_delta_micros) !== 0 ||
      Number(row.credit_micros) !== row.amount_cents * 10000
    )
      fail(
        'staff_refund_payment_mismatch',
        'Original canonical paid credit and ownership must match.',
      );
    return row;
  }
  private async financialRows(
    client: PoolClient,
    workspaceId: string,
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const reliefSchema = (await client.query("SELECT to_regclass('mr_aged_cost_reliefs') AS name"))
      .rows[0].name;
    const postingOrder = reliefSchema ? 'posting_order::text' : 'NULL::text';
    const jobs = (
      await client.query(
        'SELECT id,status,reserved_micros::text,settled_micros::text,upstream_cost_micros::text,upstream_id,attempt_count,billing_poll_pending,lease_until,queue_start_deadline_at FROM mr_jobs WHERE workspace_id=$1 ORDER BY id LIMIT 100001',
        [workspaceId],
      )
    ).rows;
    const ledger = (
      await client.query(
        `SELECT id,job_id,kind,amount_micros::text,available_delta_micros::text,reserved_delta_micros::text,reference,created_at,${postingOrder} AS posting_order FROM mr_ledger WHERE workspace_id=$1 ORDER BY created_at,id LIMIT 100001`,
        [workspaceId],
      )
    ).rows;
    const attempts = (
      await client.query(
        'SELECT a.id,a.job_id,a.number,a.route_id,a.deployment_id,a.state,a.started_at,a.completed_at FROM mr_attempts a JOIN mr_jobs j ON j.id=a.job_id WHERE j.workspace_id=$1 ORDER BY a.job_id,a.number LIMIT 100001',
        [workspaceId],
      )
    ).rows;
    const intents = (
      await client.query(
        'SELECT job_id,attempt_number,state,submission_intent_at,released_at,release_evidence FROM mr_dispatch_slots WHERE workspace_id=$1 ORDER BY job_id,attempt_number LIMIT 100001',
        [workspaceId],
      )
    ).rows;
    const keyReservations = (
      await client.query(
        'SELECT job_id,key_id,admission_month,reserved_micros::text,settled_micros::text FROM mr_key_reservations WHERE workspace_id=$1 ORDER BY job_id LIMIT 100001',
        [workspaceId],
      )
    ).rows;
    const funding = (
      await client.query(
        "SELECT id,amount_cents,credit_micros::text,status,payment_intent_id,credited_at,created_at,processor_environment_id,processor_account_id,livemode,'stripe-topup:'||id::text AS credit_reference FROM mr_payment_orders WHERE workspace_id=$1 ORDER BY created_at,id LIMIT 100001",
        [workspaceId],
      )
    ).rows;
    const automaticFunding = (
      await client.query(
        "SELECT id,amount_cents,status,payment_intent_id,credited_at,created_at,processor_environment_id,processor_account_id,livemode,'stripe-recharge:'||id::text AS credit_reference FROM mr_billing_recharge_attempts WHERE workspace_id=$1 ORDER BY created_at,id LIMIT 100001",
        [workspaceId],
      )
    ).rows;
    const holds = (
      await client.query(
        'SELECT event_id,order_id,recharge_attempt_id,source_kind,stripe_event_id,staff_refund_case_id,reason,created_at,resolved_at,resolution_reference FROM mr_billing_holds WHERE workspace_id=$1 ORDER BY event_id LIMIT 100001',
        [workspaceId],
      )
    ).rows;
    const cases = (
      await client.query(
        'SELECT id,order_id,processor_environment_id,payment_intent_id,credit_reference,origin,reference,request_hash,worksheet_hash,request_version,conversion_version,eligible_micros::text,cash_cents,principal_claim_cents,rounding_expense_micros,earmark_micros::text,outstanding_micros::text,state,financial_state,review_required,evidence_conflict,refund_id,charge_id,dispatched_at,latest_status,latest_event_id,latest_event_created,definitive_failure_balance_returned,created_at,updated_at FROM mr_staff_refund_cases WHERE workspace_id=$1 ORDER BY created_at,id LIMIT 100001',
        [workspaceId],
      )
    ).rows;
    const observations = (
      await client.query(
        "SELECT o.event_id,o.case_id,o.refund_id,o.event_created,o.observation_hash,o.created_at,o.evidence->>'amountCents' AS amount_cents,o.evidence->>'status' AS status,o.evidence->>'processorStatus' AS processor_status,o.evidence->>'definitiveFailureBalanceReturned' AS definitive_failure_balance_returned FROM mr_staff_refund_observations o JOIN mr_staff_refund_cases c ON c.id=o.case_id WHERE c.workspace_id=$1 ORDER BY o.event_id LIMIT 100001",
        [workspaceId],
      )
    ).rows;
    const events = (
      await client.query(
        `SELECT e.id,e.type,e.object_id,e.payment_intent_id,e.livemode,e.order_id,e.processor_environment_id,e.state,e.reason,e.created_at,e.processed_at FROM mr_payment_events e
        WHERE EXISTS(SELECT 1 FROM mr_billing_payment_ownership p WHERE p.workspace_id=$1
          AND p.payment_intent_id=e.payment_intent_id AND p.processor_environment_id=e.processor_environment_id AND p.livemode=e.livemode)
        OR EXISTS(SELECT 1 FROM mr_payment_orders o WHERE o.workspace_id=$1 AND o.id=e.order_id
          AND o.processor_environment_id IS NOT DISTINCT FROM e.processor_environment_id AND o.livemode=e.livemode)
        ORDER BY e.id LIMIT 100001`,
        [workspaceId],
      )
    ).rows;
    const externalReturns = (
      await client.query(
        `SELECT c.id AS source_case_id,c.reference AS source_case_reference,'prepare'::text AS phase,
          NULL::text AS audit_reference,NULL::bigint AS audit_ordinal,item->>'refundId' AS refund_id,
          item->>'amountCents' AS amount_cents,item->>'status' AS status,
          COALESCE(item->>'definitiveFailureBalanceReturned','false') AS definitive_failure_balance_returned,
          item->>'evidenceReference' AS evidence_reference
        FROM mr_staff_refund_cases c
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.worksheet->'externalReturns','[]'::jsonb)) item
        WHERE c.workspace_id=$1
        UNION ALL
        SELECT c.id,c.reference,a.action,a.reference,a.ordinal,item->>'refundId',item->>'amountCents',
          item->>'status',COALESCE(item->>'definitiveFailureBalanceReturned','false'),item->>'evidenceReference'
        FROM mr_staff_refund_audit a JOIN mr_staff_refund_cases c ON c.id=a.case_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
          a.evidence->'detail'->'approvedWorksheet'->'worksheet'->'externalReturns',
          a.evidence->'input'->'worksheet'->'externalReturns','[]'::jsonb)) item
        WHERE c.workspace_id=$1 AND a.action IN ('prepare','dispatch','apply-success','release-failed','restore-failed')
          AND a.evidence->'detail'->'allocationProof'->>'requestHash' ~ '^[a-f0-9]{64}$'
          AND a.evidence->'detail'->'allocationProof'->>'approvalReference' IS NOT NULL
        ORDER BY source_case_id,audit_ordinal NULLS FIRST,audit_reference NULLS FIRST,refund_id,amount_cents,status,evidence_reference
        LIMIT 100001`,
        [workspaceId],
      )
    ).rows;
    const rows = {
      jobs,
      ledger,
      attempts,
      intents,
      keyReservations,
      funding,
      automaticFunding,
      holds,
      cases,
      observations,
      events,
      externalReturns,
      agedCostReliefs: reliefSchema
        ? (
            await client.query(
              `SELECT job_id,amount_micros::text,credit_ledger_id,
        policy_version,request_version,allocation,created_at FROM mr_aged_cost_reliefs
        WHERE workspace_id=$1 ORDER BY created_at,job_id LIMIT 100001`,
              [workspaceId],
            )
          ).rows
        : [],
      agedCostReliefSettlements: reliefSchema
        ? (
            await client.query(
              `SELECT job_id,advance_micros::text,gross_charge_micros::text,
        recovered_micros::text,operator_funded_micros::text,settle_ledger_id,release_ledger_id,offset_ledger_id,
        created_at FROM mr_aged_cost_relief_settlements WHERE workspace_id=$1
        ORDER BY created_at,job_id LIMIT 100001`,
              [workspaceId],
            )
          ).rows
        : [],
    };
    // One overflow sentinel row bounds reads; never hash a truncated chronology.
    if (Object.values(rows).some((values) => values.length > 100000))
      fail('staff_refund_review', 'Financial history exceeds the reviewed worksheet bound.');
    return JSON.parse(JSON.stringify(rows)) as Record<string, Record<string, unknown>[]>;
  }
  private async currentSnapshot(
    client: PoolClient,
    workspaceId: string,
  ): Promise<StaffRefundSnapshot> {
    const balance = (
      await client.query('SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1', [
        workspaceId,
      ])
    ).rows[0];
    if (!balance) fail('staff_refund_not_found', 'Workspace not found.', 404);
    return {
      availableMicros: money(Number(balance.available_micros)),
      reservedMicros: money(Number(balance.reserved_micros)),
      exposureHash: staffRefundHash(await this.financialRows(client, workspaceId)),
    };
  }
  private async allocation(
    client: PoolClient,
    context: unknown,
    actor: StaffRefundActor,
    operation: StaffRefundAllocationRequest['operation'],
    funding: Pick<
      CaseRow,
      | 'workspace_id'
      | 'order_id'
      | 'payment_intent_id'
      | 'credit_reference'
      | 'original_amount_cents'
      | 'eligible_micros'
      | 'cash_cents'
      | 'rounding_expense_micros'
      | 'reference'
      | 'request_hash'
    >,
    approved: StaffRefundWorksheet,
    reaffirmation?: VerifiedStaffRefundEvidence,
  ): Promise<StaffRefundAllocationApproval> {
    if (!this.approveAllocation)
      fail(
        'staff_refund_allocation_unapproved',
        'Trusted staff approval of the actual paid allocation is required.',
        403,
      );
    const amount = Number(funding.eligible_micros);
    let allocated = 0n;
    for (const row of approved.allocation) {
      if (row.disposition === 'eligible-paid') {
        if (row.fundingReference !== funding.credit_reference)
          fail(
            'staff_refund_allocation_unapproved',
            'Eligible paid allocation names another original payment.',
            403,
          );
        allocated += BigInt(row.amountMicros);
      }
    }
    if (allocated !== BigInt(amount))
      fail(
        'staff_refund_allocation_unapproved',
        'Manual allocation must bind the exact eligible remainder of this original payment.',
        403,
      );
    const body = {
      operation,
      workspaceId: funding.workspace_id,
      orderId: funding.order_id,
      paymentIntentId: funding.payment_intent_id,
      processorEnvironmentId: this.environment.id,
      processorAccountId: this.environment.accountId,
      livemode: this.environment.livemode,
      creditReference: funding.credit_reference,
      originalAmountCents: funding.original_amount_cents,
      caseReference: funding.reference,
      caseRequestHash: funding.request_hash,
      eligibleMicros: amount,
      cashCents: funding.cash_cents,
      roundingExpenseMicros: funding.rounding_expense_micros,
      requestVersion: STAFF_REFUND_REQUEST_VERSION,
      conversionVersion: STAFF_REFUND_CONVERSION_VERSION,
      worksheet: approved,
      worksheetHash: staffRefundHash(approved),
      reaffirmation: reaffirmation
        ? {
            eventId: reaffirmation.eventId,
            payloadFingerprint: reaffirmation.payloadFingerprint,
            eventCreated: reaffirmation.eventCreated,
          }
        : null,
    } as const;
    const request: StaffRefundAllocationRequest = { ...body, requestHash: staffRefundHash(body) };
    const hash = request.requestHash;
    const before = await this.authority(client, context);
    if (before.id !== actor.id)
      fail(
        'staff_refund_authority_required',
        'Staff authority changed before allocation approval.',
        403,
      );
    const proof = await this.approveAllocation(
      client,
      context,
      JSON.parse(JSON.stringify(request)) as StaffRefundAllocationRequest,
    );
    const after = await this.authority(client, context);
    if (after.id !== actor.id)
      fail(
        'staff_refund_authority_required',
        'Staff authority changed during allocation approval.',
        403,
      );
    if (!proof || proof.requestHash !== hash)
      fail(
        'staff_refund_allocation_unapproved',
        'Staff allocation approval does not bind this frozen request.',
        403,
      );
    bounded(proof.approvalReference);
    return { requestHash: hash, approvalReference: proof.approvalReference };
  }
  async snapshot(workspaceId: string, context: unknown): Promise<StaffRefundSnapshot> {
    return (await this.reviewEvidence(workspaceId, context)).snapshot;
  }
  async reviewEvidence(workspaceId: string, context: unknown): Promise<StaffRefundReviewEvidence> {
    bounded(workspaceId, 80);
    return this.tx(
      context,
      async (client, actor) => {
        const balance = (
          await client.query(
            'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1',
            [workspaceId],
          )
        ).rows[0];
        if (!balance) fail('staff_refund_not_found', 'Workspace not found.', 404);
        if ((await this.authority(client, context)).id !== actor.id)
          fail('staff_refund_authority_required', 'Staff authority changed.', 403);
        const financialRows = await this.financialRows(client, workspaceId);
        return {
          snapshot: {
            availableMicros: money(Number(balance.available_micros)),
            reservedMicros: money(Number(balance.reserved_micros)),
            exposureHash: staffRefundHash(financialRows),
          },
          financialRows,
        };
      },
      true,
    );
  }
  private async view(client: PoolClient, row: CaseRow): Promise<StaffRefundCase> {
    const holds = (
      await client.query(
        'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 ORDER BY event_id',
        [row.id],
      )
    ).rows;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      orderId: row.order_id,
      origin: row.origin,
      eligibleMicros: Number(row.eligible_micros),
      cashCents: row.cash_cents,
      principalClaimCents: row.principal_claim_cents,
      roundingExpenseMicros: row.rounding_expense_micros,
      earmarkedMicros: Number(row.earmark_micros),
      outstandingMicros: Number(row.outstanding_micros),
      state: row.state,
      financialState: row.financial_state,
      reviewRequired: row.review_required,
      refundId: row.refund_id,
      dispatchKey: row.dispatch_key,
      holdIds: holds.map((h) => h.event_id as string),
    };
  }
  private async row(client: PoolClient, id: string): Promise<CaseRow> {
    const row = (
      await client.query<CaseRow>('SELECT * FROM mr_staff_refund_cases WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0];
    if (!row) fail('staff_refund_not_found', 'Refund case not found.', 404);
    return row;
  }
  private async withCase<T>(
    id: string,
    context: unknown,
    fn: (client: PoolClient, row: CaseRow, actor: StaffRefundActor) => Promise<T>,
  ): Promise<T> {
    uuid(id);
    return this.tx(context, async (client, actor) => {
      const identity = (
        await client.query<CaseRow>('SELECT * FROM mr_staff_refund_cases WHERE id=$1', [id])
      ).rows[0];
      if (!identity) fail('staff_refund_not_found', 'Refund case not found.', 404);
      if (
        identity.processor_environment_id !== this.environment.id ||
        identity.processor_account_id !== this.environment.accountId ||
        identity.livemode !== this.environment.livemode
      )
        fail(
          'staff_refund_payment_mismatch',
          'Refund case requires its original processor environment.',
        );
      if (
        identity.request_version !== STAFF_REFUND_REQUEST_VERSION ||
        identity.conversion_version !== STAFF_REFUND_CONVERSION_VERSION
      )
        fail(
          'staff_refund_conflict',
          'Historical refund request or conversion version cannot be reinterpreted.',
        );
      await lockPaymentIntentInTransaction(client, identity.payment_intent_id);
      await this.workspace(client, identity.workspace_id, context, actor);
      const funding = await this.funding(client, identity.workspace_id, identity.order_id);
      if (
        funding.payment_intent_id !== identity.payment_intent_id ||
        funding.amount_cents !== identity.original_amount_cents ||
        identity.credit_reference !== `stripe-topup:${funding.id}`
      )
        fail('staff_refund_payment_mismatch', 'Original payment identity changed.');
      return fn(client, await this.row(client, id), actor);
    });
  }
  private async audit(
    client: PoolClient,
    row: Pick<CaseRow, 'id'>,
    actor: StaffRefundActor,
    type: string,
    input: unknown,
    ref: string,
    detail?: unknown,
    checkOnly = false,
  ): Promise<boolean> {
    const hash = staffRefundHash({ action: type, input });
    const prior = (
      await client.query(
        'SELECT action,request_hash FROM mr_staff_refund_audit WHERE case_id=$1 AND reference=$2',
        [row.id, ref],
      )
    ).rows[0];
    if (prior) {
      if (prior.action !== type || prior.request_hash !== hash)
        fail('staff_refund_conflict', 'Audit reference already has a different frozen request.');
      return false;
    }
    if (checkOnly) return true;
    await client.query(
      'INSERT INTO mr_staff_refund_audit(id,case_id,action,reference,request_hash,actor,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        row.id,
        type,
        ref,
        hash,
        JSON.stringify(actor),
        JSON.stringify({ input, ...(detail === undefined ? {} : { detail }) }),
      ],
    );
    return true;
  }
  private async latestApprovedWorksheet(
    client: PoolClient,
    row: Pick<CaseRow, 'id'>,
  ): Promise<StaffRefundWorksheet> {
    const phase = (
      await client.query<{ worksheet: StaffRefundWorksheet; worksheet_hash: string }>(
        `SELECT COALESCE(a.evidence->'detail'->'approvedWorksheet'->'worksheet',a.evidence->'input'->'worksheet') AS worksheet,
          COALESCE(a.evidence->'detail'->'approvedWorksheet'->>'worksheetHash',a.evidence->'input'->>'worksheetHash') AS worksheet_hash
        FROM mr_staff_refund_audit a WHERE a.case_id=$1
          AND a.action IN ('prepare','dispatch','apply-success','release-failed','restore-failed')
          AND a.evidence->'detail'->'allocationProof'->>'requestHash' ~ '^[a-f0-9]{64}$'
          AND a.evidence->'detail'->'allocationProof'->>'approvalReference' IS NOT NULL
          AND COALESCE(a.evidence->'detail'->'approvedWorksheet'->'worksheet',a.evidence->'input'->'worksheet') IS NOT NULL
        ORDER BY a.ordinal DESC LIMIT 1`,
        [row.id],
      )
    ).rows[0];
    if (!phase) fail('staff_refund_review', 'An audited approved worksheet is required.');
    worksheet(phase.worksheet, phase.worksheet_hash);
    return phase.worksheet;
  }
  private async hold(client: PoolClient, row: CaseRow, reason: string) {
    await client.query(
      "INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason,source_kind,staff_refund_case_id) VALUES($1,$2,$3,$4,'staff-refund',$5)",
      [`staff-refund:${row.id}:${randomUUID()}`, row.workspace_id, row.order_id, reason, row.id],
    );
  }
  private validateEvidence(
    row: Pick<
      CaseRow,
      'workspace_id' | 'order_id' | 'payment_intent_id' | 'cash_cents' | 'refund_id' | 'charge_id'
    >,
    evidence: VerifiedStaffRefundEvidence,
  ): boolean {
    assertVerifiedStaffRefundEvidence(evidence);
    const env = this.environment;
    if (
      evidence.workspaceId !== row.workspace_id ||
      evidence.orderId !== row.order_id ||
      evidence.processorEnvironmentId !== env.id ||
      evidence.processorAccountId !== env.accountId ||
      evidence.livemode !== env.livemode ||
      evidence.paymentIntentId !== row.payment_intent_id ||
      evidence.currency !== 'USD' ||
      (row.refund_id !== null && row.refund_id !== evidence.refundId) ||
      (row.charge_id !== null && row.charge_id !== evidence.chargeId)
    )
      fail(
        'staff_refund_payment_mismatch',
        'Verified refund must match the exact original payment and frozen cash amount.',
      );
    return evidence.amountCents === row.cash_cents;
  }
  async prepare(input: PrepareStaffRefund, context: unknown): Promise<StaffRefundCase> {
    bounded(input.workspaceId, 80);
    uuid(input.orderId);
    bounded(input.reference);
    worksheet(input.worksheet, input.worksheetHash);
    const eligible = money(input.eligibleMicros);
    if (!eligible || !['new', 'reconcile-existing'].includes(input.origin))
      fail(
        'invalid_staff_refund',
        'A positive eligible paid remainder and explicit origin are required.',
      );
    const cash = Number((BigInt(eligible) + 9999n) / 10000n);
    const rounding = cash * 10000 - eligible;
    if (input.origin === 'reconcile-existing') {
      if (!input.existingRefundEvidence)
        fail(
          'staff_refund_payment_mismatch',
          'Existing returns require sealed original refund evidence.',
        );
      assertVerifiedStaffRefundEvidence(input.existingRefundEvidence);
    } else if (input.existingRefundEvidence)
      fail(
        'staff_refund_conflict',
        'A new case cannot pretend an existing refund is a new dispatch.',
      );
    const verified = input.existingRefundEvidence;
    input = JSON.parse(JSON.stringify(input)) as PrepareStaffRefund;
    if (verified) input.existingRefundEvidence = verified;
    const frozen = {
      ...input,
      ...(verified ? { existingRefundEvidence: evidenceBody(verified) } : {}),
      requestVersion: STAFF_REFUND_REQUEST_VERSION,
      conversionVersion: STAFF_REFUND_CONVERSION_VERSION,
    };
    const hash = staffRefundHash(frozen);
    return this.tx(context, async (client, actor) => {
      const selected = (
        await client.query<FundingRow>(
          'SELECT * FROM mr_payment_orders WHERE workspace_id=$1 AND id=$2',
          [input.workspaceId, input.orderId],
        )
      ).rows[0];
      if (!selected?.payment_intent_id)
        fail('staff_refund_payment_mismatch', 'An original bound paid order is required.');
      await lockPaymentIntentInTransaction(client, selected.payment_intent_id);
      const balance = await this.workspace(client, input.workspaceId, context, actor);
      const funding = await this.funding(client, input.workspaceId, input.orderId);
      if (funding.payment_intent_id !== selected.payment_intent_id)
        fail(
          'staff_refund_payment_mismatch',
          'Original payment binding changed before preparation.',
        );
      const prior = (
        await client.query<CaseRow>(
          'SELECT * FROM mr_staff_refund_cases WHERE workspace_id=$1 AND reference=$2 FOR UPDATE',
          [input.workspaceId, input.reference],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          fail(
            'staff_refund_conflict',
            'Case reference already records another immutable request.',
          );
        return this.view(client, prior);
      }
      if (
        input.existingRefundEvidence &&
        (
          await client.query(
            'SELECT id FROM mr_staff_refund_cases WHERE processor_environment_id=$1 AND refund_id=$2',
            [this.environment.id, input.existingRefundEvidence.refundId],
          )
        ).rowCount
      )
        fail(
          'staff_refund_conflict',
          'This existing processor refund already has its canonical case.',
        );
      const snapshot = await this.currentSnapshot(client, input.workspaceId);
      if (staffRefundHash(snapshot) !== staffRefundHash(input.worksheet.snapshot))
        fail(
          'staff_refund_conflict',
          'Current wallet or accepted exposure differs from the approved worksheet.',
        );
      const claimCash = Math.max(cash, input.existingRefundEvidence?.amountCents ?? 0);
      const principal = await this.principalAvailable(
        client,
        {
          id: '',
          processor_environment_id: this.environment.id,
          payment_intent_id: funding.payment_intent_id!,
          original_amount_cents: funding.amount_cents,
          principal_claim_cents: claimCash,
          refund_id: input.existingRefundEvidence?.refundId ?? null,
        },
        input.worksheet,
        input.existingRefundEvidence,
      );
      const other = principal.externalCents;
      const principalOkay = principal.available;
      if (!principalOkay && input.origin === 'new')
        fail(
          'staff_refund_principal_exceeded',
          'Pending, unknown and succeeded returns cannot exceed the original unreturned principal.',
        );
      const earmarks = BigInt(
        (
          await client.query(
            'SELECT coalesce(sum(earmark_micros),0)::text AS total FROM mr_staff_refund_cases WHERE workspace_id=$1',
            [input.workspaceId],
          )
        ).rows[0].total,
      );
      const enough =
        principalOkay &&
        claimCash === cash &&
        earmarks + BigInt(eligible) <= BigInt(balance.available_micros);
      const allocationProof = await this.allocation(
        client,
        context,
        actor,
        'prepare',
        {
          workspace_id: input.workspaceId,
          order_id: input.orderId,
          payment_intent_id: funding.payment_intent_id!,
          credit_reference: `stripe-topup:${funding.id}`,
          original_amount_cents: funding.amount_cents,
          reference: input.reference,
          request_hash: hash,
          eligible_micros: String(eligible),
          cash_cents: cash,
          rounding_expense_micros: rounding,
        },
        input.worksheet,
      );
      const id = randomUUID();
      const ev = input.existingRefundEvidence;
      if (ev)
        this.validateEvidence(
          {
            workspace_id: input.workspaceId,
            order_id: input.orderId,
            payment_intent_id: funding.payment_intent_id!,
            cash_cents: cash,
            refund_id: null,
            charge_id: null,
          },
          ev,
        );
      const row = (
        await client.query<CaseRow>(
          `INSERT INTO mr_staff_refund_cases(id,workspace_id,order_id,processor_environment_id,processor_account_id,livemode,payment_intent_id,credit_reference,original_amount_cents,origin,reference,request_hash,frozen_body,worksheet,worksheet_hash,external_other_returns_cents,eligible_micros,cash_cents,rounding_expense_micros,earmark_micros,outstanding_micros,state,review_required,refund_id,charge_id,dispatch_key,request_version,conversion_version,principal_claim_cents,evidence_conflict)
        VALUES($1,$2,$3,$4,$5,$28,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'staff-refund-original-v1','usd-ceil-cent-v1',$26,$27) RETURNING *`,
          [
            id,
            input.workspaceId,
            input.orderId,
            this.environment.id,
            this.environment.accountId,
            funding.payment_intent_id,
            `stripe-topup:${funding.id}`,
            funding.amount_cents,
            input.origin,
            input.reference,
            hash,
            JSON.stringify(frozen),
            JSON.stringify(input.worksheet),
            input.worksheetHash,
            other,
            eligible,
            cash,
            rounding,
            enough ? eligible : 0,
            enough ? 0 : eligible,
            enough ? 'prepared' : 'review',
            !enough,
            ev?.refundId ?? null,
            ev?.chargeId ?? null,
            `opengen-staff-refund-${id}`,
            claimCash,
            claimCash !== cash,
            this.environment.livemode,
          ],
        )
      ).rows[0]!;
      await this.hold(
        client,
        row,
        enough ? 'staff-refund-prepared' : 'staff-refund-insufficient-available',
      );
      await this.audit(client, row, actor, 'prepare', frozen, input.reference, {
        allocationProof,
        approvedWorksheet: { worksheet: input.worksheet, worksheetHash: input.worksheetHash },
        before: snapshot,
        after: snapshot,
      });
      if (ev) await this.observe(client, row, ev);
      return this.view(client, await this.row(client, id));
    });
  }
  async dispatch(
    caseId: string,
    input: DispatchStaffRefund,
    context: unknown,
  ): Promise<StaffRefundCase> {
    action(input);
    input = JSON.parse(JSON.stringify(input)) as DispatchStaffRefund;
    if (input.worksheet) worksheet(input.worksheet, input.worksheetHash ?? '');
    return this.withCase(caseId, context, async (client, row, actor) => {
      const prior = (
        await client.query(
          "SELECT reference FROM mr_staff_refund_audit WHERE case_id=$1 AND action='dispatch'",
          [row.id],
        )
      ).rows[0];
      if (prior) {
        if (prior.reference !== input.reference)
          fail(
            'staff_refund_not_dispatchable',
            'The original case has already been claimed; no second dispatch is permitted.',
          );
        await this.audit(client, row, actor, 'dispatch', input, input.reference);
        return { ...(await this.view(client, row)), dispatchClaimed: false };
      }
      if (
        row.origin !== 'new' ||
        row.dispatched_at ||
        row.refund_id ||
        row.evidence_conflict ||
        !['prepared', 'review'].includes(row.state)
      )
        fail(
          'staff_refund_not_dispatchable',
          'Only the secured original new case may be claimed once.',
        );
      const approved = input.worksheet ?? row.worksheet;
      if (
        staffRefundHash(approved.snapshot) !==
        staffRefundHash(await this.currentSnapshot(client, row.workspace_id))
      )
        fail(
          'staff_refund_conflict',
          'Current accepted work requires a fresh approved worksheet before dispatch.',
        );
      const allocationProof = await this.allocation(
        client,
        context,
        actor,
        'dispatch',
        row,
        approved,
      );
      if (!(await this.principalAvailable(client, row, approved)).available)
        fail(
          'staff_refund_principal_exceeded',
          'Original principal is no longer available for a cash dispatch.',
        );
      const risk = await client.query(
        "SELECT 1 FROM mr_billing_holds h JOIN mr_payment_events e ON e.id=h.stripe_event_id WHERE h.workspace_id=$1 AND h.order_id=$2 AND h.source_kind='stripe' AND h.resolved_at IS NULL AND e.processor_environment_id=$3 AND e.livemode=$4 LIMIT 1",
        [row.workspace_id, row.order_id, this.environment.id, this.environment.livemode],
      );
      const unresolved = await client.query(
        "SELECT 1 FROM mr_payment_events WHERE payment_intent_id=$1 AND processor_environment_id=$2 AND livemode=$3 AND state IN ('pending','rejected') AND (type LIKE 'charge.dispute.%' OR type IN ('charge.refunded','refund.created','refund.updated','refund.failed')) LIMIT 1",
        [row.payment_intent_id, this.environment.id, this.environment.livemode],
      );
      if (risk.rowCount || unresolved.rowCount)
        fail(
          'staff_refund_review',
          'Processor risk or return uncertainty requires review before a cash dispatch.',
        );
      const balance = (
        await client.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
          row.workspace_id,
        ])
      ).rows[0];
      const earmarks = BigInt(
        (
          await client.query(
            'SELECT coalesce(sum(earmark_micros),0)::text AS total FROM mr_staff_refund_cases WHERE workspace_id=$1 AND id<>$2',
            [row.workspace_id, row.id],
          )
        ).rows[0].total,
      );
      if (BigInt(balance.available_micros) < earmarks + BigInt(row.eligible_micros))
        fail(
          'staff_refund_not_dispatchable',
          'Eligible credit is not secured against other refund cases.',
        );
      await this.audit(client, row, actor, 'dispatch', input, input.reference, {
        allocationProof,
        approvedWorksheet: { worksheet: approved, worksheetHash: staffRefundHash(approved) },
        before: approved.snapshot,
        after: approved.snapshot,
      });
      await client.query(
        "UPDATE mr_staff_refund_cases SET dispatched_at=now(),state='unknown',earmark_micros=eligible_micros,outstanding_micros=0,review_required=false,updated_at=now() WHERE id=$1",
        [row.id],
      );
      return {
        ...(await this.view(client, await this.row(client, row.id))),
        dispatchClaimed: true,
      };
    });
  }
  private async observe(
    client: PoolClient,
    row: CaseRow,
    evidence: VerifiedStaffRefundEvidence,
    approved?: StaffRefundWorksheet,
    approvedFailureFinalization = false,
  ) {
    const amountMatches = this.validateEvidence(row, evidence);
    const body = evidenceBody(evidence);
    const hash = staffRefundHash(body);
    const prior = (
      await client.query(
        'SELECT case_id,observation_hash FROM mr_staff_refund_observations WHERE processor_environment_id=$1 AND event_id=$2',
        [this.environment.id, evidence.eventId],
      )
    ).rows[0];
    if (prior) {
      if (prior.case_id !== row.id || prior.observation_hash !== hash)
        fail('staff_refund_conflict', 'Processor event already has a different refund identity.');
      return;
    }
    const claimed = (
      await client.query(
        'SELECT id FROM mr_staff_refund_cases WHERE processor_environment_id=$1 AND refund_id=$2',
        [this.environment.id, evidence.refundId],
      )
    ).rows[0];
    if (claimed && claimed.id !== row.id)
      fail('staff_refund_conflict', 'Original refund is already assigned to another case.');
    await client.query(
      'INSERT INTO mr_staff_refund_observations(processor_environment_id,event_id,case_id,refund_id,event_created,observation_hash,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        this.environment.id,
        evidence.eventId,
        row.id,
        evidence.refundId,
        evidence.eventCreated,
        hash,
        JSON.stringify(body),
      ],
    );
    const oldTime = row.latest_event_created === null ? null : Number(row.latest_event_created);
    const outOfOrder = oldTime !== null && evidence.eventCreated < oldTime;
    const contradiction =
      row.latest_status !== null &&
      row.latest_status !== 'pending' &&
      evidence.status !== row.latest_status;
    const simultaneous =
      oldTime !== null &&
      evidence.eventCreated === oldTime &&
      row.latest_status !== evidence.status;
    const finalizedFailureConfirmed =
      ['released', 'restored'].includes(row.financial_state) &&
      row.latest_status === 'failed' &&
      row.definitive_failure_balance_returned &&
      !row.review_required &&
      !row.evidence_conflict &&
      !row.ordering_review &&
      amountMatches &&
      evidence.status === 'failed' &&
      evidence.definitiveFailureBalanceReturned &&
      !contradiction &&
      !simultaneous;
    if (
      approvedFailureFinalization &&
      (!amountMatches || evidence.status !== 'failed' || !evidence.definitiveFailureBalanceReturned)
    )
      fail(
        'staff_refund_review',
        'Only matching definitive failed evidence may exclude this claim.',
      );
    // A consistent proven failure does not become a new principal claim simply
    // because Stripe emits another event. Older conflicting facts still review.
    const orderingReview =
      !finalizedFailureConfirmed && (outOfOrder || contradiction || simultaneous);
    let capOkay = false;
    let accountingReview = false;
    try {
      capOkay = (
        await this.principalAvailable(
          client,
          {
            ...row,
            principal_claim_cents: Math.max(row.principal_claim_cents, evidence.amountCents),
          },
          approved ?? (await this.latestApprovedWorksheet(client, row)),
          evidence,
          finalizedFailureConfirmed || approvedFailureFinalization,
        )
      ).available;
    } catch (error) {
      // The immutable, valid processor receipt must survive incomplete or
      // conflicting accounting approval. No financial action occurs here.
      if (!(error instanceof StaffRefundError)) throw error;
      accountingReview = true;
    }
    const review = row.review_required || !amountMatches || !capOkay || orderingReview;
    if (!amountMatches || !capOkay || orderingReview)
      await this.hold(
        client,
        row,
        accountingReview ? 'staff-refund-accounting-review' : 'staff-refund-contradictory-evidence',
      );
    await client.query(
      `UPDATE mr_staff_refund_cases SET refund_id=$2,charge_id=$3,latest_status=$4,latest_event_id=$5,latest_event_created=$6,
      definitive_failure_balance_returned=$7,state=$8,review_required=$9,evidence_conflict=evidence_conflict OR $10,principal_claim_cents=GREATEST(principal_claim_cents,$11),ordering_review=ordering_review OR $12,updated_at=now() WHERE id=$1`,
      [
        row.id,
        evidence.refundId,
        evidence.chargeId,
        outOfOrder || simultaneous ? row.latest_status : evidence.status,
        outOfOrder || simultaneous ? row.latest_event_id : evidence.eventId,
        outOfOrder || simultaneous ? oldTime : evidence.eventCreated,
        outOfOrder || simultaneous
          ? row.definitive_failure_balance_returned
          : evidence.definitiveFailureBalanceReturned,
        review ? 'review' : evidence.status,
        review,
        !amountMatches,
        evidence.amountCents,
        orderingReview,
      ],
    );
  }
  private async principalAvailable(
    client: PoolClient,
    row: Pick<
      CaseRow,
      | 'id'
      | 'processor_environment_id'
      | 'payment_intent_id'
      | 'original_amount_cents'
      | 'principal_claim_cents'
      | 'refund_id'
    >,
    approved: StaffRefundWorksheet,
    incoming?: VerifiedStaffRefundEvidence,
    // Only trusted internal callers with matching definitive failed-return
    // evidence may remove the current claim. All other history remains checked.
    excludeCurrentFailedClaim = false,
  ): Promise<{ available: boolean; externalCents: number }> {
    const cases = (
      await client.query<CaseRow>(
        'SELECT * FROM mr_staff_refund_cases WHERE processor_environment_id=$1 AND payment_intent_id=$2 ORDER BY id LIMIT 100001',
        [row.processor_environment_id, row.payment_intent_id],
      )
    ).rows;
    const historical = (
      await client.query(
        `SELECT item->>'refundId' AS refund_id,item->>'amountCents' AS amount_cents FROM mr_staff_refund_cases c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.worksheet->'externalReturns','[]'::jsonb)) item
      WHERE c.processor_environment_id=$1 AND c.payment_intent_id=$2
      UNION ALL SELECT item->>'refundId',item->>'amountCents' FROM mr_staff_refund_audit a JOIN mr_staff_refund_cases c ON c.id=a.case_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
        a.evidence->'detail'->'approvedWorksheet'->'worksheet'->'externalReturns',
        a.evidence->'input'->'worksheet'->'externalReturns','[]'::jsonb)) item
      WHERE c.processor_environment_id=$1 AND c.payment_intent_id=$2
        AND a.action IN ('prepare','dispatch','apply-success','release-failed','restore-failed')
        AND a.evidence->'detail'->'allocationProof'->>'requestHash' ~ '^[a-f0-9]{64}$'
        AND a.evidence->'detail'->'allocationProof'->>'approvalReference' IS NOT NULL
      ORDER BY refund_id,amount_cents LIMIT 100001`,
        [row.processor_environment_id, row.payment_intent_id],
      )
    ).rows;
    const observations = (
      await client.query<{ refund_id: string; amount_cents: string }>(
        `SELECT DISTINCT o.refund_id,o.evidence->>'amountCents' AS amount_cents
        FROM mr_staff_refund_cases c JOIN mr_staff_refund_observations o
          ON o.processor_environment_id=c.processor_environment_id AND o.case_id=c.id
        WHERE c.processor_environment_id=$1 AND c.payment_intent_id=$2
        ORDER BY o.refund_id,amount_cents LIMIT 100001`,
        [row.processor_environment_id, row.payment_intent_id],
      )
    ).rows;
    if (cases.length > 100000 || historical.length > 100000 || observations.length > 100000)
      fail('staff_refund_review', 'Refund history exceeds the approved worksheet bound.');
    const historicalAmounts = new Map<string, Set<number>>();
    for (const previous of historical) {
      const amounts = historicalAmounts.get(previous.refund_id) ?? new Set<number>();
      amounts.add(Number(previous.amount_cents));
      historicalAmounts.set(previous.refund_id, amounts);
    }
    const observedAmounts = new Map<string, Set<number>>();
    for (const observation of observations) {
      const amounts = observedAmounts.get(observation.refund_id) ?? new Set<number>();
      amounts.add(Number(observation.amount_cents));
      observedAmounts.set(observation.refund_id, amounts);
    }
    if (incoming) {
      const amounts = observedAmounts.get(incoming.refundId) ?? new Set<number>();
      amounts.add(incoming.amountCents);
      observedAmounts.set(incoming.refundId, amounts);
    }
    // Canonical association removes duplicate counting, never historical amount
    // validation. Check registered facts even when omitted from this worksheet.
    for (const [refundId, amounts] of historicalAmounts) {
      const actual = observedAmounts.get(refundId);
      const historicalAmount = amounts.values().next().value;
      if (
        actual &&
        (amounts.size !== 1 ||
          actual.size !== 1 ||
          historicalAmount === undefined ||
          !actual.has(historicalAmount))
      )
        fail(
          'staff_refund_conflict',
          'Registered original refund conflicts with immutable audited cash principal.',
        );
    }
    const historicalConflict = (refundId: string, amountCents: number) => {
      const amounts = historicalAmounts.get(refundId);
      return amounts !== undefined && (amounts.size !== 1 || !amounts.has(amountCents));
    };
    if (incoming && historicalConflict(incoming.refundId, incoming.amountCents))
      fail(
        'staff_refund_conflict',
        'Original verified refund conflicts with previously audited cash principal.',
      );
    let claimed = excludeCurrentFailedClaim ? 0n : BigInt(row.principal_claim_cents),
      external = 0n;
    let consistent = true;
    const registered = new Map(
      cases.filter((c) => c.refund_id !== null).map((c) => [c.refund_id!, c]),
    );
    const itemized = new Set(approved.externalReturns.map((item) => item.refundId));
    for (const previousId of historicalAmounts.keys()) {
      if (
        !itemized.has(previousId) &&
        !registered.has(previousId) &&
        previousId !== (incoming?.refundId ?? row.refund_id)
      )
        fail(
          'staff_refund_review',
          'A previously audited external return must remain explicitly accounted for or be canonically associated.',
        );
    }
    for (const c of cases) {
      if (
        c.id !== row.id &&
        !(
          c.financial_state !== 'none' &&
          ['released', 'restored'].includes(c.financial_state) &&
          c.latest_status === 'failed' &&
          c.definitive_failure_balance_returned &&
          !c.review_required &&
          !c.evidence_conflict &&
          !c.ordering_review
        )
      )
        claimed += BigInt(c.principal_claim_cents);
    }
    for (const item of approved.externalReturns) {
      if (historicalConflict(item.refundId, item.amountCents))
        fail(
          'staff_refund_conflict',
          'An original refund ID already has different audited cash principal.',
        );
      const actual = observedAmounts.get(item.refundId);
      if (actual && (actual.size !== 1 || !actual.has(item.amountCents)))
        fail('staff_refund_conflict', 'Registered original refund has different cash principal.');
      const bound = registered.get(item.refundId);
      if (item.refundId === (incoming?.refundId ?? row.refund_id) || bound) {
        const matchesIncoming = incoming?.refundId === item.refundId;
        if (matchesIncoming && incoming.amountCents !== item.amountCents)
          fail(
            'staff_refund_conflict',
            'Matched original refund amount conflicts with itemized evidence.',
          );
        const effectiveStatus = matchesIncoming ? incoming.status : (bound?.latest_status ?? null);
        if (
          (effectiveStatus !== null &&
            item.status !== 'unknown' &&
            effectiveStatus !== item.status) ||
          (excludeCurrentFailedClaim &&
            item.refundId === (incoming?.refundId ?? row.refund_id) &&
            item.status !== 'failed') ||
          (bound &&
            ['released', 'restored'].includes(bound.financial_state) &&
            bound.latest_status === 'failed' &&
            item.status !== 'failed')
        )
          consistent = false;
        continue;
      }
      // An unbound/unknown case cannot be associated with an item merely by amount.
      // Failed external returns stay conservative unless the approved evidence
      // explicitly establishes processor balance return; this never restores a wallet.
      if (item.status !== 'failed' || !item.definitiveFailureBalanceReturned)
        external += BigInt(item.amountCents);
    }
    return {
      available: consistent && claimed + external <= BigInt(row.original_amount_cents),
      externalCents: Number(external),
    };
  }
  private async receipt(client: PoolClient, row: CaseRow) {
    const wallet = (
      await client.query('SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1', [
        row.workspace_id,
      ])
    ).rows[0];
    const before = {
      availableMicros: money(Number(wallet.available_micros)),
      reservedMicros: money(Number(wallet.reserved_micros)),
    };
    return {
      caseId: row.id,
      caseReference: row.reference,
      orderId: row.order_id,
      creditReference: row.credit_reference,
      processorEnvironmentId: row.processor_environment_id,
      processorAccountId: row.processor_account_id,
      livemode: row.livemode,
      paymentIntentId: row.payment_intent_id,
      refundId: row.refund_id,
      paidCharacter: 'original-payment',
      eligibleMicros: Number(row.eligible_micros),
      cashCents: row.cash_cents,
      roundingExpenseMicros: row.rounding_expense_micros,
      requestVersion: row.request_version,
      conversionVersion: row.conversion_version,
      before,
      after: { ...before },
    };
  }
  private async writeFinancial(
    client: PoolClient,
    row: CaseRow,
    type: 'debit' | 'restore',
    receipt: Awaited<ReturnType<StaffRefundStore['receipt']>>,
  ) {
    const delta = type === 'debit' ? -receipt.eligibleMicros : receipt.eligibleMicros;
    receipt.after.availableMicros = money(receipt.before.availableMicros + delta);
    if (
      BigInt(receipt.after.availableMicros) + BigInt(receipt.after.reservedMicros) >
      BigInt(Number.MAX_SAFE_INTEGER)
    )
      fail('invalid_staff_refund', 'Wallet exceeds safe integer money.');
    const changed = await client.query(
      'UPDATE mr_workspaces SET available_micros=$2 WHERE id=$1 AND available_micros=$3 AND reserved_micros=$4',
      [
        row.workspace_id,
        receipt.after.availableMicros,
        receipt.before.availableMicros,
        receipt.before.reservedMicros,
      ],
    );
    if (changed.rowCount !== 1)
      fail('staff_refund_conflict', 'Wallet changed during financial reconciliation.');
    const ledgerId = randomUUID();
    const publicDetails = {
      supportReference: `staff-refund:${row.id}`,
      eligibleMicros: receipt.eligibleMicros,
      cashCents: receipt.cashCents,
      roundingExpenseMicros: receipt.roundingExpenseMicros,
      requestVersion: receipt.requestVersion,
      conversionVersion: receipt.conversionVersion,
      before: receipt.before,
      after: receipt.after,
    };
    await client.query(
      'INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference,details) VALUES($1,$2,$3,$4,$5,0,$6,$7)',
      [
        ledgerId,
        row.workspace_id,
        type === 'debit' ? 'refund' : 'refund-restore',
        receipt.eligibleMicros,
        delta,
        `staff-refund:${row.id}:${type}`,
        JSON.stringify(publicDetails),
      ],
    );
    await client.query(
      `INSERT INTO mr_staff_refund_financial_entries(case_id,action,ledger_id,amount_micros,cash_cents,rounding_expense_micros,request_version,conversion_version,before_available_micros,after_available_micros,before_reserved_micros,after_reserved_micros,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        row.id,
        type,
        ledgerId,
        receipt.eligibleMicros,
        receipt.cashCents,
        receipt.roundingExpenseMicros,
        receipt.requestVersion,
        receipt.conversionVersion,
        receipt.before.availableMicros,
        receipt.after.availableMicros,
        receipt.before.reservedMicros,
        receipt.after.reservedMicros,
        JSON.stringify(receipt),
      ],
    );
    await client.query(
      'INSERT INTO mr_staff_refund_expenses(case_id,action,amount_micros) VALUES($1,$2,$3)',
      [row.id, type === 'debit' ? 'expense' : 'offset', receipt.roundingExpenseMicros],
    );
  }
  async observeVerifiedProcessorEvidence(
    caseId: string,
    evidence: VerifiedStaffRefundEvidence,
    input: StaffRefundAction,
    context: unknown,
  ): Promise<StaffRefundCase> {
    action(input);
    assertVerifiedStaffRefundEvidence(evidence);
    input = JSON.parse(JSON.stringify(input)) as StaffRefundAction;
    return this.withCase(caseId, context, async (client, row, actor) => {
      await this.audit(
        client,
        row,
        actor,
        'observe',
        { ...input, eventId: evidence.eventId, payloadFingerprint: evidence.payloadFingerprint },
        input.reference,
      );
      await this.observe(client, row, evidence);
      return this.view(client, await this.row(client, row.id));
    });
  }
  private async resolveHolds(
    client: PoolClient,
    row: CaseRow,
    ids: string[],
    input: ReconcileStaffRefund,
    actor: StaffRefundActor,
  ) {
    if (ids.length > 100 || new Set(ids).size !== ids.length)
      fail('invalid_staff_refund', 'Select at most100 distinct holds.');
    if (ids.length) {
      if (!input.holdResolutionEvidenceUrl)
        fail(
          'invalid_staff_refund',
          'Selected hold resolutions require an explicit HTTPS evidence URL.',
        );
      const url = new URL(input.holdResolutionEvidenceUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        input.holdResolutionEvidenceUrl.length > 2000
      )
        fail('invalid_staff_refund', 'Use a bounded credential-free HTTPS resolution reference.');
    }
    for (const id of [...ids].sort()) {
      bounded(id, 250);
      const hold = (
        await client.query(
          'SELECT * FROM mr_billing_holds WHERE workspace_id=$1 AND event_id=$2 FOR UPDATE',
          [row.workspace_id, id],
        )
      ).rows[0];
      if (
        !hold ||
        hold.order_id !== row.order_id ||
        (hold.source_kind === 'staff-refund' && hold.staff_refund_case_id !== row.id)
      )
        fail(
          'staff_refund_hold_mismatch',
          'Only individually reviewed holds for this exact payment may resolve.',
        );
      if (hold.source_kind === 'stripe') {
        const event = (
          await client.query('SELECT * FROM mr_payment_events WHERE id=$1', [hold.stripe_event_id])
        ).rows[0];
        if (
          !event ||
          !['refund.created', 'refund.updated', 'refund.failed'].includes(event.type) ||
          event.object_id !== row.refund_id ||
          event.order_id !== row.order_id ||
          event.payment_intent_id !== row.payment_intent_id ||
          event.processor_environment_id !== row.processor_environment_id ||
          event.livemode !== row.livemode
        )
          fail(
            'staff_refund_hold_mismatch',
            'Aggregate charge, dispute and other refund holds require separate audited review.',
          );
      }
      if (hold.resolved_at) {
        if (hold.resolution_reference !== input.reference)
          fail('staff_refund_conflict', 'Hold already has another immutable resolution.');
        continue;
      }
      await client.query(
        'INSERT INTO mr_billing_hold_resolutions(id,event_id,workspace_id,reference,note,evidence_url,actor) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          id,
          row.workspace_id,
          input.reference,
          input.note,
          input.holdResolutionEvidenceUrl,
          JSON.stringify(actor),
        ],
      );
      await client.query(
        'UPDATE mr_billing_holds SET resolved_at=now(),resolution_reference=$3 WHERE workspace_id=$1 AND event_id=$2',
        [row.workspace_id, id, input.reference],
      );
    }
  }
  async reconcile(
    caseId: string,
    input: ReconcileStaffRefund,
    context: unknown,
  ): Promise<StaffRefundCase> {
    action(input);
    const reaffirm = input.reaffirmLatestEvidence;
    if (reaffirm) assertVerifiedStaffRefundEvidence(reaffirm);
    input = JSON.parse(JSON.stringify(input)) as ReconcileStaffRefund;
    if (reaffirm) input.reaffirmLatestEvidence = reaffirm;
    if (!['apply-success', 'release-failed', 'restore-failed'].includes(input.action))
      fail('invalid_staff_refund', 'Select an explicit staff financial action.');
    if (input.worksheet) worksheet(input.worksheet, input.worksheetHash ?? '');
    return this.withCase(caseId, context, async (client, row, actor) => {
      const auditInput = {
        ...input,
        ...(reaffirm ? { reaffirmLatestEvidence: evidenceBody(reaffirm) } : {}),
      };
      if (
        !(await this.audit(
          client,
          row,
          actor,
          input.action,
          auditInput,
          input.reference,
          undefined,
          true,
        ))
      )
        return this.view(client, row);
      const amount = Number(row.eligible_micros);
      let receipt = await this.receipt(client, row);
      let allocationProof: StaffRefundAllocationApproval | undefined;
      let approvedWorksheet: StaffRefundWorksheet | undefined;
      if (input.action === 'apply-success') {
        if (
          row.financial_state === 'restored' ||
          row.evidence_conflict ||
          (row.latest_status !== 'succeeded' && !reaffirm) ||
          (row.ordering_review && !reaffirm)
        )
          fail(
            'staff_refund_review',
            'Latest original refund evidence requires an explicit current staff-approved decision.',
          );
        const approved = input.worksheet ?? row.worksheet;
        if (
          staffRefundHash(approved.snapshot) !==
          staffRefundHash(await this.currentSnapshot(client, row.workspace_id))
        )
          fail(
            'staff_refund_conflict',
            'Current wallet/exposure requires a fresh staff-approved worksheet.',
          );
        if (
          reaffirm &&
          (!this.validateEvidence(row, reaffirm) ||
            reaffirm.status !== 'succeeded' ||
            reaffirm.eventCreated < Number(row.latest_event_created ?? 0))
        )
          fail(
            'staff_refund_review',
            'Reaffirmation must match the exact original refund and current success.',
          );
        allocationProof = await this.allocation(
          client,
          context,
          actor,
          'apply-success',
          row,
          approved,
          reaffirm,
        );
        approvedWorksheet = approved;
        if (reaffirm) {
          await this.observe(client, row, reaffirm, approved);
          await client.query(
            "UPDATE mr_staff_refund_cases SET latest_status='succeeded',latest_event_id=$2,latest_event_created=$3,definitive_failure_balance_returned=false WHERE id=$1",
            [row.id, reaffirm.eventId, reaffirm.eventCreated],
          );
          // First verified evidence may have bound the refund/charge identity.
          // Financial receipts must use that committed-in-this-transaction tuple.
          row = await this.row(client, row.id);
          receipt = await this.receipt(client, row);
        }
        const current = (
          await client.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
            row.workspace_id,
          ])
        ).rows[0];
        const other = BigInt(
          (
            await client.query(
              'SELECT coalesce(sum(earmark_micros),0)::text AS total FROM mr_staff_refund_cases WHERE workspace_id=$1 AND id<>$2',
              [row.workspace_id, row.id],
            )
          ).rows[0].total,
        );
        // History must validate even without enough available credit. Otherwise
        // the review path could immutably audit an omitted or changed return.
        const principal = await this.principalAvailable(client, row, approved);
        if (
          BigInt(current.available_micros) <
            other + (row.financial_state === 'debited' ? 0n : BigInt(amount)) ||
          !principal.available
        ) {
          await client.query(
            "UPDATE mr_staff_refund_cases SET earmark_micros=0,outstanding_micros=CASE WHEN financial_state='debited' THEN outstanding_micros ELSE eligible_micros END,state='review',review_required=true,updated_at=now() WHERE id=$1",
            [row.id],
          );
          await this.hold(client, row, 'staff-refund-outstanding-liability');
          const reviewed = await this.row(client, row.id);
          await this.audit(client, row, actor, input.action, auditInput, input.reference, {
            allocationProof,
            approvedWorksheet: { worksheet: approved, worksheetHash: staffRefundHash(approved) },
            receipt,
            outstandingMicros: Number(reviewed.outstanding_micros),
          });
          return this.view(client, reviewed);
        }
        if (row.financial_state !== 'debited')
          await this.writeFinancial(client, row, 'debit', receipt);
        await client.query(
          "UPDATE mr_staff_refund_cases SET earmark_micros=0,outstanding_micros=0,financial_state='debited',state='succeeded',review_required=false,ordering_review=false,updated_at=now() WHERE id=$1",
          [row.id],
        );
      } else {
        if (row.evidence_conflict || (row.ordering_review && !reaffirm))
          fail(
            'staff_refund_review',
            'Conflicting money stays held; ordering review needs an explicit current failed-return decision.',
          );
        if (reaffirm) {
          if (
            !this.validateEvidence(row, reaffirm) ||
            reaffirm.status !== 'failed' ||
            !reaffirm.definitiveFailureBalanceReturned ||
            reaffirm.eventCreated < Number(row.latest_event_created ?? 0)
          )
            fail(
              'staff_refund_review',
              'Failed-return reaffirmation requires matching current processor balance-return proof.',
            );
        } else if (row.latest_status !== 'failed' || !row.definitive_failure_balance_returned)
          fail(
            'staff_refund_review',
            'Definitive failed return and processor balance-return proof are required.',
          );
        const approved = input.worksheet ?? row.worksheet;
        if (
          staffRefundHash(approved.snapshot) !==
          staffRefundHash(await this.currentSnapshot(client, row.workspace_id))
        )
          fail(
            'staff_refund_conflict',
            'Current financial exposure requires a fresh staff worksheet.',
          );
        allocationProof = await this.allocation(
          client,
          context,
          actor,
          input.action,
          row,
          approved,
          reaffirm,
        );
        approvedWorksheet = approved;
        if (!(await this.principalAvailable(client, row, approved, reaffirm, true)).available)
          fail(
            'staff_refund_review',
            'Proven failure removes only this claim; other return history still requires review.',
          );
        if (reaffirm) {
          await this.observe(client, row, reaffirm, approved, true);
          await client.query(
            "UPDATE mr_staff_refund_cases SET latest_status='failed',latest_event_id=$2,latest_event_created=$3,definitive_failure_balance_returned=true WHERE id=$1",
            [row.id, reaffirm.eventId, reaffirm.eventCreated],
          );
          row = await this.row(client, row.id);
          receipt = await this.receipt(client, row);
        }
        if (input.action === 'release-failed') {
          if (!['none', 'released'].includes(row.financial_state))
            fail('staff_refund_review', 'A debited refund requires explicit audited restoration.');
          await client.query(
            "UPDATE mr_staff_refund_cases SET earmark_micros=0,outstanding_micros=0,financial_state='released',state='failed',review_required=false,evidence_conflict=false,ordering_review=false,updated_at=now() WHERE id=$1",
            [row.id],
          );
        } else {
          if (!['debited', 'restored'].includes(row.financial_state))
            fail('staff_refund_review', 'Only an original debit can be restored.');
          if (row.financial_state !== 'restored') {
            await this.writeFinancial(client, row, 'restore', receipt);
          }
          await client.query(
            "UPDATE mr_staff_refund_cases SET earmark_micros=0,outstanding_micros=0,financial_state='restored',state='failed',review_required=false,evidence_conflict=false,ordering_review=false,updated_at=now() WHERE id=$1",
            [row.id],
          );
        }
      }
      const final = await this.row(client, row.id);
      await this.audit(client, row, actor, input.action, auditInput, input.reference, {
        receipt,
        ...(allocationProof ? { allocationProof } : {}),
        ...(approvedWorksheet
          ? {
              approvedWorksheet: {
                worksheet: approvedWorksheet,
                worksheetHash: staffRefundHash(approvedWorksheet),
              },
            }
          : {}),
      });
      if (input.resolveHoldIds)
        await this.resolveHolds(client, final, input.resolveHoldIds, input, actor);
      return this.view(client, final);
    });
  }
}
