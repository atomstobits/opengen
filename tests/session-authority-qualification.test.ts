import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createEngine,
  AccountStore,
  AccountGovernanceStore,
  keyScopes,
  revalidateGovernanceAuthority,
} from '../packages/engine/src/index.js';
import { buildApp } from '../apps/server/src/app';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import { privateStorageFixture } from './helpers/private-storage';
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('session source authority qualification', () => {
  it('exchanges readless identity but rejects stale authenticated principals after rotation or revocation', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'session_authority');
    const publicUrl = 'https://session.fixture.invalid';
    const workspaceId = 'session-owner';
    const operatorToken = 'fixture-operator-not-live';
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        publicUrl,
        adapters: [],
        poolSize: 1,
        providerEnv: {},
        vaultKey: '0'.repeat(64),
        storage: privateStorageFixture(),
      }),
    );
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    const cookieOf = (response: any) => String(response.headers['set-cookie'] ?? '').split(';')[0];
    const admin: any = { workspaceId, scopes: [...keyScopes], bootstrap: true };
    try {
      await engine.initialize();
      await engine.ensureWorkspace(workspaceId, 0);
      app = await buildApp({ engine, workspaceId, apiToken: operatorToken, publicUrl, env: {} });
      const governance = new AccountGovernanceStore(engine.pool);
      const readless = await engine.accounts.createKey(workspaceId, {
        name: 'Readless manager',
        scopes: ['keys:write'],
      });
      const metadata = await app.inject({
        url: '/v1/session',
        headers: { authorization: `Bearer ${readless.token}` },
      });
      const readlessExchange = await app.inject({
        method: 'POST',
        url: '/v1/session',
        payload: { token: readless.token },
      });
      assert.equal(metadata.json().authenticated, true);
      assert.equal(readlessExchange.statusCode, 200);
      {
        assert.deepEqual(readlessExchange.json().scopes, ['keys:write']);
        const cookie = cookieOf(readlessExchange);
        assert.equal(
          (await app.inject({ url: '/v1/session', headers: { cookie } })).json().authenticated,
          true,
        );
        assert.equal(
          (await app.inject({ url: '/v1/governance/keys', headers: { cookie } })).statusCode,
          200,
        );
        assert.equal(
          (await app.inject({ url: '/v1/generations', headers: { cookie } })).statusCode,
          403,
        );
      }
      async function pendingExchange(action: 'rotate' | 'revoke') {
        const key = await engine.accounts.createKey(workspaceId, {
          name: 'Pending ' + action,
          scopes: ['read', 'keys:write'],
        });
        const original = engine.accounts.createSession;
        let signal!: () => void;
        const entered = new Promise<void>((resolve) => {
          signal = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let version: number | undefined;
        engine.accounts.createSession = async (principal, token) => {
          version = principal.keySecretVersion;
          signal();
          await gate;
          return original.call(engine.accounts, principal, token);
        };
        const request = Promise.resolve(
          app!.inject({ method: 'POST', url: '/v1/session', payload: { token: key.token } }),
        );
        let timer: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            entered,
            new Promise((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('The session request did not authenticate.')),
                5000,
              );
            }),
          ]);
          clearTimeout(timer!);
          assert.equal(version, 1);
          if (action === 'rotate') await governance.rotateKey(admin, key.id, 1);
          else await governance.revokeKey(admin, key.id);
          release();
          const response = await request;
          assert.equal(response.statusCode, 403);
          {
            assert.equal(response.headers['set-cookie'], undefined);
            assert.equal(response.json().error.code, 'policy_denied');
          }
          const count = (
            await engine.pool.query(
              'SELECT count(*)::int AS n FROM mr_sessions WHERE workspace_id=$1 AND key_id=$2',
              [workspaceId, key.id],
            )
          ).rows[0].n;
          assert.equal(count, 0);
          const cookie = cookieOf(response);
          const active = cookie
            ? (await app!.inject({ url: '/v1/session', headers: { cookie } })).json().authenticated
            : false;
          assert.equal(active, false);
          return {
            statusCode: response.statusCode,
            newSessions: count,
            cookieAuthenticated: active,
          };
        } finally {
          release();
          engine.accounts.createSession = original;
          await request.catch(() => {});
        }
      }
      const rotation = await pendingExchange('rotate');
      const revocation = await pendingExchange('revoke');
      // A session committed before a later rotation must still be revoked normally.
      const normal = await engine.accounts.createKey(workspaceId, {
        name: 'Ordinary API',
        scopes: ['read', 'keys:write'],
      });
      const beforeRotation = await app.inject({
        method: 'POST',
        url: '/v1/session',
        payload: { token: normal.token },
      });
      assert.equal(beforeRotation.statusCode, 200);
      const normalCookie = cookieOf(beforeRotation);
      assert.equal(
        (await app.inject({ url: '/v1/session', headers: { cookie: normalCookie } })).json()
          .authenticated,
        true,
      );
      await governance.rotateKey(admin, normal.id, 1);
      assert.equal(
        (await app.inject({ url: '/v1/session', headers: { cookie: normalCookie } })).json()
          .authenticated,
        false,
      );
      // Preserve the delegated OAuth ban before even pool cleanup/checkout.
      let forbiddenQueries = 0;
      const detached = new AccountStore({
        query: async () => {
          forbiddenQueries++;
          throw new Error('No query allowed');
        },
        connect: async () => {
          forbiddenQueries++;
          throw new Error('No checkout allowed');
        },
      } as any);
      await assert.rejects(
        detached.createSession({
          workspaceId,
          keyId: normal.id,
          keyKind: 'oauth',
          keySecretVersion: 1,
          scopes: ['read'],
          grantId: '11111111-1111-4111-8111-111111111111',
        }),
        { code: 'policy_denied' },
      );
      assert.equal(forbiddenQueries, 0);
      {
        const principal = (await engine.accounts.authenticate(readless.token))!;
        const client = await engine.pool.connect();
        try {
          await client.query('BEGIN');
          await assert.rejects(revalidateGovernanceAuthority(client, principal), {
            code: 'policy_denied',
          });
          assert.deepEqual((await revalidateGovernanceAuthority(client, principal, null)).scopes, [
            'keys:write',
          ]);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        const policy = await engine.accounts.savePolicy(workspaceId, {
          name: 'Restricted cookie policy',
          policy: { endpointRegions: ['eu-central-1'] },
          maxCostMicros: 100,
        });
        const limited = await engine.accounts.createKey(workspaceId, {
          name: 'Constrained API',
          scopes: ['read', 'generate'],
          policyId: policy.id,
        });
        const staleLimits = (await engine.accounts.authenticate(limited.token))!;
        await engine.pool.query('UPDATE mr_policies SET max_cost_micros=20 WHERE id=$1', [
          policy.id,
        ]);
        await engine.pool.query(
          'UPDATE mr_api_keys SET monthly_cap_micros=30,scopes=\'["generate"]\' WHERE id=$1',
          [limited.id],
        );
        const limitedCookie = await engine.accounts.createSession(staleLimits);
        const constrained = await engine.accounts.session(limitedCookie);
        assert.deepEqual(constrained?.scopes, ['generate']);
        assert.equal(constrained?.maxCostMicros, 20);
        assert.equal(constrained?.monthlyCapMicros, 30);
        const limitedHttp = await app.inject({
          method: 'POST',
          url: '/v1/session',
          payload: { token: limited.token },
        });
        assert.equal(limitedHttp.statusCode, 200);
        assert.deepEqual(limitedHttp.json().scopes, ['generate']);
        assert.equal(
          (await app.inject({ url: '/v1/generations', headers: { cookie: cookieOf(limitedHttp) } }))
            .statusCode,
          403,
        );
        const bootstrap = await app.inject({
          method: 'POST',
          url: '/v1/session',
          payload: { token: operatorToken },
        });
        assert.equal(bootstrap.statusCode, 200);
        assert.equal(bootstrap.json().isOperator, true);
        assert.equal(
          (
            await app.inject({ url: '/v1/session', headers: { cookie: cookieOf(bootstrap) } })
          ).json().isOperator,
          true,
        );
        const browser = await engine.accounts.identity(
          'https://identity.fixture.invalid',
          'synthetic-browser',
        );
        assert.equal(browser.keySecretVersion, 1);
        const browserSession = await engine.accounts.createSession(browser);
        assert.equal((await engine.accounts.session(browserSession))?.keyKind, 'browser');
        const browserMetadata = await app.inject({
          url: '/v1/session',
          headers: { cookie: `og_session=${browserSession}` },
        });
        assert.equal(browserMetadata.json().canSwitchWorkspace, true);
        await engine.pool.query('UPDATE mr_memberships SET removed_at=now() WHERE id=$1', [
          browser.membershipId,
        ]);
        await assert.rejects(engine.accounts.createSession(browser), { code: 'policy_denied' });
      }
    } finally {
      await app?.close();
      await engine.close();
      await isolated.close();
    }
  }, 60000);
});
