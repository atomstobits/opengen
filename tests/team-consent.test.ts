import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEngine } from '@media-router/engine';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('invitation acceptance is an account-consent operation', () => {
  it('denies a read-only fixed project key while preserving explicit browser acceptance', async () => {
    const engine = createEngine({ databaseUrl: databaseUrl! });
    try {
      await engine.initialize();
      const issuer = 'https://issuer.example',
        ownerSubject = `owner-${randomUUID()}`,
        recipientSubject = `recipient-${randomUUID()}`;
      const owner = await engine.accounts.identity(issuer, ownerSubject);
      const recipient = await engine.accounts.identity(issuer, recipientSubject);
      const team = await engine.accounts.createTeam(owner, 'Synthetic consent fixture');
      const ownerSession = await engine.accounts.createSession(owner);
      const administrator = await engine.accounts.switchSession(ownerSession, owner, team.id);
      const invitation = await engine.accounts.inviteMember(administrator, {
        issuer,
        subject: recipientSubject,
        role: 'member',
      });
      const key = await engine.accounts.createKey(
        recipient.workspaceId,
        { name: 'Read-only project integration', scopes: ['read'] },
        recipient.membershipId,
      );
      const fixed = await engine.accounts.authenticate(key.token);
      expect(fixed).toMatchObject({
        keyKind: 'api',
        scopes: ['read'],
        identity: { issuer, subject: recipientSubject },
      });
      await expect(engine.accounts.acceptInvite(fixed!, team.id)).rejects.toMatchObject({
        statusCode: 403,
      });
      const pending = (
        await engine.pool.query('SELECT accepted_at FROM mr_memberships WHERE id=$1', [
          invitation.id,
        ])
      ).rows[0];
      expect(pending.accepted_at).toBeNull();
      const accepted = await engine.accounts.acceptInvite(recipient, team.id);
      expect(accepted.workspace_id).toBe(team.id);
      expect(accepted.accepted_at).not.toBeNull();
    } finally {
      await engine.close();
    }
  });
});
