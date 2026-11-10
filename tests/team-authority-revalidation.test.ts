import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountGovernanceStore,
  createEngine,
  keyScopes,
  type Principal,
} from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('team mutations revalidate current credential authority', () => {
  async function fixture() {
    const engine = createEngine({
      databaseUrl: databaseUrl!,
      poolSize: 1,
      publicUrl: 'https://opengen.example',
    });
    await engine.initialize();
    const workspaceId = `team-authority-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId);
    const operator: Principal = { workspaceId, bootstrap: true, scopes: [...keyScopes] };
    const key = await engine.accounts.createKey(workspaceId, {
      name: 'Synthetic team administrator',
      scopes: [...keyScopes],
    });
    const target = await engine.accounts.identity(
      'https://identity.example',
      `invite-target-${randomUUID()}`,
    );
    const governance = new AccountGovernanceStore(engine.pool);
    const app = await buildApp({ engine, publicUrl: 'https://opengen.example', env: {} });

    // Pause precisely between the real credential lookup and the real route's
    // mutation. This models a completed administration action while a request
    // waits; no fabricated principal or handler replacement is involved.
    function afterAuthentication(change: () => Promise<unknown>) {
      const authenticate = engine.accounts.authenticate.bind(engine.accounts);
      return vi.spyOn(engine.accounts, 'authenticate').mockImplementationOnce(async (token) => {
        const principal = await authenticate(token);
        expect(principal).toMatchObject({ keyId: key.id, keySecretVersion: 1 });
        await change();
        return principal;
      });
    }
    return {
      engine,
      app,
      workspaceId,
      operator,
      key,
      target,
      governance,
      afterAuthentication,
      headers: { authorization: `Bearer ${key.token}` },
      async close() {
        vi.restoreAllMocks();
        await app.close();
        await engine.close();
      },
    };
  }

  for (const change of ['revoke', 'rotate', 'cap'] as const)
    it(`denies an invite when the source key changes after authentication: ${change}`, async () => {
      const f = await fixture();
      try {
        f.afterAuthentication(() =>
          change === 'revoke'
            ? f.governance.revokeKey(f.operator, f.key.id)
            : change === 'rotate'
              ? f.governance.rotateKey(f.operator, f.key.id, 1)
              : f.governance.updateKey(f.operator, f.key.id, { monthlyCapMicros: 1_000 }),
        );
        const response = await f.app.inject({
          method: 'POST',
          url: '/v1/members',
          headers: f.headers,
          payload: { ...f.target.identity!, role: 'member' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'policy_denied' } });
        expect(
          (
            await f.engine.pool.query(
              'SELECT id FROM mr_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3',
              [f.workspaceId, f.target.identity!.issuer, f.target.identity!.subject],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        await f.close();
      }
    });

  it('denies removal by a revoked key and retains the target membership', async () => {
    const f = await fixture();
    try {
      const invitation = await f.engine.accounts.inviteMember(f.operator, {
        ...f.target.identity!,
        role: 'member',
      });
      f.afterAuthentication(() => f.governance.revokeKey(f.operator, f.key.id));
      const response = await f.app.inject({
        method: 'DELETE',
        url: `/v1/members/${invitation.id}`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(
        (
          await f.engine.pool.query('SELECT removed_at FROM mr_memberships WHERE id=$1', [
            invitation.id,
          ])
        ).rows[0].removed_at,
      ).toBeNull();
    } finally {
      await f.close();
    }
  });

  it('preserves unrestricted workspace administration and fresh browser authority', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: '/v1/members',
        headers: f.headers,
        payload: { ...f.target.identity!, role: 'member' },
      });
      expect(response.statusCode).toBe(201);
      const browser = await f.engine.accounts.identity(
        'https://identity.example',
        `browser-admin-${randomUUID()}`,
      );
      expect(browser.keySecretVersion).toBe(1);
      const team = await f.engine.accounts.createTeam(browser, 'Synthetic team');
      const session = await f.engine.accounts.createSession(browser);
      const selected = await f.engine.accounts.switchSession(session, browser, team.id);
      expect(selected.keySecretVersion).toBe(1);
      await expect(
        f.engine.accounts.inviteMember(selected, { ...f.target.identity!, role: 'member' }),
      ).resolves.toMatchObject({ status: 'invited' });
    } finally {
      await f.close();
    }
  });
});
