import type { Pool, PoolClient } from 'pg';
import { keyScopes, type KeyScope } from '@media-router/contracts';
import type { Principal } from './accounts.js';
import {
  BillingPolicyError,
  readBillingOwnerInTransaction,
  type BillingOwner,
  type BillingPrincipal,
  type BillingScope,
} from './billing-policy.js';
import { revalidateGovernanceAuthority } from './governance-authority.js';

const billingScopes: readonly BillingScope[] = ['billing:read', 'billing:manage'];
const denied = () =>
  new BillingPolicyError(
    'billing_access_denied',
    'Current explicit billing authority is required.',
    403,
  );

// This marker binds a request to its verified transport and the authority it saw.
// A durable hosted setup needs its own validation of the stored setup and owner.
const proof = Symbol('billing authority');
interface BillingProof {
  source: Principal;
  browserSession: boolean;
  owner: BillingOwner;
  delegationVersion: number | null;
  membershipEpoch: string | undefined;
  permissions: readonly BillingScope[];
}
type ProjectedPrincipal = BillingPrincipal & { [proof]: BillingProof };

function projected(snapshot: BillingProof): ProjectedPrincipal {
  return {
    ...snapshot.source,
    scopes: [...snapshot.source.scopes, ...snapshot.permissions],
    membershipEpoch: snapshot.membershipEpoch,
    [proof]: snapshot,
  };
}

function target(actor: Principal, browserSession: boolean) {
  if (actor.bootstrap || actor.externalOAuth) throw denied();
  if (browserSession) {
    if (actor.keyKind !== 'browser' || !actor.keyId || !actor.membershipId || !actor.identity)
      throw denied();
    return { kind: 'owner', id: actor.membershipId } as const;
  }
  if (
    actor.keyKind === 'api' &&
    actor.keyId &&
    !actor.grantId &&
    !actor.clientId &&
    !actor.oauthResource
  )
    return { kind: 'key', id: actor.keyId } as const;
  if (
    actor.keyKind === 'oauth' &&
    actor.grantId &&
    actor.clientId &&
    actor.oauthResource &&
    actor.authorityExpiresAt
  )
    return { kind: 'grant', id: actor.grantId } as const;
  throw denied();
}

function assertSameSource(expected: BillingPrincipal, actual: BillingPrincipal) {
  for (const field of [
    'workspaceId',
    'keyKind',
    'keyId',
    'keySecretVersion',
    'membershipId',
    'grantId',
    'clientId',
    'oauthResource',
    'authorityExpiresAt',
    'bootstrap',
    'externalOAuth',
  ] as const) {
    if (expected[field] !== actual[field]) throw denied();
  }
  if (
    expected.identity?.issuer !== actual.identity?.issuer ||
    expected.identity?.subject !== actual.identity?.subject
  )
    throw denied();
}

async function currentProof(
  client: PoolClient,
  actor: Principal,
  browserSession: boolean,
): Promise<BillingProof> {
  const selected = target(actor, browserSession);
  const current = await revalidateGovernanceAuthority(client, actor, null);
  // Native grant revalidation also has to retain its original source key version.
  assertSameSource(actor, current);
  const source = {
    ...current,
    scopes: current.scopes.filter((scope) => keyScopes.includes(scope)),
  };
  if (!source.scopes.length) throw denied();
  const owner = await readBillingOwnerInTransaction(client, source.workspaceId);
  if (!owner) throw denied();

  let membershipEpoch: string | undefined;
  if (source.membershipId) {
    const member = (
      await client.query<{ epoch: string }>(
        `SELECT extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships
         WHERE workspace_id=$1 AND id=$2 AND issuer=$3 AND subject=$4
           AND accepted_at IS NOT NULL AND removed_at IS NULL FOR SHARE`,
        [
          source.workspaceId,
          source.membershipId,
          source.identity?.issuer,
          source.identity?.subject,
        ],
      )
    ).rows[0];
    if (!member) throw denied();
    membershipEpoch = member.epoch;
  }
  if (selected.kind === 'owner') {
    if (
      source.role !== 'admin' ||
      owner.membershipId !== selected.id ||
      owner.membershipEpoch !== membershipEpoch
    )
      throw denied();
    return {
      source,
      browserSession,
      owner,
      delegationVersion: null,
      membershipEpoch,
      permissions: billingScopes,
    };
  }

  const delegation = (
    await client.query<{ version: number; permissions: BillingScope[] }>(
      `SELECT version,permissions FROM mr_billing_delegations
       WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3
         AND owner_authority_version=$4 AND revoked_at IS NULL FOR SHARE`,
      [source.workspaceId, selected.kind, selected.id, owner.authorityVersion],
    )
  ).rows[0];
  const permissions = billingScopes.filter((scope) => delegation?.permissions.includes(scope));
  if (!delegation || !permissions.length) throw denied();
  return {
    source,
    browserSession,
    owner,
    delegationVersion: delegation.version,
    membershipEpoch,
    permissions,
  };
}

/** Use only with the original authenticated principal and verified cookie provenance. */
export async function projectBillingPrincipal(
  pool: Pool,
  principal: Principal,
  browserSession: boolean,
): Promise<BillingPrincipal> {
  // Reject unsupported authentication methods before checking out a connection.
  target(principal, browserSession);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = projected(await currentProof(client, principal, browserSession));
    await client.query('COMMIT');
    return actor;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The caller holds the workspace lock and has verified the original hosted setup. */
export async function projectStoredBillingSetupPrincipal(
  client: PoolClient,
  workspaceId: string,
  setupId: string,
): Promise<BillingPrincipal> {
  const setup = (
    await client.query<{
      authority_snapshot: Partial<BillingPrincipal> | null;
      human_membership_id: string;
      owner_authority_version: number;
      owner_membership_epoch: string;
      owner_consent_reference: string;
      consent_reference: string;
      processor_environment_id: string;
      livemode: boolean;
    }>(
      `SELECT authority_snapshot,human_membership_id,owner_authority_version,owner_membership_epoch,
         owner_consent_reference,consent_reference,processor_environment_id,livemode
       FROM mr_billing_setups WHERE workspace_id=$1 AND id=$2 AND session_id IS NOT NULL
         AND status IN ('pending','open') FOR SHARE`,
      [workspaceId, setupId],
    )
  ).rows[0];
  const stored = setup?.authority_snapshot;
  if (
    !setup ||
    !stored ||
    setup.consent_reference !== `billing-setup:${setupId}` ||
    stored.workspaceId !== workspaceId ||
    stored.keyKind !== 'browser' ||
    stored.role !== 'admin' ||
    stored.bootstrap ||
    stored.externalOAuth ||
    stored.grantId ||
    stored.clientId ||
    stored.oauthResource ||
    typeof stored.keyId !== 'string' ||
    !Number.isSafeInteger(stored.keySecretVersion) ||
    stored.membershipId !== setup.human_membership_id ||
    typeof stored.identity?.issuer !== 'string' ||
    typeof stored.identity?.subject !== 'string' ||
    !Array.isArray(stored.scopes) ||
    !stored.scopes.includes('billing:manage')
  )
    throw denied();

  const snapshot = await currentProof(
    client,
    {
      workspaceId,
      keyKind: 'browser',
      keyId: stored.keyId,
      keySecretVersion: stored.keySecretVersion,
      membershipId: stored.membershipId,
      identity: stored.identity,
      authorityExpiresAt: stored.authorityExpiresAt,
      scopes: stored.scopes.filter((scope): scope is KeyScope =>
        keyScopes.includes(scope as KeyScope),
      ),
    },
    true,
  );
  const owner = snapshot.owner;
  if (
    owner.authorityVersion !== setup.owner_authority_version ||
    owner.membershipEpoch !== setup.owner_membership_epoch ||
    owner.consentReference !== setup.owner_consent_reference ||
    owner.processorEnvironmentId !== setup.processor_environment_id ||
    owner.livemode !== setup.livemode
  )
    throw denied();
  return projected({
    ...snapshot,
    permissions: snapshot.permissions.filter((scope) => stored.scopes!.includes(scope)),
  });
}

/** Caller owns the transaction and workspace lock. Source and billing checks use that client. */
export async function revalidateBillingAuthority(
  client: PoolClient,
  actor: BillingPrincipal,
  requiredScope: BillingScope,
): Promise<BillingPrincipal> {
  const snapshot = (actor as Partial<ProjectedPrincipal>)[proof];
  if (
    !snapshot ||
    !snapshot.permissions.includes(requiredScope) ||
    !actor.scopes.includes(requiredScope)
  )
    throw denied();
  assertSameSource(snapshot.source, actor);
  const current = await currentProof(client, snapshot.source, snapshot.browserSession);
  if (
    current.owner.authorityVersion !== snapshot.owner.authorityVersion ||
    current.delegationVersion !== snapshot.delegationVersion ||
    current.membershipEpoch !== snapshot.membershipEpoch ||
    actor.membershipEpoch !== snapshot.membershipEpoch ||
    !current.permissions.includes(requiredScope)
  )
    throw denied();
  const verified: ProjectedPrincipal = {
    ...current.source,
    scopes: [
      ...current.source.scopes,
      ...current.permissions.filter((scope) => snapshot.permissions.includes(scope)),
    ].filter((scope) => actor.scopes.includes(scope)),
    membershipEpoch: current.membershipEpoch,
    [proof]: snapshot,
  };
  return verified;
}
