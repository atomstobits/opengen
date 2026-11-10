import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Explicit opt-in capabilities. Shared auth adapters must not append these to
 * legacy key/default OAuth scopes merely because this union exists. */
export type BillingScope = 'billing:read' | 'billing:manage';
/** Authentication constructs this tuple; never deserialize it from an HTTP body. */
export interface BillingPrincipal {
  workspaceId: string;
  scopes: readonly string[];
  keyKind?: 'api' | 'browser' | 'oauth';
  keyId?: string;
  keySecretVersion?: number;
  membershipId?: string;
  membershipEpoch?: string;
  role?: 'admin' | 'member';
  grantId?: string;
  clientId?: string;
  oauthResource?: string;
  identity?: { issuer: string; subject: string };
  authorityExpiresAt?: string;
  bootstrap?: boolean;
  externalOAuth?: true;
}
/** Must use only this transaction client. Recheck source key/secret version,
 * grant/client/resource, expiry, membership and current scope projections. */
export type BillingAuthorityCallback = (
  client: PoolClient,
  actor: BillingPrincipal,
  requiredScope: BillingScope,
) => Promise<BillingPrincipal>;
export interface BillingPolicyValues {
  enabled: boolean;
  thresholdMicros: number;
  amountCents: number;
  monthlyCapCents: number;
  maxAttemptsPerMonth: number;
  cooldownSeconds: number;
  failureLimit: number;
  mandateId: string | null;
}
export interface BillingPolicy extends BillingPolicyValues {
  workspaceId: string;
  version: number;
  ownerAuthorityVersion: number | null;
  updatedAt: string | null;
}
export interface BillingDelegationRails {
  allowsEnabled: boolean;
  maxThresholdMicros: number;
  maxAmountCents: number;
  maxMonthlyCapCents: number;
  maxAttemptsPerMonth: number;
  minCooldownSeconds: number;
  maxFailureLimit: number;
}
export interface BillingDelegationTarget {
  kind: 'key' | 'grant';
  id: string;
}
export interface BillingDelegation {
  workspaceId: string;
  target: BillingDelegationTarget;
  permissions: BillingScope[];
  ownerAuthorityVersion: number;
  rails: BillingDelegationRails;
  version: number;
  consentReference: string;
  revoked: boolean;
}
export interface BillingPolicyAuthority {
  principal: BillingPrincipal;
  delegation: BillingDelegation | null;
  owner: BillingOwner;
  /** Present only for the active, explicitly approved human funding owner. */
  humanMembershipId?: string;
}
export interface BillingOwner {
  workspaceId: string;
  membershipId: string;
  membershipEpoch: string;
  authorityVersion: number;
  processorEnvironmentId: string;
  livemode: boolean;
  rails: BillingDelegationRails;
  consentReference: string;
  approvalReference: string;
}
/** This approval is server-controlled, never parsed from a request. Default is
 * no callback/no approval. Section 11.5 must choose a real enrollment process. */
export type BillingOwnerApprovalCallback = (
  client: PoolClient,
  actor: BillingPrincipal,
  request: {
    expectedAuthorityVersion: number;
    rails: BillingDelegationRails;
    processorEnvironmentId: string;
    livemode: boolean;
    consentReference: string;
  },
) => Promise<{
  principal: BillingPrincipal;
  approvalReference: string;
  processorEnvironmentId: string;
}>;
/** Proposed fixture defaults/ceilings, not production mandate or product approval.
 * These card-funding caps never reset or replace generation spending caps. */
export const BILLING_POLICY_DEFAULTS: Readonly<BillingPolicyValues> = Object.freeze({
  enabled: false,
  thresholdMicros: 5_000_000,
  amountCents: 2500,
  monthlyCapCents: 10000,
  maxAttemptsPerMonth: 4,
  cooldownSeconds: 86400,
  failureLimit: 3,
  mandateId: null,
});
export const BILLING_POLICY_LIMITS = Object.freeze({
  maxThresholdMicros: 1_000_000_000_000,
  minAmountCents: 500,
  maxAmountCents: 100000,
  maxMonthlyCapCents: 10_000_000,
  maxAttemptsPerMonth: 10000,
  minCooldownSeconds: 60,
  maxCooldownSeconds: 2678400,
  maxFailureLimit: 100,
});
export class BillingPolicyError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
const denied = (message = 'Current explicit billing authority is required.') =>
  new BillingPolicyError('billing_access_denied', message, 403);
const invalid = () =>
  new BillingPolicyError(
    'invalid_billing_policy',
    'Billing settings must use the documented bounded integer fields.',
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
function bounded(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}
function reference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new BillingPolicyError(
      'invalid_consent_reference',
      'A bounded human-approved consent reference is required.',
    );
  return value;
}
function expectedVersion(value: number) {
  if (!bounded(value, 0, 2147483646))
    throw new BillingPolicyError(
      'invalid_policy_version',
      'Supply the current nonnegative policy version.',
    );
}
export function parseBillingPolicyValues(value: unknown): BillingPolicyValues {
  const fields = Object.keys(BILLING_POLICY_DEFAULTS);
  if (
    !plain(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    typeof value.enabled !== 'boolean' ||
    !bounded(value.thresholdMicros, 0, BILLING_POLICY_LIMITS.maxThresholdMicros) ||
    !bounded(
      value.amountCents,
      BILLING_POLICY_LIMITS.minAmountCents,
      BILLING_POLICY_LIMITS.maxAmountCents,
    ) ||
    !bounded(
      value.monthlyCapCents,
      BILLING_POLICY_LIMITS.minAmountCents,
      BILLING_POLICY_LIMITS.maxMonthlyCapCents,
    ) ||
    value.monthlyCapCents < value.amountCents ||
    !bounded(value.maxAttemptsPerMonth, 1, BILLING_POLICY_LIMITS.maxAttemptsPerMonth) ||
    !bounded(
      value.cooldownSeconds,
      BILLING_POLICY_LIMITS.minCooldownSeconds,
      BILLING_POLICY_LIMITS.maxCooldownSeconds,
    ) ||
    !bounded(value.failureLimit, 1, BILLING_POLICY_LIMITS.maxFailureLimit) ||
    !(
      value.mandateId === null ||
      (typeof value.mandateId === 'string' && uuid.test(value.mandateId))
    ) ||
    (value.enabled && value.mandateId === null)
  )
    throw invalid();
  return { ...value } as unknown as BillingPolicyValues;
}
export function parseBillingDelegationRails(value: unknown): BillingDelegationRails {
  if (plain(value) && value.allowsEnabled === undefined) value = { ...value, allowsEnabled: false };
  const fields = [
    'allowsEnabled',
    'maxThresholdMicros',
    'maxAmountCents',
    'maxMonthlyCapCents',
    'maxAttemptsPerMonth',
    'minCooldownSeconds',
    'maxFailureLimit',
  ];
  if (
    !plain(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    typeof value.allowsEnabled !== 'boolean' ||
    !bounded(value.maxThresholdMicros, 0, BILLING_POLICY_LIMITS.maxThresholdMicros) ||
    !bounded(
      value.maxAmountCents,
      BILLING_POLICY_LIMITS.minAmountCents,
      BILLING_POLICY_LIMITS.maxAmountCents,
    ) ||
    !bounded(
      value.maxMonthlyCapCents,
      BILLING_POLICY_LIMITS.minAmountCents,
      BILLING_POLICY_LIMITS.maxMonthlyCapCents,
    ) ||
    value.maxMonthlyCapCents < value.maxAmountCents ||
    !bounded(value.maxAttemptsPerMonth, 1, BILLING_POLICY_LIMITS.maxAttemptsPerMonth) ||
    !bounded(
      value.minCooldownSeconds,
      BILLING_POLICY_LIMITS.minCooldownSeconds,
      BILLING_POLICY_LIMITS.maxCooldownSeconds,
    ) ||
    !bounded(value.maxFailureLimit, 1, BILLING_POLICY_LIMITS.maxFailureLimit)
  )
    throw invalid();
  return { ...value } as unknown as BillingDelegationRails;
}
function target(value: BillingDelegationTarget): BillingDelegationTarget {
  if (
    !plain(value) ||
    Object.keys(value).length !== 2 ||
    !['key', 'grant'].includes(value.kind) ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id)
  )
    throw new BillingPolicyError('invalid_billing_target', 'Supply a stable key or grant UUID.');
  return { kind: value.kind, id: value.id };
}
interface PolicyRow {
  workspace_id: string;
  enabled: boolean;
  threshold_micros: string;
  amount_cents: number;
  monthly_cap_cents: number;
  max_attempts_per_month: number;
  cooldown_seconds: number;
  failure_limit: number;
  mandate_id: string | null;
  owner_authority_version: number;
  version: number;
  updated_at: Date;
}
function policy(row: PolicyRow): BillingPolicy {
  return {
    workspaceId: row.workspace_id,
    enabled: row.enabled,
    thresholdMicros: Number(row.threshold_micros),
    amountCents: row.amount_cents,
    monthlyCapCents: row.monthly_cap_cents,
    maxAttemptsPerMonth: row.max_attempts_per_month,
    cooldownSeconds: row.cooldown_seconds,
    failureLimit: row.failure_limit,
    mandateId: row.mandate_id,
    version: row.version,
    ownerAuthorityVersion: row.owner_authority_version,
    updatedAt: row.updated_at.toISOString(),
  };
}
/** Internal worker snapshot only. Caller already holds workspace FOR UPDATE and
 * must revalidate mandate, risk holds/monthly exposure before admitting a charge.
 * This helper is read-only, opens no transaction and performs no external I/O. */
export async function readBillingPolicyInTransaction(
  client: PoolClient,
  workspaceId: string,
): Promise<BillingPolicy> {
  const row = (
    await client.query<PolicyRow>('SELECT * FROM mr_billing_policies WHERE workspace_id=$1', [
      workspaceId,
    ])
  ).rows[0];
  return row
    ? policy(row)
    : {
        ...BILLING_POLICY_DEFAULTS,
        workspaceId,
        version: 0,
        ownerAuthorityVersion: null,
        updatedAt: null,
      };
}
interface DelegationRow {
  workspace_id: string;
  target_kind: 'key' | 'grant';
  target_id: string;
  permissions: BillingScope[];
  owner_authority_version: number;
  rails: BillingDelegationRails;
  version: number;
  consent_reference: string;
  revoked_at: Date | null;
}
function delegation(row: DelegationRow): BillingDelegation {
  return {
    workspaceId: row.workspace_id,
    target: { kind: row.target_kind, id: row.target_id },
    permissions: row.permissions,
    ownerAuthorityVersion: row.owner_authority_version,
    rails: row.rails,
    version: row.version,
    consentReference: row.consent_reference,
    revoked: row.revoked_at !== null,
  };
}
function browserAdministrator(actor: BillingPrincipal): boolean {
  return (
    actor.keyKind === 'browser' &&
    Boolean(actor.membershipId && actor.identity && actor.keyId) &&
    actor.role === 'admin' &&
    !actor.bootstrap
  );
}
interface OwnerRow {
  workspace_id: string;
  membership_id: string;
  membership_epoch: string;
  authority_version: number;
  processor_environment_id: string;
  livemode: boolean;
  rails: BillingDelegationRails;
  consent_reference: string;
  approval_reference: string;
  revoked_at: Date | null;
  current_epoch: string;
  role: string;
  accepted_at: Date | null;
  removed_at: Date | null;
}
function ownerView(row: OwnerRow): BillingOwner {
  return {
    workspaceId: row.workspace_id,
    membershipId: row.membership_id,
    membershipEpoch: row.membership_epoch,
    authorityVersion: row.authority_version,
    processorEnvironmentId: row.processor_environment_id,
    livemode: row.livemode,
    rails: parseBillingDelegationRails(row.rails),
    consentReference: row.consent_reference,
    approvalReference: row.approval_reference,
  };
}
/** Caller holds workspace FOR UPDATE. Missing/revoked/stale owner approval means
 * no NEW billing capability or recharge admission, regardless of admin role. */
export async function readBillingOwnerInTransaction(
  client: PoolClient,
  workspaceId: string,
): Promise<BillingOwner | null> {
  const row = (
    await client.query<OwnerRow>(
      `SELECT o.*,m.role,m.accepted_at,m.removed_at,extract(epoch FROM m.accepted_at)::text AS current_epoch
    FROM mr_billing_owners o JOIN mr_memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id
    JOIN mr_billing_processor_environments p ON p.id=o.processor_environment_id AND p.livemode=o.livemode
    WHERE o.workspace_id=$1 FOR SHARE OF o,m,p`,
      [workspaceId],
    )
  ).rows[0];
  if (
    !row ||
    row.revoked_at ||
    !row.accepted_at ||
    row.removed_at ||
    row.role !== 'admin' ||
    row.current_epoch !== row.membership_epoch
  )
    return null;
  return ownerView(row);
}
function fundingOwner(actor: BillingPrincipal, owner: BillingOwner) {
  return browserAdministrator(actor) && actor.membershipId === owner.membershipId;
}
function within(values: BillingPolicyValues, rails: BillingDelegationRails): boolean {
  return (
    (!values.enabled || rails.allowsEnabled) &&
    values.thresholdMicros <= rails.maxThresholdMicros &&
    values.amountCents <= rails.maxAmountCents &&
    values.monthlyCapCents <= rails.maxMonthlyCapCents &&
    values.maxAttemptsPerMonth <= rails.maxAttemptsPerMonth &&
    values.cooldownSeconds >= rails.minCooldownSeconds &&
    values.failureLimit <= rails.maxFailureLimit
  );
}
function railsWithin(r: BillingDelegationRails, owner: BillingDelegationRails): boolean {
  return (
    (!r.allowsEnabled || owner.allowsEnabled) &&
    r.maxThresholdMicros <= owner.maxThresholdMicros &&
    r.maxAmountCents <= owner.maxAmountCents &&
    r.maxMonthlyCapCents <= owner.maxMonthlyCapCents &&
    r.maxAttemptsPerMonth <= owner.maxAttemptsPerMonth &&
    r.minCooldownSeconds >= owner.minCooldownSeconds &&
    r.maxFailureLimit <= owner.maxFailureLimit
  );
}
function sameSource(actor: BillingPrincipal, current: BillingPrincipal) {
  if (
    actor.bootstrap ||
    current.bootstrap ||
    actor.externalOAuth ||
    current.externalOAuth ||
    actor.workspaceId !== current.workspaceId
  )
    throw denied();
  for (const field of [
    'keyKind',
    'keyId',
    'keySecretVersion',
    'membershipId',
    'grantId',
    'clientId',
    'oauthResource',
    'externalOAuth',
  ] as const)
    if (current[field] !== actor[field])
      throw denied('The billing source authority changed; authenticate again.');
  if (
    actor.identity &&
    (current.identity?.issuer !== actor.identity.issuer ||
      current.identity?.subject !== actor.identity.subject)
  )
    throw denied();
  for (const expires of [actor.authorityExpiresAt, current.authorityExpiresAt])
    if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()))
      throw denied();
}
function actorRef(actor: BillingPrincipal) {
  const source = {
    keyId: actor.keyId ?? null,
    keySecretVersion: actor.keySecretVersion ?? null,
    membershipId: actor.membershipId ?? null,
    membershipEpoch: actor.membershipEpoch ?? null,
    grantId: actor.grantId ?? null,
    clientId: actor.clientId ?? null,
    oauthResource: actor.oauthResource ?? null,
  };
  if (actor.keyKind === 'oauth' && actor.grantId && actor.clientId)
    return { kind: 'grant', ...source };
  if (actor.keyKind === 'browser' && actor.membershipId) return { kind: 'membership', ...source };
  if (actor.keyKind === 'api' && actor.keyId) return { kind: 'key', ...source };
  throw denied('A revalidated stable billing actor is required.');
}

export class BillingPolicyStore {
  constructor(
    private pool: Pool,
    private options: {
      revalidateAuthority: BillingAuthorityCallback;
      approveOwner?: BillingOwnerApprovalCallback;
    },
  ) {}
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async lockWorkspace(client: PoolClient, workspaceId: string) {
    if (
      !(await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]))
        .rowCount
    )
      throw denied();
  }
  private async authorize(client: PoolClient, actor: BillingPrincipal, scope: BillingScope) {
    await this.lockWorkspace(client, actor.workspaceId);
    const current = await this.options.revalidateAuthority(client, actor, scope);
    sameSource(actor, current);
    if (!actor.scopes.includes(scope) || !current.scopes.includes(scope)) throw denied();
    if (current.membershipId) {
      const member = (
        await client.query(
          'SELECT extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1 AND workspace_id=$2 AND removed_at IS NULL AND accepted_at IS NOT NULL FOR SHARE',
          [current.membershipId, current.workspaceId],
        )
      ).rows[0];
      if (!member) throw denied();
      current.membershipEpoch = member.epoch;
    }
    actorRef(current);
    return { ...current, scopes: current.scopes.filter((item) => actor.scopes.includes(item)) };
  }
  private async actorDelegation(
    client: PoolClient,
    actor: BillingPrincipal,
    scope: BillingScope,
    owner: BillingOwner,
  ): Promise<BillingDelegation | null> {
    if (fundingOwner(actor, owner)) return null;
    const candidates: BillingDelegationTarget[] = [];
    if (actor.grantId) candidates.push({ kind: 'grant', id: actor.grantId });
    if (actor.keyId && actor.keyKind !== 'browser')
      candidates.push({ kind: 'key', id: actor.keyId });
    for (const candidate of candidates) {
      const row = (
        await client.query<DelegationRow>(
          'SELECT * FROM mr_billing_delegations WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3 FOR UPDATE',
          [actor.workspaceId, candidate.kind, candidate.id],
        )
      ).rows[0];
      if (row) {
        if (
          row.revoked_at ||
          row.owner_authority_version !== owner.authorityVersion ||
          !row.permissions.includes(scope)
        )
          throw denied('Billing delegation or owner approval changed.');
        return delegation(row);
      }
    }
    throw denied('This actor has no explicit current owner-approved billing authority.');
  }
  private async audit(
    client: PoolClient,
    actor: BillingPrincipal,
    operation: string,
    before: unknown,
    after: unknown,
    consent: string | null,
    authority: BillingDelegation | null,
  ) {
    await client.query(
      'INSERT INTO mr_billing_policy_audit(id,workspace_id,actor,operation,before_state,after_state,consent_reference,delegation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        actor.workspaceId,
        JSON.stringify(actorRef(actor)),
        operation,
        JSON.stringify(before),
        JSON.stringify(after),
        consent,
        authority ? JSON.stringify(authority) : null,
      ],
    );
  }
  /** Same-client final gate for B3 and worker-authority adapters; never nested. */
  async authorizeInTransaction(
    client: PoolClient,
    actor: BillingPrincipal,
    scope: BillingScope,
    expectedAuthorityVersion?: number,
  ): Promise<BillingPolicyAuthority> {
    const principal = await this.authorize(client, actor, scope);
    const owner = await readBillingOwnerInTransaction(client, principal.workspaceId);
    if (!owner)
      throw denied(
        'Explicit active funding-owner approval is required; workspace admin role alone is insufficient.',
      );
    if (
      expectedAuthorityVersion !== undefined &&
      owner.authorityVersion !== expectedAuthorityVersion
    )
      throw new BillingPolicyError(
        'billing_owner_conflict',
        'The funding envelope changed. Review its current version.',
        409,
      );
    const delegation = await this.actorDelegation(client, principal, scope, owner);
    return {
      principal,
      owner,
      delegation,
      ...(fundingOwner(principal, owner) ? { humanMembershipId: principal.membershipId! } : {}),
    };
  }
  /** Unmounted default-deny enrollment seam. Caller configuration must provide an
   * out-of-band approval callback after section 11.5 is explicitly resolved. */
  async establishOwner(
    actor: BillingPrincipal,
    input: {
      expectedAuthorityVersion: number;
      rails: BillingDelegationRails;
      processorEnvironmentId: string;
      livemode: boolean;
      consentReference: string;
    },
  ): Promise<BillingOwner> {
    expectedVersion(input.expectedAuthorityVersion);
    const rails = parseBillingDelegationRails(input.rails),
      consent = reference(input.consentReference);
    if (
      typeof input.livemode !== 'boolean' ||
      typeof input.processorEnvironmentId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(input.processorEnvironmentId) ||
      !this.options.approveOwner
    )
      throw denied('Funding-owner enrollment is not configured or approved.');
    return this.tx(async (client) => {
      await this.lockWorkspace(client, actor.workspaceId);
      const approval = await this.options.approveOwner!(client, actor, { ...input, rails });
      sameSource(actor, approval.principal);
      if (approval.processorEnvironmentId !== input.processorEnvironmentId)
        throw denied('Funding approval does not match the server-owned processor environment.');
      if (
        !(
          await client.query(
            'SELECT id FROM mr_billing_processor_environments WHERE id=$1 AND livemode=$2 FOR SHARE',
            [approval.processorEnvironmentId, input.livemode],
          )
        ).rowCount
      )
        throw denied('A registered server-owned processor environment is required.');
      const current = approval.principal;
      if (!browserAdministrator(current))
        throw denied('Verified human browser funding approval is required.');
      const member = (
        await client.query(
          'SELECT *,extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1 AND workspace_id=$2 FOR SHARE',
          [current.membershipId, current.workspaceId],
        )
      ).rows[0];
      if (
        !member ||
        !member.accepted_at ||
        member.removed_at ||
        member.role !== 'admin' ||
        member.issuer !== current.identity!.issuer ||
        member.subject !== current.identity!.subject
      )
        throw denied();
      const before = (
        await client.query<OwnerRow>(
          'SELECT * FROM mr_billing_owners WHERE workspace_id=$1 FOR UPDATE',
          [current.workspaceId],
        )
      ).rows[0];
      if ((before?.authority_version ?? 0) !== input.expectedAuthorityVersion)
        throw new BillingPolicyError(
          'billing_owner_conflict',
          'The funding envelope changed. Review its current version.',
          409,
        );
      const row = (
        await client.query<OwnerRow>(
          `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,processor_environment_id,livemode,rails,consent_reference,approval_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id) DO UPDATE SET membership_id=EXCLUDED.membership_id,membership_epoch=EXCLUDED.membership_epoch,authority_version=EXCLUDED.authority_version,processor_environment_id=EXCLUDED.processor_environment_id,livemode=EXCLUDED.livemode,rails=EXCLUDED.rails,consent_reference=EXCLUDED.consent_reference,approval_reference=EXCLUDED.approval_reference,revoked_at=NULL,updated_at=clock_timestamp() RETURNING *`,
          [
            current.workspaceId,
            member.id,
            member.epoch,
            (before?.authority_version ?? 0) + 1,
            approval.processorEnvironmentId,
            input.livemode,
            JSON.stringify(rails),
            consent,
            reference(approval.approvalReference),
          ],
        )
      ).rows[0]!;
      const after = ownerView(row);
      current.membershipEpoch = member.epoch;
      await this.audit(
        client,
        current,
        'owner.approved',
        before ? ownerView(before) : null,
        after,
        consent,
        null,
      );
      return after;
    });
  }
  async getPolicy(actor: BillingPrincipal): Promise<BillingPolicy> {
    return this.tx(async (client) => {
      const { principal } = await this.authorizeInTransaction(client, actor, 'billing:read');
      return readBillingPolicyInTransaction(client, principal.workspaceId);
    });
  }
  async updatePolicy(
    actor: BillingPrincipal,
    input: {
      expectedVersion: number;
      expectedAuthorityVersion: number;
      policy: BillingPolicyValues;
      consentReference?: string;
    },
  ): Promise<BillingPolicy> {
    expectedVersion(input.expectedVersion);
    expectedVersion(input.expectedAuthorityVersion);
    const values = parseBillingPolicyValues(input.policy);
    return this.tx(async (client) => {
      const {
        principal: current,
        owner,
        delegation: authority,
      } = await this.authorizeInTransaction(
        client,
        actor,
        'billing:manage',
        input.expectedAuthorityVersion,
      );
      const before = await readBillingPolicyInTransaction(client, current.workspaceId);
      if (before.version !== input.expectedVersion)
        throw new BillingPolicyError(
          'billing_policy_conflict',
          'Billing policy changed. Read the current version before editing.',
          409,
        );
      if (!within(values, owner.rails))
        throw denied('The policy exceeds the aggregate human-approved workspace funding envelope.');
      if (
        authority &&
        (values.mandateId !== before.mandateId ||
          !within(values, parseBillingDelegationRails(authority.rails)))
      )
        throw denied('The change exceeds the human-owned billing delegation ceiling.');
      let consent =
        authority?.consentReference ??
        (input.consentReference === undefined ? null : reference(input.consentReference));
      if (
        !authority &&
        (values.mandateId !== before.mandateId || (!before.enabled && values.enabled))
      )
        consent = reference(input.consentReference);
      if (values.enabled || (values.mandateId !== null && values.mandateId !== before.mandateId)) {
        const mandate = (
          await client.query(
            "SELECT id FROM mr_billing_mandates WHERE id=$1 AND workspace_id=$2 AND livemode=$3 AND status='active' AND owner_authority_version=$4 AND owner_consent_reference=$5 AND owner_membership_epoch=$6 AND processor_environment_id=$7 FOR SHARE",
            [
              values.mandateId,
              current.workspaceId,
              owner.livemode,
              owner.authorityVersion,
              owner.consentReference,
              owner.membershipEpoch,
              owner.processorEnvironmentId,
            ],
          )
        ).rows[0];
        if (!mandate)
          throw new BillingPolicyError(
            'billing_mandate_required',
            'An active, owned, human-approved payment mandate in the funding environment is required.',
            409,
          );
      }
      const changed = (
        await client.query<PolicyRow>(
          `INSERT INTO mr_billing_policies(workspace_id,enabled,threshold_micros,amount_cents,monthly_cap_cents,max_attempts_per_month,cooldown_seconds,failure_limit,mandate_id,version,owner_authority_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,threshold_micros=EXCLUDED.threshold_micros,amount_cents=EXCLUDED.amount_cents,monthly_cap_cents=EXCLUDED.monthly_cap_cents,max_attempts_per_month=EXCLUDED.max_attempts_per_month,cooldown_seconds=EXCLUDED.cooldown_seconds,failure_limit=EXCLUDED.failure_limit,mandate_id=EXCLUDED.mandate_id,version=EXCLUDED.version,owner_authority_version=EXCLUDED.owner_authority_version,updated_at=clock_timestamp() RETURNING *`,
          [
            current.workspaceId,
            values.enabled,
            values.thresholdMicros,
            values.amountCents,
            values.monthlyCapCents,
            values.maxAttemptsPerMonth,
            values.cooldownSeconds,
            values.failureLimit,
            values.mandateId,
            before.version + 1,
            owner.authorityVersion,
          ],
        )
      ).rows[0]!;
      const after = policy(changed);
      await this.audit(client, current, 'policy.updated', before, after, consent, authority);
      return after;
    });
  }
  async setDelegation(
    actor: BillingPrincipal,
    input: {
      expectedVersion: number;
      expectedAuthorityVersion: number;
      target: BillingDelegationTarget;
      rails: BillingDelegationRails;
      permissions: BillingScope[];
      consentReference: string;
    },
  ): Promise<BillingDelegation> {
    expectedVersion(input.expectedVersion);
    expectedVersion(input.expectedAuthorityVersion);
    const selected = target(input.target),
      rails = parseBillingDelegationRails(input.rails),
      consent = reference(input.consentReference);
    if (
      !Array.isArray(input.permissions) ||
      input.permissions.length === 0 ||
      new Set(input.permissions).size !== input.permissions.length ||
      input.permissions.some((scope) => scope !== 'billing:read' && scope !== 'billing:manage')
    )
      throw denied();
    return this.tx(async (client) => {
      const { principal: current, owner } = await this.authorizeInTransaction(
        client,
        actor,
        'billing:manage',
        input.expectedAuthorityVersion,
      );
      if (!fundingOwner(current, owner))
        throw denied(
          'Only the explicitly approved human funding owner may change delegation ceilings.',
        );
      if (!railsWithin(rails, owner.rails))
        throw denied('Delegation rails exceed the current workspace funding envelope.');
      await this.validateTarget(client, current.workspaceId, selected);
      const before = (
        await client.query<DelegationRow>(
          'SELECT * FROM mr_billing_delegations WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3 FOR UPDATE',
          [current.workspaceId, selected.kind, selected.id],
        )
      ).rows[0];
      if ((before?.version ?? 0) !== input.expectedVersion)
        throw new BillingPolicyError(
          'billing_delegation_conflict',
          'The delegation changed. Read its current version before editing.',
          409,
        );
      const row = (
        await client.query<DelegationRow>(
          `INSERT INTO mr_billing_delegations(workspace_id,target_kind,target_id,permissions,rails,version,consent_reference,owner_authority_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,target_kind,target_id) DO UPDATE SET permissions=EXCLUDED.permissions,rails=EXCLUDED.rails,version=EXCLUDED.version,consent_reference=EXCLUDED.consent_reference,owner_authority_version=EXCLUDED.owner_authority_version,revoked_at=NULL,updated_at=clock_timestamp() RETURNING *`,
          [
            current.workspaceId,
            selected.kind,
            selected.id,
            JSON.stringify(input.permissions),
            JSON.stringify(rails),
            (before?.version ?? 0) + 1,
            consent,
            owner.authorityVersion,
          ],
        )
      ).rows[0]!;
      const after = delegation(row);
      await this.audit(
        client,
        current,
        'delegation.updated',
        before ? delegation(before) : null,
        after,
        consent,
        null,
      );
      return after;
    });
  }
  async revokeDelegation(
    actor: BillingPrincipal,
    selectedTarget: BillingDelegationTarget,
    version: number,
    consentReference: string,
    expectedAuthorityVersion: number,
  ): Promise<BillingDelegation> {
    expectedVersion(version);
    expectedVersion(expectedAuthorityVersion);
    const selected = target(selectedTarget),
      consent = reference(consentReference);
    return this.tx(async (client) => {
      const { principal: current, owner } = await this.authorizeInTransaction(
        client,
        actor,
        'billing:manage',
        expectedAuthorityVersion,
      );
      if (!fundingOwner(current, owner))
        throw denied('Only the approved human funding owner may revoke billing delegations.');
      const before = (
        await client.query<DelegationRow>(
          'SELECT * FROM mr_billing_delegations WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3 FOR UPDATE',
          [current.workspaceId, selected.kind, selected.id],
        )
      ).rows[0];
      if (!before || before.version !== version)
        throw new BillingPolicyError(
          'billing_delegation_conflict',
          'The delegation changed. Read its current version before editing.',
          409,
        );
      const row = (
        await client.query<DelegationRow>(
          'UPDATE mr_billing_delegations SET revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND target_kind=$2 AND target_id=$3 RETURNING *',
          [current.workspaceId, selected.kind, selected.id],
        )
      ).rows[0]!;
      const after = delegation(row);
      await this.audit(
        client,
        current,
        'delegation.revoked',
        delegation(before),
        after,
        consent,
        null,
      );
      return after;
    });
  }
  private async validateTarget(
    client: PoolClient,
    workspaceId: string,
    selected: BillingDelegationTarget,
  ) {
    const row =
      selected.kind === 'key'
        ? (
            await client.query(
              "SELECT id FROM mr_api_keys WHERE id=$1 AND workspace_id=$2 AND key_kind='api' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE",
              [selected.id, workspaceId],
            )
          ).rows[0]
        : (
            await client.query(
              'SELECT id FROM mr_mcp_oauth_grants WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',
              [selected.id, workspaceId],
            )
          ).rows[0];
    if (!row)
      throw denied('The delegation target must be a current key or grant in this workspace.');
  }
}
