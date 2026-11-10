import type { PoolClient } from 'pg';
import type { CheckoutSession } from './payments.js';

export type FundingKind = 'manual' | 'automatic';
export interface PaymentOwnershipIdentity {
  processorEnvironmentId: string;
  livemode: boolean;
  paymentIntentId: string;
}
export interface PaymentOwnership extends PaymentOwnershipIdentity {
  workspaceId: string;
  kind: FundingKind;
  localId: string;
  amountCents: number;
  currency: 'USD';
  creditReference: string;
}
export interface PaymentOwnershipClaim extends Omit<PaymentOwnership, 'currency'> {
  /** Fresh Checkout GET from the server's verified processor environment. A
   * legacy local order must already carry this exact Checkout session ID. */
  legacySession?: CheckoutSession;
}
export class PaymentOwnershipError extends Error {
  readonly statusCode = 409;
  constructor(
    public code: 'payment_ownership_conflict' | 'payment_environment_unqualified',
    message: string,
  ) {
    super(message);
  }
}
const conflict = () =>
  new PaymentOwnershipError(
    'payment_ownership_conflict',
    'Payment identity conflicts with its authoritative funding owner.',
  );
const unqualified = () =>
  new PaymentOwnershipError(
    'payment_environment_unqualified',
    'Payment identity requires evidence from its original processor environment.',
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const intentPattern = /^pi_[A-Za-z0-9_]{1,240}$/;
const environmentPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const validAmount = (amount: number) =>
  Number.isSafeInteger(amount) && amount >= 500 && amount <= 100000;

export function canonicalFundingCreditReference(kind: FundingKind, localId: string): string {
  return `${kind === 'manual' ? 'stripe-topup' : 'stripe-recharge'}:${localId.toLowerCase()}`;
}

interface BoundFunding {
  kind: FundingKind;
  id: string;
  workspace_id: string;
  livemode: boolean;
  processor_environment_id: string | null;
  payment_intent_id: string | null;
  amount_cents: number;
  session_id: string | null;
}
interface OwnerRow {
  kind: FundingKind;
  local_id: string;
  workspace_id: string;
  processor_environment_id: string;
  livemode: boolean;
  payment_intent_id: string;
  amount_cents: number;
  currency: 'USD';
  credit_reference: string;
}
const ownerView = (row: OwnerRow): PaymentOwnership => ({
  processorEnvironmentId: row.processor_environment_id,
  livemode: row.livemode,
  paymentIntentId: row.payment_intent_id,
  workspaceId: row.workspace_id,
  kind: row.kind,
  localId: row.local_id,
  amountCents: row.amount_cents,
  currency: row.currency,
  creditReference: row.credit_reference,
});

/** Share the namespace used by legacy Checkout, recharge and risk journaling. */
export async function lockPaymentIntentInTransaction(
  client: PoolClient,
  paymentIntentId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('opengen-payment-intent'),hashtext($1))",
    [paymentIntentId],
  );
}
async function requireEnvironment(client: PoolClient, identity: PaymentOwnershipIdentity) {
  if (
    !environmentPattern.test(identity.processorEnvironmentId) ||
    !intentPattern.test(identity.paymentIntentId) ||
    typeof identity.livemode !== 'boolean'
  )
    throw unqualified();
  const result = await client.query(
    'SELECT id FROM mr_billing_processor_environments WHERE id=$1 AND livemode=$2',
    [identity.processorEnvironmentId, identity.livemode],
  );
  if (!result.rowCount) throw unqualified();
}
async function existingOwner(client: PoolClient, identity: PaymentOwnershipIdentity) {
  return (
    await client.query<OwnerRow>(
      'SELECT * FROM mr_billing_payment_ownership WHERE processor_environment_id=$1 AND payment_intent_id=$2',
      [identity.processorEnvironmentId, identity.paymentIntentId],
    )
  ).rows[0];
}
async function legacyAndCurrentBindings(client: PoolClient, identity: PaymentOwnershipIdentity) {
  return (
    await client.query<BoundFunding>(
      `SELECT 'manual' AS kind,id,workspace_id,livemode,processor_environment_id,payment_intent_id,amount_cents,session_id
    FROM mr_payment_orders WHERE payment_intent_id=$1 AND livemode=$2 AND (processor_environment_id=$3 OR processor_environment_id IS NULL)
    UNION ALL
    SELECT 'automatic' AS kind,id,workspace_id,livemode,processor_environment_id,payment_intent_id,amount_cents,NULL AS session_id
    FROM mr_billing_recharge_attempts WHERE payment_intent_id=$1 AND livemode=$2 AND (processor_environment_id=$3 OR processor_environment_id IS NULL)`,
      [identity.paymentIntentId, identity.livemode, identity.processorEnvironmentId],
    )
  ).rows;
}
async function localFunding(
  client: PoolClient,
  owner: Pick<PaymentOwnership, 'kind' | 'workspaceId' | 'localId'>,
  lock = false,
): Promise<BoundFunding | undefined> {
  const table = owner.kind === 'manual' ? 'mr_payment_orders' : 'mr_billing_recharge_attempts';
  const session = owner.kind === 'manual' ? 'session_id' : 'NULL AS session_id';
  return (
    await client.query<BoundFunding>(
      `SELECT $3::text AS kind,id,workspace_id,livemode,processor_environment_id,payment_intent_id,amount_cents,${session}
    FROM ${table} WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [owner.workspaceId, owner.localId, owner.kind],
    )
  ).rows[0];
}
function assertLocalFunding(
  row: BoundFunding | undefined,
  owner: Omit<PaymentOwnership, 'currency'>,
): asserts row is BoundFunding {
  if (
    !row ||
    row.livemode !== owner.livemode ||
    row.amount_cents !== owner.amountCents ||
    (row.payment_intent_id !== null && row.payment_intent_id !== owner.paymentIntentId)
  )
    throw conflict();
  if (
    row.processor_environment_id !== null &&
    row.processor_environment_id !== owner.processorEnvironmentId
  )
    throw unqualified();
}
function assertBindings(
  bindings: BoundFunding[],
  owner: Pick<PaymentOwnership, 'kind' | 'localId' | 'workspaceId' | 'amountCents'>,
) {
  if (
    bindings.some(
      (row) =>
        row.kind !== owner.kind ||
        row.id !== owner.localId ||
        row.workspace_id !== owner.workspaceId ||
        row.amount_cents !== owner.amountCents,
    )
  )
    throw conflict();
}
function qualifiedLegacyCheckout(row: BoundFunding, input: PaymentOwnershipClaim): boolean {
  const session = input.legacySession;
  if (!session || row.kind !== 'manual' || !row.session_id) return false;
  const intent =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  return (
    session.id === row.session_id &&
    session.client_reference_id === row.id &&
    session.mode === 'payment' &&
    session.livemode === row.livemode &&
    session.currency === 'usd' &&
    session.amount_subtotal === row.amount_cents &&
    session.amount_total === row.amount_cents &&
    intent === input.paymentIntentId
  );
}

/** Caller owns BEGIN and acquires the PI lock before any workspace lock.
 * Use an already verified payment/Checkout snapshot from the configured server
 * transport. Commit this claim, local PI binding, and any paid reconciliation
 * on the same client. This helper performs no network or ledger operations. */
export async function claimPaymentOwnershipInTransaction(
  client: PoolClient,
  input: PaymentOwnershipClaim,
): Promise<PaymentOwnership> {
  const localId = input.localId.toLowerCase();
  const creditReference = canonicalFundingCreditReference(input.kind, localId);
  if (
    !uuid.test(localId) ||
    !validAmount(input.amountCents) ||
    !['manual', 'automatic'].includes(input.kind) ||
    input.creditReference !== creditReference
  )
    throw conflict();
  await requireEnvironment(client, input);
  await lockPaymentIntentInTransaction(client, input.paymentIntentId);
  if (
    !(
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
    ).rowCount
  )
    throw conflict();
  const owner = { ...input, localId, creditReference };
  const row = await localFunding(client, owner, true);
  assertLocalFunding(row, owner);
  assertBindings(await legacyAndCurrentBindings(client, input), owner);
  const prior = await existingOwner(client, input);
  if (prior) {
    const stored = ownerView(prior);
    if (
      stored.workspaceId !== owner.workspaceId ||
      stored.kind !== owner.kind ||
      stored.localId !== localId ||
      stored.livemode !== owner.livemode ||
      stored.amountCents !== owner.amountCents ||
      stored.creditReference !== creditReference
    )
      throw conflict();
    return stored;
  }
  if (
    row.processor_environment_id !== input.processorEnvironmentId &&
    !(row.processor_environment_id === null && qualifiedLegacyCheckout(row, input))
  )
    throw unqualified();
  const inserted = (
    await client.query<OwnerRow>(
      `INSERT INTO mr_billing_payment_ownership(processor_environment_id,livemode,payment_intent_id,workspace_id,kind,local_id,manual_order_id,recharge_attempt_id,amount_cents,credit_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
      [
        input.processorEnvironmentId,
        input.livemode,
        input.paymentIntentId,
        input.workspaceId,
        input.kind,
        localId,
        input.kind === 'manual' ? localId : null,
        input.kind === 'automatic' ? localId : null,
        input.amountCents,
        creditReference,
      ],
    )
  ).rows[0];
  if (!inserted) throw conflict();
  return ownerView(inserted);
}

/** Routes known PI observations within the verified processor environment. A
 * legacy null-environment row qualifies only through an existing shared claim.
 * Call before acquiring a workspace lock. Record the routing decision and
 * event receipt in the same transaction, then commit before external retrieval. */
export async function resolvePaymentOwnershipInTransaction(
  client: PoolClient,
  identity: PaymentOwnershipIdentity,
): Promise<PaymentOwnership | null> {
  await requireEnvironment(client, identity);
  await lockPaymentIntentInTransaction(client, identity.paymentIntentId);
  const bindings = await legacyAndCurrentBindings(client, identity);
  const stored = await existingOwner(client, identity);
  if (stored) {
    const owner = ownerView(stored);
    if (owner.livemode !== identity.livemode) throw conflict();
    assertBindings(bindings, owner);
    assertLocalFunding(await localFunding(client, owner), owner);
    return owner;
  }
  if (bindings.length > 1) throw conflict();
  const row = bindings[0];
  if (!row || row.processor_environment_id !== identity.processorEnvironmentId) return null;
  if (!validAmount(row.amount_cents)) throw conflict();
  return {
    processorEnvironmentId: identity.processorEnvironmentId,
    livemode: identity.livemode,
    paymentIntentId: identity.paymentIntentId,
    workspaceId: row.workspace_id,
    kind: row.kind,
    localId: row.id,
    amountCents: row.amount_cents,
    currency: 'USD',
    creditReference: canonicalFundingCreditReference(row.kind, row.id),
  };
}
