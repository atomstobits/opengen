import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  BILLING_STRIPE_API_VERSION,
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
  resolvePaymentOwnershipInTransaction,
} from './billing-payment-ownership.js';

export const MIN_TOPUP_CENTS = 500;
export const MAX_TOPUP_CENTS = 100000;
export const PAYMENT_RATE_LIMITS = Object.freeze({
  windowMs: 3600000,
  ordersPerWorkspace: 10,
  ordersPerInstallation: 1000,
  checkoutPerWorkspace: 30,
  checkoutPerInstallation: 3000,
  checkoutCooldownMs: 60000,
});
export class PaymentError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function centsToMicros(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS)
    throw new PaymentError(
      'invalid_amount',
      'Choose a whole-cent USD amount between $5 and $1,000.',
    );
  return cents * 10000;
}
export type PaymentStatus =
  | 'created'
  | 'checkout_pending'
  | 'checkout_open'
  | 'payment_pending'
  | 'payment_failed'
  | 'expired'
  | 'credited'
  | 'review';
export interface PaymentOrder {
  id: string;
  workspaceId: string;
  amountCents: number;
  creditMicros: number;
  currency: 'USD';
  status: PaymentStatus;
  checkoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
  creditedAt: string | null;
}
export type CheckoutRequestVersion = 'checkout_hosted_v1' | 'checkout_hosted_page_v2';
export interface CheckoutOrder extends PaymentOrder {
  requestVersion: CheckoutRequestVersion;
  apiVersion: typeof BILLING_STRIPE_API_VERSION;
  stripeIdempotencyKey: string;
  expiresAt: number;
  integrationIdentifier: string;
}
export interface CheckoutSession {
  id: string;
  mode: string | null;
  currency: string | null;
  amount_subtotal: number | null;
  amount_total: number | null;
  payment_status: string;
  status: string | null;
  client_reference_id: string | null;
  payment_intent: string | { id: string } | null;
  livemode: boolean;
  url: string | null;
}
export interface PaymentTransport {
  readonly processorEnvironment?: Readonly<BillingProcessorEnvironment>;
  assertProcessorEnvironment?(): void;
  createSession(order: CheckoutOrder): Promise<CheckoutSession>;
  retrieveSession(id: string): Promise<CheckoutSession>;
}
export interface VerifiedPaymentEvent {
  /** Server-owned context from the verified ingress, never from event metadata. */
  processorEnvironment?: Readonly<BillingProcessorEnvironment>;
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}
/** Must use this client, never acquire a second connection or commit here.
 * Main integration extracts the existing Engine.creditWorkspace rules into this contract. */
export type CreditInTransaction = (
  client: PoolClient,
  workspaceId: string,
  amountMicros: number,
  reference: string,
) => Promise<unknown>;
interface OrderRow {
  id: string;
  workspace_id: string;
  amount_cents: number;
  credit_micros: string;
  status: PaymentStatus;
  checkout_url: string | null;
  created_at: Date;
  updated_at: Date;
  credited_at: Date | null;
  stripe_idempotency_key: string;
  checkout_request_version: CheckoutRequestVersion;
  checkout_api_version: typeof BILLING_STRIPE_API_VERSION;
  integration_identifier: string;
  checkout_started_at: Date | null;
  checkout_expires_at: Date | null;
  checkout_lease_until: Date | null;
  checkout_next_request_at: Date | null;
  session_id: string | null;
  payment_intent_id: string | null;
  livemode: boolean;
  processor_environment_id?: string | null;
  processor_account_id?: string | null;
}
interface RateRow {
  payment_order_window: string;
  payment_order_count: number;
  payment_checkout_window: string;
  payment_checkout_count: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionTypes = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);
export const isPaymentRiskEvent = (type: string) =>
  type === 'charge.refunded' ||
  type.startsWith('charge.dispute.') ||
  ['refund.created', 'refund.updated', 'refund.failed'].includes(type);
export function paymentIntentId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string')
    return value.id;
  return null;
}
function view(row: OrderRow): PaymentOrder {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    amountCents: row.amount_cents,
    creditMicros: Number(row.credit_micros),
    currency: 'USD',
    status: row.status,
    checkoutUrl: row.status === 'checkout_open' ? row.checkout_url : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    creditedAt: row.credited_at?.toISOString() ?? null,
  };
}
function validSession(row: OrderRow, session: CheckoutSession, historical = false): boolean {
  return (
    /^cs_[A-Za-z0-9_]+$/.test(session.id) &&
    session.client_reference_id === row.id &&
    session.mode === 'payment' &&
    session.currency === 'usd' &&
    session.livemode === row.livemode &&
    session.amount_subtotal === row.amount_cents &&
    session.amount_total === row.amount_cents &&
    (!row.session_id || row.session_id === session.id) &&
    (!row.payment_intent_id ||
      (historical && session.payment_intent === null) ||
      row.payment_intent_id === paymentIntentId(session.payment_intent))
  );
}
function checkoutUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.origin === 'https://checkout.stripe.com' && !url.username && !url.password)
      return url.href;
  } catch {}
  throw new PaymentError('invalid_checkout_url', 'Payment session requires review.', 502);
}

interface ProcessorPaymentReceipt {
  state: 'pending' | 'processed' | 'ignored' | 'rejected';
  type: string;
  object_id: string;
  livemode: boolean;
  payment_intent_id: string | null;
  processor_environment_id: string | null;
}
function matchesPaymentEventReceipt(
  receipt: ProcessorPaymentReceipt,
  event: VerifiedPaymentEvent,
  intent: string | null,
  environmentId?: string,
): boolean {
  const receiptEnvironment = receipt.processor_environment_id ?? null;
  return (
    receipt.type === event.type &&
    receipt.object_id === event.data.object.id &&
    receipt.livemode === event.livemode &&
    receipt.payment_intent_id === intent &&
    (receiptEnvironment === null || receiptEnvironment === environmentId)
  );
}
/** Call under the shared intent lock when there is a PI. Legacy receipts can be
 * qualified by a matching signed delivery from the current environment. */
export async function recordProcessorPaymentEventInTransaction(
  client: PoolClient,
  event: VerifiedPaymentEvent,
  intent: string | null,
  environment: BillingProcessorEnvironment,
): Promise<ProcessorPaymentReceipt> {
  const id = event.data.object.id;
  if (
    !event.id ||
    event.id.length > 250 ||
    typeof id !== 'string' ||
    !id ||
    id.length > 250 ||
    !sameBillingProcessorEnvironment(environment, event.processorEnvironment) ||
    event.livemode !== environment.livemode
  )
    throw new PaymentError('invalid_event', 'Unexpected processor event identity.');
  await client.query(
    `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,processor_environment_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [event.id, event.type, id, intent, event.livemode, environment.id],
  );
  const receipt = (
    await client.query<ProcessorPaymentReceipt>(
      'SELECT * FROM mr_payment_events WHERE id=$1 FOR UPDATE',
      [event.id],
    )
  ).rows[0]!;
  // The old ignored PI path recorded object.id but left payment_intent_id empty.
  const legacyIgnoredIntent =
    receipt.processor_environment_id === null &&
    receipt.state === 'ignored' &&
    event.type.startsWith('payment_intent.') &&
    receipt.payment_intent_id === null &&
    id === intent;
  if (
    receipt.type !== event.type ||
    receipt.object_id !== id ||
    receipt.livemode !== event.livemode ||
    (!legacyIgnoredIntent && receipt.payment_intent_id !== intent) ||
    (receipt.processor_environment_id !== null &&
      receipt.processor_environment_id !== environment.id)
  )
    throw new PaymentError('event_conflict', 'Event identity conflicts with the journal.', 409);
  if (receipt.processor_environment_id === null)
    await client.query(
      `UPDATE mr_payment_events SET processor_environment_id=$2,payment_intent_id=$3,
       state=CASE WHEN $4 THEN 'pending' ELSE state END,
       processed_at=CASE WHEN $4 THEN NULL ELSE processed_at END WHERE id=$1`,
      [event.id, environment.id, intent, legacyIgnoredIntent],
    );
  return legacyIgnoredIntent ? { ...receipt, state: 'pending' } : receipt;
}

/** The store derives this from the owned, locked order, never request JSON.
 * New funding may require current assent; accepted retrieval and exact recovery
 * retain their original request and remain subject to ordinary payer authority. */
export interface PaymentAuthorityContext {
  newFunding: boolean;
}
export type PaymentAuthority = (
  client: PoolClient,
  context?: PaymentAuthorityContext,
) => Promise<void>;

export class PaymentStore {
  private readonly processorEnvironment?: Readonly<BillingProcessorEnvironment>;
  constructor(
    private pool: Pool,
    private options: {
      creditInTransaction: CreditInTransaction;
      livemode: boolean;
      now?: () => number;
      processorEnvironment?: BillingProcessorEnvironment;
    },
  ) {
    if (options.processorEnvironment) {
      this.processorEnvironment = validatedBillingProcessorEnvironment(
        options.processorEnvironment,
      );
      if (this.processorEnvironment.livemode !== options.livemode)
        throw new PaymentError(
          'environment_mismatch',
          'Payment processor mode does not match.',
          409,
        );
    }
  }
  private orderView(row: OrderRow): PaymentOrder {
    const order = view(row);
    if (
      !this.matchesEnvironment(row) ||
      (this.processorEnvironment && !row.processor_environment_id)
    )
      order.checkoutUrl = null;
    return order;
  }
  private requireTransport(transport: PaymentTransport) {
    if (!this.processorEnvironment) return;
    if (!transport.processorEnvironment || !transport.assertProcessorEnvironment)
      throw new PaymentError(
        'processor_environment_not_configured',
        'A verified Stripe transport is required.',
        503,
      );
    assertBillingProcessorTransport(this.processorEnvironment, {
      processorEnvironment: transport.processorEnvironment,
      assertProcessorEnvironment: () => transport.assertProcessorEnvironment!(),
    });
  }
  private matchesEnvironment(row: OrderRow) {
    return (
      !row.processor_environment_id ||
      (row.processor_environment_id === this.processorEnvironment?.id &&
        row.processor_account_id === this.processorEnvironment?.accountId)
    );
  }
  private async qualifyOrder(client: PoolClient, row: OrderRow, session: CheckoutSession) {
    const environment = this.processorEnvironment;
    if (!this.matchesEnvironment(row))
      throw new PaymentError(
        'environment_mismatch',
        'Payment belongs to a different processor environment.',
        409,
      );
    const intent = paymentIntentId(session.payment_intent);
    if (!environment) {
      if (intent) await this.assertLegacyIntentAvailable(client, row, intent);
      return row;
    }
    if (intent)
      await claimPaymentOwnershipInTransaction(client, {
        processorEnvironmentId: environment.id,
        livemode: environment.livemode,
        paymentIntentId: intent,
        workspaceId: row.workspace_id,
        kind: 'manual',
        localId: row.id,
        amountCents: row.amount_cents,
        creditReference: canonicalFundingCreditReference('manual', row.id),
        legacySession: session,
      });
    if (!row.processor_environment_id) {
      await client.query(
        'UPDATE mr_payment_orders SET processor_environment_id=$2,processor_account_id=$3 WHERE id=$1',
        [row.id, environment.id, environment.accountId],
      );
      return {
        ...row,
        processor_environment_id: environment.id,
        processor_account_id: environment.accountId,
      };
    }
    return row;
  }
  private async assertLegacyIntentAvailable(client: PoolClient, row: OrderRow, intent: string) {
    // A legacy/manual-only store can still serve installations without the new
    // schema. On a shared upgraded database, take the same PI lock (already held
    // by checkout/reconcile) and reject ownership reserved by any scoped store.
    const installed = (
      await client.query(
        "SELECT to_regclass('mr_billing_payment_ownership') IS NOT NULL AS installed",
      )
    ).rows[0].installed;
    if (!installed) return;
    const conflict = (
      await client.query(
        `SELECT 1 FROM mr_billing_payment_ownership
      WHERE payment_intent_id=$1 AND livemode=$2 AND (kind<>'manual' OR local_id<>$3)
      UNION ALL SELECT 1 FROM mr_billing_recharge_attempts WHERE payment_intent_id=$1 AND livemode=$2 LIMIT 1`,
        [intent, row.livemode, row.id],
      )
    ).rowCount;
    if (conflict)
      throw new PaymentOwnershipError(
        'payment_ownership_conflict',
        'Payment identity belongs to another funding record.',
      );
  }
  /** Resolve and journal under one PI lock. The dispatcher never uses metadata
   * as ownership or falls through to another funding flow on uncertainty. */
  async routeIntent(
    event: VerifiedPaymentEvent,
    intent: string,
  ): Promise<'manual' | 'automatic' | 'unmatched'> {
    const environment = this.processorEnvironment;
    if (!environment)
      throw new PaymentError(
        'processor_environment_not_configured',
        'Payment ownership requires a verified environment.',
        503,
      );
    const result = await this.transaction(async (client) => {
      await assertBillingProcessorEnvironmentInTransaction(client, environment);
      await lockPaymentIntentInTransaction(client, intent);
      const receipt = await recordProcessorPaymentEventInTransaction(
        client,
        event,
        intent,
        environment,
      );
      let owner;
      try {
        owner = await resolvePaymentOwnershipInTransaction(client, {
          processorEnvironmentId: environment.id,
          livemode: environment.livemode,
          paymentIntentId: intent,
        });
      } catch (error) {
        if (!(error instanceof PaymentOwnershipError)) throw error;
        if (receipt.state === 'pending' || receipt.state === 'rejected')
          await client.query(
            "UPDATE mr_payment_events SET state='rejected',reason=$2 WHERE id=$1",
            [event.id, error.code],
          );
        return error;
      }
      if (!owner) {
        if (receipt.state === 'pending' || receipt.state === 'rejected')
          await client.query(
            "UPDATE mr_payment_events SET state='pending',reason='unmatched_payment_intent' WHERE id=$1",
            [event.id],
          );
        return 'unmatched' as const;
      }
      if (owner.kind === 'manual' && event.type.startsWith('payment_intent.'))
        await client.query(
          "UPDATE mr_payment_events SET state='ignored',order_id=$2,reason='manual_checkout_authoritative',processed_at=now() WHERE id=$1",
          [event.id, owner.localId],
        );
      return owner.kind;
    });
    if (result instanceof PaymentOwnershipError) throw result;
    return result;
  }
  /** Shared outbound Stripe admission. Lock this before any workspace/actor row.
   * No nested transaction or pool acquisition; caller commits before external I/O. */
  async lockExternalInTransaction(client: PoolClient): Promise<void> {
    await this.lockLimits(client);
  }
  async admitExternalInTransaction(client: PoolClient, workspaceId: string): Promise<void> {
    const installation = await this.lockLimits(client);
    const workspace = (
      await client.query<RateRow>('SELECT * FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ])
    ).rows[0];
    if (!workspace) throw new PaymentError('not_found', 'Workspace not found.', 404);
    await this.consumeLimit(
      client,
      workspaceId,
      installation,
      workspace,
      'checkout',
      await this.now(client),
    );
  }
  private async now(client: PoolClient): Promise<number> {
    // A shared database clock avoids different gateway clocks reopening windows.
    return (
      this.options.now?.() ??
      (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime()
    );
  }
  private limited(retryMs: number, message: string): PaymentError {
    const seconds = Math.max(1, Math.ceil(retryMs / 1000));
    return new PaymentError(
      'payment_rate_limited',
      `${message} Try again in ${seconds} seconds; resume the same order and retry key.`,
      429,
      seconds,
    );
  }
  private async lockLimits(client: PoolClient): Promise<RateRow> {
    const row = (
      await client.query<RateRow>(
        'SELECT * FROM mr_payment_rate_limits WHERE singleton=true FOR UPDATE',
      )
    ).rows[0];
    if (!row)
      throw new PaymentError(
        'payment_limits_unavailable',
        'Payment admission is unavailable.',
        503,
      );
    return row;
  }
  private async consumeLimit(
    client: PoolClient,
    workspaceId: string,
    installation: RateRow,
    workspace: RateRow,
    operation: 'order' | 'checkout',
    now: number,
  ) {
    const windowColumn = `payment_${operation}_window` as const;
    const countColumn = `payment_${operation}_count` as const;
    const current = Math.floor(now / PAYMENT_RATE_LIMITS.windowMs);
    // Never reset a counter on a backwards clock adjustment.
    const installationWindow = Math.max(Number(installation[windowColumn]), current);
    const workspaceWindow = Math.max(Number(workspace[windowColumn]), current);
    const installationCount =
      installationWindow > Number(installation[windowColumn]) ? 0 : installation[countColumn];
    const workspaceCount =
      workspaceWindow > Number(workspace[windowColumn]) ? 0 : workspace[countColumn];
    const installationCap =
      operation === 'order'
        ? PAYMENT_RATE_LIMITS.ordersPerInstallation
        : PAYMENT_RATE_LIMITS.checkoutPerInstallation;
    const workspaceCap =
      operation === 'order'
        ? PAYMENT_RATE_LIMITS.ordersPerWorkspace
        : PAYMENT_RATE_LIMITS.checkoutPerWorkspace;
    const blockedUntil = Math.max(
      installationCount >= installationCap
        ? (installationWindow + 1) * PAYMENT_RATE_LIMITS.windowMs
        : 0,
      workspaceCount >= workspaceCap ? (workspaceWindow + 1) * PAYMENT_RATE_LIMITS.windowMs : 0,
    );
    if (blockedUntil)
      throw this.limited(
        blockedUntil - now,
        `Too many ${operation === 'order' ? 'new payment orders' : 'Checkout requests'}.`,
      );
    // Both rows are already locked, installation first. No quota is refunded after
    // an external attempt, regardless of success, timeout, retry or process death.
    await client.query(
      `UPDATE mr_payment_rate_limits SET ${windowColumn}=$1,${countColumn}=$2 WHERE singleton=true`,
      [installationWindow, installationCount + 1],
    );
    await client.query(
      `UPDATE mr_workspaces SET ${windowColumn}=$2,${countColumn}=$3 WHERE id=$1`,
      [workspaceId, workspaceWindow, workspaceCount + 1],
    );
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
  private async owned(
    client: Pick<PoolClient, 'query'>,
    workspaceId: string,
    id: string,
    lock = false,
  ): Promise<OrderRow> {
    if (!uuid.test(id)) throw new PaymentError('not_found', 'Payment order not found.', 404);
    const { rows } = await client.query<OrderRow>(
      `SELECT * FROM mr_payment_orders WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [workspaceId, id],
    );
    if (!rows[0]) throw new PaymentError('not_found', 'Payment order not found.', 404);
    return rows[0];
  }
  async createOrder(
    workspaceId: string,
    amountCents: number,
    clientKey: string,
    authorize?: PaymentAuthority,
  ): Promise<PaymentOrder> {
    const credit = centsToMicros(amountCents);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientKey))
      throw new PaymentError(
        'invalid_idempotency_key',
        'A stable 8–128 character Idempotency-Key is required.',
      );
    return this.transaction(async (client) => {
      // Admission always locks installation before workspace; replay spends no quota.
      const installation = await this.lockLimits(client);
      const workspace = await client.query<RateRow>(
        'SELECT * FROM mr_workspaces WHERE id=$1 FOR UPDATE',
        [workspaceId],
      );
      if (!workspace.rowCount) throw new PaymentError('not_found', 'Workspace not found.', 404);
      await authorize?.(client, { newFunding: false });
      const existing = (
        await client.query<OrderRow>(
          'SELECT * FROM mr_payment_orders WHERE workspace_id=$1 AND client_key=$2',
          [workspaceId, clientKey],
        )
      ).rows[0];
      if (existing) {
        if (existing.amount_cents !== amountCents)
          throw new PaymentError(
            'idempotency_conflict',
            'Retry key already belongs to a different amount.',
            409,
          );
        return this.orderView(existing);
      }
      await authorize?.(client, { newFunding: true });
      if (await this.held(client, workspaceId))
        throw new PaymentError('billing_hold', 'Billing needs review before adding credit.', 409);
      await this.consumeLimit(
        client,
        workspaceId,
        installation,
        workspace.rows[0]!,
        'order',
        await this.now(client),
      );
      const id = randomUUID();
      const suffix = Array.from(randomBytes(8), (n) => String.fromCharCode(97 + (n % 26))).join('');
      const result = await client.query<OrderRow>(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,stripe_idempotency_key,integration_identifier,checkout_request_version,checkout_api_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id,
          workspaceId,
          clientKey,
          amountCents,
          credit,
          this.options.livemode,
          `opengen-topup-${id}`,
          `opengen_topup_${suffix}`,
          'checkout_hosted_page_v2',
          BILLING_STRIPE_API_VERSION,
        ],
      );
      return this.orderView(result.rows[0]!);
    });
  }
  async getOrder(
    workspaceId: string,
    id: string,
    authorize?: PaymentAuthority,
  ): Promise<PaymentOrder> {
    const read = async (client: Pick<PoolClient, 'query'>) =>
      this.orderView(await this.owned(client, workspaceId, id));
    if (!authorize) return read(this.pool);
    return this.transaction(async (client) => {
      await authorize(client, { newFunding: false });
      return read(client);
    });
  }
  async listOrders(workspaceId: string, authorize?: PaymentAuthority): Promise<PaymentOrder[]> {
    const read = async (client: Pick<PoolClient, 'query'>) => {
      const result = await client.query<OrderRow>(
        'SELECT * FROM mr_payment_orders WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        [workspaceId],
      );
      return result.rows.map((row) => this.orderView(row));
    };
    if (!authorize) return read(this.pool);
    return this.transaction(async (client) => {
      await authorize(client, { newFunding: false });
      return read(client);
    });
  }
  private async held(client: Pick<PoolClient, 'query'>, workspaceId: string): Promise<boolean> {
    return Boolean(
      (
        await client.query(
          'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
          [workspaceId],
        )
      ).rowCount,
    );
  }
  async hasBillingHold(workspaceId: string): Promise<boolean> {
    return this.held(this.pool, workspaceId);
  }

  async checkout(
    workspaceId: string,
    id: string,
    transport: PaymentTransport,
    authorize?: PaymentAuthority,
  ): Promise<PaymentOrder> {
    this.requireTransport(transport);
    const environment = this.processorEnvironment;
    const attempt = await this.transaction(async (client) => {
      const installation = await this.lockLimits(client);
      const workspace = (
        await client.query<RateRow>('SELECT * FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
          workspaceId,
        ])
      ).rows[0];
      await authorize?.(client, { newFunding: false });
      const row = await this.owned(client, workspaceId, id, true);
      if (row.livemode !== this.options.livemode || !this.matchesEnvironment(row))
        throw new PaymentError(
          'environment_mismatch',
          'This payment belongs to another environment.',
          409,
        );
      if (row.status === 'credited' || (row.status === 'review' && row.session_id))
        return { row, external: false };
      if (row.status === 'review')
        throw new PaymentError(
          'payment_review',
          'Payment request needs operator reconciliation.',
          409,
        );
      // An old/unknown POST keeps its original serializer and retry key. Known
      // sessions still use GET/reconciliation; never reinterpret an unbound key.
      if (
        !row.session_id &&
        (row.checkout_request_version !== 'checkout_hosted_page_v2' ||
          row.checkout_api_version !== BILLING_STRIPE_API_VERSION)
      )
        throw new PaymentError(
          'unsupported_checkout_request',
          'This historical Checkout request requires operator review.',
          409,
        );
      if (!row.session_id && !row.checkout_started_at)
        await authorize?.(client, { newFunding: true });
      if (await this.held(client, workspaceId))
        throw new PaymentError('billing_hold', 'Billing needs review before adding credit.', 409);
      const now = await this.now(client);
      if (environment) {
        await assertBillingProcessorEnvironmentInTransaction(client, environment);
        if (!row.processor_environment_id && !row.session_id && row.checkout_started_at) {
          // No proof links an uncertain historical POST to this configured account.
          await client.query(
            "UPDATE mr_payment_orders SET status='review',updated_at=now() WHERE id=$1",
            [id],
          );
          return { row: { ...row, status: 'review' as const }, external: false };
        }
        if (!row.processor_environment_id && !row.checkout_started_at) {
          await client.query(
            'UPDATE mr_payment_orders SET processor_environment_id=$2,processor_account_id=$3 WHERE id=$1',
            [id, environment.id, environment.accountId],
          );
        }
      }
      // This timestamp is independent of leases and never cleared by a timeout,
      // response binding or webhook. A cached known-session result needs no call.
      if (row.checkout_next_request_at && row.checkout_next_request_at.getTime() > now) {
        if (row.session_id) return { row, external: false };
        throw this.limited(
          row.checkout_next_request_at.getTime() - now,
          'Checkout is being confirmed.',
        );
      }
      // Stripe may prune keys after 24h. Never POST again near that boundary.
      if (
        !row.session_id &&
        row.checkout_started_at &&
        (now - row.checkout_started_at.getTime() >= 20 * 3600000 ||
          row.checkout_expires_at!.getTime() <= now + 31 * 60000)
      ) {
        await client.query(
          "UPDATE mr_payment_orders SET status='review',updated_at=now() WHERE id=$1",
          [id],
        );
        return { row: { ...row, status: 'review' as const }, external: false };
      }
      await this.consumeLimit(client, workspaceId, installation, workspace!, 'checkout', now);
      const updated = (
        await client.query<OrderRow>(
          `UPDATE mr_payment_orders SET
        status=CASE WHEN session_id IS NULL THEN 'checkout_pending' ELSE status END,
        checkout_started_at=COALESCE(checkout_started_at,$2),checkout_expires_at=COALESCE(checkout_expires_at,$3),
        checkout_lease_until=$4,checkout_next_request_at=$4,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            id,
            new Date(now),
            new Date(Math.floor(now / 1000) * 1000 + 23 * 3600000),
            new Date(now + PAYMENT_RATE_LIMITS.checkoutCooldownMs),
          ],
        )
      ).rows[0]!;
      return { row: updated, external: true };
    });
    const row = attempt.row;
    if (!attempt.external) return this.orderView(row);
    let session: CheckoutSession;
    try {
      session = row.session_id
        ? await transport.retrieveSession(row.session_id)
        : await transport.createSession({
            ...view(row),
            requestVersion: row.checkout_request_version,
            apiVersion: row.checkout_api_version,
            stripeIdempotencyKey: row.stripe_idempotency_key,
            integrationIdentifier: row.integration_identifier,
            expiresAt: Math.floor(row.checkout_expires_at!.getTime() / 1000),
          });
    } catch {
      // The call might have succeeded upstream; retain the same request/key.
      await this.pool.query('UPDATE mr_payment_orders SET checkout_lease_until=NULL WHERE id=$1', [
        id,
      ]);
      throw new PaymentError(
        'checkout_uncertain',
        'Checkout could not be confirmed. Wait 60 seconds, then retry this same order.',
        503,
      );
    }
    const result = await this.transaction(async (client) => {
      await this.lockIntent(client, paymentIntentId(session.payment_intent));
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const current = await this.owned(client, workspaceId, id, true);
      let url: string | null;
      try {
        if (!validSession(current, session))
          throw new PaymentError('session_mismatch', 'Payment session requires review.', 409);
        url = checkoutUrl(session.url);
      } catch (error) {
        if (!(error instanceof PaymentError)) throw error;
        await client.query(
          "UPDATE mr_payment_orders SET status='review',checkout_lease_until=NULL,updated_at=now() WHERE id=$1 AND credited_at IS NULL",
          [id],
        );
        return error;
      }
      const status = current.credited_at
        ? 'credited'
        : current.status === 'review'
          ? 'review'
          : current.status === 'payment_failed' && session.payment_status !== 'paid'
            ? 'payment_failed'
            : session.status === 'expired'
              ? 'expired'
              : session.status === 'complete'
                ? 'payment_pending'
                : 'checkout_open';
      try {
        await this.qualifyOrder(client, current, session);
      } catch (error) {
        if (!(error instanceof PaymentOwnershipError)) throw error;
        if (!current.credited_at)
          await client.query(
            "UPDATE mr_payment_orders SET status='review',checkout_lease_until=NULL,updated_at=now() WHERE id=$1",
            [id],
          );
        return error;
      }
      const updated = (
        await client.query<OrderRow>(
          `UPDATE mr_payment_orders SET session_id=$2,payment_intent_id=COALESCE(payment_intent_id,$3),checkout_url=$4,status=$5,checkout_lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
          [id, session.id, paymentIntentId(session.payment_intent), url, status],
        )
      ).rows[0]!;
      await this.pendingHolds(client, updated, paymentIntentId(session.payment_intent));
      return this.orderView(updated); // Even a paid retrieve never grants credit here.
    });
    if (result instanceof PaymentError || result instanceof PaymentOwnershipError) throw result;
    return result;
  }

  private async lockIntent(client: PoolClient, intent: string | null) {
    if (intent)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('opengen-payment-intent'),hashtext($1))",
        [intent],
      );
  }
  private async pendingHolds(client: PoolClient, row: OrderRow, intent: string | null) {
    if (!intent) return;
    const risk = await client.query(
      this.processorEnvironment
        ? "SELECT id,type FROM mr_payment_events WHERE payment_intent_id=$1 AND state='pending' AND processor_environment_id=$2"
        : "SELECT id,type FROM mr_payment_events WHERE payment_intent_id=$1 AND state='pending'",
      this.processorEnvironment ? [intent, this.processorEnvironment.id] : [intent],
    );
    for (const pending of risk.rows)
      if (isPaymentRiskEvent(pending.type)) await this.hold(client, row, pending.id, pending.type);
  }
  /** Only pass events verified from exact raw bytes using the endpoint secret. */
  async reconcile(
    event: VerifiedPaymentEvent,
    transport: PaymentTransport,
  ): Promise<{ received: true; duplicate?: boolean; ignored?: boolean }> {
    const environment = this.processorEnvironment;
    if (environment) {
      this.requireTransport(transport);
      if (!sameBillingProcessorEnvironment(environment, event.processorEnvironment))
        throw new PaymentError('environment_mismatch', 'Unexpected payment environment.', 409);
    }
    const object = event.data.object;
    if (!event.id || typeof object.id !== 'string')
      throw new PaymentError('invalid_event', 'Invalid payment event.');
    if (event.livemode !== this.options.livemode)
      throw new PaymentError('environment_mismatch', 'Unexpected payment environment.');
    const isSession = sessionTypes.has(event.type),
      isRisk = isPaymentRiskEvent(event.type);
    const paymentIntent = paymentIntentId(object.payment_intent);
    if (isSession) {
      const receipt = (
        await this.pool.query<ProcessorPaymentReceipt>(
          'SELECT * FROM mr_payment_events WHERE id=$1',
          [event.id],
        )
      ).rows[0];
      if (receipt) {
        if (!matchesPaymentEventReceipt(receipt, event, paymentIntent, environment?.id))
          throw new PaymentError(
            'event_conflict',
            'Event identity conflicts with the journal.',
            409,
          );
        if (
          (receipt.state === 'processed' || receipt.state === 'ignored') &&
          (receipt.processor_environment_id ?? null) === (environment?.id ?? null)
        ) {
          if (environment)
            await assertBillingProcessorEnvironmentInTransaction(this.pool, environment);
          return { received: true, duplicate: true };
        }
      }
    }
    // Unknown session IDs never become authoritative through metadata/client_reference_id.
    // A lost create response must first be recovered by replay of the stored create key.
    let candidate = isSession
      ? (
          await this.pool.query<OrderRow>('SELECT * FROM mr_payment_orders WHERE session_id=$1', [
            object.id,
          ])
        ).rows[0]
      : paymentIntent
        ? (
            await this.pool.query<OrderRow>(
              'SELECT * FROM mr_payment_orders WHERE payment_intent_id=$1',
              [paymentIntent],
            )
          ).rows[0]
        : undefined;
    if (candidate && !this.matchesEnvironment(candidate)) candidate = undefined;
    const session = isSession && candidate ? await transport.retrieveSession(object.id) : undefined;
    const result = await this.transaction(async (client) => {
      // Locks precede journal writes, workspace/order locks and credit. This serializes
      // pending risk insertion with session/payment-intent binding and its hold scan.
      await this.lockIntent(
        client,
        session ? paymentIntentId(session.payment_intent) : paymentIntent,
      );
      // Binding may have committed while this event waited for the intent lock.
      if (isRisk && paymentIntent)
        candidate = (
          await client.query<OrderRow>(
            'SELECT * FROM mr_payment_orders WHERE payment_intent_id=$1',
            [paymentIntent],
          )
        ).rows[0];
      if (environment) {
        await assertBillingProcessorEnvironmentInTransaction(client, environment);
        await recordProcessorPaymentEventInTransaction(client, event, paymentIntent, environment);
        if (
          isRisk &&
          candidate &&
          (!this.matchesEnvironment(candidate) ||
            candidate.processor_environment_id !== environment.id)
        )
          candidate = undefined;
      } else
        await client.query(
          `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [event.id, event.type, object.id, paymentIntent, event.livemode],
        );
      const prior = (
        await client.query<ProcessorPaymentReceipt>(
          'SELECT * FROM mr_payment_events WHERE id=$1 FOR UPDATE',
          [event.id],
        )
      ).rows[0]!;
      if (!matchesPaymentEventReceipt(prior, event, paymentIntent, environment?.id))
        return new PaymentError(
          'event_conflict',
          'Event identity conflicts with the journal.',
          409,
        );
      if (prior.state === 'processed' || prior.state === 'ignored')
        return { received: true as const, duplicate: true };
      if (!isSession && !isRisk) {
        await client.query(
          "UPDATE mr_payment_events SET state='ignored',processed_at=now() WHERE id=$1",
          [event.id],
        );
        return { received: true as const, ignored: true };
      }
      if (!candidate) {
        await client.query("UPDATE mr_payment_events SET reason='unmatched_payment' WHERE id=$1", [
          event.id,
        ]);
        return new PaymentError(
          'unmatched_payment',
          'Payment awaits identity reconciliation.',
          503,
        );
      }
      const workspaceId = candidate.workspace_id;
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const row = await this.owned(client, workspaceId, candidate.id, true);
      if (!this.matchesEnvironment(row))
        return new PaymentError(
          'environment_mismatch',
          'Payment belongs to a different processor environment.',
          409,
        );
      if (
        isSession &&
        (session!.id !== object.id ||
          !validSession(row, session!) ||
          !validSession(row, object as unknown as CheckoutSession, true) ||
          (paymentIntent !== null && paymentIntent !== paymentIntentId(session!.payment_intent)))
      ) {
        await client.query(
          "UPDATE mr_payment_events SET state='rejected',reason='session_mismatch' WHERE id=$1",
          [event.id],
        );
        return new PaymentError(
          'session_mismatch',
          'Payment session does not match the stored order.',
          409,
        );
      }
      if (isRisk) {
        if (!paymentIntent || row.payment_intent_id !== paymentIntent)
          return new PaymentError('session_mismatch', 'Payment identity changed.', 409);
        await this.hold(client, row, event.id, event.type);
      } else {
        const intent = paymentIntentId(session!.payment_intent);
        try {
          await this.qualifyOrder(client, row, session!);
        } catch (error) {
          if (!(error instanceof PaymentOwnershipError)) throw error;
          await client.query(
            "UPDATE mr_payment_events SET state='rejected',reason=$2 WHERE id=$1",
            [event.id, error.code],
          );
          return error;
        }
        await client.query(
          'UPDATE mr_payment_orders SET payment_intent_id=COALESCE(payment_intent_id,$2),checkout_lease_until=NULL WHERE id=$1',
          [row.id, intent],
        );
        await this.pendingHolds(client, row, intent);
        const paid =
          session!.payment_status === 'paid' && session!.status === 'complete' && intent !== null;
        const paidEvent =
          ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(
            event.type,
          ) &&
          object.payment_status === 'paid' &&
          object.status === 'complete';
        if (paid && paidEvent && !row.credited_at && row.status !== 'review') {
          await this.options.creditInTransaction(
            client,
            workspaceId,
            Number(row.credit_micros),
            canonicalFundingCreditReference('manual', row.id),
          );
          await client.query(
            "UPDATE mr_payment_orders SET status='credited',credited_at=now(),checkout_url=NULL,updated_at=now() WHERE id=$1",
            [row.id],
          );
        } else if (!row.credited_at && row.status !== 'review') {
          const status = paid
            ? 'payment_pending'
            : row.status === 'payment_failed'
              ? 'payment_failed'
              : session!.status === 'expired'
                ? 'expired'
                : event.type === 'checkout.session.async_payment_failed'
                  ? 'payment_failed'
                  : 'payment_pending';
          await client.query(
            'UPDATE mr_payment_orders SET status=$2,updated_at=now() WHERE id=$1',
            [row.id, status],
          );
        }
      }
      await client.query(
        "UPDATE mr_payment_events SET state='processed',order_id=$2,processed_at=now(),reason=NULL WHERE id=$1",
        [event.id, row.id],
      );
      return { received: true as const };
    });
    if (result instanceof PaymentError || result instanceof PaymentOwnershipError) throw result;
    return result;
  }
  private async hold(client: PoolClient, row: OrderRow, eventId: string, reason: string) {
    await client.query(
      'INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [eventId, row.workspace_id, row.id, reason],
    );
    await client.query(
      "UPDATE mr_payment_events SET state='processed',order_id=$2,processed_at=now(),reason=NULL WHERE id=$1",
      [eventId, row.id],
    );
  }
}
