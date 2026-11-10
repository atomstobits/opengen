import type { Pool, PoolClient } from 'pg';
import { staffRefundHash } from './staff-refunds.js';

export const AGED_COST_RELIEF_VERSION = 'aged-cost-relief-v1' as const;
export class AgedCostReliefError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
    this.name = 'AgedCostReliefError';
  }
}
export interface AgedCostReliefActor {
  kind: 'installation-operator';
  id: string;
}
export interface AgedCostReliefTarget {
  workspaceId: string;
  jobId: string;
  allocation: { ledgerId: string; amountMicros: number }[];
}
export interface AgedCostReliefInput extends AgedCostReliefTarget {
  reference: string;
  note: string;
  evidenceUrl: string;
  snapshotHash: string;
}
export interface ReliefFundingAllocation {
  sourceLedgerId: string;
  sourceReference: string;
  amountMicros: number;
  sourceAmountMicros: number;
  sourcePostingOrder: string | null;
  reservationPostingOrder: string | null;
  chronologyBasis: 'recorded-posting-order' | 'pre-migration-source' | 'independent-staff-evidence';
  character: 'paid' | 'noncash';
  originalPayment: null | {
    kind: 'manual' | 'automatic';
    localId: string;
    paymentIntentId: string;
    processorEnvironmentId: string;
    processorAccountId: string;
    livemode: boolean;
    originalAmountCents: number;
    createdAt: string;
    creditedAt: string;
  };
}
export interface AgedCostReliefReview {
  amountMicros: number;
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  allocation: ReliefFundingAllocation[];
}
export interface AgedCostReliefApprovalRequest extends AgedCostReliefReview {
  requestVersion: typeof AGED_COST_RELIEF_VERSION;
  policyVersion: string;
  workspaceId: string;
  jobId: string;
  reference: string;
  note: string;
  evidenceUrl: string;
  requestHash: string;
}
export interface AgedCostReliefOptions {
  activation?: 'staff-approved';
  policyVersion: string;
  /** Trusted server hooks use this client for reads/revalidation only. They must
   * not perform external I/O, commit, acquire another connection or change money. */
  authorize(client: PoolClient, context: unknown): Promise<AgedCostReliefActor>;
  /** Independently verifies the original funding allocation and its chronology,
   * including prior cash returns. A self-hashed staff packet is not approval. */
  approveRelief?(
    client: PoolClient,
    context: unknown,
    request: Readonly<AgedCostReliefApprovalRequest>,
  ): Promise<{ approvalReference: string; requestHash: string }>;
  creditInTransaction(
    client: PoolClient,
    workspaceId: string,
    amountMicros: number,
    reference: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
}
export interface AgedCostReliefReceipt {
  jobId: string;
  workspaceId: string;
  amountMicros: number;
  creditLedgerId: string;
  allocation: ReliefFundingAllocation[];
  createdAt: Date;
}
type JobRow = {
  id: string;
  workspace_id: string;
  status: string;
  input: Record<string, unknown>;
  request_hash: string;
  reserved_micros: string;
  settled_micros: string | null;
  upstream_cost_micros: string | null;
  upstream_id: string | null;
  attempt_count: number;
  route_snapshot: { id: string };
  deployment_snapshot: { id: string };
  fee_admission: unknown;
  created_at: Date;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code: string, message: string, status = 409): never {
  throw new AgedCostReliefError(code, message, status);
}
function bounded(value: unknown, limit = 200): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > limit ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail('aged_cost_relief_invalid', 'Use a bounded nonempty reference.');
}
function amount(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    fail('aged_cost_relief_invalid', 'Use nonnegative safe integer micro-USD.');
  return result;
}
function keys(value: unknown, names: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== names.length ||
    Reflect.ownKeys(value).some(
      (name) =>
        typeof name !== 'string' ||
        !names.includes(name) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, name)!, 'value'),
    )
  )
    fail('aged_cost_relief_invalid', 'Use only the defined relief fields.');
}
function jobTarget(input: Pick<AgedCostReliefTarget, 'workspaceId' | 'jobId'>) {
  if (
    !input ||
    typeof input.workspaceId !== 'string' ||
    typeof input.jobId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(input.workspaceId) ||
    !uuid.test(input.jobId)
  )
    fail('aged_cost_relief_invalid', 'Select one original workspace-owned job.');
}
function target(input: AgedCostReliefTarget) {
  jobTarget(input);
  if (
    !Array.isArray(input.allocation) ||
    input.allocation.length < 1 ||
    input.allocation.length > 100
  )
    fail('aged_cost_relief_invalid', 'Select one original job and at most 100 funding sources.');
  const ids = new Set<string>();
  for (const part of input.allocation) {
    keys(part, ['ledgerId', 'amountMicros']);
    if (
      !part ||
      typeof part.ledgerId !== 'string' ||
      !uuid.test(part.ledgerId) ||
      ids.has(part.ledgerId.toLowerCase()) ||
      typeof part.amountMicros !== 'number' ||
      !amount(part.amountMicros)
    )
      fail('aged_cost_relief_invalid', 'Use distinct funding ledger IDs and positive amounts.');
    ids.add(part.ledgerId.toLowerCase());
  }
}
function receipt(row: Record<string, unknown>): AgedCostReliefReceipt {
  return {
    jobId: row.job_id as string,
    workspaceId: row.workspace_id as string,
    amountMicros: amount(row.amount_micros),
    creditLedgerId: row.credit_ledger_id as string,
    allocation: row.allocation as ReliefFundingAllocation[],
    createdAt: row.created_at as Date,
  };
}

/** Bounded internal operation. No route, scheduler, provider call or cash issuer.
 * The original supplier liability stays held until the ordinary evidence path
 * settles it. Its unused advance is recovered only from that original release. */
export class AgedCostReliefStore {
  constructor(
    private pool: Pool,
    private options: AgedCostReliefOptions,
  ) {
    if (
      !options ||
      typeof options.authorize !== 'function' ||
      typeof options.creditInTransaction !== 'function' ||
      typeof options.policyVersion !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(options.policyVersion) ||
      (options.activation !== undefined && options.activation !== 'staff-approved')
    )
      fail('aged_cost_relief_disabled', 'Use explicit reviewed staff relief composition.', 403);
    this.options = Object.freeze({ ...options });
  }
  private async actor(client: PoolClient, context: unknown) {
    const actor = await this.options.authorize(client, context);
    if (!actor || actor.kind !== 'installation-operator')
      fail(
        'aged_cost_relief_authority_required',
        'Current installation staff authority is required.',
        403,
      );
    bounded(actor.id);
    return { kind: actor.kind, id: actor.id };
  }
  private async withJob<T>(
    input: Pick<AgedCostReliefTarget, 'workspaceId' | 'jobId'>,
    context: unknown,
    run: (client: PoolClient, row: JobRow, actor: AgedCostReliefActor) => Promise<T>,
  ) {
    if (this.options.activation !== 'staff-approved')
      fail('aged_cost_relief_disabled', 'Aged-cost relief is closed by default.', 503);
    jobTarget(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const actor = await this.actor(client, context);
      const owned = await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
        input.workspaceId,
      ]);
      if (!owned.rowCount) fail('aged_cost_relief_not_found', 'Workspace not found.', 404);
      if ((await this.actor(client, context)).id !== actor.id)
        fail('aged_cost_relief_authority_required', 'Staff authority changed.', 403);
      const row = (
        await client.query<JobRow>(
          'SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [input.workspaceId, input.jobId],
        )
      ).rows[0];
      if (!row) fail('aged_cost_relief_not_found', 'Original job not found.', 404);
      const result = await run(client, row, actor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async allocation(
    client: PoolClient,
    input: AgedCostReliefTarget,
  ): Promise<ReliefFundingAllocation[]> {
    const sources = (
      await client.query<{
        id: string;
        reference: string | null;
        kind: string;
        amount_micros: string;
        available_delta_micros: string;
        reserved_delta_micros: string;
        job_id: string | null;
        source_posting_order: string | null;
        reservation_posting_order: string | null;
      }>(
        `SELECT l.id,l.reference,l.kind,l.amount_micros,l.available_delta_micros,l.reserved_delta_micros,l.job_id,
          l.posting_order::text AS source_posting_order,r.posting_order::text AS reservation_posting_order
        FROM mr_ledger l JOIN mr_ledger r ON r.workspace_id=l.workspace_id AND r.job_id=$3 AND r.kind='reserve'
        WHERE l.workspace_id=$1 AND l.id=ANY($2::uuid[]) AND (
          (r.posting_order IS NULL AND l.posting_order IS NULL)
          OR (r.posting_order IS NOT NULL AND (l.posting_order IS NULL OR l.posting_order<r.posting_order)))
        ORDER BY l.id`,
        [input.workspaceId, input.allocation.map((part) => part.ledgerId), input.jobId],
      )
    ).rows;
    const payments = (
      await client.query<{
        kind: 'manual' | 'automatic';
        local_id: string;
        payment_intent_id: string;
        processor_environment_id: string;
        processor_account_id: string;
        livemode: boolean;
        amount_cents: number;
        credit_reference: string;
        created_at: Date;
        credited_at: Date;
      }>(
        `SELECT f.* FROM (
      SELECT 'manual'::text AS kind,o.id AS local_id,o.payment_intent_id,o.processor_environment_id,o.processor_account_id,o.livemode,o.amount_cents,
        'stripe-topup:'||o.id::text AS credit_reference,o.created_at,o.credited_at
      FROM mr_payment_orders o WHERE o.workspace_id=$1 AND o.status='credited' AND o.credited_at IS NOT NULL
      UNION ALL SELECT 'automatic',r.id,r.payment_intent_id,r.processor_environment_id,r.processor_account_id,r.livemode,r.amount_cents,
        'stripe-recharge:'||r.id::text,r.created_at,r.credited_at
      FROM mr_billing_recharge_attempts r WHERE r.workspace_id=$1 AND r.status='succeeded' AND r.credited_at IS NOT NULL
    ) f JOIN mr_billing_payment_ownership p ON p.workspace_id=$1 AND p.credit_reference=f.credit_reference
      AND p.kind=f.kind AND p.local_id=f.local_id AND p.payment_intent_id=f.payment_intent_id
      AND p.processor_environment_id=f.processor_environment_id AND p.livemode=f.livemode
      AND p.amount_cents=f.amount_cents AND p.currency='USD'
    JOIN mr_billing_processor_environments e ON e.id=f.processor_environment_id AND e.account_id=f.processor_account_id AND e.livemode=f.livemode
    WHERE f.credit_reference=ANY($2::text[])`,
        [input.workspaceId, sources.map((source) => source.reference)],
      )
    ).rows;
    const ledger = new Map(sources.map((source) => [source.id, source]));
    const paid = new Map(payments.map((payment) => [payment.credit_reference, payment]));
    return input.allocation.map((part) => {
      const source = ledger.get(part.ledgerId.toLowerCase());
      if (
        !source ||
        !['opening', 'credit'].includes(source.kind) ||
        source.job_id !== null ||
        !amount(source.amount_micros) ||
        Number(source.available_delta_micros) !== Number(source.amount_micros) ||
        Number(source.reserved_delta_micros) !== 0 ||
        part.amountMicros > Number(source.amount_micros) ||
        source.reference?.startsWith('aged-cost-relief:')
      )
        fail(
          'aged_cost_relief_origin_invalid',
          'Trace this allocation to its original positive funding ledger.',
        );
      const payment = source.reference ? paid.get(source.reference) : undefined;
      if (payment && source.kind !== 'credit')
        fail(
          'aged_cost_relief_origin_invalid',
          'Paid funding requires its original positive credit entry.',
        );
      if (
        source.reference?.match(/^stripe-(topup|recharge):/) &&
        (!payment || payment.amount_cents * 10000 !== Number(source.amount_micros))
      )
        fail(
          'aged_cost_relief_origin_invalid',
          'Original paid funding requires its canonical payment ownership.',
        );
      return {
        sourceLedgerId: source.id,
        sourceReference: source.reference ?? `opening:${source.id}`,
        amountMicros: part.amountMicros,
        sourceAmountMicros: amount(source.amount_micros),
        sourcePostingOrder: source.source_posting_order,
        reservationPostingOrder: source.reservation_posting_order,
        chronologyBasis:
          source.reservation_posting_order === null
            ? 'independent-staff-evidence'
            : source.source_posting_order === null
              ? 'pre-migration-source'
              : 'recorded-posting-order',
        character: payment ? 'paid' : 'noncash',
        originalPayment: payment
          ? {
              kind: payment.kind,
              localId: payment.local_id,
              paymentIntentId: payment.payment_intent_id,
              processorEnvironmentId: payment.processor_environment_id,
              processorAccountId: payment.processor_account_id,
              livemode: payment.livemode,
              originalAmountCents: payment.amount_cents,
              createdAt: payment.created_at.toISOString(),
              creditedAt: payment.credited_at.toISOString(),
            }
          : null,
      };
    });
  }
  private async inspect(
    client: PoolClient,
    row: JobRow,
    input: AgedCostReliefTarget,
  ): Promise<AgedCostReliefReview> {
    const attempts = (
      await client.query(
        `SELECT a.id,a.number,a.route_id,a.deployment_id,a.state,a.started_at,a.completed_at,c.identity AS credential_identity
      FROM mr_attempts a LEFT JOIN mr_attempt_credentials c ON c.job_id=a.job_id AND c.attempt_number=a.number AND c.workspace_id=$2
      WHERE a.job_id=$1 ORDER BY a.number LIMIT 101`,
        [row.id, row.workspace_id],
      )
    ).rows;
    if (
      attempts.length > 100 ||
      attempts.length !== row.attempt_count ||
      attempts.some((attempt, index) => attempt.number !== index + 1)
    )
      fail(
        'aged_cost_relief_review_required',
        'Original attempt history needs review before this bounded remedy.',
      );
    const aging = (
      await client.query(
        `SELECT min(started_at)::text AS liability_since,
      coalesce(min(started_at)<=clock_timestamp()-interval '24 hours',false) AS aged
      FROM mr_attempts WHERE job_id=$1`,
        [row.id],
      )
    ).rows[0];
    if (
      (row.input.billing ?? 'managed') !== 'managed' ||
      !amount(row.reserved_micros) ||
      row.settled_micros !== null ||
      row.upstream_cost_micros !== null ||
      !aging.aged ||
      row.attempt_count < 1
    )
      fail(
        'aged_cost_relief_ineligible',
        'Use an aged unresolved managed reservation with original provider exposure.',
      );
    const budget = (
      await client.query(
        `SELECT r.key_id,to_char(r.admission_month,'YYYY-MM-DD') AS admission_month,r.reserved_micros,r.settled_micros,r.admitted_at,
      m.held_micros,m.gross_debit_micros FROM mr_key_reservations r JOIN mr_key_months m USING(workspace_id,key_id,admission_month)
      WHERE r.workspace_id=$1 AND r.job_id=$2 FOR UPDATE OF r`,
        [row.workspace_id, row.id],
      )
    ).rows;
    const reservation = (
      await client.query(
        `SELECT id,amount_micros,available_delta_micros,reserved_delta_micros,created_at,posting_order::text
      FROM mr_ledger WHERE workspace_id=$1 AND job_id=$2 AND kind='reserve'`,
        [row.workspace_id, row.id],
      )
    ).rows;
    if (
      reservation.length !== 1 ||
      Number(reservation[0].amount_micros) !== Number(row.reserved_micros) ||
      Number(reservation[0].available_delta_micros) !== -Number(row.reserved_micros) ||
      Number(reservation[0].reserved_delta_micros) !== Number(row.reserved_micros) ||
      budget.some(
        (entry) =>
          entry.settled_micros !== null ||
          Number(entry.reserved_micros) !== Number(row.reserved_micros),
      )
    )
      fail(
        'aged_cost_relief_ineligible',
        'Original reservation and budget exposure require review.',
      );
    const allocation = await this.allocation(client, input);
    if (
      allocation.reduce((total, part) => total + BigInt(part.amountMicros), 0n) !==
      BigInt(row.reserved_micros)
    )
      fail(
        'aged_cost_relief_origin_invalid',
        'Approve the complete original reservation funding allocation.',
      );
    const balance = (
      await client.query('SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1', [
        row.workspace_id,
      ])
    ).rows[0];
    const chronology = {
      ledger: (
        await client.query(
          `SELECT id,job_id,kind,amount_micros::text,available_delta_micros::text,
        reserved_delta_micros::text,reference,created_at,posting_order::text FROM mr_ledger WHERE workspace_id=$1
        ORDER BY created_at,id LIMIT 100001`,
          [row.workspace_id],
        )
      ).rows,
      holds: (
        await client.query(
          `SELECT event_id,order_id,recharge_attempt_id,source_kind,staff_refund_case_id,
        reason,resolved_at,resolution_reference FROM mr_billing_holds WHERE workspace_id=$1
        ORDER BY event_id LIMIT 100001`,
          [row.workspace_id],
        )
      ).rows,
      refundCases: (
        await client.query(
          `SELECT id,order_id,request_hash,worksheet_hash,principal_claim_cents,
        earmark_micros::text,outstanding_micros::text,state,financial_state,review_required,
        evidence_conflict,ordering_review,refund_id,latest_event_id,latest_event_created,updated_at
        FROM mr_staff_refund_cases WHERE workspace_id=$1 ORDER BY id LIMIT 100001`,
          [row.workspace_id],
        )
      ).rows,
      refundAudit: (
        await client.query(
          `SELECT a.id,a.ordinal,a.case_id,a.action,a.reference,a.request_hash
        FROM mr_staff_refund_audit a JOIN mr_staff_refund_cases c ON c.id=a.case_id
        WHERE c.workspace_id=$1 ORDER BY a.ordinal LIMIT 100001`,
          [row.workspace_id],
        )
      ).rows,
      paymentEvents: (
        await client.query(
          `SELECT e.id,e.type,e.object_id,e.payment_intent_id,e.state,e.reason,
        e.processed_at FROM mr_payment_events e WHERE EXISTS(SELECT 1 FROM mr_billing_payment_ownership p
          WHERE p.workspace_id=$1 AND p.payment_intent_id=e.payment_intent_id
          AND p.processor_environment_id=e.processor_environment_id AND p.livemode=e.livemode)
        OR EXISTS(SELECT 1 FROM mr_payment_orders o WHERE o.workspace_id=$1 AND o.id=e.order_id
          AND o.processor_environment_id IS NOT DISTINCT FROM e.processor_environment_id AND o.livemode=e.livemode)
        ORDER BY e.id LIMIT 100001`,
          [row.workspace_id],
        )
      ).rows,
    };
    if (Object.values(chronology).some((rows) => rows.length > 100000))
      fail(
        'aged_cost_relief_review_required',
        'Funding chronology exceeds this bounded staff remedy.',
      );
    const snapshot = JSON.parse(
      JSON.stringify({
        job: {
          id: row.id,
          workspaceId: row.workspace_id,
          requestHash: row.request_hash,
          inputHash: staffRefundHash(row.input),
          status: row.status,
          attemptCount: row.attempt_count,
          upstreamId: row.upstream_id,
          routeId: row.route_snapshot.id,
          deploymentId: row.deployment_snapshot.id,
          reservedMicros: row.reserved_micros,
          settledMicros: row.settled_micros,
          upstreamCostMicros: row.upstream_cost_micros,
          feeAdmissionHash: staffRefundHash(row.fee_admission),
          createdAt: row.created_at,
        },
        liabilitySince: aging.liability_since,
        chronology,
        attempts,
        budget,
        reservation,
        balance,
        allocation,
      }),
    ) as Record<string, unknown>;
    return {
      amountMicros: amount(row.reserved_micros),
      snapshot,
      snapshotHash: staffRefundHash(snapshot),
      allocation,
    };
  }
  async review(input: AgedCostReliefTarget, context: unknown): Promise<AgedCostReliefReview> {
    keys(input, ['workspaceId', 'jobId', 'allocation']);
    target(input);
    input = JSON.parse(JSON.stringify(input)) as AgedCostReliefTarget;
    return this.withJob(input, context, (client, row) => this.inspect(client, row, input));
  }
  async getReceipt(input: Pick<AgedCostReliefTarget, 'workspaceId' | 'jobId'>, context: unknown) {
    keys(input, ['workspaceId', 'jobId']);
    jobTarget(input);
    input = { workspaceId: input.workspaceId, jobId: input.jobId };
    return this.withJob(input, context, async (client, row) => {
      const grant = (
        await client.query(
          'SELECT * FROM mr_aged_cost_reliefs WHERE workspace_id=$1 AND job_id=$2',
          [row.workspace_id, row.id],
        )
      ).rows[0];
      if (!grant) fail('aged_cost_relief_not_found', 'Relief receipt not found.', 404);
      const settled = (
        await client.query<{ receipt: Record<string, unknown> }>(
          'SELECT receipt FROM mr_aged_cost_relief_settlements WHERE workspace_id=$1 AND job_id=$2',
          [row.workspace_id, row.id],
        )
      ).rows[0];
      return { grant: receipt(grant), settlement: settled?.receipt ?? null };
    });
  }
  async grant(input: AgedCostReliefInput, context: unknown): Promise<AgedCostReliefReceipt> {
    if (!this.options.approveRelief)
      fail(
        'aged_cost_relief_approval_required',
        'Independent current relief approval is required.',
        403,
      );
    keys(input, [
      'workspaceId',
      'jobId',
      'allocation',
      'reference',
      'note',
      'evidenceUrl',
      'snapshotHash',
    ]);
    target(input);
    bounded(input.reference);
    bounded(input.note, 2000);
    bounded(input.evidenceUrl, 2000);
    const url = new URL(input.evidenceUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      typeof input.snapshotHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.snapshotHash)
    )
      fail(
        'aged_cost_relief_invalid',
        'Use a current snapshot and credential-free HTTPS evidence reference.',
      );
    input = JSON.parse(JSON.stringify(input)) as AgedCostReliefInput;
    const frozen = JSON.parse(
      JSON.stringify({
        input,
        policyVersion: this.options.policyVersion,
        requestVersion: AGED_COST_RELIEF_VERSION,
      }),
    );
    const requestHash = staffRefundHash(frozen);
    return this.withJob(input, context, async (client, row, actor) => {
      const prior = (
        await client.query('SELECT * FROM mr_aged_cost_reliefs WHERE job_id=$1', [row.id])
      ).rows[0];
      if (prior) {
        if (prior.workspace_id !== input.workspaceId || prior.request_hash !== requestHash)
          fail(
            'aged_cost_relief_conflict',
            'The original job already has a different immutable relief decision.',
          );
        return receipt(prior);
      }
      const reviewed = await this.inspect(client, row, input);
      if (reviewed.snapshotHash !== input.snapshotHash)
        fail(
          'aged_cost_relief_conflict',
          'Original exposure changed. Review and approve a current snapshot.',
        );
      const request: AgedCostReliefApprovalRequest = {
        ...reviewed,
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        reference: input.reference,
        note: input.note,
        evidenceUrl: input.evidenceUrl,
        policyVersion: this.options.policyVersion,
        requestVersion: AGED_COST_RELIEF_VERSION,
        requestHash,
      };
      const approval = await this.options.approveRelief!(
        client,
        context,
        JSON.parse(JSON.stringify(request)),
      );
      if (!approval || approval.requestHash !== requestHash)
        fail(
          'aged_cost_relief_approval_required',
          'Relief approval does not bind this exact decision.',
          403,
        );
      bounded(approval.approvalReference);
      const current = (
        await client.query<JobRow>('SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2', [
          row.workspace_id,
          row.id,
        ])
      ).rows[0];
      if (
        (await this.actor(client, context)).id !== actor.id ||
        !current ||
        (await this.inspect(client, current, input)).snapshotHash !== reviewed.snapshotHash
      )
        fail('aged_cost_relief_conflict', 'Authority or exposure changed during approval.');
      const creditReference = `aged-cost-relief:${row.id}:advance`;
      await this.options.creditInTransaction(
        client,
        row.workspace_id,
        reviewed.amountMicros,
        creditReference,
        {
          purpose: 'aged-cost-customer-relief',
          jobId: row.id,
          amountMicros: reviewed.amountMicros,
          policyVersion: this.options.policyVersion,
          requestVersion: AGED_COST_RELIEF_VERSION,
        },
      );
      const credit = (
        await client.query('SELECT id FROM mr_ledger WHERE workspace_id=$1 AND reference=$2', [
          row.workspace_id,
          creditReference,
        ])
      ).rows[0];
      const inserted = (
        await client.query(
          `INSERT INTO mr_aged_cost_reliefs(job_id,workspace_id,reference,request_hash,request_version,policy_version,
        snapshot_hash,snapshot,allocation,amount_micros,credit_ledger_id,approval_reference,approval_hash,actor,note,evidence_url,liability_since)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [
            row.id,
            row.workspace_id,
            input.reference,
            requestHash,
            AGED_COST_RELIEF_VERSION,
            this.options.policyVersion,
            reviewed.snapshotHash,
            JSON.stringify(reviewed.snapshot),
            JSON.stringify(reviewed.allocation),
            reviewed.amountMicros,
            credit.id,
            approval.approvalReference,
            approval.requestHash,
            JSON.stringify(actor),
            input.note,
            input.evidenceUrl,
            reviewed.snapshot.liabilitySince,
          ],
        )
      ).rows[0];
      return receipt(inserted);
    });
  }
}
