import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const verifiedEmailCreditClaim = Symbol('verified pending-email-credit OIDC identity');

export interface VerifiedPendingEmailCreditIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly [verifiedEmailCreditClaim]: true;
}

export type PendingEmailCreditStatus = 'pending' | 'claimed' | 'revoked';

export interface PendingEmailCredit {
  id: string;
  issuer: string;
  email: string;
  amountMicros: number;
  reference: string;
  note: string | null;
  status: PendingEmailCreditStatus;
  createdAt: string;
  claimedAt: string | null;
  claimedWorkspaceId: string | null;
  claimedSubject: string | null;
  revokedAt: string | null;
}

interface PendingEmailCreditRow {
  id: string;
  issuer: string;
  email: string;
  amount_micros: string;
  reference: string;
  note: string | null;
  created_at: Date;
  claimed_at: Date | null;
  claimed_workspace_id: string | null;
  claimed_subject: string | null;
  revoked_at: Date | null;
}

export type CreditWorkspaceTx = (
  client: PoolClient,
  workspaceId: string,
  amountMicros: number,
  reference: string,
  details?: Record<string, unknown>,
) => Promise<void>;

const error = (code: string, message: string, statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });

const readable = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);

export function normalizePendingCreditEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !readable(trimmed, 254) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(trimmed)
  )
    return null;
  const [local, domain] = trimmed.split('@');
  if (
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !domain?.includes('.') ||
    domain.includes('..')
  )
    return null;
  return trimmed.toLowerCase();
}

export function validatePendingCreditIssuer(value: unknown): string | null {
  if (!readable(value, 500) || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null;
    return value;
  } catch {
    return null;
  }
}

/** Call ONLY after openid-client verified signature, issuer, nonce and ID token claims.
 * Never feed request JSON or unverified profile fields into this helper. */
export function pendingEmailCreditIdentityFromVerifiedOidcClaims(
  claims: Record<string, unknown>,
): VerifiedPendingEmailCreditIdentity | null {
  if (claims.email_verified !== true) return null;
  const issuer = validatePendingCreditIssuer(claims.iss);
  const email = normalizePendingCreditEmail(claims.email);
  if (!issuer || !email || !readable(claims.sub, 500)) return null;
  return Object.freeze({
    issuer,
    subject: claims.sub,
    email,
    [verifiedEmailCreditClaim]: true as const,
  });
}

function formatRow(row: PendingEmailCreditRow): PendingEmailCredit {
  const status: PendingEmailCreditStatus = row.claimed_at
    ? 'claimed'
    : row.revoked_at
      ? 'revoked'
      : 'pending';
  return {
    id: row.id,
    issuer: row.issuer,
    email: row.email,
    amountMicros: Number(row.amount_micros),
    reference: row.reference,
    note: row.note ?? null,
    status,
    createdAt: row.created_at.toISOString(),
    claimedAt: row.claimed_at ? row.claimed_at.toISOString() : null,
    claimedWorkspaceId: row.claimed_workspace_id ?? null,
    claimedSubject: row.claimed_subject ?? null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export class PendingEmailCreditStore {
  constructor(
    readonly pool: Pool,
    private readonly creditInTransaction: CreditWorkspaceTx,
  ) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Operator-only: queue a noncash credit claimed on verified OIDC sign-in for (issuer, email). */
  async enqueue(input: {
    issuer: string;
    email: string;
    amountMicros: number;
    reference: string;
    note?: string;
  }): Promise<{ credit: PendingEmailCredit; created: boolean }> {
    const issuer = validatePendingCreditIssuer(input.issuer);
    if (!issuer) throw error('invalid_issuer', 'A valid HTTPS OIDC issuer URL is required.', 400);
    const email = normalizePendingCreditEmail(input.email);
    if (!email) throw error('invalid_email', 'A valid recipient email address is required.', 400);
    if (
      typeof input.amountMicros !== 'number' ||
      !Number.isSafeInteger(input.amountMicros) ||
      input.amountMicros <= 0
    )
      throw error('invalid_amount', 'amountMicros must be a positive safe integer.', 400);
    if (
      !readable(input.reference, 200) ||
      input.reference.trim() !== input.reference ||
      /^stripe-(?:topup|recharge):/.test(input.reference)
    )
      throw error(
        'invalid_reference',
        'A trimmed non-empty reference (not starting with stripe-topup: or stripe-recharge:) is required.',
        400,
      );
    let note: string | null = null;
    if (input.note !== undefined) {
      if (!readable(input.note, 1000))
        throw error('invalid_note', 'Note must be 1–1000 printable characters.', 400);
      note = input.note;
    }

    return this.transaction(async (client) => {
      const inserted = await client.query<PendingEmailCreditRow>(
        `INSERT INTO mr_pending_email_credits(id,issuer,email,amount_micros,reference,note)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(reference) DO NOTHING
         RETURNING *`,
        [randomUUID(), issuer, email, input.amountMicros, input.reference, note],
      );
      if (inserted.rows[0]) return { credit: formatRow(inserted.rows[0]), created: true };

      const existing = (
        await client.query<PendingEmailCreditRow>(
          'SELECT * FROM mr_pending_email_credits WHERE reference=$1',
          [input.reference],
        )
      ).rows[0];
      if (!existing)
        throw error(
          'pending_credit_conflict',
          'Pending credit reference could not be reconciled.',
          409,
        );
      if (
        existing.issuer !== issuer ||
        existing.email !== email ||
        Number(existing.amount_micros) !== input.amountMicros ||
        (existing.note ?? null) !== note
      )
        throw error(
          'pending_credit_conflict',
          'Reference already used for a different pending email credit.',
          409,
        );
      return { credit: formatRow(existing), created: false };
    });
  }

  /** Operator-only: list pending, claimed, or revoked email credits. */
  async list(
    options: { email?: string; status?: PendingEmailCreditStatus; limit?: number } = {},
  ): Promise<PendingEmailCredit[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.email !== undefined) {
      const normalized = normalizePendingCreditEmail(options.email);
      if (!normalized) throw error('invalid_email', 'Invalid email filter.', 400);
      params.push(normalized);
      clauses.push(`email=$${params.length}`);
    }
    if (options.status === 'pending') clauses.push('claimed_at IS NULL AND revoked_at IS NULL');
    else if (options.status === 'claimed') clauses.push('claimed_at IS NOT NULL');
    else if (options.status === 'revoked') clauses.push('revoked_at IS NOT NULL');
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw error('invalid_limit', 'Limit must be an integer between 1 and 100.', 400);
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query<PendingEmailCreditRow>(
      `SELECT * FROM mr_pending_email_credits ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(formatRow);
  }

  /** Operator-only: revoke an unclaimed pending email credit. Already-claimed credits cannot be revoked. */
  async revoke(id: string): Promise<PendingEmailCredit> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw error('not_found', 'Pending email credit not found.', 404);
    return this.transaction(async (client) => {
      const existing = (
        await client.query<PendingEmailCreditRow>(
          'SELECT * FROM mr_pending_email_credits WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!existing) throw error('not_found', 'Pending email credit not found.', 404);
      if (existing.claimed_at)
        throw error(
          'pending_credit_already_claimed',
          'This pending email credit was already claimed and cannot be revoked.',
          409,
        );
      if (existing.revoked_at) return formatRow(existing);
      const updated = (
        await client.query<PendingEmailCreditRow>(
          `UPDATE mr_pending_email_credits
           SET revoked_at=now()
           WHERE id=$1 AND claimed_at IS NULL AND revoked_at IS NULL
           RETURNING *`,
          [id],
        )
      ).rows[0];
      if (!updated)
        throw error(
          'pending_credit_already_claimed',
          'This pending email credit could not be revoked.',
          409,
        );
      return formatRow(updated);
    });
  }

  /** Atomically claims all unclaimed pending credits matching a verified OIDC email into the
   * user's verified personal workspace. Must only receive a Symbol-branded verified identity. */
  async claimForVerifiedIdentity(
    workspaceId: string,
    verified: VerifiedPendingEmailCreditIdentity,
  ): Promise<PendingEmailCredit[]> {
    if (!verified || verified[verifiedEmailCreditClaim] !== true)
      throw error(
        'verified_email_required',
        'A verified OIDC email claim is required to claim pending credits.',
        403,
      );
    return this.transaction(async (client) => {
      const owned = await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM mr_identities WHERE issuer=$1 AND subject=$2 AND workspace_id=$3',
        [verified.issuer, verified.subject, workspaceId],
      );
      if (!owned.rowCount)
        throw error(
          'pending_credit_identity_mismatch',
          'Verified identity does not match the target personal workspace.',
          403,
        );
      // Acquire the workspace money lock first to match all ledger/billing lock ordering.
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);

      const claimable = (
        await client.query<PendingEmailCreditRow>(
          `SELECT * FROM mr_pending_email_credits
           WHERE issuer=$1 AND email=$2 AND claimed_at IS NULL AND revoked_at IS NULL
           ORDER BY created_at ASC, id ASC
           FOR UPDATE`,
          [verified.issuer, verified.email],
        )
      ).rows;
      if (!claimable.length) return [];

      const claimed: PendingEmailCredit[] = [];
      for (const row of claimable) {
        const updated = (
          await client.query<PendingEmailCreditRow>(
            `UPDATE mr_pending_email_credits
             SET claimed_at=now(), claimed_workspace_id=$2, claimed_subject=$3
             WHERE id=$1 AND claimed_at IS NULL AND revoked_at IS NULL
             RETURNING *`,
            [row.id, workspaceId, verified.subject],
          )
        ).rows[0];
        if (!updated) continue;
        // Ledger reference uses pending-email-credit:<uuid> so it is globally unique
        // and classified as noncash operator credit (never stripe-topup:/stripe-recharge:).
        // Omit raw email PII from mr_ledger.details.
        await this.creditInTransaction(
          client,
          workspaceId,
          Number(updated.amount_micros),
          `pending-email-credit:${updated.id}`,
          {
            source: 'pending-email-credit',
            pendingCreditId: updated.id,
            operatorReference: updated.reference,
          },
        );
        claimed.push(formatRow(updated));
      }
      return claimed;
    });
  }
}
