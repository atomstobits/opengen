import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CreditInTransaction, VerifiedPaymentEvent } from './payments.js';
import {
  centsToMicros,
  PaymentError,
  isPaymentRiskEvent,
  paymentIntentId,
  recordProcessorPaymentEventInTransaction,
} from './payments.js';
import {
  assertBillingProcessorEnvironmentInTransaction,
  assertBillingProcessorTransport,
  sameBillingProcessorEnvironment,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
} from './billing-customer.js';
import {
  canonicalFundingCreditReference,
  claimPaymentOwnershipInTransaction,
  lockPaymentIntentInTransaction,
  PaymentOwnershipError,
} from './billing-payment-ownership.js';
import {
  readBillingPolicyInTransaction,
  readBillingOwnerInTransaction,
  type BillingPolicy,
  type BillingOwner,
} from './billing-policy.js';
import type {
  RechargePayment,
  RechargeTransport,
  RechargeRecoveryTransport,
} from './billing-customer.js';

const active = [
  'queued',
  'submitting',
  'unknown',
  'processing',
  'requires_authentication',
  'review',
];
export type RechargeStatus =
  | 'queued'
  | 'submitting'
  | 'unknown'
  | 'processing'
  | 'requires_authentication'
  | 'review'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export interface RechargeAttempt {
  id: string;
  workspaceId: string;
  policyVersion: number;
  amountCents: number;
  admissionMonth: string;
  status: RechargeStatus;
  createdAt: string;
  updatedAt: string;
  creditedAt: string | null;
  failureCode: string | null;
}
interface AttemptRow {
  id: string;
  workspace_id: string;
  policy_version: number;
  policy_snapshot: BillingPolicy;
  mandate_id: string;
  customer_id: string;
  payment_method_id: string;
  livemode: boolean;
  processor_environment_id: string;
  processor_account_id: string;
  amount_cents: number;
  admission_month: string;
  status: RechargeStatus;
  stripe_idempotency_key: string;
  request_version: 'recharge_pi_v1';
  api_version: '2026-10-28.endive';
  payment_intent_id: string | null;
  external_started_at: Date | null;
  next_request_at: Date | null;
  credited_at: Date | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface RechargeStoreOptions {
  processorEnvironment: BillingProcessorEnvironment;
  /** Explicit source activation gate. Defaults false; fixtures inject true. */
  automaticChargesEnabled?: boolean;
  authenticationRecoveryEnabled?: boolean;
  creditInTransaction: CreditInTransaction;
  lockExternalInTransaction(client: PoolClient): Promise<void>;
  admitExternalInTransaction(client: PoolClient, workspaceId: string): Promise<void>;
  onFundingInTransaction?(
    client: PoolClient,
    input: { workspaceId: string; attemptId: string; amountCents: number },
  ): Promise<void>;
  now?: () => Date;
}
const columns = "*,to_char(admission_month,'YYYY-MM-DD') AS admission_month";
const view = (row: AttemptRow): RechargeAttempt => ({
  id: row.id,
  workspaceId: row.workspace_id,
  policyVersion: row.policy_version,
  amountCents: row.amount_cents,
  admissionMonth: row.admission_month,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  creditedAt: row.credited_at?.toISOString() ?? null,
  failureCode: row.failure_code,
});
const month = (at: Date) =>
  `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;

/** Funding is worker-driven. Reading balance, policy, history or a quote never calls this worker. */
export class RechargeStore {
  private readonly processorEnvironment: Readonly<BillingProcessorEnvironment>;
  constructor(
    private pool: Pool,
    private options: RechargeStoreOptions,
  ) {
    this.processorEnvironment = validatedBillingProcessorEnvironment(options.processorEnvironment);
  }
  private matchesEnvironment(row: AttemptRow) {
    return (
      row.processor_environment_id === this.processorEnvironment.id &&
      row.processor_account_id === this.processorEnvironment.accountId &&
      row.livemode === this.processorEnvironment.livemode
    );
  }
  private async claim(client: PoolClient, row: AttemptRow, intent: string) {
    if (!this.matchesEnvironment(row) || !row.external_started_at)
      throw new PaymentError(
        'payment_environment_unqualified',
        'Original recharge ownership needs review.',
        409,
      );
    return claimPaymentOwnershipInTransaction(client, {
      processorEnvironmentId: this.processorEnvironment.id,
      livemode: this.processorEnvironment.livemode,
      paymentIntentId: intent,
      workspaceId: row.workspace_id,
      kind: 'automatic',
      localId: row.id,
      amountCents: row.amount_cents,
      creditReference: canonicalFundingCreditReference('automatic', row.id),
    });
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async now(client: PoolClient): Promise<Date> {
    return (
      this.options.now?.() ?? (await client.query('SELECT clock_timestamp() AS at')).rows[0].at
    );
  }
  private async workspace(client: PoolClient, id: string) {
    const row = (await client.query('SELECT * FROM mr_workspaces WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!row) throw new PaymentError('not_found', 'Workspace not found.', 404);
    return row;
  }
  private async mandate(client: PoolClient, policy: BillingPolicy) {
    if (!policy.mandateId) return null;
    const owner = await readBillingOwnerInTransaction(client, policy.workspaceId);
    if (!owner) return null;
    return (
      (
        await client.query(
          `SELECT m.* FROM mr_billing_mandates m JOIN mr_billing_customers c
      ON c.workspace_id=m.workspace_id AND c.stripe_customer_id=m.customer_id AND c.livemode=m.livemode AND c.processor_environment_id=m.processor_environment_id AND c.processor_account_id=m.processor_account_id
      WHERE m.id=$1 AND m.workspace_id=$2 AND m.livemode=$3 AND m.status='active' AND m.owner_authority_version=$4 AND m.owner_consent_reference=$5 AND m.owner_membership_epoch=$6 AND m.processor_environment_id=$7 AND m.processor_account_id=$8 FOR SHARE OF m,c`,
          [
            policy.mandateId,
            policy.workspaceId,
            this.processorEnvironment.livemode,
            owner.authorityVersion,
            owner.consentReference,
            owner.membershipEpoch,
            this.processorEnvironment.id,
            this.processorEnvironment.accountId,
          ],
        )
      ).rows[0] ?? null
    );
  }
  private async held(client: PoolClient, id: string) {
    return Boolean(
      (
        await client.query(
          'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
          [id],
        )
      ).rowCount,
    );
  }
  async listInTransaction(
    client: Pick<PoolClient, 'query'>,
    workspaceId: string,
  ): Promise<RechargeAttempt[]> {
    return (
      await client.query<AttemptRow>(
        `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
        [workspaceId],
      )
    ).rows.map(view);
  }
  async list(workspaceId: string): Promise<RechargeAttempt[]> {
    return this.listInTransaction(this.pool, workspaceId);
  }
  async get(workspaceId: string, id: string): Promise<RechargeAttempt> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new PaymentError('not_found', 'Recharge attempt not found.', 404);
    const row = (
      await this.pool.query<AttemptRow>(
        `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id],
      )
    ).rows[0];
    if (!row) throw new PaymentError('not_found', 'Recharge attempt not found.', 404);
    return view(row);
  }
  private withinOwner(policy: BillingPolicy, owner: BillingOwner | null): boolean {
    return Boolean(
      owner &&
      owner.livemode === this.processorEnvironment.livemode &&
      owner.processorEnvironmentId === this.processorEnvironment.id &&
      policy.ownerAuthorityVersion === owner.authorityVersion &&
      owner.rails.allowsEnabled &&
      policy.amountCents <= owner.rails.maxAmountCents &&
      policy.monthlyCapCents <= owner.rails.maxMonthlyCapCents &&
      policy.maxAttemptsPerMonth <= owner.rails.maxAttemptsPerMonth &&
      policy.thresholdMicros <= owner.rails.maxThresholdMicros &&
      policy.cooldownSeconds >= owner.rails.minCooldownSeconds &&
      policy.failureLimit <= owner.rails.maxFailureLimit,
    );
  }
  /** Only a worker may admit. The persisted attempt is not a card charge. */
  async admit(workspaceId: string): Promise<RechargeAttempt | null> {
    if (!this.options.automaticChargesEnabled) return null;
    return this.transaction(async (client) => {
      const balance = await this.workspace(client, workspaceId);
      const policy = await readBillingPolicyInTransaction(client, workspaceId);
      const owner = await readBillingOwnerInTransaction(client, workspaceId);
      if (!this.withinOwner(policy, owner)) return null;
      await assertBillingProcessorEnvironmentInTransaction(client, this.processorEnvironment);
      if (
        !policy.enabled ||
        (await this.held(client, workspaceId)) ||
        !(await this.mandate(client, policy))
      )
        return null;
      centsToMicros(policy.amountCents);
      if (Number(balance.available_micros) >= policy.thresholdMicros) return null;
      const inflight = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND status=ANY($2::text[]) FOR UPDATE`,
          [workspaceId, active],
        )
      ).rows[0];
      if (inflight) return view(inflight);
      const now = await this.now(client);
      await client.query(
        'INSERT INTO mr_billing_recharge_state(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',
        [workspaceId],
      );
      const state = (
        await client.query(
          'SELECT * FROM mr_billing_recharge_state WHERE workspace_id=$1 FOR UPDATE',
          [workspaceId],
        )
      ).rows[0];
      if (state.failure_count >= policy.failureLimit || state.next_attempt_at > now) return null;
      const bucket = month(now);
      // All admitted current-month attempts consume funding capacity, including
      // declines. Active older attempts carry exposure across the month boundary.
      const totals = (
        await client.query(
          `SELECT COALESCE(sum(amount_cents),0)::text AS cents,count(*)::text AS attempts
        FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND status<>'cancelled'
        AND (admission_month=$2 OR status=ANY($3::text[]))`,
          [workspaceId, bucket, active],
        )
      ).rows[0];
      if (
        BigInt(totals.cents) + BigInt(policy.amountCents) > BigInt(policy.monthlyCapCents) ||
        Number(totals.attempts) >= policy.maxAttemptsPerMonth
      )
        return null;
      const mandate = await this.mandate(client, policy);
      if (!mandate) return null;
      const id = randomUUID();
      const row = (
        await client.query<AttemptRow>(
          `INSERT INTO mr_billing_recharge_attempts
        (id,workspace_id,policy_version,policy_snapshot,mandate_id,customer_id,payment_method_id,livemode,amount_cents,admission_month,status,stripe_idempotency_key,processor_environment_id,processor_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13) RETURNING ${columns}`,
          [
            id,
            workspaceId,
            policy.version,
            JSON.stringify(policy),
            mandate.id,
            mandate.customer_id,
            mandate.payment_method_id,
            this.processorEnvironment.livemode,
            policy.amountCents,
            bucket,
            `opengen-recharge-${id}`,
            this.processorEnvironment.id,
            this.processorEnvironment.accountId,
          ],
        )
      ).rows[0]!;
      await client.query(
        'UPDATE mr_billing_recharge_state SET next_attempt_at=$2 WHERE workspace_id=$1',
        [workspaceId, new Date(now.getTime() + policy.cooldownSeconds * 1000)],
      );
      return view(row);
    });
  }
  private valid(row: AttemptRow, payment: RechargePayment) {
    return (
      /^pi_[A-Za-z0-9_]+$/.test(payment.id) &&
      (!row.payment_intent_id || row.payment_intent_id === payment.id) &&
      payment.customer === row.customer_id &&
      payment.payment_method === row.payment_method_id &&
      payment.livemode === row.livemode &&
      payment.currency === 'usd' &&
      payment.amount === row.amount_cents &&
      Number.isSafeInteger(payment.amount_received) &&
      payment.amount_received >= 0 &&
      payment.amount_received <= row.amount_cents
    );
  }
  private async pendingRisk(client: PoolClient, row: AttemptRow, intent: string) {
    const events = (
      await client.query(
        "SELECT id,type FROM mr_payment_events WHERE payment_intent_id=$1 AND state='pending' AND processor_environment_id=$2",
        [intent, this.processorEnvironment.id],
      )
    ).rows;
    for (const event of events)
      if (isPaymentRiskEvent(event.type)) {
        await client.query(
          'INSERT INTO mr_billing_holds(event_id,workspace_id,recharge_attempt_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [event.id, row.workspace_id, row.id, event.type],
        );
        await client.query(
          "UPDATE mr_payment_events SET state='processed',processed_at=now(),reason=NULL WHERE id=$1",
          [event.id],
        );
      }
  }
  private async bind(id: string, payment: RechargePayment): Promise<RechargeAttempt> {
    return this.transaction(async (client) => {
      const before = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!before) throw new PaymentError('not_found', 'Recharge attempt not found.', 404);
      await lockPaymentIntentInTransaction(client, payment.id);
      await this.workspace(client, before.workspace_id);
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0]!;
      if (!this.valid(row, payment)) {
        if (!row.credited_at)
          await client.query(
            "UPDATE mr_billing_recharge_attempts SET status='review',failure_code='payment_mismatch',updated_at=now() WHERE id=$1",
            [id],
          );
        return {
          error: new PaymentError('payment_mismatch', 'Recharge requires identity review.', 409),
        } as const;
      }
      try {
        await this.claim(client, row, payment.id);
      } catch (error) {
        if (!(error instanceof PaymentOwnershipError)) throw error;
        if (!row.credited_at && active.includes(row.status))
          await client.query(
            "UPDATE mr_billing_recharge_attempts SET status='review',failure_code=$2,updated_at=now() WHERE id=$1",
            [id, error.code],
          );
        return { error } as const;
      }
      if (row.status === 'cancelled') {
        const eventId = `internal:recharge-late:${row.id}`;
        await client.query(
          `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,state) VALUES($1,'billing.recharge.late_response',$2,$2,$3,'processed') ON CONFLICT DO NOTHING`,
          [eventId, payment.id, row.livemode],
        );
        await client.query(
          `INSERT INTO mr_billing_holds(event_id,workspace_id,recharge_attempt_id,reason) VALUES($1,$2,$3,'payment_after_unpaid_resolution') ON CONFLICT DO NOTHING`,
          [eventId, row.workspace_id, row.id],
        );
        const late = (
          await client.query<AttemptRow>(
            `UPDATE mr_billing_recharge_attempts SET payment_intent_id=$2,failure_code='late_response_after_resolution',updated_at=now() WHERE id=$1 RETURNING ${columns}`,
            [row.id, payment.id],
          )
        ).rows[0]!;
        return { order: view(late) } as const;
      }
      await this.pendingRisk(client, row, payment.id);
      if (row.credited_at) return { order: view(row) } as const;
      const status =
        payment.authentication_required || payment.status === 'requires_action'
          ? 'requires_authentication'
          : payment.status === 'canceled'
            ? 'failed'
            : payment.status === 'requires_payment_method'
              ? 'failed'
              : 'processing';
      const updated = (
        await client.query<AttemptRow>(
          `UPDATE mr_billing_recharge_attempts SET payment_intent_id=$2,status=$3,failure_code=$4,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
          [id, payment.id, status, status === 'failed' ? 'payment_failed' : null],
        )
      ).rows[0]!;
      if (status === 'failed' && row.status !== 'failed')
        await client.query(
          'UPDATE mr_billing_recharge_state SET failure_count=failure_count+1 WHERE workspace_id=$1',
          [row.workspace_id],
        );
      return { order: view(updated) } as const; // A successful response never credits.
    }).then((result) => {
      if ('error' in result) throw result.error;
      return result.order;
    });
  }
  /** Persist quota and external identity before I/O; poll an accepted object even
   * if policy is disabled. An unknown POST may never be replaced by another one. */
  async dispatch(id: string, transport: RechargeTransport): Promise<RechargeAttempt | null> {
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    const selected = (
      await this.pool.query<AttemptRow>(
        `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!selected) throw new PaymentError('not_found', 'Recharge attempt not found.', 404);
    if (!this.matchesEnvironment(selected))
      throw new PaymentError(
        'processor_environment_mismatch',
        'Original recharge requires its processor environment.',
        409,
      );
    if (!this.options.automaticChargesEnabled && !selected.payment_intent_id) return null;
    const result = await this.transaction(async (client) => {
      await this.options.lockExternalInTransaction(client);
      await assertBillingProcessorEnvironmentInTransaction(client, this.processorEnvironment);
      await this.workspace(client, selected.workspace_id);
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0]!;
      if (
        !active.includes(row.status) ||
        ['requires_authentication', 'review'].includes(row.status)
      )
        return { row, run: false };
      const now = await this.now(client);
      if (row.next_request_at && row.next_request_at > now) return { row, run: false };
      const policy = await readBillingPolicyInTransaction(client, row.workspace_id);
      const mandate = await this.mandate(client, policy);
      const owner = await readBillingOwnerInTransaction(client, row.workspace_id);
      const allowed =
        policy.enabled &&
        this.withinOwner(policy, owner) &&
        policy.version === row.policy_version &&
        policy.mandateId === row.mandate_id &&
        Boolean(mandate) &&
        !(await this.held(client, row.workspace_id));
      // Manual funding may have restored balance after this queued admission.
      const balance = (
        await client.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
          row.workspace_id,
        ])
      ).rows[0];
      if (
        !row.payment_intent_id &&
        (!allowed ||
          (!row.external_started_at && Number(balance.available_micros) >= policy.thresholdMicros))
      ) {
        const status = row.external_started_at ? 'review' : 'cancelled';
        await client.query(
          'UPDATE mr_billing_recharge_attempts SET status=$2,failure_code=$3,updated_at=now() WHERE id=$1',
          [id, status, 'policy_or_balance_changed'],
        );
        return { row: { ...row, status }, run: false };
      }
      if (
        !row.payment_intent_id &&
        row.external_started_at &&
        now.getTime() - row.external_started_at.getTime() >= 20 * 3600000
      ) {
        await client.query(
          "UPDATE mr_billing_recharge_attempts SET status='review',failure_code='request_uncertain',updated_at=now() WHERE id=$1",
          [id],
        );
        return { row: { ...row, status: 'review' }, run: false };
      }
      await this.options.admitExternalInTransaction(client, row.workspace_id);
      const updated = (
        await client.query<AttemptRow>(
          `UPDATE mr_billing_recharge_attempts SET status=CASE WHEN payment_intent_id IS NULL THEN 'submitting' ELSE status END,
        external_started_at=COALESCE(external_started_at,$2),next_request_at=$3,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
          [id, now, new Date(now.getTime() + 60000)],
        )
      ).rows[0]!;
      return { row: updated, run: true };
    });
    if (!result.run) return view(result.row as AttemptRow);
    let payment: RechargePayment;
    try {
      const row = result.row;
      payment = row.payment_intent_id
        ? await transport.retrieveRecharge(row.payment_intent_id)
        : await transport.createRecharge({
            id: row.id,
            processorEnvironment: this.processorEnvironment,
            customerId: row.customer_id,
            paymentMethodId: row.payment_method_id,
            amountCents: row.amount_cents,
            stripeIdempotencyKey: row.stripe_idempotency_key,
            requestVersion: row.request_version,
            apiVersion: row.api_version,
          });
    } catch (error) {
      // Typed transport errors can carry an authoritative PI (e.g. SCA). Bind it
      // using the identical validation; no client secret/raw error is persisted.
      if (error && typeof error === 'object' && 'payment' in error && error.payment)
        return this.bind(id, error.payment as RechargePayment);
      await this.pool.query(
        "UPDATE mr_billing_recharge_attempts SET status=CASE WHEN credited_at IS NULL AND payment_intent_id IS NULL THEN 'unknown' ELSE status END,failure_code='request_uncertain',updated_at=now() WHERE id=$1",
        [id],
      );
      throw new PaymentError(
        'recharge_uncertain',
        'Recharge could not be confirmed. Resume this same attempt after the cooldown.',
        503,
      );
    }
    return this.bind(id, payment);
  }
  /** The HTTP adapter must verify the exact raw bytes before invoking this method. */
  async reconcile(
    event: VerifiedPaymentEvent,
    transport: RechargeTransport,
  ): Promise<{ received: true; ignored?: boolean; duplicate?: boolean }> {
    if (!event.type.startsWith('payment_intent.')) return { received: true, ignored: true };
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    if (
      !sameBillingProcessorEnvironment(this.processorEnvironment, event.processorEnvironment) ||
      event.livemode !== this.processorEnvironment.livemode ||
      typeof event.data.object.id !== 'string'
    )
      throw new PaymentError('environment_mismatch', 'Unexpected recharge event.');
    const id = event.data.object.id;
    const attempt = (
      await this.pool.query<AttemptRow>(
        `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE payment_intent_id=$1 AND processor_environment_id=$2`,
        [id, this.processorEnvironment.id],
      )
    ).rows[0];
    if (!attempt) {
      await this.transaction(async (client) => {
        await assertBillingProcessorEnvironmentInTransaction(client, this.processorEnvironment);
        await lockPaymentIntentInTransaction(client, id);
        const receipt = await recordProcessorPaymentEventInTransaction(
          client,
          event,
          id,
          this.processorEnvironment,
        );
        if (receipt.state === 'pending')
          await client.query(
            "UPDATE mr_payment_events SET reason='unmatched_recharge' WHERE id=$1",
            [event.id],
          );
      });
      throw new PaymentError(
        'unmatched_recharge',
        'Recharge awaits original-request identity recovery.',
        503,
      );
    }
    const fetchRequired = await this.transaction(async (client) => {
      await this.options.lockExternalInTransaction(client);
      await this.workspace(client, attempt.workspace_id);
      const prior = (
        await client.query('SELECT object_id,type FROM mr_billing_recharge_events WHERE id=$1', [
          event.id,
        ])
      ).rows[0];
      if (prior) {
        if (prior.object_id !== id || prior.type !== event.type)
          throw new PaymentError('event_conflict', 'Recharge event conflicts.', 409);
        return false;
      }
      await this.options.admitExternalInTransaction(client, attempt.workspace_id);
      return true;
    });
    if (!fetchRequired) return { received: true, duplicate: true };
    const payment = await transport.retrieveRecharge(id);
    return this.transaction(async (client) => {
      await lockPaymentIntentInTransaction(client, id);
      await this.workspace(client, attempt.workspace_id);
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE id=$1 FOR UPDATE`,
          [attempt.id],
        )
      ).rows[0]!;
      if (
        !this.valid(row, payment) ||
        !this.valid(row, event.data.object as unknown as RechargePayment) ||
        payment.id !== id
      )
        throw new PaymentError(
          'payment_mismatch',
          'Recharge does not match the stored attempt.',
          409,
        );
      const owner = await this.claim(client, row, id);
      await recordProcessorPaymentEventInTransaction(client, event, id, this.processorEnvironment);
      await this.pendingRisk(client, row, id);
      const duplicate = (
        await client.query('SELECT object_id,type FROM mr_billing_recharge_events WHERE id=$1', [
          event.id,
        ])
      ).rows[0];
      if (duplicate) {
        if (duplicate.object_id !== id || duplicate.type !== event.type)
          throw new PaymentError('event_conflict', 'Recharge event conflicts.', 409);
        return { received: true as const, duplicate: true };
      }
      await client.query(
        'INSERT INTO mr_billing_recharge_events(id,attempt_id,type,object_id) VALUES($1,$2,$3,$4)',
        [event.id, row.id, event.type, id],
      );
      if (
        event.type === 'payment_intent.succeeded' &&
        event.data.object.status === 'succeeded' &&
        event.data.object.amount_received === row.amount_cents &&
        payment.status === 'succeeded' &&
        payment.amount_received === row.amount_cents &&
        !row.credited_at
      ) {
        // Same client, same ledger primitive; no generation cap/month reset.
        await this.options.creditInTransaction(
          client,
          row.workspace_id,
          centsToMicros(row.amount_cents),
          owner.creditReference,
        );
        await client.query(
          "UPDATE mr_billing_recharge_attempts SET status='succeeded',credited_at=now(),failure_code=NULL,updated_at=now() WHERE id=$1",
          [row.id],
        );
        await client.query(
          'UPDATE mr_billing_recharge_state SET failure_count=0 WHERE workspace_id=$1',
          [row.workspace_id],
        );
        await this.options.onFundingInTransaction?.(client, {
          workspaceId: row.workspace_id,
          attemptId: row.id,
          amountCents: row.amount_cents,
        });
      } else if (!row.credited_at) {
        const status =
          payment.authentication_required || payment.status === 'requires_action'
            ? 'requires_authentication'
            : payment.status === 'canceled' || payment.status === 'requires_payment_method'
              ? 'failed'
              : 'processing';
        await client.query(
          'UPDATE mr_billing_recharge_attempts SET status=$2,failure_code=$3,updated_at=now() WHERE id=$1',
          [row.id, status, status === 'failed' ? 'payment_failed' : null],
        );
        if (status === 'failed' && row.status !== 'failed')
          await client.query(
            'UPDATE mr_billing_recharge_state SET failure_count=failure_count+1 WHERE workspace_id=$1',
            [row.workspace_id],
          );
      }
      await client.query(
        "UPDATE mr_payment_events SET state='processed',processed_at=now(),reason=NULL WHERE id=$1",
        [event.id],
      );
      return { received: true as const };
    });
  }
  /** Explicit on-session recovery of an already-owned card PaymentIntent.
   * Returns a scoped client capability only after final human authority checks;
   * it is never persisted, logged, credited or made available to agent tools. */
  async authentication(
    workspaceId: string,
    id: string,
    input: { expectedPolicyVersion: number; expectedAuthorityVersion: number },
    authorize: (client: PoolClient) => Promise<void>,
    transport: RechargeRecoveryTransport,
  ): Promise<{
    attemptId: string;
    paymentIntentId: string;
    amountCents: number;
    clientSecret: string;
  }> {
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    if (!this.options.authenticationRecoveryEnabled)
      throw new PaymentError(
        'recovery_not_activated',
        'Payment authentication recovery is not enabled.',
        409,
      );
    const snapshot = async (client: PoolClient) => {
      await this.workspace(client, workspaceId);
      await authorize(client);
      const policy = await readBillingPolicyInTransaction(client, workspaceId),
        owner = await readBillingOwnerInTransaction(client, workspaceId);
      if (
        !policy.enabled ||
        !this.withinOwner(policy, owner) ||
        policy.version !== input.expectedPolicyVersion ||
        owner!.authorityVersion !== input.expectedAuthorityVersion
      )
        throw new PaymentError(
          'billing_policy_conflict',
          'Funding authority or policy changed. Refresh before authenticating this payment.',
          409,
        );
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, id],
        )
      ).rows[0];
      if (
        !row ||
        !this.matchesEnvironment(row) ||
        row.status !== 'requires_authentication' ||
        !row.payment_intent_id ||
        row.mandate_id !== policy.mandateId ||
        row.amount_cents > policy.amountCents ||
        !(await this.mandate(client, policy)) ||
        (await this.held(client, workspaceId))
      )
        throw new PaymentError(
          'recovery_unavailable',
          'The original payment needs review before authentication.',
          409,
        );
      const now = await this.now(client);
      const exposure = (
        await client.query(
          `SELECT COALESCE(sum(amount_cents),0)::text AS cents,count(*)::text AS attempts FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND status<>'cancelled' AND(admission_month=$2 OR status=ANY($3::text[]))`,
          [workspaceId, month(now), active],
        )
      ).rows[0];
      if (
        BigInt(exposure.cents) > BigInt(policy.monthlyCapCents) ||
        Number(exposure.attempts) > policy.maxAttemptsPerMonth
      )
        throw new PaymentError(
          'funding_cap_exceeded',
          'Pending funding exceeds the current approved card limit.',
          409,
        );
      return row;
    };
    const row = await this.transaction(async (client) => {
      await this.options.lockExternalInTransaction(client);
      const row = await snapshot(client);
      await this.options.admitExternalInTransaction(client, workspaceId);
      return row;
    });
    const recovery = await transport.retrieveRechargeRecovery(row.payment_intent_id!);
    if (
      !this.valid(row, recovery.payment) ||
      recovery.payment.id !== row.payment_intent_id ||
      recovery.methodType !== 'card' ||
      !recovery.clientSecret.startsWith(`${row.payment_intent_id}_secret_`) ||
      recovery.clientSecret.length > 2048 ||
      !(recovery.payment.authentication_required || recovery.payment.status === 'requires_action')
    )
      throw new PaymentError(
        'payment_mismatch',
        'The original card authentication requires review.',
        409,
      );
    return this.transaction(async (client) => {
      const current = await snapshot(client);
      if (current.payment_intent_id !== row.payment_intent_id)
        throw new PaymentError('recovery_changed', 'The original payment changed.', 409);
      return {
        attemptId: row.id,
        paymentIntentId: row.payment_intent_id!,
        amountCents: row.amount_cents,
        clientSecret: recovery.clientSecret,
      };
    });
  }
  /** Routes only already-owned automatic payment risk; unknown identities remain
   * in PaymentStore's existing minimized pending-event journal for later binding. */
  async reconcileRisk(event: VerifiedPaymentEvent): Promise<boolean> {
    const intent = paymentIntentId(event.data.object.payment_intent);
    if (!intent || !isPaymentRiskEvent(event.type)) return false;
    return this.transaction(async (client) => {
      await assertBillingProcessorEnvironmentInTransaction(client, this.processorEnvironment);
      await lockPaymentIntentInTransaction(client, intent);
      await recordProcessorPaymentEventInTransaction(
        client,
        event,
        intent,
        this.processorEnvironment,
      );
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE payment_intent_id=$1 AND processor_environment_id=$2`,
          [intent, this.processorEnvironment.id],
        )
      ).rows[0];
      if (!row) return false;
      await this.workspace(client, row.workspace_id);
      await this.claim(client, row, intent);
      await this.pendingRisk(client, row, intent);
      return true;
    });
  }
  /** Trusted operator-only reconciliation. Unknown acceptance is never guessed
   * from age; every decision retains the evidence and original external identity. */
  async resolve(
    workspaceId: string,
    id: string,
    input: {
      action: 'bind' | 'confirmed-unpaid';
      paymentIntentId?: string;
      reference: string;
      note: string;
      evidenceUrl: string;
    },
    actor: Record<string, unknown>,
    authorize: (client: PoolClient) => Promise<void>,
    transport: RechargeTransport,
  ): Promise<RechargeAttempt> {
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    if (!input.reference || input.reference.length > 200 || !input.note || input.note.length > 2000)
      throw new PaymentError(
        'invalid_resolution',
        'A bounded evidence reference and note are required.',
      );
    const evidence = new URL(input.evidenceUrl);
    if (evidence.protocol !== 'https:' || evidence.username || evidence.password)
      throw new PaymentError('invalid_evidence', 'Use an HTTPS evidence reference.');
    const selected = await this.transaction(async (client) => {
      await this.options.lockExternalInTransaction(client);
      await this.workspace(client, workspaceId);
      await authorize(client);
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, id],
        )
      ).rows[0];
      if (!row) throw new PaymentError('not_found', 'Recharge attempt not found.', 404);
      if (!this.matchesEnvironment(row))
        throw new PaymentError(
          'processor_environment_mismatch',
          'Original recharge requires its processor environment.',
          409,
        );
      if (input.action === 'bind' && !row.external_started_at)
        throw new PaymentError('invalid_payment', 'This recharge was never submitted.', 409);
      const now = await this.now(client);
      if (row.status === 'submitting' || (row.next_request_at && row.next_request_at > now))
        throw new PaymentError(
          'request_in_progress',
          'Wait for the original external request to finish before reconciling.',
          409,
        );
      if (
        input.action === 'bind' &&
        (!input.paymentIntentId || !/^pi_[A-Za-z0-9_]+$/.test(input.paymentIntentId))
      )
        throw new PaymentError(
          'invalid_payment',
          'The original authoritative PaymentIntent is required.',
        );
      const externalId = input.action === 'bind' ? input.paymentIntentId! : row.payment_intent_id;
      if (externalId) await this.options.admitExternalInTransaction(client, workspaceId);
      return { row, externalId };
    });
    const payment = selected.externalId
      ? await transport.retrieveRecharge(selected.externalId)
      : null;
    if (input.action === 'bind') {
      // Record a requested identity only after validation; final authority is
      // checked again below. Never credit from operator binding.
      if (!payment || !this.valid(selected.row, payment))
        throw new PaymentError(
          'payment_mismatch',
          'Original recharge identity does not match.',
          409,
        );
    } else if (payment && (!this.valid(selected.row, payment) || payment.status !== 'canceled')) {
      throw new PaymentError(
        'payment_not_unpaid',
        'An accepted PaymentIntent must be authoritatively canceled before an unpaid resolution.',
        409,
      );
    }
    await this.transaction(async (client) => {
      if (payment) await lockPaymentIntentInTransaction(client, payment.id);
      await this.workspace(client, workspaceId);
      await authorize(client);
      const row = (
        await client.query<AttemptRow>(
          `SELECT ${columns} FROM mr_billing_recharge_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, id],
        )
      ).rows[0]!;
      const now = await this.now(client);
      if (row.status === 'submitting' || (row.next_request_at && row.next_request_at > now))
        throw new PaymentError(
          'request_in_progress',
          'Original payment work changed while reviewing.',
          409,
        );
      if (row.credited_at && input.action === 'confirmed-unpaid')
        throw new PaymentError('already_credited', 'A credited payment cannot be erased.', 409);
      if (
        row.payment_intent_id !== selected.row.payment_intent_id ||
        row.status !== selected.row.status
      )
        throw new PaymentError(
          'resolution_conflict',
          'Payment state changed during evidence lookup.',
          409,
        );
      const prior = (
        await client.query(
          'SELECT * FROM mr_billing_recharge_resolutions WHERE attempt_id=$1 AND reference=$2',
          [id, input.reference],
        )
      ).rows[0];
      if (
        prior &&
        (prior.action !== input.action ||
          prior.note !== input.note ||
          prior.evidence_url !== input.evidenceUrl ||
          prior.payment_intent_id !== (input.paymentIntentId ?? null))
      )
        throw new PaymentError(
          'resolution_conflict',
          'Reference already records different evidence or payment identity.',
          409,
        );
      if (input.action === 'confirmed-unpaid') {
        if (!payment && !['queued', 'unknown', 'review', 'cancelled'].includes(row.status))
          throw new PaymentError(
            'payment_not_unpaid',
            'This attempt requires authoritative payment cancellation evidence.',
            409,
          );
        await client.query(
          "UPDATE mr_billing_recharge_attempts SET status='cancelled',failure_code='operator_confirmed_unpaid',updated_at=now() WHERE id=$1",
          [id],
        );
      } else {
        await this.claim(client, row, payment!.id);
        const status =
          payment!.status === 'requires_action'
            ? 'requires_authentication'
            : payment!.status === 'canceled'
              ? 'failed'
              : 'processing';
        await client.query(
          'UPDATE mr_billing_recharge_attempts SET payment_intent_id=$2,status=CASE WHEN credited_at IS NOT NULL THEN status ELSE $3 END,updated_at=now() WHERE id=$1',
          [id, payment!.id, status],
        );
        await this.pendingRisk(client, row, payment!.id);
      }
      await client.query(
        'INSERT INTO mr_billing_recharge_resolutions(id,attempt_id,reference,note,evidence_url,action,payment_intent_id,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [
          randomUUID(),
          id,
          input.reference,
          input.note,
          input.evidenceUrl,
          input.action,
          input.paymentIntentId ?? null,
          JSON.stringify(actor),
        ],
      );
    });
    return this.get(workspaceId, id);
  }
  async workOnce(transport: RechargeTransport): Promise<void> {
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    const due = this.options.automaticChargesEnabled
      ? (
          await this.pool.query<{
            workspace_id: string;
          }>(`SELECT p.workspace_id FROM mr_billing_policies p
      LEFT JOIN mr_billing_recharge_state s ON s.workspace_id=p.workspace_id
      WHERE p.enabled AND (s.next_evaluation_at IS NULL OR s.next_evaluation_at<=now()) ORDER BY p.workspace_id LIMIT 20`)
        ).rows
      : [];
    for (const item of due) {
      await this.pool.query(
        `INSERT INTO mr_billing_recharge_state(workspace_id,next_evaluation_at) VALUES($1,now()+interval '60 seconds')
        ON CONFLICT(workspace_id) DO UPDATE SET next_evaluation_at=EXCLUDED.next_evaluation_at`,
        [item.workspace_id],
      );
      await this.admit(item.workspace_id);
    }
    const attempts = (
      await this.pool.query<{ id: string }>(
        `SELECT id FROM mr_billing_recharge_attempts WHERE status=ANY($1::text[])
      AND processor_environment_id=$2 AND ($3 OR payment_intent_id IS NOT NULL)
      AND (next_request_at IS NULL OR next_request_at<=now()) ORDER BY created_at,id LIMIT 20`,
        [
          ['queued', 'submitting', 'unknown', 'processing'],
          this.processorEnvironment.id,
          Boolean(this.options.automaticChargesEnabled),
        ],
      )
    ).rows;
    for (const item of attempts) {
      try {
        await this.dispatch(item.id, transport);
      } catch (error) {
        if (!(error instanceof PaymentError) || ![429, 503].includes(error.statusCode)) throw error;
      }
    }
  }
}
