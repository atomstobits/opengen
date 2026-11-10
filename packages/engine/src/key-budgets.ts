import type { PoolClient } from 'pg';

export class KeyBudgetError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'KeyBudgetError';
  }
}
function money(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new KeyBudgetError('invalid_money', 'Use nonnegative integer micro-USD.');
  return amount;
}
export function utcAdmissionMonth(at: Date): string {
  if (!Number.isFinite(at.getTime()))
    throw new KeyBudgetError('invalid_date', 'Invalid admission date.');
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
export interface KeyBudgetReservation {
  keyId: string;
  admissionMonth: string;
  reservedMicros: number;
  settledMicros: number | null;
  admittedAt: string;
}
interface ReservationRow {
  key_id: string;
  admission_month: string;
  reserved_micros: string;
  settled_micros: string | null;
  admitted_at: Date;
}
// PostgreSQL DATE is a calendar label, not an instant. pg otherwise decodes it
// at local midnight, whose ISO conversion can report the previous UTC date.
const reservationColumns = `key_id,to_char(admission_month,'YYYY-MM-DD') AS admission_month,
  reserved_micros,settled_micros,admitted_at`;
function reservation(row: ReservationRow): KeyBudgetReservation {
  return {
    keyId: row.key_id,
    admissionMonth: row.admission_month,
    reservedMicros: money(row.reserved_micros),
    settledMicros: row.settled_micros === null ? null : money(row.settled_micros),
    admittedAt: row.admitted_at.toISOString(),
  };
}
async function lockWorkspace(client: PoolClient, workspaceId: string) {
  if (
    !(await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]))
      .rowCount
  )
    throw new KeyBudgetError('workspace_not_found', 'Workspace unavailable.', 404);
}

/** No nested transactions/pool calls/provider I/O. The caller commits these writes
 * with the job, workspace reserve and ledger, using workspace-first lock order.
 * The trusted key ID comes from final authority revalidation, never request JSON. */
export class KeyBudgetStore {
  /** Test clock only; production obtains wall-clock admission time AFTER the lock. */
  constructor(private readonly clock?: () => Date) {}

  async reserveInTransaction(
    client: PoolClient,
    input: {
      workspaceId: string;
      jobId: string;
      keyId: string | null;
      billing: 'managed' | 'byok';
      reservedMicros: number;
    },
  ): Promise<KeyBudgetReservation | null> {
    const amount = money(input.reservedMicros);
    await lockWorkspace(client, input.workspaceId);
    const previous = (
      await client.query<ReservationRow>(
        `SELECT ${reservationColumns} FROM mr_key_reservations WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE`,
        [input.workspaceId, input.jobId],
      )
    ).rows[0];
    if (previous) {
      if (
        input.billing !== 'managed' ||
        previous.key_id !== input.keyId ||
        money(previous.reserved_micros) !== amount
      )
        throw new KeyBudgetError(
          'budget_reservation_conflict',
          'Job already has a different key exposure.',
          409,
        );
      return reservation(previous);
    }
    // External BYOK charges have no enforceable ledger ceiling. Unattributed
    // bootstrap/legacy admissions do not invent a key or a zero-usage history.
    if (input.billing === 'byok' || !input.keyId) return null;
    if (
      !(
        await client.query('SELECT id FROM mr_jobs WHERE workspace_id=$1 AND id=$2', [
          input.workspaceId,
          input.jobId,
        ])
      ).rowCount
    )
      throw new KeyBudgetError('job_unavailable', 'Job unavailable in this workspace.', 404);
    const key = (
      await client.query(
        `SELECT monthly_cap_micros,cap_coverage_started_at FROM mr_api_keys
       WHERE workspace_id=$1 AND id=$2 AND key_kind='api' FOR UPDATE`,
        [input.workspaceId, input.keyId],
      )
    ).rows[0];
    if (!key) throw new KeyBudgetError('key_unavailable', 'Managed budget key unavailable.', 403);
    // Source key revocation/scopes/policy MUST also be checked by the authority
    // hook in this same transaction. This module is accounting, not auth.
    const at = this.clock
      ? this.clock()
      : ((await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date);
    if (at < key.cap_coverage_started_at)
      throw new KeyBudgetError(
        'budget_coverage_unknown',
        'Admission predates tracked key coverage.',
        409,
      );
    const month = utcAdmissionMonth(at);
    await client.query(
      `INSERT INTO mr_key_months(workspace_id,key_id,admission_month) VALUES($1,$2,$3)
       ON CONFLICT(workspace_id,key_id,admission_month) DO NOTHING`,
      [input.workspaceId, input.keyId, month],
    );
    const bucket = (
      await client.query(
        `SELECT gross_debit_micros,held_micros FROM mr_key_months
       WHERE workspace_id=$1 AND key_id=$2 AND admission_month=$3 FOR UPDATE`,
        [input.workspaceId, input.keyId, month],
      )
    ).rows[0];
    const exposure = money(money(bucket.gross_debit_micros) + money(bucket.held_micros) + amount);
    if (key.monthly_cap_micros !== null && exposure > money(key.monthly_cap_micros))
      throw new KeyBudgetError(
        'key_monthly_cap_exceeded',
        'Managed monthly key debit and held exposure exceed the cap.',
        402,
      );
    await client.query(
      `UPDATE mr_key_months SET held_micros=held_micros+$4
       WHERE workspace_id=$1 AND key_id=$2 AND admission_month=$3`,
      [input.workspaceId, input.keyId, month, amount],
    );
    const inserted = (
      await client.query<ReservationRow>(
        `INSERT INTO mr_key_reservations(job_id,workspace_id,key_id,admission_month,reserved_micros,admitted_at)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING ${reservationColumns}`,
        [input.jobId, input.workspaceId, input.keyId, month, amount, at],
      )
    ).rows[0]!;
    return reservation(inserted);
  }

  /** Call only once the customer debit is known. Unknown acceptance/cost keeps
   * the reservation held. Credits/refunds never reduce this gross-debit bucket. */
  async settleInTransaction(
    client: PoolClient,
    workspaceId: string,
    jobId: string,
    chargedMicros: number,
  ): Promise<KeyBudgetReservation | null> {
    const charge = money(chargedMicros);
    await lockWorkspace(client, workspaceId);
    const row = (
      await client.query<ReservationRow>(
        `SELECT ${reservationColumns} FROM mr_key_reservations WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE`,
        [workspaceId, jobId],
      )
    ).rows[0];
    if (!row) return null; // pre-cutover / BYOK / no stable key: unknown, not zero.
    if (row.settled_micros !== null) {
      if (money(row.settled_micros) !== charge)
        throw new KeyBudgetError(
          'budget_settlement_conflict',
          'Key exposure was settled for another debit.',
          409,
        );
      return reservation(row);
    }
    if (charge > money(row.reserved_micros))
      throw new KeyBudgetError(
        'budget_charge_exceeds_reserve',
        'Customer debit exceeds the held reservation.',
        409,
      );
    await client.query(
      `UPDATE mr_key_months SET held_micros=held_micros-$4,gross_debit_micros=gross_debit_micros+$5
       WHERE workspace_id=$1 AND key_id=$2 AND admission_month=$3`,
      [workspaceId, row.key_id, row.admission_month, money(row.reserved_micros), charge],
    );
    const updated = (
      await client.query<ReservationRow>(
        `UPDATE mr_key_reservations SET settled_micros=$3,settled_at=clock_timestamp()
       WHERE workspace_id=$1 AND job_id=$2 RETURNING ${reservationColumns}`,
        [workspaceId, jobId, charge],
      )
    ).rows[0]!;
    return reservation(updated);
  }

  /** Internal write: adapter must revalidate keys:write/admin in this transaction.
   * Lowering below exposure is allowed and blocks subsequent admissions. */
  async setCapInTransaction(
    client: PoolClient,
    workspaceId: string,
    keyId: string,
    capMicros: number | null,
  ) {
    if (capMicros !== null) money(capMicros);
    await lockWorkspace(client, workspaceId);
    const result = await client.query(
      `UPDATE mr_api_keys SET monthly_cap_micros=$3 WHERE workspace_id=$1 AND id=$2 AND key_kind='api'
       RETURNING id,monthly_cap_micros,cap_coverage_started_at`,
      [workspaceId, keyId, capMicros],
    );
    if (!result.rows[0])
      throw new KeyBudgetError('key_unavailable', 'Managed budget key unavailable.', 404);
    return result.rows[0];
  }
}
