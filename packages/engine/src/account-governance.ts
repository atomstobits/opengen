import { randomBytes, randomUUID } from 'node:crypto';
import { keyScopes, type KeyScope } from '@media-router/contracts';
import { tokenHash } from './accounts.js';
import { loadBoundRoutingPolicy } from './routing-governance.js';
import type { Pool, PoolClient } from 'pg';
import {
  requireGovernanceAdmin,
  rotateKeySecretInTransaction,
  type GovernancePrincipal,
} from './governance-authority.js';
import { KeyBudgetStore, utcAdmissionMonth } from './key-budgets.js';

const invalid = (message: string) =>
  Object.assign(new Error(message), { code: 'invalid_key_update', statusCode: 400 });
/** Account-domain adapter. Every mutation checks current authority and commits once;
 * no caller-controlled workspace, principal IDs, token hashes or usage counters. */
export class AccountGovernanceStore {
  private readonly budgets = new KeyBudgetStore();
  constructor(readonly pool: Pool) {}
  private async transaction<T>(
    actor: GovernancePrincipal,
    operation: (client: PoolClient, current: GovernancePrincipal) => Promise<T>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await requireGovernanceAdmin(client, actor);
      const result = await operation(client, current);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async createKey(
    actor: GovernancePrincipal,
    input: {
      name: string;
      scopes: KeyScope[];
      policyId?: string;
      expiresAt?: string;
      monthlyCapMicros?: number;
    },
  ) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(input.name)
    )
      throw invalid('Use a readable key name of 1–80 characters.');
    if (
      !Array.isArray(input.scopes) ||
      !input.scopes.length ||
      input.scopes.some((scope) => !keyScopes.includes(scope))
    )
      throw invalid('Use known key scopes.');
    if (
      input.monthlyCapMicros !== undefined &&
      (!Number.isSafeInteger(input.monthlyCapMicros) || input.monthlyCapMicros < 0)
    )
      throw invalid('Use nonnegative integer micro-USD.');
    return this.transaction(actor, async (client, current) => {
      if (input.scopes.some((scope) => !current.scopes.includes(scope)))
        throw Object.assign(new Error('Cannot grant scopes this authority does not hold.'), {
          code: 'policy_denied',
          statusCode: 403,
        });
      if (
        input.expiresAt &&
        (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())
      )
        throw invalid('Key expiry must be in the future.');
      if (input.policyId) await loadBoundRoutingPolicy(client, current.workspaceId, input.policyId);
      const token = `og_sk_${randomBytes(32).toString('hex')}`;
      const row = (
        await client.query(
          `INSERT INTO mr_api_keys(id,workspace_id,name,token_hash,scopes,policy_id,expires_at,membership_id,monthly_cap_micros)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,scopes,policy_id,expires_at,created_at,secret_version`,
          [
            randomUUID(),
            current.workspaceId,
            input.name.trim(),
            tokenHash(token),
            JSON.stringify([...new Set(input.scopes)]),
            input.policyId ?? null,
            input.expiresAt ?? null,
            current.membershipId ?? null,
            input.monthlyCapMicros ?? null,
          ],
        )
      ).rows[0];
      return { ...row, token };
    });
  }
  async revokeKey(actor: GovernancePrincipal, id: string) {
    return this.transaction(actor, async (client, current) => {
      const result = await client.query(
        'UPDATE mr_api_keys SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2 RETURNING id',
        [current.workspaceId, id],
      );
      if (result.rowCount) {
        await client.query('DELETE FROM mr_sessions WHERE workspace_id=$1 AND key_id=$2', [
          current.workspaceId,
          id,
        ]);
        await client.query(
          'UPDATE mr_mcp_oauth_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=$1 AND source_key_id=$2',
          [current.workspaceId, id],
        );
      }
      return Boolean(result.rowCount);
    });
  }
  async listKeys(actor: GovernancePrincipal) {
    return this.transaction(actor, async (client) => {
      const now = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
      const month = utcAdmissionMonth(now);
      const rows = (
        await client.query(
          `SELECT k.id,k.name,k.scopes,k.policy_id,k.expires_at,k.revoked_at,k.created_at,
           k.secret_version,k.rotated_at,k.monthly_cap_micros,k.cap_coverage_started_at,
           coalesce(b.gross_debit_micros,0)::text AS gross_debit_micros,
           coalesce(b.held_micros,0)::text AS held_micros
         FROM mr_api_keys k LEFT JOIN mr_key_months b ON b.workspace_id=k.workspace_id
           AND b.key_id=k.id AND b.admission_month=$2
         WHERE k.workspace_id=$1 AND k.key_kind='api' ORDER BY k.created_at DESC,k.id DESC`,
          [actor.workspaceId, month],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        scopes: row.scopes,
        policyId: row.policy_id,
        expiresAt: row.expires_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        secretVersion: row.secret_version,
        rotatedAt: row.rotated_at?.toISOString() ?? null,
        monthlyCapMicros: row.monthly_cap_micros === null ? null : Number(row.monthly_cap_micros),
        coverageStartedAt: row.cap_coverage_started_at.toISOString(),
        admissionMonth: month,
        grossDebitMicros: Number(row.gross_debit_micros),
        heldMicros: Number(row.held_micros),
        legacyCoverage: 'since_cutover' as const,
      }));
    });
  }
  async updateKey(
    actor: GovernancePrincipal,
    id: string,
    patch: { name?: string; monthlyCapMicros?: number | null },
  ) {
    const fields = Object.keys(patch);
    if (!fields.length || fields.some((field) => !['name', 'monthlyCapMicros'].includes(field)))
      throw invalid('Provide a key name or managed monthly cap.');
    const name = patch.name;
    if (
      name !== undefined &&
      (typeof name !== 'string' ||
        !name.trim() ||
        name.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(name))
    )
      throw invalid('Key name must contain 1–80 readable characters.');
    const cap = patch.monthlyCapMicros;
    if (cap !== undefined && cap !== null && (!Number.isSafeInteger(cap) || cap < 0))
      throw invalid('Monthly cap must be nonnegative integer micro-USD or null.');
    return this.transaction(actor, async (client) => {
      const key = (
        await client.query(
          "SELECT id,name,monthly_cap_micros FROM mr_api_keys WHERE workspace_id=$1 AND id=$2 AND key_kind='api' FOR UPDATE",
          [actor.workspaceId, id],
        )
      ).rows[0];
      if (!key)
        throw Object.assign(new Error('Key unavailable.'), {
          code: 'key_unavailable',
          statusCode: 404,
        });
      if (name !== undefined)
        await client.query('UPDATE mr_api_keys SET name=$3 WHERE workspace_id=$1 AND id=$2', [
          actor.workspaceId,
          id,
          name.trim(),
        ]);
      if (cap !== undefined)
        await this.budgets.setCapInTransaction(client, actor.workspaceId, id, cap);
      return {
        id,
        name: name?.trim() ?? key.name,
        monthlyCapMicros:
          cap === undefined
            ? key.monthly_cap_micros === null
              ? null
              : Number(key.monthly_cap_micros)
            : cap,
      };
    });
  }
  async rotateKey(actor: GovernancePrincipal, id: string, expectedSecretVersion: number) {
    return this.transaction(actor, (client) =>
      rotateKeySecretInTransaction(client, actor, id, expectedSecretVersion),
    );
  }
}
