import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../packages/engine/src/accounts.js';
import {
  revalidateGovernanceAuthority,
  type GovernancePrincipal,
} from '../packages/engine/src/governance-authority.js';
import {
  BILLING_POLICY_DEFAULTS,
  BillingPolicyStore,
  parseBillingDelegationRails,
  parseBillingPolicyValues,
  readBillingPolicyInTransaction,
  readBillingOwnerInTransaction,
  type BillingAuthorityCallback,
  type BillingDelegationRails,
  type BillingPolicyValues,
  type BillingPrincipal,
} from '../packages/engine/src/billing-policy.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const native = process.env.TEST_NATIVE_POSTGRES === '1' && Boolean(databaseUrl);
const processorEnvironmentId = 'fixture-billing-processor';
const rails: BillingDelegationRails = {
  allowsEnabled: true,
  maxThresholdMicros: 10_000_000,
  maxAmountCents: 5000,
  maxMonthlyCapCents: 20000,
  maxAttemptsPerMonth: 6,
  minCooldownSeconds: 3600,
  maxFailureLimit: 3,
};
const values = (patch: Partial<BillingPolicyValues> = {}): BillingPolicyValues => ({
  ...BILLING_POLICY_DEFAULTS,
  ...patch,
});

it('keeps unconfigured policy disabled and validates exact bounded card-funding integers', () => {
  expect(BILLING_POLICY_DEFAULTS.enabled).toBe(false);
  expect(BILLING_POLICY_DEFAULTS.mandateId).toBeNull();
  expect(parseBillingPolicyValues(values())).toEqual(values());
  for (const patch of [
    { amountCents: 499 },
    { amountCents: 100001 },
    { amountCents: 500.5 },
    { thresholdMicros: NaN },
    { thresholdMicros: 1e13 },
    { monthlyCapCents: 100 },
    { maxAttemptsPerMonth: 0 },
    { cooldownSeconds: 59 },
    { failureLimit: 101 },
    { enabled: true },
    { mandateId: 'caller-controlled-object' },
    { extra: 'unknown' },
  ])
    expect(() => parseBillingPolicyValues({ ...values(), ...patch })).toThrow();
});
it('validates all human-owned delegation rails without accepting hidden extensions', () => {
  expect(parseBillingDelegationRails(rails)).toEqual(rails);
  const { allowsEnabled: _allowsEnabled, ...withoutEnable } = rails;
  expect(parseBillingDelegationRails(withoutEnable).allowsEnabled).toBe(false);
  for (const patch of [
    { maxAmountCents: 0 },
    { maxMonthlyCapCents: 499 },
    { minCooldownSeconds: 0 },
    { maxThresholdMicros: Infinity },
    { maxAttemptsPerMonth: 1.5 },
    { maxFailureLimit: 101 },
    { delegatesMayRaiseCeiling: true },
  ])
    expect(() => parseBillingDelegationRails({ ...rails, ...patch })).toThrow();
});

/** Integrator supplies the real projection for new billing scopes. This fixture
 * uses the existing real source-key/member/grant revalidation, then explicitly
 * grants the new fixture browser-admin capability (never an HTTP body field). */
const authority: BillingAuthorityCallback = async (client, actor) => {
  const current = await revalidateGovernanceAuthority(
    client,
    actor as unknown as GovernancePrincipal,
    null,
  );
  return current.keyKind === 'browser' && current.role === 'admin'
    ? { ...current, scopes: [...new Set([...current.scopes, 'billing:read', 'billing:manage'])] }
    : current;
};
async function fixture(max = 1, approvedOwner = true) {
  const schema = `billing_policy_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    options: `-c search_path=${schema}`,
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${schema}`);
    },
  });
  // Standalone B2 proposal, before the root assigns forward migration slots.
  for (let i = 1; i <= 21; i++)
    await pool.query(
      await readFile(
        new URL(`../packages/engine/migrations/${String(i).padStart(3, '0')}.sql`, import.meta.url),
        'utf8',
      ),
    );
  await pool.query(
    'CREATE TABLE mr_billing_processor_environments(id text PRIMARY KEY,account_id text NOT NULL,livemode boolean NOT NULL)',
  );
  await pool.query(
    "INSERT INTO mr_billing_processor_environments(id,account_id,livemode) VALUES($1,'acct_fixture',false)",
    [processorEnvironmentId],
  );
  await pool.query(
    `CREATE TABLE mr_billing_mandates(id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES mr_workspaces(id),status text NOT NULL CHECK(status IN ('active','revoked')),livemode boolean NOT NULL DEFAULT false,owner_authority_version integer NOT NULL DEFAULT 1,owner_consent_reference text NOT NULL DEFAULT 'owner-envelope-fixture',owner_membership_epoch text NOT NULL DEFAULT 'foreign-fixture-epoch',processor_environment_id text NOT NULL DEFAULT 'fixture-billing-processor')`,
  );
  await pool.query(
    await readFile(new URL('../docs/billing/policy-schema.sql', import.meta.url), 'utf8'),
  );
  const accounts = new AccountStore(pool);
  const human = await accounts.identity('https://billing-fixture.example', randomUUID());
  const owner: BillingPrincipal = {
    ...human,
    scopes: [...new Set([...human.scopes, 'billing:read', 'billing:manage'])],
  };
  if (approvedOwner)
    await pool.query(
      `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,processor_environment_id,livemode,rails,consent_reference,approval_reference)
    SELECT $1,$2,extract(epoch FROM accepted_at)::text,1,$4,false,$3,'owner-envelope-fixture','explicit-fixture-approval' FROM mr_memberships WHERE id=$2`,
      [owner.workspaceId, owner.membershipId, JSON.stringify(rails), processorEnvironmentId],
    );
  const ordinaryKey = await accounts.createKey(owner.workspaceId, {
    name: 'Ordinary generation fixture',
    scopes: ['read', 'generate'],
  });
  const agentKey = await accounts.createKey(owner.workspaceId, {
    name: 'Explicit billing fixture',
    scopes: ['read', 'generate'],
  });
  // This models a separately owner-authorized scope projection, not enum defaults.
  await pool.query('UPDATE mr_api_keys SET scopes=$2 WHERE id=$1', [
    agentKey.id,
    JSON.stringify(['read', 'generate', 'billing:read', 'billing:manage']),
  ]);
  const agent = (await accounts.authenticate(agentKey.token))!;
  const ordinary = (await accounts.authenticate(ordinaryKey.token))!;
  const store = new BillingPolicyStore(pool, { revalidateAuthority: authority });
  const mandateId = randomUUID();
  await pool.query(
    "INSERT INTO mr_billing_mandates(id,workspace_id,status,owner_membership_epoch) SELECT $1,$2,'active',extract(epoch FROM accepted_at)::text FROM mr_memberships WHERE id=$3",
    [mandateId, owner.workspaceId, owner.membershipId],
  );
  const seed = async () =>
    store.updatePolicy(owner, {
      expectedVersion: 0,
      expectedAuthorityVersion: 1,
      policy: values({ mandateId }),
      consentReference: 'human-setup-fixture',
    });
  const delegate = async () =>
    store.setDelegation(owner, {
      expectedVersion: 0,
      expectedAuthorityVersion: 1,
      target: { kind: 'key', id: agentKey.id },
      permissions: ['billing:read', 'billing:manage'],
      rails,
      consentReference: 'human-approved-ceiling-fixture',
    });
  return {
    pool,
    accounts,
    owner,
    agent,
    ordinary,
    agentKey,
    ordinaryKey,
    store,
    mandateId,
    seed,
    delegate,
    async grant() {
      const grantId = randomUUID(),
        clientId = `billing-client-${randomUUID()}`;
      await pool.query(
        "INSERT INTO mr_mcp_oauth_clients(id,name,redirect_uris) VALUES($1,'Fixture billing client','[]')",
        [clientId],
      );
      await pool.query(
        `INSERT INTO mr_mcp_oauth_grants(id,client_id,workspace_id,resource,source_key_id,scopes,expires_at)
        VALUES($1,$2,$3,'https://opengen.example/mcp',$4,$5,clock_timestamp()+interval '1 day')`,
        [
          grantId,
          clientId,
          owner.workspaceId,
          agentKey.id,
          JSON.stringify(['read', 'billing:read', 'billing:manage']),
        ],
      );
      return {
        ...agent,
        keyKind: 'oauth' as const,
        grantId,
        clientId,
        oauthResource: 'https://opengen.example/mcp',
        authorityExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
    async tx<T>(fn: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
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
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query('SET search_path TO public');
      await admin.end();
    },
  };
}

describe.skipIf(!databaseUrl)('durable versioned billing policy authority', () => {
  it('denies existing administrators without explicit owner approval, and owner enrollment defaults closed', async () => {
    const f = await fixture(1, false);
    try {
      await expect(f.store.getPolicy(f.owner)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.store.establishOwner(f.owner, {
          expectedAuthorityVersion: 0,
          processorEnvironmentId,
          rails: { ...rails, allowsEnabled: false },
          livemode: false,
          consentReference: 'generic-admin-click',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        await f.tx((client) => readBillingOwnerInTransaction(client, f.owner.workspaceId)),
      ).toBeNull();
      const approved = new BillingPolicyStore(f.pool, {
        revalidateAuthority: authority,
        approveOwner: async (client, actor) => ({
          principal: await authority(client, actor, 'billing:manage'),
          approvalReference: 'explicit-out-of-band-fixture',
          processorEnvironmentId,
        }),
      });
      await expect(
        approved.establishOwner(f.owner, {
          expectedAuthorityVersion: 0,
          processorEnvironmentId: 'unapproved-sandbox',
          rails: { ...rails, allowsEnabled: false },
          livemode: false,
          consentReference: 'foreign-processor-attempt',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      const owner = await approved.establishOwner(f.owner, {
        expectedAuthorityVersion: 0,
        processorEnvironmentId,
        rails: { ...rails, allowsEnabled: false },
        livemode: false,
        consentReference: 'approved-fixture-enrollment',
      });
      expect(owner).toMatchObject({
        authorityVersion: 1,
        membershipId: f.owner.membershipId,
        processorEnvironmentId,
        rails: { allowsEnabled: false },
      });
      await f.pool.query('UPDATE mr_billing_mandates SET owner_consent_reference=$2 WHERE id=$1', [
        f.mandateId,
        owner.consentReference,
      ]);
      await f.seed();
      await expect(
        f.store.updatePolicy(f.owner, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          policy: values({ enabled: true, mandateId: f.mandateId }),
          consentReference: 'human-enable',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await f.store.getPolicy(f.owner)).enabled).toBe(false);
    } finally {
      await f.close();
    }
  });
  it('applies one aggregate owner envelope to human and multiple delegates, with stale owner revisions rejected', async () => {
    const f = await fixture();
    try {
      await f.seed();
      await f.delegate();
      await expect(
        f.store.updatePolicy(f.owner, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId, monthlyCapCents: rails.maxMonthlyCapCents + 1 }),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      const secondKey = await f.accounts.createKey(f.owner.workspaceId, {
        name: 'Second explicit billing delegate',
        scopes: ['read', 'generate'],
      });
      await f.pool.query('UPDATE mr_api_keys SET scopes=$2 WHERE id=$1', [
        secondKey.id,
        JSON.stringify(['billing:read', 'billing:manage']),
      ]);
      const second = (await f.accounts.authenticate(secondKey.token))!;
      await f.store.setDelegation(f.owner, {
        expectedVersion: 0,
        expectedAuthorityVersion: 1,
        target: { kind: 'key', id: secondKey.id },
        permissions: ['billing:read', 'billing:manage'],
        rails,
        consentReference: 'second-delegate-fixture',
      });
      for (const actor of [f.agent, second])
        await expect(
          f.store.updatePolicy(actor, {
            expectedVersion: 1,
            expectedAuthorityVersion: 1,
            policy: values({
              mandateId: f.mandateId,
              monthlyCapCents: rails.maxMonthlyCapCents + 1,
            }),
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (
          await f.pool.query('SELECT count(*) FROM mr_billing_policies WHERE workspace_id=$1', [
            f.owner.workspaceId,
          ])
        ).rows[0].count,
      ).toBe('1');
      await f.pool.query('UPDATE mr_billing_owners SET authority_version=2 WHERE workspace_id=$1', [
        f.owner.workspaceId,
      ]);
      await expect(
        f.store.updatePolicy(f.owner, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId }),
        }),
      ).rejects.toMatchObject({ code: 'billing_owner_conflict', statusCode: 409 });
      await expect(
        f.store.updatePolicy(f.agent, {
          expectedVersion: 1,
          expectedAuthorityVersion: 2,
          policy: values({ mandateId: f.mandateId }),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (await f.tx((client) => readBillingOwnerInTransaction(client, f.owner.workspaceId)))
          ?.authorityVersion,
      ).toBe(2);
      expect((await f.store.getPolicy(f.owner)).ownerAuthorityVersion).toBe(1);
      await f.pool.query(
        "UPDATE mr_memberships SET accepted_at=accepted_at+interval '1 second' WHERE id=$1",
        [f.owner.membershipId],
      );
      expect(
        await f.tx((client) => readBillingOwnerInTransaction(client, f.owner.workspaceId)),
      ).toBeNull();
      await expect(f.store.getPolicy(f.owner)).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await f.close();
    }
  });
  it('denies ordinary agents and scoped agents without a separate delegation; reads create no policy or money', async () => {
    const f = await fixture();
    try {
      await expect(f.store.getPolicy(f.ordinary)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.store.updatePolicy(f.ordinary, {
          expectedVersion: 0,
          expectedAuthorityVersion: 1,
          policy: values(),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(f.store.getPolicy(f.agent)).rejects.toMatchObject({ statusCode: 403 });
      expect(await f.store.getPolicy(f.owner)).toMatchObject({
        enabled: false,
        version: 0,
        mandateId: null,
      });
      expect(
        await f.tx((client) => readBillingPolicyInTransaction(client, f.owner.workspaceId)),
      ).toMatchObject({ enabled: false, version: 0 });
      for (const table of ['mr_billing_policies', 'mr_billing_policy_audit'])
        expect((await f.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('allows explicit delegated edits within rails but denies every ceiling escalation, mandate change and self grant', async () => {
    const f = await fixture();
    try {
      await f.seed();
      await f.delegate();
      const changed = await f.store.updatePolicy(f.agent, {
        expectedVersion: 1,
        expectedAuthorityVersion: 1,
        policy: values({
          enabled: true,
          mandateId: f.mandateId,
          amountCents: 5000,
          cooldownSeconds: 3600,
        }),
      });
      expect(changed).toMatchObject({ enabled: true, version: 2, amountCents: 5000 });
      for (const patch of [
        { thresholdMicros: rails.maxThresholdMicros + 1 },
        { amountCents: rails.maxAmountCents + 1 },
        { monthlyCapCents: rails.maxMonthlyCapCents + 1 },
        { maxAttemptsPerMonth: rails.maxAttemptsPerMonth + 1 },
        { cooldownSeconds: rails.minCooldownSeconds - 1 },
        { failureLimit: rails.maxFailureLimit + 1 },
        { mandateId: randomUUID() },
      ])
        await expect(
          f.store.updatePolicy(f.agent, {
            expectedVersion: 2,
            expectedAuthorityVersion: 1,
            policy: values({ enabled: true, mandateId: f.mandateId, ...patch }),
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.store.setDelegation(f.agent, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          target: { kind: 'key', id: f.agentKey.id },
          permissions: ['billing:read', 'billing:manage'],
          rails: { ...rails, maxAmountCents: 100000, maxMonthlyCapCents: 100000 },
          consentReference: 'agent-claimed-consent',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await f.store.getPolicy(f.agent)).version).toBe(2);
      const audits = (
        await f.pool.query(
          "SELECT actor,consent_reference,delegation FROM mr_billing_policy_audit WHERE operation='policy.updated' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      expect(audits.actor).toMatchObject({ kind: 'key', keyId: f.agentKey.id });
      expect(audits.consent_reference).toBe('human-approved-ceiling-fixture');
      expect(audits.delegation.rails).toEqual(rails);
      expect(JSON.stringify(audits)).not.toContain(f.agentKey.token);
    } finally {
      await f.close();
    }
  });
  it('requires current human administrator consent and an active owned mandate for initial binding', async () => {
    const f = await fixture();
    try {
      await f.delegate();
      await expect(
        f.store.updatePolicy(f.agent, {
          expectedVersion: 0,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId }),
          consentReference: 'agent-consent',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.store.updatePolicy(f.owner, {
          expectedVersion: 0,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId }),
        }),
      ).rejects.toMatchObject({ code: 'invalid_consent_reference' });
      const other = await f.accounts.identity('https://billing-fixture.example', randomUUID());
      const foreign = randomUUID();
      await f.pool.query(
        "INSERT INTO mr_billing_mandates(id,workspace_id,status) VALUES($1,$2,'active')",
        [foreign, other.workspaceId],
      );
      await expect(
        f.store.updatePolicy(f.owner, {
          expectedVersion: 0,
          expectedAuthorityVersion: 1,
          policy: values({ enabled: true, mandateId: foreign }),
          consentReference: 'human-consent',
        }),
      ).rejects.toMatchObject({ code: 'billing_mandate_required' });
      await f.seed();
      await f.pool.query("UPDATE mr_billing_mandates SET status='revoked' WHERE id=$1", [
        f.mandateId,
      ]);
      await expect(
        f.store.updatePolicy(f.owner, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          policy: values({ enabled: true, mandateId: f.mandateId }),
          consentReference: 'human-consent',
        }),
      ).rejects.toMatchObject({ code: 'billing_mandate_required' });
      // Disabling remains possible even when the previously saved mandate is revoked.
      expect(
        await f.store.updatePolicy(f.owner, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId }),
        }),
      ).toMatchObject({ enabled: false, version: 2 });
    } finally {
      await f.close();
    }
  });
  it('refuses mandate proof frozen under another owner revision, consent or membership epoch', async () => {
    const f = await fixture();
    try {
      const saved = (
        await f.pool.query(
          'SELECT owner_authority_version,owner_consent_reference,owner_membership_epoch,processor_environment_id FROM mr_billing_mandates WHERE id=$1',
          [f.mandateId],
        )
      ).rows[0];
      for (const [field, value] of [
        ['owner_authority_version', 2],
        ['owner_consent_reference', 'another-owner-consent'],
        ['owner_membership_epoch', 'another-acceptance-epoch'],
        ['processor_environment_id', 'another-test-processor'],
      ] as const) {
        await f.pool.query(`UPDATE mr_billing_mandates SET ${field}=$2 WHERE id=$1`, [
          f.mandateId,
          value,
        ]);
        await expect(f.seed()).rejects.toMatchObject({
          code: 'billing_mandate_required',
          statusCode: 409,
        });
        await f.pool.query(`UPDATE mr_billing_mandates SET ${field}=$2 WHERE id=$1`, [
          f.mandateId,
          saved[field],
        ]);
      }
      expect((await f.store.getPolicy(f.owner)).version).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('checks optimistic versions atomically and rolls back stale edits and audit writes with pool size one', async () => {
    const f = await fixture();
    try {
      const first = await f.seed();
      const results = await Promise.allSettled([
        f.store.updatePolicy(f.owner, {
          expectedVersion: first.version,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId, thresholdMicros: 1 }),
        }),
        f.store.updatePolicy(f.owner, {
          expectedVersion: first.version,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId, thresholdMicros: 2 }),
        }),
      ]);
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'billing_policy_conflict', statusCode: 409 });
      expect((await f.store.getPolicy(f.owner)).version).toBe(2);
      expect(
        (
          await f.pool.query(
            "SELECT count(*) FROM mr_billing_policy_audit WHERE operation='policy.updated'",
          )
        ).rows[0].count,
      ).toBe('2');
      await expect(
        f.pool.query('UPDATE mr_billing_policies SET amount_cents=1 WHERE workspace_id=$1', [
          f.owner.workspaceId,
        ]),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it('rechecks current key scopes, key revocation, membership and delegation rather than trusting an authenticated snapshot', async () => {
    const f = await fixture();
    try {
      await f.seed();
      await f.delegate();
      await f.pool.query('UPDATE mr_api_keys SET scopes=$2 WHERE id=$1', [
        f.agentKey.id,
        JSON.stringify(['read', 'generate', 'billing:read']),
      ]);
      await expect(
        f.store.updatePolicy(f.agent, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId }),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await f.pool.query('UPDATE mr_api_keys SET revoked_at=clock_timestamp() WHERE id=$1', [
        f.agentKey.id,
      ]);
      await expect(f.store.getPolicy(f.agent)).rejects.toMatchObject({ statusCode: 403 });
      await f.pool.query("UPDATE mr_memberships SET role='member' WHERE id=$1", [
        f.owner.membershipId,
      ]);
      await expect(
        f.store.setDelegation(f.owner, {
          expectedVersion: 1,
          expectedAuthorityVersion: 1,
          target: { kind: 'key', id: f.agentKey.id },
          permissions: ['billing:read'],
          rails,
          consentReference: 'old-admin',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (
          await f.pool.query('SELECT version FROM mr_billing_policies WHERE workspace_id=$1', [
            f.owner.workspaceId,
          ])
        ).rows[0].version,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
  it('retains OAuth source/grant/client identity across refresh while explicit grant revocation overrides key delegation', async () => {
    const f = await fixture();
    try {
      await f.seed();
      await f.delegate();
      const grant = await f.grant();
      expect((await f.store.getPolicy(grant)).version).toBe(1);
      const refreshed = {
        ...grant,
        authorityExpiresAt: new Date(Date.now() + 7200000).toISOString(),
      };
      await f.store.updatePolicy(refreshed, {
        expectedVersion: 1,
        expectedAuthorityVersion: 1,
        policy: values({ mandateId: f.mandateId, thresholdMicros: 2 }),
      });
      const audit = (
        await f.pool.query(
          "SELECT actor FROM mr_billing_policy_audit WHERE operation='policy.updated' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0].actor;
      expect(audit).toMatchObject({
        kind: 'grant',
        grantId: grant.grantId,
        clientId: grant.clientId,
        keyId: f.agentKey.id,
      });
      const delegation = await f.store.setDelegation(f.owner, {
        expectedVersion: 0,
        expectedAuthorityVersion: 1,
        target: { kind: 'grant', id: grant.grantId },
        permissions: ['billing:read', 'billing:manage'],
        rails,
        consentReference: 'grant-explicit',
      });
      await f.store.revokeDelegation(
        f.owner,
        delegation.target,
        delegation.version,
        'human-revoked',
        1,
      );
      await expect(f.store.getPolicy(refreshed)).rejects.toMatchObject({ statusCode: 403 });
      await f.pool.query(
        'UPDATE mr_mcp_oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1',
        [grant.grantId],
      );
      await expect(
        f.store.updatePolicy(refreshed, {
          expectedVersion: 2,
          expectedAuthorityVersion: 1,
          policy: values({ mandateId: f.mandateId }),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await f.close();
    }
  });
  it('fails closed if a final authority callback changes source tuple/workspace or returns an expired capability', async () => {
    const f = await fixture();
    try {
      for (const change of [
        { workspaceId: 'another-workspace' },
        { keyId: randomUUID() },
        { keySecretVersion: 2 },
        { authorityExpiresAt: '2000-01-01T00:00:00Z' },
      ]) {
        const store = new BillingPolicyStore(f.pool, {
          revalidateAuthority: async (client, actor, scope) => ({
            ...(await authority(client, actor, scope)),
            ...change,
          }),
        });
        await expect(store.getPolicy(f.owner)).rejects.toMatchObject({ statusCode: 403 });
      }
      const bootstrap: BillingPrincipal = { ...f.owner, bootstrap: true };
      await expect(f.store.getPolicy(bootstrap)).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await f.close();
    }
  });
});

describe.skipIf(!native)('native PostgreSQL billing policy races', () => {
  it('serializes independent policy writers so exactly one expected version can commit', async () => {
    const f = await fixture(4);
    try {
      await f.seed();
      await f.delegate();
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          f.store.updatePolicy(f.agent, {
            expectedVersion: 1,
            expectedAuthorityVersion: 1,
            policy: values({ mandateId: f.mandateId, thresholdMicros: i }),
          }),
        ),
      );
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      for (const item of results)
        if (item.status === 'rejected')
          expect(item.reason).toMatchObject({ code: 'billing_policy_conflict' });
      expect((await f.store.getPolicy(f.owner)).version).toBe(2);
    } finally {
      await f.close();
    }
  });
  it('denies an edit queued behind committed delegation revocation under the workspace lock', async () => {
    const f = await fixture(4);
    const blocker = await f.pool.connect();
    let edit: Promise<unknown> | undefined;
    try {
      await f.seed();
      await f.delegate();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
        f.owner.workspaceId,
      ]);
      edit = f.store.updatePolicy(f.agent, {
        expectedVersion: 1,
        expectedAuthorityVersion: 1,
        policy: values({ mandateId: f.mandateId, enabled: true }),
      });
      void edit.catch(() => {});
      await blocker.query(
        'UPDATE mr_billing_delegations SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1',
        [f.owner.workspaceId],
      );
      await blocker.query('COMMIT');
      await expect(edit).rejects.toMatchObject({ statusCode: 403 });
      expect((await f.store.getPolicy(f.owner)).version).toBe(1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(edit ? [edit] : []);
      await f.close();
    }
  });
});
