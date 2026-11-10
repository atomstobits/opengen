import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

type Transaction = Pick<PoolClient, 'query'>;
export type DispatchState = 'queued' | 'occupied' | 'unknown' | 'released' | 'expired';
export type ReleaseEvidence = 'confirmed_terminal' | 'explicit_rejection' | 'operator_reconciled';
export interface DispatchIdentity {
  jobId: string;
  attemptNumber: number;
  workspaceId: string;
  workspacePoolId: string;
  providerPoolId: string;
}
export interface PoolLimits {
  id: string;
  kind: 'workspace' | 'provider';
  maxActive: number;
  maxQueued: number;
}
export class DispatchCapacityError extends Error {
  constructor(
    public readonly code:
      | 'dispatch_backpressure'
      | 'dispatch_identity_conflict'
      | 'dispatch_not_found'
      | 'dispatch_configuration',
    public readonly statusCode = 409,
  ) {
    super(
      code === 'dispatch_backpressure'
        ? 'The dispatch backlog is full. Retry admission with the same idempotency key later.'
        : code === 'dispatch_not_found'
          ? 'Dispatch work was not found.'
          : code === 'dispatch_configuration'
            ? 'Dispatch capacity is not configured.'
            : 'Dispatch identity conflicts with existing work.',
    );
    this.name = 'DispatchCapacityError';
  }
}

function key(parts: string[]): string {
  if (parts.some((part) => !part || part.length > 512))
    throw new DispatchCapacityError('dispatch_configuration', 503);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
/** Internal only. IDs identify a stable supply account, never a credential value/version. */
export const workspacePoolId = (workspaceId: string): string => `workspace:${key([workspaceId])}`;
export function providerPoolId(
  input:
    | { mode: 'managed'; supplyId: string }
    | { mode: 'byok'; workspaceId: string; connectionId: string },
): string {
  return input.mode === 'managed'
    ? `managed:${key([input.supplyId])}`
    : `byok:${key([input.workspaceId, input.connectionId])}`;
}

interface Slot extends QueryResultRow {
  job_id: string;
  attempt_number: number;
  workspace_id: string;
  workspace_pool_id: string;
  provider_pool_id: string;
  state: DispatchState;
  start_deadline_at: Date | string | null;
}
interface PoolRow extends QueryResultRow {
  id: string;
  kind: PoolLimits['kind'];
  max_active: number;
  max_queued: number;
}
function identity(value: DispatchIdentity): void {
  if (
    !Number.isSafeInteger(value.attemptNumber) ||
    value.attemptNumber < 1 ||
    value.workspacePoolId !== workspacePoolId(value.workspaceId) ||
    !/^(managed|byok):[a-f0-9]{64}$/.test(value.providerPoolId)
  )
    throw new DispatchCapacityError('dispatch_identity_conflict');
}
function sameSlot(row: Slot, value: DispatchIdentity): void {
  if (
    row.workspace_id !== value.workspaceId ||
    row.workspace_pool_id !== value.workspacePoolId ||
    row.provider_pool_id !== value.providerPoolId
  )
    throw new DispatchCapacityError('dispatch_identity_conflict');
}
async function lockPools(client: Transaction, value: DispatchIdentity): Promise<PoolRow[]> {
  identity(value);
  // Caller locks the workspace financial row FIRST. Every C6 transition uses workspace -> supply.
  const rows: PoolRow[] = [];
  for (const [id, kind] of [
    [value.workspacePoolId, 'workspace'],
    [value.providerPoolId, 'provider'],
  ] as const) {
    const row = (
      await client.query<PoolRow>('SELECT * FROM mr_execution_pools WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (!row || row.kind !== kind) throw new DispatchCapacityError('dispatch_configuration', 503);
    rows.push(row);
  }
  return rows;
}
async function slot(client: Transaction, value: DispatchIdentity): Promise<Slot | undefined> {
  const row = (
    await client.query<Slot>(
      'SELECT * FROM mr_dispatch_slots WHERE job_id=$1 AND attempt_number=$2 FOR UPDATE',
      [value.jobId, value.attemptNumber],
    )
  ).rows[0];
  if (row) sameSlot(row, value);
  return row;
}
async function counts(
  client: Transaction,
  pool: PoolRow,
): Promise<{ active: number; queued: number }> {
  const column = pool.kind === 'workspace' ? 'workspace_pool_id' : 'provider_pool_id';
  const row = (
    await client.query(
      `SELECT count(*) FILTER (WHERE state IN ('occupied','unknown'))::int AS active,
      count(*) FILTER (WHERE state='queued')::int AS queued FROM mr_dispatch_slots WHERE ${column}=$1`,
      [pool.id],
    )
  ).rows[0];
  return row;
}

/** Operator configuration only. Never derive these limits/identities from a generation body. */
export async function configurePoolInTransaction(
  client: Transaction,
  limits: PoolLimits,
): Promise<void> {
  if (
    !Number.isInteger(limits.maxActive) ||
    limits.maxActive < 1 ||
    limits.maxActive > 1_000_000 ||
    !Number.isInteger(limits.maxQueued) ||
    limits.maxQueued < 0 ||
    limits.maxQueued > 1_000_000 ||
    !/^(workspace|managed|byok):[a-f0-9]{64}$/.test(limits.id) ||
    (limits.kind === 'workspace') !== limits.id.startsWith('workspace:')
  )
    throw new DispatchCapacityError('dispatch_configuration', 503);
  const result = await client.query(
    `INSERT INTO mr_execution_pools(id,kind,max_active,max_queued) VALUES($1,$2,$3,$4)
     ON CONFLICT(id) DO UPDATE SET max_active=EXCLUDED.max_active,max_queued=EXCLUDED.max_queued
     WHERE mr_execution_pools.kind=EXCLUDED.kind RETURNING id`,
    [limits.id, limits.kind, limits.maxActive, limits.maxQueued],
  );
  if (!result.rows.length) throw new DispatchCapacityError('dispatch_configuration', 503);
}

/** Same transaction as admission/reservation; a rejected backlog must roll back the entire admission. */
export async function enqueueDispatchInTransaction(
  client: Transaction,
  value: DispatchIdentity & { startDeadlineAt?: string | null },
): Promise<{ state: DispatchState; replay: boolean }> {
  const deadline = value.startDeadlineAt == null ? null : new Date(value.startDeadlineAt);
  if (
    deadline &&
    (!Number.isFinite(deadline.getTime()) || deadline.toISOString() !== value.startDeadlineAt)
  )
    throw new DispatchCapacityError('dispatch_identity_conflict');
  const pools = await lockPools(client, value);
  const existing = await slot(client, value);
  if (existing) {
    const saved =
      existing.start_deadline_at == null
        ? null
        : new Date(existing.start_deadline_at).toISOString();
    if (saved !== (deadline?.toISOString() ?? null))
      throw new DispatchCapacityError('dispatch_identity_conflict');
    return { state: existing.state, replay: true };
  }
  const owned = (
    await client.query('SELECT id FROM mr_jobs WHERE id=$1 AND workspace_id=$2', [
      value.jobId,
      value.workspaceId,
    ])
  ).rows[0];
  if (!owned) throw new DispatchCapacityError('dispatch_not_found', 404);
  const previous = (
    await client.query(
      `SELECT attempt_number,state FROM mr_dispatch_slots WHERE job_id=$1 ORDER BY attempt_number DESC LIMIT 1`,
      [value.jobId],
    )
  ).rows[0];
  // Fallback is a new attempt only after explicit rejection/terminal evidence releases its predecessor.
  if (
    value.attemptNumber !== (previous ? previous.attempt_number + 1 : 1) ||
    (previous && previous.state !== 'released')
  )
    throw new DispatchCapacityError('dispatch_identity_conflict');
  for (const pool of pools) {
    if ((await counts(client, pool)).queued >= pool.max_queued)
      throw new DispatchCapacityError('dispatch_backpressure', 429);
  }
  await client.query(
    `INSERT INTO mr_dispatch_slots(job_id,attempt_number,workspace_id,workspace_pool_id,provider_pool_id,state,start_deadline_at)
     VALUES($1,$2,$3,$4,$5,'queued',$6)`,
    [
      value.jobId,
      value.attemptNumber,
      value.workspaceId,
      value.workspacePoolId,
      value.providerPoolId,
      deadline,
    ],
  );
  return { state: 'queued', replay: false };
}

/** Commit this intent before the outbound submit. Only 'acquired' permits ONE submit. No lease can release it. */
export async function beginDispatchInTransaction(
  client: Transaction,
  value: DispatchIdentity,
): Promise<'acquired' | 'blocked' | 'expired' | 'already_started' | 'closed'> {
  const pools = await lockPools(client, value);
  const row = await slot(client, value);
  if (!row) throw new DispatchCapacityError('dispatch_not_found', 404);
  if (row.state === 'occupied' || row.state === 'unknown') return 'already_started';
  if (row.state !== 'queued') return row.state === 'expired' ? 'expired' : 'closed';
  // Deadline is checked at the authoritative submission-intent boundary, even when capacity is full.
  if (await expireLocked(client, value)) return 'expired';
  for (const pool of pools)
    if ((await counts(client, pool)).active >= pool.max_active) return 'blocked';
  const started = await client.query(
    `WITH boundary AS MATERIALIZED (SELECT clock_timestamp() AS at)
     UPDATE mr_dispatch_slots SET state='occupied',submission_intent_at=boundary.at FROM boundary
     WHERE job_id=$1 AND attempt_number=$2 AND state='queued'
       AND (start_deadline_at IS NULL OR start_deadline_at>boundary.at) RETURNING job_id`,
    [value.jobId, value.attemptNumber],
  );
  // Counting/lock waits can cross the deadline after the first expiry check.
  if (!started.rows.length) {
    await expireLocked(client, value);
    return 'expired';
  }
  return 'acquired';
}
async function expireLocked(client: Transaction, value: DispatchIdentity): Promise<boolean> {
  return (
    (
      await client.query(
        `UPDATE mr_dispatch_slots SET state='expired',released_at=clock_timestamp(),release_evidence='never_submitted_deadline'
     WHERE job_id=$1 AND attempt_number=$2 AND state='queued' AND submission_intent_at IS NULL
     AND start_deadline_at <= clock_timestamp() RETURNING job_id`,
        [value.jobId, value.attemptNumber],
      )
    ).rows.length === 1
  );
}
/** Return true only for a first never-submitted expiry. Caller performs its ledger release in this transaction. */
export async function expireQueuedDispatchInTransaction(
  client: Transaction,
  value: DispatchIdentity,
): Promise<boolean> {
  await lockPools(client, value);
  if (!(await slot(client, value))) throw new DispatchCapacityError('dispatch_not_found', 404);
  return expireLocked(client, value);
}
export async function markDispatchUnknownInTransaction(
  client: Transaction,
  value: DispatchIdentity,
): Promise<void> {
  await lockPools(client, value);
  if (!(await slot(client, value))) throw new DispatchCapacityError('dispatch_not_found', 404);
  await client.query(
    `UPDATE mr_dispatch_slots SET state='unknown' WHERE job_id=$1 AND attempt_number=$2 AND state='occupied'`,
    [value.jobId, value.attemptNumber],
  );
}
/** Trusted upstream/operator evidence only. Cancellation requested, polling failure, delivery, settlement and worker lease expiry are NOT evidence. */
export async function releaseDispatchInTransaction(
  client: Transaction,
  value: DispatchIdentity,
  evidence: ReleaseEvidence,
): Promise<boolean> {
  if (!['confirmed_terminal', 'explicit_rejection', 'operator_reconciled'].includes(evidence))
    throw new DispatchCapacityError('dispatch_identity_conflict');
  await lockPools(client, value);
  if (!(await slot(client, value))) throw new DispatchCapacityError('dispatch_not_found', 404);
  return (
    (
      await client.query(
        `UPDATE mr_dispatch_slots SET state='released',released_at=clock_timestamp(),release_evidence=$3
     WHERE job_id=$1 AND attempt_number=$2 AND state IN ('occupied','unknown') RETURNING job_id`,
        [value.jobId, value.attemptNumber, evidence],
      )
    ).rows.length === 1
  );
}

/** First worker pass: accepted work bypasses all dispatch limits. Delivery receipts have their own equivalent queue. */
export async function claimAcceptedWorkInTransaction<Row extends QueryResultRow = QueryResultRow>(
  client: Transaction,
  leaseMs: number,
  excludeFeeJobs = false,
): Promise<Row | null> {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)
    throw new DispatchCapacityError('dispatch_configuration', 503);
  const result = await client.query<Row>(
    `WITH candidate AS (
       SELECT id FROM mr_jobs WHERE
         (status='running' OR (status IN ('succeeded','failed','cancelled') AND billing_poll_pending=true
          AND settled_micros IS NULL AND upstream_id IS NOT NULL))
         ${excludeFeeJobs ? 'AND fee_admission IS NULL' : ''}
         AND next_poll_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
       ORDER BY next_poll_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
     ) UPDATE mr_jobs j SET lease_until=clock_timestamp()+($1 * interval '1 millisecond')
       FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
    [leaseMs],
  );
  return result.rows[0] ?? null;
}

/** A queued cancellation proves no submission intent. Retain its private capacity
 * receipt; it is neither provider cancellation nor deadline expiry. */
export async function cancelQueuedDispatchInTransaction(
  client: Transaction,
  value: DispatchIdentity,
): Promise<boolean> {
  await lockPools(client, value);
  const row = await slot(client, value);
  if (!row) return false;
  return Boolean(
    (
      await client.query(
        `UPDATE mr_dispatch_slots SET state='released',released_at=clock_timestamp(),release_evidence='never_submitted_cancelled'
     WHERE job_id=$1 AND attempt_number=$2 AND state='queued' AND submission_intent_at IS NULL RETURNING job_id`,
        [value.jobId, value.attemptNumber],
      )
    ).rowCount,
  );
}
