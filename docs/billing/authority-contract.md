# B2 billing authority and versioned policy contract

2026-11-04. Fixture implementation of B0/core authority review. All defaults,
ceilings, owner enrollment rules and delegated enable/re-enable remain **proposed,
not production-approved section 11.5 policy**. There is no automatic enrollment,
card charge or real mandate activation. No existing administrator, key, session or
grant gains billing authority from this module or from adding scope vocabulary.

## Explicit funding owner and aggregate envelope

`mr_billing_owners` stores one explicit workspace/environment funding approval:
`workspace_id`, `membership_id`, exact `membership_epoch`, `authority_version`,
`processor_environment_id`, `livemode`, bounded `rails`, `consent_reference`, server-proven `approval_reference`
and revocation timestamps. This is separate from the existing admin/member role.

`readBillingOwnerInTransaction(client, workspaceId): Promise<BillingOwner|null>`
is the internal worker gate. The caller already holds workspace `FOR UPDATE`.
The helper checks active approval, current accepted membership, exact acceptance
epoch, admin role and revocation using the same client. Missing/stale/revoked
approval means no new billing capability or recharge admission. Ordinary workspace
admin, bootstrap bearer, API-key-backed cookie, OAuth grant or external issuer
scope is insufficient. Removing/demoting the approving member, changing their
acceptance epoch or revoking the row stops new admission. Accepted/unknown payments
still reconcile under their original durable authorization.

The optional `approveOwner` constructor callback is the **only** enrollment or
owner-envelope-change seam. No callback means default deny. Root mounts no owner
bootstrap route. Section 11.5 must first choose a trusted out-of-band human funding
approval process; the callback must revalidate the actual verified OIDC browser
source/membership and explicit approval, then return the current principal and an
approval reference. Its return value is never accepted from request JSON.
`establishOwner(actor,{expectedAuthorityVersion,rails,processorEnvironmentId,livemode,consentReference})`
requires that callback, current browser source/identity, exact member epoch and
explicit approval for the registered processor environment.
The owner version and audit record commit atomically. Tests may seed an explicit
approved owner record or inject a named trusted fixture approval. A generic admin
click, `consent:true` or actor boolean does not enroll an owner.

All humans and delegates share **one aggregate workspace funding envelope**.
Every policy edit must fit it, including the approved owner’s own edits. Changing
the envelope requires explicit approval and a new authority version. Lowering it
does not rewrite accepted/unknown exposure, historic attempts or generation caps;
new admission must report over-cap/stale state and stop. Multiple delegates do not
multiply amount/count limits.

`BillingDelegationRails` contains:

```ts
interface BillingDelegationRails {
  allowsEnabled: boolean;
  maxThresholdMicros: number;
  maxAmountCents: number;
  maxMonthlyCapCents: number;
  maxAttemptsPerMonth: number;
  minCooldownSeconds: number;
  maxFailureLimit: number;
}
```

Missing `allowsEnabled` parses to restrictive **false**. Both aggregate owner
approval and delegated rails must explicitly allow enabling; otherwise the agent
cannot enable/re-enable. Numeric settings remain bounded even when disabled.
A delegated row snapshots `ownerAuthorityVersion`. Any owner revision requires
explicit reapproval of stale delegated rails before further agent edits. Human
delegation creation/change/revocation additionally requires the **same explicitly
approved funding member**, not just another administrator.

## Policy, defaults and B4 snapshot

Exports from `packages/engine/src/billing-policy.ts` include `BillingPolicyStore`,
`BillingPolicyError`, `BillingPolicyValues`, `BillingPolicy`, `BillingOwner`,
`BillingOwnerApprovalCallback`, `BillingPrincipal`, `BillingScope`,
`BillingAuthorityCallback`, `BillingPolicyAuthority`, `BillingDelegationTarget`,
`BillingDelegationRails`, `BillingDelegation`, `BILLING_POLICY_DEFAULTS`,
`BILLING_POLICY_LIMITS`, parsers, `readBillingPolicyInTransaction` and
`readBillingOwnerInTransaction`.

```ts
interface BillingPolicyValues {
  enabled: boolean;
  thresholdMicros: number;
  amountCents: number;
  monthlyCapCents: number;
  maxAttemptsPerMonth: number;
  cooldownSeconds: number;
  failureLimit: number;
  mandateId: string | null;
}
interface BillingPolicy extends BillingPolicyValues {
  workspaceId: string;
  version: number;
  ownerAuthorityVersion: number | null;
  updatedAt: string | null;
}
```

The proposed virtual default is disabled, $5 threshold, $25 reload, $100 automatic
monthly funding cap, four attempts/month, 24-hour cooldown and three failures. No
mandate, policy row or authority is inferred from this default. Reads create no
rows, trigger no charges and do not grant access without explicit owner approval.
Hard engineering bounds are $5–$1,000 reloads; aggregate monthly cap at most
$100,000; at most 10,000 attempts/month; cooldown 60 seconds–31 days; at most 100
failures; threshold at most $1,000,000. All are exact finite safe integers and not
merchant/customer authorization. Owner/delegate ceilings may be much lower.

`readBillingPolicyInTransaction(client, workspaceId)` performs one SELECT and
returns the disabled version-zero virtual default if no row exists. It is
internal and side-effect free. Before a B4 charge intent, read/revalidate the
current owner and policy under workspace `FOR UPDATE`; require
`policy.ownerAuthorityVersion === owner.authorityVersion`, fit policy values to
all current owner rails including `allowsEnabled`, and validate current mandate,
environment, hold, available balance, monthly pending/unknown/succeeded exposure,
attempt count, cooldown/failure state and unique in-flight admission. Persist
policy/owner/mandate versions and original UTC funding month before external I/O.
No policy/top-up change resets generation key spending exposure.

## Final-lock source and delegated authority

The constructor also requires `revalidateAuthority(client, actor, requiredScope)`.
The store first locks workspace `FOR UPDATE`. The callback must use only that
transaction client; never connect, commit or perform network I/O. Root extends
`revalidateGovernanceAuthority` to the new narrow scopes, rechecking current source
key/secret version/expiry, accepted member, grant/client/resource/source tuple,
exact consented scopes and original access expiry. An authenticated snapshot,
request scope or role claim alone is insufficient.

The module intersects scopes with the authenticated snapshot, checks stable
source/workspace identity and both original/current expiry, rejects bootstrap and
external JWT billing, and loads fresh membership epoch for audit. Owner and
delegation records are checked inside the same transaction. A removed member,
revoked/rotated key, reduced grant/scope/ceiling or new owner version defeats a
previously authenticated pending mutation. Initial default OAuth remains read
and generate; adding the supported scope vocabulary cannot widen refresh,
consent, generic child-key creation, admin invites, browser or bootstrap defaults.

`authorizeInTransaction(client, actor, scope, expectedAuthorityVersion?)` is the
shared same-client B3 gate. It returns `{principal,owner,delegation,
humanMembershipId?}`. The optional human ID exists only for the active explicitly
approved funding owner. B3 uses it for signed setup/mandate actions and its selected
history/portal policy; delegated management never silently means customer/card
replacement. It never opens a nested transaction.

Both `billing:read` and `billing:manage` require current explicit scopes plus an
active owner-bound delegation for agents. Management does not imply reading
history. Targets are stable API-key or native-grant UUIDs in the same workspace.
Source-key OAuth may inherit its key delegation if there is no grant-specific
row; an explicit revoked/narrower grant row overrides it. Delegates cannot set
mandate/customer/environment, create/raise their own rails, regrant a revoked
capability, grant another delegate or manufacture human consent. Their policy
audit uses the existing human-approved consent reference and delegation revision.

## Versioning, mandate and audit

Policy update requires
`{expectedVersion,expectedAuthorityVersion,policy,consentReference?}`. Delegation
set requires both expected versions plus `target,permissions,rails,consentReference`.
Revoke takes target, delegation version, consent reference and expected owner
version. Stale policy/delegation/owner state returns 409 with no mutation or audit
commit. After a lost response, read/review current state rather than automatically
retrying against newer limits.

Only the approved human funding member may initially bind or change a policy
mandate. It requires a bounded consent reference and actual B3 owned active
mandate in the same environment and with the exact current owner authority
version, consent reference and accepted-member epoch frozen by setup. B3 signed setup completion, not that string or an
agent boolean, establishes card authorization. An old revoked mandate can remain
on a disabled policy so disabling is always possible. B4 separately rechecks the
current mandate before new dispatch; accepted/unknown attempts still reconcile.

Mutation and immutable `mr_billing_policy_audit` commit together. Audit includes
stable source key/secret version, member/acceptance epoch, grant/client/resource,
before/after policy and owner versions/settings, consent and applicable delegated
limits. No raw tokens, cookies, cards, arbitrary payment/provider payloads or
customer generation data are stored. Owner approval changes are audited separately.

The unnumbered `docs/billing/policy-schema.sql` is B2-only schema for core-owned
slot 023; core adds B3 mandate FK in 024. It changes no 001–021 migration, default
scope, legacy order, generation cap or current balance. Numbering/loader/upgrade
qualification remain with core. All writers use workspace-before-owner/member/
delegation/mandate locks; any installation quota needed by recharge comes **before**
workspace. No policy writer acquires installation quota after workspace.

## Typed HTTP/MCP proposals (root integrates)

| Operation                    | HTTP                             | Authority and financial effects                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.policy.get`         | `GET /v1/billing/policy`         | Explicit `billing:read` plus owner/delegation. Read-only private policy; never charges, enqueues or creates rows.                                                                                                                                              |
| `billing.policy.update`      | `PATCH /v1/billing/policy`       | Explicit `billing:manage`, current owner version and all rails. Financially effective: enabling/configuring can permit future saved-method charges within mandate/envelope. No arbitrary immediate charge. Accepted attempts may still complete after disable. |
| `billing.delegations.set`    | `PUT /v1/billing/delegations`    | Approved human funding owner and exact owner/delegation versions. Changes delegated financial authority; outside agent/MCP allowlist.                                                                                                                          |
| `billing.delegations.revoke` | `DELETE /v1/billing/delegations` | Approved funding owner only. The body names the target kind and ID, expected owner/delegation versions and consent reference. Stops future agent edits while preserving policy, accepted attempts and history.                                                 |

Schemas are closed and require all policy fields with explicit microUSD versus USD
cent units, integer versions and owned mandate UUID/null. Never accept actor,
owner proof, workspace authority, Stripe customer/method objects or delegated
ceilings in the ordinary policy request. No owner enrollment endpoint is mounted
or exposed to MCP. Section 11.5 must authorize its real approval mechanism first.

MCP get is read-only. Update is explicitly financially effective, optimistic and
not advertised as harmless/read-only. 409 requires review; a retry must not silently
accept a newer envelope. Recharge/balance/status/schema/quote remain read-only
and never trigger charging. Cookie routes preserve exact Origin plus private
workspace/recovery scope binding; API/native OAuth use deliberate narrow authority
without weakening the human setup paths. Session logout/switch cancellation needs
the core session-lock contract; this module does not claim to revalidate a raw
session-cookie row under workspace locks.

## Evidence and remaining qualification

Pure parsers/defaults pass. SQL fixtures cover ordinary and generic-admin denial,
default-deny enrollment, explicit approved owner/epoch/environment, aggregate and
delegate ceilings, disabled-by-default enable permission, owner-version staleness,
current key/member/grant revocation, OAuth attribution and no-token audit. Native
cases cover simultaneous expected-version updates and revocation while queued
behind the final workspace lock. Root schedules SQL serially; PGlite is not native
lock evidence. Shared default-scope/OAuth/session/HTTP/MCP integration and actual
OIDC/Stripe/production approval are separate gates.
