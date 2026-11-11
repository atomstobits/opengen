import type { PoolClient } from 'pg';
import type { BillingPolicyAuthority } from '../../../packages/engine/src/billing-policy.js';
import {
  currentHumanTermsPolicy,
  HUMAN_TERMS_NOTICE_VERSION,
  type HumanTermsPolicy,
} from './terms-login.js';

const denied = (reason: 'terms-required' | 'terms-inactive' = 'terms-required') =>
  Object.assign(
    new Error(
      reason === 'terms-inactive'
        ? 'An active current human Terms policy is required before adding funds.'
        : 'Current human Terms assent is required before adding funds.',
    ),
    {
      code:
        reason === 'terms-inactive'
          ? 'current_human_terms_inactive'
          : 'current_human_terms_required',
      statusCode: 403,
    },
  );

function humanIdentity(authority: BillingPolicyAuthority) {
  const { principal, humanMembershipId, owner, delegation } = authority;
  if (
    !humanMembershipId ||
    humanMembershipId !== principal.membershipId ||
    humanMembershipId !== owner.membershipId ||
    principal.workspaceId !== owner.workspaceId ||
    principal.membershipEpoch !== owner.membershipEpoch ||
    !owner.livemode ||
    principal.keyKind !== 'browser' ||
    !principal.keyId ||
    principal.role !== 'admin' ||
    !principal.scopes.includes('billing:manage') ||
    principal.bootstrap ||
    principal.externalOAuth ||
    principal.grantId ||
    principal.clientId ||
    principal.oauthResource ||
    delegation ||
    !principal.identity?.issuer ||
    !principal.identity.subject
  )
    throw denied();
  return { ...principal.identity };
}

function activeSnapshot(readPolicy: () => HumanTermsPolicy): HumanTermsPolicy {
  const policy = readPolicy();
  if (
    policy.status !== 'active' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(policy.version) ||
    !/^[a-f0-9]{64}$/.test(policy.digest) ||
    !policy.effectiveAt ||
    !Number.isFinite(Date.parse(policy.effectiveAt)) ||
    Date.parse(policy.effectiveAt) > Date.now()
  )
    throw denied('terms-inactive');
  // Copy values: a mutable trusted fixture reader must not change our snapshot in place.
  return {
    version: policy.version,
    digest: policy.digest,
    status: policy.status,
    effectiveAt: policy.effectiveAt,
  };
}

function assertSamePolicy(snapshot: HumanTermsPolicy, readPolicy: () => HumanTermsPolicy) {
  const current = activeSnapshot(readPolicy);
  if (
    current.version !== snapshot.version ||
    current.digest !== snapshot.digest ||
    current.status !== snapshot.status ||
    current.effectiveAt !== snapshot.effectiveAt
  )
    throw denied();
}

/** Verifies an OIDC-verified human Terms receipt for the active published policy
 * inside the caller's financial transaction. Neither writes a receipt nor gates
 * accepted-money recovery. */
export async function verifyHumanIdentityTermsReceiptInTransaction(
  client: PoolClient,
  identity: { issuer: string; subject: string },
  readPolicy: () => HumanTermsPolicy = currentHumanTermsPolicy,
): Promise<HumanTermsPolicy> {
  if (!identity.issuer || !identity.subject) throw denied();
  const policy = activeSnapshot(readPolicy);
  const receipt = await client.query(
    `SELECT 1 FROM mr_terms_receipts
     WHERE issuer=$1 AND subject=$2 AND policy_version=$3 AND policy_digest=$4
       AND notice_version=$5 AND action='continue' AND method='oidc-verified'`,
    [identity.issuer, identity.subject, policy.version, policy.digest, HUMAN_TERMS_NOTICE_VERSION],
  );
  assertSamePolicy(policy, readPolicy);
  if (!receipt.rowCount) throw denied();
  return policy;
}

/** New LIVE funding only. The caller supplies the actual current billing:manage
 * proof and reauthorizes on this same financial transaction client. This neither
 * writes a receipt nor makes assent a condition of accepted-money recovery. */
export async function requireCurrentHumanTermsInTransaction(
  client: PoolClient,
  authority: BillingPolicyAuthority,
  reauthorize: () => Promise<BillingPolicyAuthority>,
  readPolicy: () => HumanTermsPolicy = currentHumanTermsPolicy,
): Promise<void> {
  const identity = humanIdentity(authority);
  const source = {
    humanMembershipId: authority.humanMembershipId,
    authorityVersion: authority.owner.authorityVersion,
    keyId: authority.principal.keyId,
    keySecretVersion: authority.principal.keySecretVersion,
    membershipEpoch: authority.principal.membershipEpoch,
  };
  const policy = await verifyHumanIdentityTermsReceiptInTransaction(client, identity, readPolicy);

  // The receipt read is awaited; retain the original verified identity and current
  // human owner rather than treating a historical receipt as funding authority.
  const current = await reauthorize();
  const currentIdentity = humanIdentity(current);
  if (
    currentIdentity.issuer !== identity.issuer ||
    currentIdentity.subject !== identity.subject ||
    current.humanMembershipId !== source.humanMembershipId ||
    current.owner.authorityVersion !== source.authorityVersion ||
    current.principal.keyId !== source.keyId ||
    current.principal.keySecretVersion !== source.keySecretVersion ||
    current.principal.membershipEpoch !== source.membershipEpoch
  )
    throw denied();
  assertSamePolicy(policy, readPolicy);
}
