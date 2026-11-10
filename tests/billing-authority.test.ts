import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { AccountGovernanceStore, createEngine, keyScopes } from '@media-router/engine';
import {
  projectBillingPrincipal,
  projectStoredBillingSetupPrincipal,
  revalidateBillingAuthority,
} from '../packages/engine/src/billing-authority.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import type { BillingPrincipal, BillingScope } from '../packages/engine/src/billing-policy.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const publicUrl = 'https://billing-authority.fixture.invalid';
const rails = {
  allowsEnabled: false,
  maxThresholdMicros: 10_000_000,
  maxAmountCents: 2_500,
  maxMonthlyCapCents: 10_000,
  maxAttemptsPerMonth: 4,
  minCooldownSeconds: 86_400,
  maxFailureLimit: 3,
};
const denied = { statusCode: 403 };

async function fixture() {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'billing_authority');
  const engine = isolated.bind(
    createEngine({ databaseUrl: isolated.databaseUrl, publicUrl, providerEnv: {}, poolSize: 1 }),
  );
  const close = async () => {
    try {
      await engine.close();
    } finally {
      await isolated.close();
    }
  };
  try {
    await engine.initialize();
    const browserKey = await engine.accounts.identity(
      'https://identity.fixture.invalid',
      randomUUID(),
    );
    const cookie = await engine.accounts.createSession(browserKey);
    const browser = (await engine.accounts.session(cookie))!;
    const workspaceId = browser.workspaceId;
    const pool = engine.pool;
    const processor = {
      id: 'fixture-billing-processor',
      accountId: 'acct_fixture',
      livemode: false,
    };
    await registerBillingProcessorEnvironmentInTransaction(pool, processor);
    const approve = () =>
      pool.query(
        `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,
           processor_environment_id,livemode,rails,consent_reference,approval_reference)
         SELECT workspace_id,id,extract(epoch FROM accepted_at)::text,1,$3,false,$4,
           'fixture-owner-consent','fixture-explicit-approval'
         FROM mr_memberships WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, browser.membershipId, processor.id, JSON.stringify(rails)],
      );
    const delegate = (kind: 'key' | 'grant', id: string, permissions: BillingScope[]) =>
      pool.query(
        `INSERT INTO mr_billing_delegations(workspace_id,target_kind,target_id,owner_authority_version,
           permissions,rails,version,consent_reference) VALUES($1,$2,$3,1,$4,$5,1,'fixture-delegation')`,
        [workspaceId, kind, id, JSON.stringify(permissions), JSON.stringify(rails)],
      );
    const createKey = async () => {
      const key = await engine.accounts.createKey(workspaceId, {
        name: 'Synthetic billing delegate',
        scopes: ['read', 'generate'],
      });
      return { key, source: (await engine.accounts.authenticate(key.token))! };
    };
    const inWorkspace = async <T>(action: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        return await action(client);
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    };
    const verify = (actor: BillingPrincipal, scope: BillingScope) =>
      inWorkspace((client) => revalidateBillingAuthority(client, actor, scope));
    return {
      engine,
      pool,
      browser,
      workspaceId,
      approve,
      delegate,
      createKey,
      inWorkspace,
      verify,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('explicit billing authority bridge', () => {
  it('requires an approved owner and cookie-only browser provenance', async () => {
    const f = await fixture();
    try {
      expect(f.browser.scopes).toEqual([...keyScopes]);
      await expect(projectBillingPrincipal(f.pool, f.browser, true)).rejects.toMatchObject(denied);
      await f.approve();
      await expect(projectBillingPrincipal(f.pool, f.browser, false)).rejects.toMatchObject(denied);
      const owner = await projectBillingPrincipal(f.pool, f.browser, true);
      expect(owner.scopes).toEqual([...keyScopes, 'billing:read', 'billing:manage']);
      expect(f.browser.scopes).toEqual([...keyScopes]);
      await expect(f.verify({ ...owner }, 'billing:manage')).resolves.toMatchObject({
        membershipId: f.browser.membershipId,
        membershipEpoch: owner.membershipEpoch,
      });
      await expect(
        f.verify(JSON.parse(JSON.stringify(owner)), 'billing:manage'),
      ).rejects.toMatchObject(denied);
      await expect(
        projectBillingPrincipal(f.pool, { ...f.browser, bootstrap: true }, true),
      ).rejects.toMatchObject(denied);
      await expect(
        projectBillingPrincipal(
          f.pool,
          { ...f.browser, keyKind: 'oauth', externalOAuth: true },
          false,
        ),
      ).rejects.toMatchObject(denied);
      await f.pool.query(
        "UPDATE mr_memberships SET accepted_at=accepted_at+interval '1 second' WHERE id=$1",
        [f.browser.membershipId],
      );
      await expect(f.verify(owner, 'billing:read')).rejects.toMatchObject(denied);
    } finally {
      await f.close();
    }
  });

  it('fences API-key cookies and stale versions while preserving stable bearer delegation', async () => {
    const f = await fixture();
    try {
      await f.approve();
      const { key, source } = await f.createKey();
      await expect(projectBillingPrincipal(f.pool, source, false)).rejects.toMatchObject(denied);
      await f.delegate('key', key.id, ['billing:read']);
      const cookie = await f.engine.accounts.createSession(source);
      const keySession = (await f.engine.accounts.session(cookie))!;
      await expect(projectBillingPrincipal(f.pool, keySession, true)).rejects.toMatchObject(denied);
      const actor = await projectBillingPrincipal(f.pool, source, false);
      expect(actor.scopes).toEqual(['read', 'generate', 'billing:read']);
      await expect(
        f.verify({ ...actor, scopes: [...actor.scopes, 'billing:manage'] }, 'billing:manage'),
      ).rejects.toMatchObject(denied);
      await f.pool.query('UPDATE mr_api_keys SET scopes=$2 WHERE id=$1', [
        key.id,
        '["read","billing:manage"]',
      ]);
      await expect(f.verify(actor, 'billing:read')).resolves.toMatchObject({
        scopes: ['read', 'billing:read'],
      });
      const rotation = await new AccountGovernanceStore(f.pool).rotateKey(f.browser, key.id, 1);
      await expect(f.verify(actor, 'billing:read')).rejects.toMatchObject(denied);
      const rotated = (await f.engine.accounts.authenticate(rotation.token))!;
      await expect(projectBillingPrincipal(f.pool, rotated, false)).resolves.toMatchObject({
        keyId: key.id,
        keySecretVersion: 2,
        scopes: ['read', 'billing:read'],
      });
    } finally {
      await f.close();
    }
  });

  it('requires the exact native OAuth grant instead of inheriting a source-key delegation', async () => {
    const f = await fixture();
    try {
      await f.approve();
      const { key, source } = await f.createKey();
      await f.delegate('key', key.id, ['billing:read', 'billing:manage']);
      const oauth = f.engine.mcpOAuth;
      const redirectUri = 'https://client.fixture.invalid/callback';
      const registered = await oauth.registerClient(
        { clientName: 'Synthetic native agent', redirectUris: [redirectUri] },
        'fixture',
      );
      const verifier = 'v'.repeat(43);
      const request = await oauth.beginAuthorization(
        {
          clientId: registered.client_id,
          redirectUri,
          responseType: 'code',
          codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
          codeChallengeMethod: 'S256',
          resource: oauth.resource,
        },
        'fixture',
      );
      const consent = await oauth.approve(request.requestId, source, f.workspaceId, ['read']);
      const tokens = await oauth.exchangeCode({
        clientId: registered.client_id,
        code: new URL(consent.redirectTo).searchParams.get('code')!,
        redirectUri,
        verifier,
        resource: oauth.resource,
      });
      const grant = (await oauth.authenticate(tokens.access_token))!;
      expect(grant).toMatchObject({
        keyKind: 'oauth',
        keyId: key.id,
        clientId: registered.client_id,
      });
      await expect(projectBillingPrincipal(f.pool, grant, false)).rejects.toMatchObject(denied);
      await f.delegate('grant', grant.grantId!, ['billing:read']);
      const actor = await projectBillingPrincipal(f.pool, grant, false);
      expect(actor.scopes).toEqual(['read', 'billing:read']);
      await expect(f.verify(actor, 'billing:manage')).rejects.toMatchObject(denied);
      await expect(
        f.verify({ ...actor, clientId: 'another-client' }, 'billing:read'),
      ).rejects.toMatchObject(denied);
      await expect(f.verify(actor, 'billing:read')).resolves.toMatchObject({
        grantId: grant.grantId,
      });
      await oauth.revoke(registered.client_id, tokens.access_token);
      await expect(f.verify(actor, 'billing:read')).rejects.toMatchObject(denied);
      await expect(projectBillingPrincipal(f.pool, source, false)).resolves.toMatchObject({
        scopes: ['read', 'generate', 'billing:read', 'billing:manage'],
      });
    } finally {
      await f.close();
    }
  });

  it('rechecks approval and delegation revisions inside the caller transaction', async () => {
    const f = await fixture();
    try {
      await f.approve();
      const { key, source } = await f.createKey();
      await f.delegate('key', key.id, ['billing:manage']);
      const actor = await projectBillingPrincipal(f.pool, source, false);
      await f.inWorkspace(async (client) => {
        await client.query('UPDATE mr_billing_delegations SET version=2 WHERE workspace_id=$1', [
          f.workspaceId,
        ]);
        await expect(
          revalidateBillingAuthority(client, actor, 'billing:manage'),
        ).rejects.toMatchObject(denied);
      });
      await f.inWorkspace(async (client) => {
        await client.query(
          'UPDATE mr_billing_owners SET authority_version=2 WHERE workspace_id=$1',
          [f.workspaceId],
        );
        await expect(
          revalidateBillingAuthority(client, actor, 'billing:manage'),
        ).rejects.toMatchObject(denied);
      });
      await expect(f.verify(actor, 'billing:manage')).resolves.toMatchObject({ keyId: key.id });
    } finally {
      await f.close();
    }
  });

  it('restores proof only from the bound setup and its original owner, source and consent', async () => {
    const f = await fixture();
    try {
      await f.approve();
      const owner = await projectBillingPrincipal(f.pool, f.browser, true);
      const setupId = randomUUID();
      await f.pool.query(
        `INSERT INTO mr_billing_customers(id,workspace_id,livemode,processor_environment_id,
           processor_account_id,stripe_customer_id,status,stripe_idempotency_key,started_at)
         VALUES($1,$2,false,'fixture-billing-processor','acct_fixture','cus_fixture','ready',
           'fixture-customer-request',clock_timestamp())`,
        [randomUUID(), f.workspaceId],
      );
      await f.pool.query(
        `INSERT INTO mr_billing_setups(id,workspace_id,livemode,processor_environment_id,
           processor_account_id,customer_id,client_key,stripe_idempotency_key,session_id,status,
           terms_version,terms_snapshot,authority_snapshot,human_membership_id,consent_reference,
           owner_authority_version,owner_consent_reference,owner_membership_epoch,started_at,expires_at)
         SELECT $1,o.workspace_id,false,o.processor_environment_id,'acct_fixture','cus_fixture',
           'fixture-setup-client-key','fixture-setup-request','cs_fixture','open','fixture-v1','{}',
           $3,o.membership_id,$4,o.authority_version,o.consent_reference,o.membership_epoch,
           clock_timestamp(),clock_timestamp()+interval '1 hour'
         FROM mr_billing_owners o WHERE o.workspace_id=$2`,
        [setupId, f.workspaceId, JSON.stringify(owner), `billing-setup:${setupId}`],
      );
      const restore = (client: PoolClient) =>
        projectStoredBillingSetupPrincipal(client, f.workspaceId, setupId);
      await f.inWorkspace(async (client) => {
        const actor = await restore(client);
        await expect(
          revalidateBillingAuthority(client, actor, 'billing:manage'),
        ).resolves.toMatchObject({
          keyId: f.browser.keyId,
          membershipId: f.browser.membershipId,
        });
        await expect(
          projectStoredBillingSetupPrincipal(client, 'other-workspace', setupId),
        ).rejects.toMatchObject(denied);
      });
      await f.inWorkspace(async (client) => {
        await client.query('UPDATE mr_billing_setups SET authority_snapshot=$2 WHERE id=$1', [
          setupId,
          JSON.stringify({ ...owner, scopes: ['read'] }),
        ]);
        await expect(restore(client)).rejects.toMatchObject(denied);
      });
      await f.inWorkspace(async (client) => {
        await client.query(
          'UPDATE mr_billing_owners SET authority_version=2 WHERE workspace_id=$1',
          [f.workspaceId],
        );
        await expect(restore(client)).rejects.toMatchObject(denied);
      });
      await f.inWorkspace(async (client) => {
        await client.query('UPDATE mr_api_keys SET secret_version=2 WHERE id=$1', [
          f.browser.keyId,
        ]);
        await expect(restore(client)).rejects.toMatchObject(denied);
      });
    } finally {
      await f.close();
    }
  });
});
