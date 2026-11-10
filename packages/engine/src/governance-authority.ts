import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  keyScopes,
  type GenerationMetadata,
  type JobAttribution,
  type KeyScope,
} from '@media-router/contracts';
import { type Principal, tokenHash } from './accounts.js';
import { intersectRoutingPolicies, type GovernedRoutingPolicy } from './routing-governance.js';

/** Only authentication code constructs this value. Never parse it from a request body. */
export interface GovernancePrincipal extends Principal {
  /** Stable source API key, including key-derived OAuth. Browser keys are short-lived sessions. */
  keySecretVersion?: number;
  grantId?: string;
  clientId?: string;
  oauthResource?: string;
  /** Set only by the verified external JWT adapter; native grants must retain their tuple. */
  externalOAuth?: true;
  /** Authentication/token expiry, separate from longer-lived source key/grant expiry. */
  authorityExpiresAt?: string;
  monthlyCapMicros?: number;
  policy?: GovernedRoutingPolicy;
}
export interface TrustedJobAttribution extends JobAttribution {
  clientId: string | null;
}
const denied = (message = 'Authorization is no longer valid for this workspace.') =>
  Object.assign(new Error(message), { code: 'policy_denied', statusCode: 403 });
const invalidMetadata = () =>
  Object.assign(new Error('Metadata permits a bounded project and up to 16 string tags.'), {
    code: 'invalid_metadata',
    statusCode: 400,
  });
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const label = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** Private broker metadata, not model input or authority. Sorted keys make idempotency stable. */
export function parseGenerationMetadata(value: unknown): GenerationMetadata {
  if (value === undefined) return {};
  if (!plain(value) || Object.keys(value).some((key) => key !== 'project' && key !== 'tags'))
    throw invalidMetadata();
  const result: GenerationMetadata = {};
  if (value.project !== undefined) {
    if (!label(value.project, 80)) throw invalidMetadata();
    result.project = value.project;
  }
  if (value.tags !== undefined) {
    if (!plain(value.tags) || Object.keys(value.tags).length > 16) throw invalidMetadata();
    const entries = Object.entries(value.tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (
      entries.some(
        ([key, item]) =>
          !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
          !label(item, 160) ||
          ['__proto__', 'prototype', 'constructor'].includes(key),
      )
    )
      throw invalidMetadata();
    if (entries.length) result.tags = Object.fromEntries(entries) as Record<string, string>;
  }
  return result;
}

/** Legacy unknown remains unknown. Labels and caller metadata never participate. */
export function attributionForPrincipal(actor?: GovernancePrincipal): TrustedJobAttribution {
  return {
    kind: !actor ? 'unknown' : actor.bootstrap ? 'bootstrap' : (actor.keyKind ?? 'unknown'),
    keyId: actor?.keyId ?? null,
    membershipId: actor?.membershipId ?? null,
    grantId: actor?.grantId ?? null,
    clientId: actor?.clientId ?? null,
  };
}

async function lockWorkspace(client: PoolClient, workspaceId: string) {
  if (
    !(await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]))
      .rowCount
  )
    throw denied();
}

async function currentKey(
  client: PoolClient,
  actor: GovernancePrincipal,
  id: string,
): Promise<GovernancePrincipal> {
  // Workspace lock comes first; the row lock also serializes older direct revocation paths.
  const row = (
    await client.query(
      `SELECT k.*,p.policy,p.max_cost_micros,p.archived_at,
       m.role,m.removed_at,m.accepted_at,m.issuer,m.subject
     FROM mr_api_keys k LEFT JOIN mr_policies p ON p.id=k.policy_id AND p.workspace_id=k.workspace_id
     LEFT JOIN mr_memberships m ON m.id=k.membership_id AND m.workspace_id=k.workspace_id
     WHERE k.id=$1 AND k.workspace_id=$2 FOR UPDATE OF k`,
      [id, actor.workspaceId],
    )
  ).rows[0];
  if (
    !row ||
    row.revoked_at ||
    row.archived_at ||
    (row.expires_at && row.expires_at <= new Date()) ||
    (row.policy_id && row.policy === null) ||
    (row.membership_id &&
      (!row.accepted_at || row.removed_at || !['admin', 'member'].includes(row.role)))
  )
    throw denied();
  const scopes: KeyScope[] =
    row.key_kind === 'browser' && row.membership_id
      ? row.role === 'admin'
        ? [...keyScopes]
        : ['read', 'generate']
      : row.role === 'member'
        ? row.scopes.filter((scope: KeyScope) => scope === 'read' || scope === 'generate')
        : row.scopes;
  return {
    workspaceId: row.workspace_id,
    keyId: row.id,
    keyKind: row.key_kind,
    keySecretVersion: row.secret_version,
    scopes,
    ...(row.policy === null ? {} : { policy: row.policy }),
    ...(row.max_cost_micros === null ? {} : { maxCostMicros: Number(row.max_cost_micros) }),
    ...(row.monthly_cap_micros == null ? {} : { monthlyCapMicros: Number(row.monthly_cap_micros) }),
    ...(row.membership_id
      ? {
          membershipId: row.membership_id,
          role: row.role,
          identity: { issuer: row.issuer, subject: row.subject },
        }
      : {}),
  };
}

/** Caller owns BEGIN/COMMIT and the workspace reservation. No pool checkout or external I/O. */
export async function revalidateGovernanceAuthority(
  client: PoolClient,
  actor: GovernancePrincipal,
  /** Null is identity-only session exchange; generation/admin callers retain their required scopes. */
  requiredScope: KeyScope | null = 'generate',
): Promise<GovernancePrincipal> {
  await lockWorkspace(client, actor.workspaceId);
  if (
    actor.authorityExpiresAt !== undefined &&
    (!Number.isFinite(Date.parse(actor.authorityExpiresAt)) ||
      Date.parse(actor.authorityExpiresAt) <= Date.now())
  )
    throw denied();
  if (actor.bootstrap) {
    if (
      (requiredScope !== null && !actor.scopes.includes(requiredScope)) ||
      actor.policy ||
      actor.maxCostMicros !== undefined ||
      actor.monthlyCapMicros !== undefined
    )
      throw denied();
    return actor;
  }
  let current: GovernancePrincipal;
  if (actor.keyKind === 'oauth') {
    if (actor.externalOAuth) {
      if (
        !actor.membershipId ||
        !actor.identity ||
        !actor.authorityExpiresAt ||
        actor.keyId ||
        actor.grantId ||
        actor.clientId ||
        actor.oauthResource
      )
        throw denied();
      const member = (
        await client.query(
          `SELECT * FROM mr_memberships WHERE id=$1 AND workspace_id=$2 FOR SHARE`,
          [actor.membershipId, actor.workspaceId],
        )
      ).rows[0];
      if (
        !member ||
        !member.accepted_at ||
        member.removed_at ||
        !['admin', 'member'].includes(member.role) ||
        member.issuer !== actor.identity.issuer ||
        member.subject !== actor.identity.subject
      )
        throw denied();
      current = {
        workspaceId: actor.workspaceId,
        keyKind: 'oauth',
        externalOAuth: true,
        membershipId: member.id,
        identity: { issuer: member.issuer, subject: member.subject },
        role: member.role,
        scopes: member.role === 'admin' ? [...keyScopes] : ['read', 'generate'],
      };
    } else {
      if (!actor.grantId || !actor.clientId || !actor.oauthResource) throw denied();
      const grant = (
        await client.query(
          'SELECT * FROM mr_mcp_oauth_grants WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [actor.grantId, actor.workspaceId],
        )
      ).rows[0];
      if (
        !grant ||
        grant.revoked_at ||
        grant.expires_at <= new Date() ||
        grant.client_id !== actor.clientId ||
        grant.resource !== actor.oauthResource
      )
        throw denied();
      // A sourced grant always follows its source key even when it also records a member.
      current = grant.source_key_id
        ? await currentKey(client, actor, grant.source_key_id)
        : { workspaceId: actor.workspaceId, scopes: ['read', 'generate'] };
      if (!grant.source_key_id && !grant.membership_id) throw denied();
      if (grant.membership_id) {
        const member = (
          await client.query(
            `SELECT *,extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships
         WHERE id=$1 AND workspace_id=$2 FOR SHARE`,
            [grant.membership_id, actor.workspaceId],
          )
        ).rows[0];
        if (
          !member ||
          !member.accepted_at ||
          member.removed_at ||
          member.epoch !== grant.membership_epoch ||
          !['admin', 'member'].includes(member.role) ||
          (current.membershipId && current.membershipId !== member.id)
        )
          throw denied();
        current = {
          ...current,
          membershipId: member.id,
          role: member.role,
          identity: { issuer: member.issuer, subject: member.subject },
        };
        if (member.role === 'member')
          current.scopes = current.scopes.filter(
            (scope) => scope === 'read' || scope === 'generate',
          );
      }
      if (
        (actor.keyId ?? null) !== (grant.source_key_id ?? null) ||
        (actor.membershipId ?? null) !== (current.membershipId ?? null)
      )
        throw denied();
      current = {
        ...current,
        keyKind: 'oauth',
        grantId: grant.id,
        clientId: grant.client_id,
        oauthResource: grant.resource,
        scopes: current.scopes.filter((scope) => grant.scopes.includes(scope)),
        policy: intersectRoutingPolicies(current.policy, grant.policy_snapshot ?? undefined),
        maxCostMicros: minimum(
          current.maxCostMicros,
          grant.max_cost_micros === null ? undefined : Number(grant.max_cost_micros),
        ),
      };
    }
  } else {
    if (!actor.keyId || actor.keySecretVersion === undefined) throw denied();
    current = await currentKey(client, actor, actor.keyId);
    if (
      actor.keySecretVersion !== current.keySecretVersion ||
      actor.keyKind !== current.keyKind ||
      (actor.membershipId ?? null) !== (current.membershipId ?? null)
    )
      throw denied();
  }
  current.scopes = current.scopes.filter((scope) => actor.scopes.includes(scope));
  if (actor.authorityExpiresAt !== undefined) current.authorityExpiresAt = actor.authorityExpiresAt;
  current.policy = intersectRoutingPolicies(current.policy, actor.policy);
  current.maxCostMicros = minimum(current.maxCostMicros, actor.maxCostMicros);
  current.monthlyCapMicros = minimum(current.monthlyCapMicros, actor.monthlyCapMicros);
  if (requiredScope !== null && !current.scopes.includes(requiredScope)) throw denied();
  return current;
}
const minimum = (...values: (number | undefined)[]) => {
  const numbers = values.filter((value): value is number => value !== undefined);
  return numbers.length ? Math.min(...numbers) : undefined;
};

/** Must be called inside the mutation transaction, before changing keys or policies. */
export async function requireGovernanceAdmin(
  client: PoolClient,
  actor: GovernancePrincipal,
  scope: 'keys:write' | 'policies:write' = 'keys:write',
): Promise<GovernancePrincipal> {
  const current = await revalidateGovernanceAuthority(client, actor, scope);
  if (
    current.policy ||
    current.maxCostMicros !== undefined ||
    current.monthlyCapMicros !== undefined ||
    (current.membershipId && current.role !== 'admin')
  )
    throw denied('Use an unrestricted active workspace administrator to manage governance.');
  return current;
}

/** Stable ID and cap subject survive. The one-time secret is returned only after caller commits. */
export async function rotateKeySecretInTransaction(
  client: PoolClient,
  actor: GovernancePrincipal,
  keyId: string,
  expectedSecretVersion: number,
): Promise<{ id: string; token: string; secretVersion: number }> {
  await requireGovernanceAdmin(client, actor);
  const key = (
    await client.query(
      `SELECT id,key_kind,secret_version FROM mr_api_keys
     WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR UPDATE`,
      [keyId, actor.workspaceId],
    )
  ).rows[0];
  if (!key || key.key_kind !== 'api')
    throw denied('An active API key in this workspace is required.');
  if (!Number.isSafeInteger(expectedSecretVersion) || key.secret_version !== expectedSecretVersion)
    throw Object.assign(new Error('The key changed. Refresh its metadata before rotating again.'), {
      code: 'key_rotation_conflict',
      statusCode: 409,
    });
  if (key.secret_version >= 2147483647) throw denied('Key rotation limit reached.');
  const token = `og_sk_${randomBytes(32).toString('hex')}`;
  const changed = (
    await client.query(
      `UPDATE mr_api_keys SET token_hash=$3,secret_version=secret_version+1,rotated_at=clock_timestamp()
     WHERE id=$1 AND workspace_id=$2 RETURNING secret_version`,
      [keyId, actor.workspaceId, tokenHash(token)],
    )
  ).rows[0];
  // A previously derived browser session or OAuth token cannot outlive deliberate rotation.
  await client.query('DELETE FROM mr_sessions WHERE key_id=$1 AND workspace_id=$2', [
    keyId,
    actor.workspaceId,
  ]);
  await client.query(
    'UPDATE mr_mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE source_key_id=$1 AND workspace_id=$2',
    [keyId, actor.workspaceId],
  );
  return { id: keyId, token, secretVersion: changed.secret_version };
}
