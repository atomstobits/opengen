import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createEngine, type Principal } from '@media-router/engine';
import {
  McpOAuthStore,
  validateOAuthRedirect,
  intersectOAuthPolicy,
  oauthScopes,
} from '../packages/engine/src/mcp-oauth';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerMcpAuthorization } from '../apps/server/src/mcp-authorization';

const issuer = 'https://opengen.example';
const verifier = 'a'.repeat(43),
  challenge = createHash('sha256').update(verifier).digest('base64url');
describe('MCP OAuth protocol boundaries', () => {
  it('accepts exact public HTTPS, literal loopback and explicit-port localhost callbacks', () => {
    expect(validateOAuthRedirect('https://client.example/callback?application=desktop')).toBe(
      'https://client.example/callback?application=desktop',
    );
    for (const value of [
      'http://127.0.0.1:65432/callback',
      'http://[::1]:65432/callback',
      'http://localhost:8787/callback',
      'http://localhost:65432/oauth/callback?application=desktop',
      'http://localhost:80/callback',
    ])
      expect(validateOAuthRedirect(value)).toBe(value);
    for (const value of [
      'http://client.example/callback',
      'https://user:password@client.example/callback',
      'https://client.example/callback#secret',
      'http://localhost/callback',
      'http://localhost:0/callback',
      'http://localhost:65536/callback',
      'http://localhost.:8787/callback',
      'http://%6cocalhost:8787/callback',
      'http://app.localhost:8787/callback',
      'http://localhost.evil.example:8787/callback',
      'http://192.168.1.1:8787/callback',
      'http://0.0.0.0:8787/callback',
      'http://user:secret@localhost:8787/callback',
      'http://localhost:8787/callback#fragment',
      'http://localhost:8787/callback?code=existing',
      'http://localhost:8787/callback?state=existing',
      'http://localhost:8787/callback?error=existing',
      'file:///tmp/callback',
      'https://127.0.0.1/callback',
      'https://client.example/callback?code=existing',
      'https://client.example/call\nback',
    ])
      expect(() => validateOAuthRedirect(value)).toThrow();
    expect(() => oauthScopes('read keys:write')).toThrow();
  });
  it('intersects current and original restrictions rather than widening delegated authority', () => {
    expect(
      intersectOAuthPolicy(
        { endpointRegions: ['eu-central-1'], fidelity: 'native', fallback: false },
        { endpointRegions: ['us-east-1'], fidelity: 'any', fallback: true },
      ),
    ).toMatchObject({ endpointRegions: [], fidelity: 'native', fallback: false });
  });
  it('does not offer account sign-in before the identity provider is configured', async () => {
    const app = Fastify();
    const unauthenticated = async (): Promise<Principal> => {
      throw new Error('No session');
    };
    await registerMcpAuthorization(app, {
      publicUrl: issuer,
      signInEnabled: false,
      authenticateBrowser: unauthenticated,
      authenticate: unauthenticated,
    });
    try {
      const response = await app.inject({ url: '/oauth/consent?request=not-authenticated' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'login_required', loginUrl: null });
      expect((await app.inject({ url: '/oauth/login?request=not-authenticated' })).statusCode).toBe(
        503,
      );
      const malformed = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/json' },
        payload: '{private-token-do-not-echo',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toBe('invalid_request');
      expect(malformed.body).not.toContain('private-token-do-not-echo');
      expect(malformed.headers['cache-control']).toBe('no-store');
      expect(malformed.headers['access-control-allow-origin']).toBe('*');
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('durable MCP OAuth authorization', () => {
  async function fixture() {
    const engine = createEngine({ databaseUrl: process.env.TEST_DATABASE_URL! });
    await engine.initialize();
    const store = new McpOAuthStore(engine.pool, engine.accounts, { issuer });
    const subject = randomUUID();
    const browser = await engine.accounts.identity('https://identity.example', subject);
    const team = await engine.accounts.createTeam(browser, 'Film studio');
    const teamSession = await engine.accounts.createSession(browser);
    const teamAdmin = await engine.accounts.switchSession(teamSession, browser, team.id);
    const client = await store.registerClient(
      { clientName: 'Synthetic hosted client', redirectUris: ['https://client.example/callback'] },
      subject,
    );
    return { engine, store, browser, team, teamAdmin, client, subject };
  }
  async function consent(
    f: Awaited<ReturnType<typeof fixture>>,
    actor = f.browser,
    workspace = f.team.id,
  ) {
    const request = await f.store.beginAuthorization(
      {
        clientId: f.client.client_id,
        redirectUri: f.client.redirect_uris[0]!,
        responseType: 'code',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        resource: f.store.resource,
        state: 'caller-state',
      },
      f.subject,
    );
    const approved = await f.store.approve(request.requestId, actor, workspace, [
      'read',
      'generate',
    ]);
    const url = new URL(approved.redirectTo);
    expect(url.searchParams.get('state')).toBe('caller-state');
    return { request, code: url.searchParams.get('code')! };
  }
  async function exchange(f: Awaited<ReturnType<typeof fixture>>, code: string) {
    return f.store.exchangeCode({
      clientId: f.client.client_id,
      code,
      redirectUri: f.client.redirect_uris[0]!,
      verifier,
      resource: f.store.resource,
    });
  }

  it('binds consent to the paying workspace and enforces redirect, PKCE and resource before issuing tokens', async () => {
    const f = await fixture();
    try {
      const { request, code } = await consent(f);
      expect(await f.store.pendingAuthorization(request.requestId)).toBe(false);
      await expect(
        f.store.exchangeCode({
          clientId: f.client.client_id,
          code,
          redirectUri: 'https://other.example/callback',
          verifier,
        }),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      await expect(
        f.store.exchangeCode({
          clientId: f.client.client_id,
          code,
          redirectUri: f.client.redirect_uris[0]!,
          verifier: 'b'.repeat(43),
        }),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      await expect(
        f.store.exchangeCode({
          clientId: f.client.client_id,
          code,
          redirectUri: f.client.redirect_uris[0]!,
          verifier,
          resource: 'https://other.example/mcp',
        }),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      const tokens = await exchange(f, code);
      expect(await f.store.authenticate(tokens.access_token)).toMatchObject({
        workspaceId: f.team.id,
        scopes: ['read', 'generate'],
        keyKind: 'oauth',
      });
      expect(
        await new McpOAuthStore(f.engine.pool, f.engine.accounts, {
          issuer: 'https://other-opengen.example',
        }).authenticate(tokens.access_token),
      ).toBeNull();
      const stored = JSON.stringify(
        (
          await f.engine.pool.query(
            'SELECT * FROM mr_mcp_oauth_access WHERE grant_id IN (SELECT id FROM mr_mcp_oauth_grants WHERE workspace_id=$1)',
            [f.team.id],
          )
        ).rows,
      );
      expect(stored).not.toContain(tokens.access_token);
      await expect(exchange(f, code)).rejects.toMatchObject({ code: 'invalid_grant' });
      expect(await f.store.authenticate(tokens.access_token)).toBeNull();
    } finally {
      await f.engine.close();
    }
  });
  it('keeps localhost callbacks exact across registration, authorization and token exchange', async () => {
    const f = await fixture();
    try {
      const redirectUri = 'http://localhost:8787/callback';
      const client = await f.store.registerClient(
        {
          clientName: 'Synthetic native client',
          redirectUris: [redirectUri, 'https://www.cursor.com/agents/mcp/oauth/callback'],
        },
        f.subject,
      );
      const local = { ...f, client };
      for (const alternative of [
        'http://localhost:8788/callback',
        'http://localhost:8787/other-path',
        'http://localhost:8787/callback?application=desktop',
        'http://127.0.0.1:8787/callback',
      ]) {
        await expect(
          f.store.beginAuthorization(
            {
              clientId: client.client_id,
              redirectUri: alternative,
              responseType: 'code',
              codeChallenge: challenge,
              codeChallengeMethod: 'S256',
              resource: f.store.resource,
            },
            f.subject,
          ),
        ).rejects.toMatchObject({ code: 'invalid_request' });
      }
      const { code } = await consent(local);
      await expect(
        f.store.exchangeCode({
          clientId: client.client_id,
          code,
          redirectUri: 'http://localhost:8788/callback',
          verifier,
          resource: f.store.resource,
        }),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      await expect(
        f.store.exchangeCode({
          clientId: client.client_id,
          code,
          redirectUri,
          verifier: 'b'.repeat(43),
          resource: f.store.resource,
        }),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      await expect(
        f.store.exchangeCode({
          clientId: client.client_id,
          code,
          redirectUri,
          verifier,
          resource: 'https://other.example/mcp',
        }),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      const tokens = await exchange(local, code);
      expect(await f.store.authenticate(tokens.access_token)).toMatchObject({
        workspaceId: f.team.id,
        keyKind: 'oauth',
      });
    } finally {
      await f.engine.close();
    }
  });
  it('rotates refresh tokens, narrows scopes and revokes the family on replay', async () => {
    const f = await fixture();
    try {
      const first = await exchange(f, (await consent(f)).code);
      const second = await f.store.refresh({
        clientId: f.client.client_id,
        refreshToken: first.refresh_token,
        scope: 'read',
      });
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect((await f.store.authenticate(second.access_token))?.scopes).toEqual(['read']);
      await expect(
        f.store.refresh({
          clientId: f.client.client_id,
          refreshToken: second.refresh_token,
          scope: 'read generate',
        }),
      ).rejects.toMatchObject({ code: 'invalid_scope' });
      await expect(
        f.store.refresh({ clientId: f.client.client_id, refreshToken: first.refresh_token }),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      expect(await f.store.authenticate(second.access_token)).toBeNull();
    } finally {
      await f.engine.close();
    }
  });
  it('does not revive a browser grant when membership is removed and re-invited', async () => {
    const f = await fixture();
    try {
      const guest = await f.engine.accounts.identity(
        'https://identity.example',
        `guest-${f.subject}`,
      );
      const invite = await f.engine.accounts.inviteMember(f.teamAdmin, {
        ...guest.identity!,
        role: 'member',
      });
      await f.engine.accounts.acceptInvite(guest, f.team.id);
      const first = await exchange(f, (await consent(f, guest)).code);
      expect(await f.store.authenticate(first.access_token)).not.toBeNull();
      await f.engine.accounts.changeMember(f.teamAdmin, invite.id, null);
      await f.engine.accounts.inviteMember(f.teamAdmin, { ...guest.identity!, role: 'member' });
      await f.engine.accounts.acceptInvite(guest, f.team.id);
      expect(await f.store.authenticate(first.access_token)).toBeNull();
    } finally {
      await f.engine.close();
    }
  });
  it('keeps fixed-key sessions in one workspace and retains both original and current policy limits', async () => {
    const f = await fixture();
    try {
      const policy = await f.engine.accounts.savePolicy(f.browser.workspaceId, {
        name: 'EU',
        policy: { endpointRegions: ['eu-central-1'] },
        maxCostMicros: 500,
      });
      const key = await f.engine.accounts.createKey(f.browser.workspaceId, {
        name: 'CLI',
        scopes: ['read', 'generate'],
        policyId: policy.id,
      });
      const actor = (await f.engine.accounts.authenticate(key.token))!;
      await expect(consent(f, actor, f.team.id)).rejects.toMatchObject({ code: 'access_denied' });
      const tokens = await exchange(f, (await consent(f, actor, actor.workspaceId)).code);
      await f.engine.pool.query(
        'UPDATE mr_policies SET policy=$2,max_cost_micros=1000 WHERE id=$1',
        [policy.id, JSON.stringify({ endpointRegions: ['eu-central-1', 'us-east-1'] })],
      );
      expect(await f.store.authenticate(tokens.access_token)).toMatchObject({
        workspaceId: actor.workspaceId,
        policy: { endpointRegions: ['eu-central-1'] },
        maxCostMicros: 500,
      });
      await f.engine.accounts.revokeKey(actor.workspaceId, key.id);
      expect(await f.store.authenticate(tokens.access_token)).toBeNull();
    } finally {
      await f.engine.close();
    }
  });
  it('keeps browser grants independent of ephemeral browser-key expiry and refuses bootstrap delegation', async () => {
    const f = await fixture();
    try {
      await expect(
        f.store.consentView(
          (
            await f.store.beginAuthorization(
              {
                clientId: f.client.client_id,
                redirectUri: f.client.redirect_uris[0]!,
                responseType: 'code',
                codeChallenge: challenge,
                codeChallengeMethod: 'S256',
              },
              f.subject,
            )
          ).requestId,
          { workspaceId: f.browser.workspaceId, scopes: ['read', 'generate'], bootstrap: true },
        ),
      ).rejects.toMatchObject({ code: 'access_denied' });
      const tokens = await exchange(f, (await consent(f)).code);
      await f.engine.pool.query(
        "UPDATE mr_api_keys SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [f.browser.keyId],
      );
      expect(await f.store.authenticate(tokens.access_token)).toMatchObject({
        workspaceId: f.team.id,
      });
      await f.store.revoke(f.client.client_id, tokens.refresh_token);
      expect(await f.store.authenticate(tokens.access_token)).toBeNull();
    } finally {
      await f.engine.close();
    }
  });
  it('uses standard protocol forms and explicit browser consent rather than bearer-only authorization', async () => {
    const f = await fixture();
    const app = Fastify();
    await app.register(cookie);
    await registerMcpAuthorization(app, {
      store: f.store,
      publicUrl: issuer,
      authenticateBrowser: async () => f.browser,
      authenticate: async () => f.browser,
    });
    try {
      expect(
        (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json(),
      ).toMatchObject({
        issuer,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      const auth = await f.store.beginAuthorization(
        {
          clientId: f.client.client_id,
          redirectUri: f.client.redirect_uris[0]!,
          responseType: 'code',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
        },
        f.subject,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/oauth/consent',
            headers: { origin: 'https://attacker.example' },
            payload: {
              requestId: auth.requestId,
              workspaceId: f.team.id,
              scopes: ['read'],
              approve: true,
            },
          })
        ).statusCode,
      ).toBe(403);
      const approval = await app.inject({
        method: 'POST',
        url: '/oauth/consent',
        headers: { origin: issuer },
        payload: {
          requestId: auth.requestId,
          workspaceId: f.team.id,
          scopes: ['read'],
          approve: true,
        },
      });
      const code = new URL(approval.json().redirectTo).searchParams.get('code')!;
      const response = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: f.client.client_id,
          code,
          redirect_uri: f.client.redirect_uris[0]!,
          code_verifier: verifier,
        }).toString(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().scope).toBe('read');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBe('*');
    } finally {
      await app.close();
      await f.engine.close();
    }
  });
});
