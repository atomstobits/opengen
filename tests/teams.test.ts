import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { createEngine, keyScopes, type Principal } from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('workspace membership boundaries', () => {
  async function fixture() {
    const engine = createEngine({
      databaseUrl: databaseUrl!,
      vaultKey: 'ab'.repeat(32),
      publicUrl: 'https://opengen.example',
    });
    await engine.initialize();
    const issuer = 'https://identity.example';
    const alice = await engine.accounts.identity(issuer, `alice-${randomUUID()}`);
    const bob = await engine.accounts.identity(issuer, `bob-${randomUUID()}`);
    const eve = await engine.accounts.identity(issuer, `eve-${randomUUID()}`);
    const team = await engine.accounts.createTeam(alice, 'A small studio');
    const aliceSession = await engine.accounts.createSession(alice);
    const owner = await engine.accounts.switchSession(aliceSession, alice, team.id);
    return { engine, alice, bob, eve, team, owner, aliceSession };
  }
  it('requires a verified invite target and explicit acceptance before session selection', async () => {
    const { engine, alice, bob, eve, team, owner } = await fixture();
    try {
      await expect(
        engine.accounts.inviteMember(owner, {
          issuer: 'https://identity.example',
          subject: 'unverified',
          role: 'member',
        }),
      ).rejects.toMatchObject({ code: 'identity_not_found' });
      await engine.accounts.inviteMember(owner, { ...bob.identity!, role: 'member' });
      const directory = await engine.accounts.listWorkspaces(bob);
      expect(directory.find((row) => row.id === team.id)).toMatchObject({
        role: 'member',
        accepted_at: null,
      });
      const session = await engine.accounts.createSession(bob);
      await expect(engine.accounts.switchSession(session, bob, team.id)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(engine.accounts.acceptInvite(eve, team.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await engine.accounts.acceptInvite(bob, team.id);
      const member = await engine.accounts.switchSession(session, bob, team.id);
      expect(member).toMatchObject({
        workspaceId: team.id,
        role: 'member',
        scopes: ['read', 'generate'],
      });
      expect((await engine.accounts.session(session))?.workspaceId).toBe(team.id);
      await expect(
        engine.accounts.switchSession(session, member, alice.workspaceId),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await engine.getBalance(team.id)).toEqual({
        availableMicros: 0,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      await engine.close();
    }
  });

  it('preserves a last administrator and invalidates membership-bound keys and sessions after removal', async () => {
    const { engine, alice, bob, eve, team, owner } = await fixture();
    try {
      await expect(engine.accounts.changeMember(alice, alice.membershipId!, null)).rejects.toThrow(
        'personal workspace owner',
      );
      await expect(engine.accounts.changeMember(owner, owner.membershipId!, null)).rejects.toThrow(
        'at least one',
      );
      const invite = await engine.accounts.inviteMember(owner, { ...bob.identity!, role: 'admin' });
      await engine.accounts.acceptInvite(bob, team.id);
      const session = await engine.accounts.createSession(bob);
      const admin = await engine.accounts.switchSession(session, bob, team.id);
      const key = await engine.accounts.createKey(
        team.id,
        { name: 'Studio agent', scopes: ['read', 'generate'] },
        admin.membershipId,
      );
      expect((await engine.accounts.authenticate(key.token))?.workspaceId).toBe(team.id);
      await expect(engine.accounts.changeMember(eve, invite.id, null)).rejects.toMatchObject({
        statusCode: 404,
      });
      await engine.accounts.changeMember(owner, invite.id, 'member');
      expect((await engine.accounts.session(session))?.scopes).toEqual(['read', 'generate']);
      await expect(
        engine.accounts.createKey(
          team.id,
          { name: 'Escape', scopes: [...keyScopes] },
          admin.membershipId,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      await engine.accounts.changeMember(owner, invite.id, null);
      expect(await engine.accounts.session(session)).toBeNull();
      expect(await engine.accounts.authenticate(key.token)).toBeNull();
      await engine.accounts.inviteMember(owner, { ...bob.identity!, role: 'member' });
      await engine.accounts.acceptInvite(bob, team.id);
      expect(await engine.accounts.authenticate(key.token)).toBeNull();
    } finally {
      await engine.close();
    }
  });

  it('keeps restricted keys fixed to one workspace and prevents delegated scope escalation', async () => {
    const { engine, alice, bob, team, owner } = await fixture();
    try {
      const policy = await engine.accounts.savePolicy(team.id, {
        name: 'EU only',
        policy: { endpointRegions: ['eu-central-1'] },
      });
      const limited = await engine.accounts.createKey(
        team.id,
        { name: 'Restricted administrator', scopes: [...keyScopes], policyId: policy.id },
        owner.membershipId,
      );
      const principal = await engine.accounts.authenticate(limited.token);
      await expect(
        engine.accounts.inviteMember(principal!, { ...bob.identity!, role: 'member' }),
      ).rejects.toMatchObject({ statusCode: 403 });
      const session = await engine.accounts.createSession(principal!);
      await expect(
        engine.accounts.switchSession(session, principal!, alice.workspaceId),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await engine.accounts.listWorkspaces(principal!)).toHaveLength(1);
      const delegated = {
        ...owner,
        scopes: ['read', 'generate', 'members:write'],
      } satisfies Principal;
      await expect(
        engine.accounts.inviteMember(delegated, { ...bob.identity!, role: 'admin' }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await engine.accounts.inviteMember(delegated, { ...bob.identity!, role: 'member' });
    } finally {
      await engine.close();
    }
  });

  it('enforces member/admin boundaries through HTTP and switches only matching HttpOnly sessions', async () => {
    const { engine, bob, team, owner } = await fixture();
    const operatorWorkspace = `operator-${randomUUID()}`;
    await engine.ensureWorkspace(operatorWorkspace);
    const app = await buildApp({
      engine,
      workspaceId: operatorWorkspace,
      apiToken: 'fixture-installation-operator',
      publicUrl: 'https://opengen.example',
    });
    try {
      await engine.accounts.inviteMember(owner, { ...bob.identity!, role: 'member' });
      await engine.accounts.acceptInvite(bob, team.id);
      const rawSession = await engine.accounts.createSession(bob);
      const cookie = `og_session=${rawSession}`;
      const selected = await app.inject({
        method: 'POST',
        url: '/v1/session/workspace',
        headers: { cookie },
        payload: { workspaceId: team.id },
      });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toMatchObject({
        workspaceId: team.id,
        role: 'member',
        isOperator: false,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/keys',
            headers: { cookie },
            payload: { name: 'Escape', scopes: ['keys:write'] },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/members',
            headers: { cookie },
            payload: { ...bob.identity!, role: 'admin' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${team.id}/credits`,
            headers: { cookie },
            payload: { amountMicros: 100, reference: 'unauthorized' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/v1/session',
            headers: { cookie, 'x-workspace-id': operatorWorkspace },
          })
        ).json().workspaceId,
      ).toBe(team.id);
      const operator = await app.inject({
        url: '/v1/session',
        headers: { authorization: 'Bearer fixture-installation-operator' },
      });
      expect(operator.json().isOperator).toBe(true);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/session/workspace',
            headers: { cookie, authorization: 'Bearer fixture-installation-operator' },
            payload: { workspaceId: operatorWorkspace },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
      await engine.close();
    }
  });

  it('never upgrades a legacy API key because its display name resembles an internal browser key', async () => {
    const { engine, alice } = await fixture();
    try {
      const key = await engine.accounts.createKey(alice.workspaceId, {
        name: 'Browser sign-in',
        scopes: ['read'],
      });
      await engine.pool.query(
        await readFile(new URL('../packages/engine/migrations/010.sql', import.meta.url), 'utf8'),
      );
      const principal = await engine.accounts.authenticate(key.token);
      expect(principal).toMatchObject({ keyKind: 'api', scopes: ['read'] });
      const session = await engine.accounts.createSession(principal!);
      await expect(
        engine.accounts.switchSession(session, principal!, alice.workspaceId),
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await engine.close();
    }
  });

  it('serializes key issuance with member removal so reinvitation cannot revive an old credential', async () => {
    const { engine, bob, team, owner } = await fixture();
    try {
      const invitation = await engine.accounts.inviteMember(owner, {
        ...bob.identity!,
        role: 'admin',
      });
      await engine.accounts.acceptInvite(bob, team.id);
      const session = await engine.accounts.createSession(bob);
      const admin = await engine.accounts.switchSession(session, bob, team.id);
      const [created] = await Promise.allSettled([
        engine.accounts.createKey(
          team.id,
          { name: 'Concurrent key', scopes: ['read', 'generate'] },
          admin.membershipId,
        ),
        engine.accounts.changeMember(owner, invitation.id, null),
      ]);
      if (created.status === 'fulfilled')
        expect(await engine.accounts.authenticate(created.value.token)).toBeNull();
      expect(await engine.accounts.session(session)).toBeNull();
      await engine.accounts.inviteMember(owner, { ...bob.identity!, role: 'admin' });
      await engine.accounts.acceptInvite(bob, team.id);
      if (created.status === 'fulfilled')
        expect(await engine.accounts.authenticate(created.value.token)).toBeNull();
      expect(await engine.accounts.session(session)).toBeNull();
    } finally {
      await engine.close();
    }
  });

  it('allows explicitly authorized account OAuth to create an unfunded team while fixed API keys cannot', async () => {
    const { engine, alice } = await fixture();
    try {
      const account: Principal = {
        ...alice,
        keyId: undefined,
        keyKind: 'oauth',
        scopes: ['read', 'generate', 'members:write'],
      };
      const created = await engine.accounts.createTeam(account, 'Agent-created studio');
      expect(
        (await engine.accounts.listWorkspaces(account)).some(
          (workspace) => workspace.id === created.id,
        ),
      ).toBe(true);
      expect((await engine.getBalance(created.id)).availableMicros).toBe(0);
      await expect(
        engine.accounts.createTeam({ ...account, scopes: ['read', 'generate'] }, 'Denied'),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        engine.accounts.createTeam({ ...account, keyKind: 'api' }, 'Denied'),
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await engine.close();
    }
  });
});
