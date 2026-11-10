import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  createEngine,
  McpOAuthStore,
  type AccountStore,
  type Principal,
} from '@media-router/engine';
import { registerAccounts } from '../apps/server/src/accounts';
import { registerMcpAuthorization } from '../apps/server/src/mcp-authorization';
import { buildApp } from '../apps/server/src/app';

// Exercise our callback/session boundaries without contacting a real identity provider.
// ID-token and state/nonce verification itself remains the openid-client library's contract.
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(async () => ({})),
    buildAuthorizationUrl: vi.fn(() => new URL('https://identity.example/authorize')),
    authorizationCodeGrant: vi.fn(async () => ({
      claims: () => ({ iss: 'https://identity.example', sub: 'verified-human' }),
    })),
  };
});

const issuer = 'https://opengen.example';
const verifier = 's'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const cookies = (headers: Record<string, unknown>) => {
  const value = headers['set-cookie'];
  return (Array.isArray(value) ? value : value ? [value] : []).map(
    (item) => String(item).split(';')[0]!,
  );
};

async function continueBrowserLogin(app: FastifyInstance, consentRequest?: string) {
  const pendingCookie = consentRequest ? [`og_mcp_consent=${consentRequest}`] : [];
  const notice = await app.inject({
    url: '/auth/login',
    headers: { cookie: pendingCookie.join('; ') },
  });
  expect(notice.statusCode).toBe(200);
  expect(notice.headers['content-type']).toContain('text/html');
  const tokenInput = notice.body.match(/<input\b[^>]*name="actionToken"[^>]*>/)?.[0];
  const token = tokenInput?.match(/value="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(token).toBeTruthy();
  const result = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: {
      origin: issuer,
      cookie: [...pendingCookie, ...cookies(notice.headers)].join('; '),
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ action: 'continue', actionToken: token! }).toString(),
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers.location).toBeUndefined();
  expect(result.body).toMatch(
    /<a\b[^>]*id="oidc-handoff"[^>]*href="https:\/\/identity\.example\/authorize/,
  );
  return result;
}

describe('native authorization configuration', () => {
  it('lands browser sign-in on Start while preserving valid MCP consent precedence', async () => {
    const app = Fastify();
    const principal: Principal = {
      workspaceId: 'signed-in-fixture',
      scopes: ['read', 'generate'],
      keyId: 'browser-key-fixture',
      keyKind: 'browser',
      identity: { issuer: 'https://identity.example', subject: 'verified-human' },
    };
    const identity = vi.fn(async () => principal);
    const createSession = vi.fn(async () => 'b'.repeat(64));
    const pendingRequestId = `og_req_${'n'.repeat(43)}`;
    const pendingAuthorization = vi.fn(async (request: string) => request === pendingRequestId);
    await registerAccounts(app, {
      engine: {
        accounts: { identity, createSession } as unknown as AccountStore,
        mcpOAuth: { pendingAuthorization } as unknown as McpOAuthStore,
      },
      publicUrl: issuer,
      env: {
        NODE_ENV: 'test',
        OIDC_ISSUER: 'https://identity.example',
        OIDC_CLIENT_ID: 'client-fixture',
        OIDC_CLIENT_SECRET: 'server-only-fixture',
        MR_SESSION_SECRET: 'a'.repeat(32),
      },
    });
    try {
      for (const [consentRequest, expectedLocation] of [
        [undefined, `${issuer}/app#start`],
        [pendingRequestId, `${issuer}/oauth/consent?request=${pendingRequestId}`],
      ]) {
        const begin = await continueBrowserLogin(app, consentRequest);
        const transactionCookie = cookies(begin.headers).find((value) =>
          value.startsWith('og_oidc='),
        )!;
        const callback = await app.inject({
          url: '/auth/callback?code=fixture&returnTo=https://attacker.example',
          headers: {
            cookie: [
              transactionCookie,
              ...(consentRequest ? [`og_mcp_consent=${consentRequest}`] : []),
            ].join('; '),
          },
        });
        expect(callback.statusCode).toBe(302);
        expect(callback.headers.location).toBe(expectedLocation);
        expect(cookies(callback.headers)).toContain('og_oidc=');
        expect(cookies(callback.headers)).toContain('og_mcp_consent=');
        expect(cookies(callback.headers)).toContain(`og_session=${'b'.repeat(64)}`);
      }
      expect(
        (
          await app.inject({
            url: '/auth/login',
            headers: { cookie: 'og_mcp_consent=https%3A%2F%2Fattacker.example' },
          })
        ).statusCode,
      ).toBe(401);
      expect(identity).toHaveBeenCalledWith('https://identity.example', 'verified-human');
      expect(createSession).toHaveBeenCalledWith(principal);
      expect(pendingAuthorization).toHaveBeenCalledWith(pendingRequestId);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed explicit credentials instead of silently using a cookie payer', async () => {
    const app = Fastify();
    const payer: Principal = {
      workspaceId: 'cookie-payer',
      scopes: ['read', 'generate'],
      keyKind: 'api',
    };
    const accounts = {
      session: async () => payer,
      authenticate: async (token: string) =>
        token === 'valid-fixture-bearer' ? { ...payer, workspaceId: 'bearer-payer' } : null,
    } as unknown as AccountStore;
    const hooks = await registerAccounts(app, {
      engine: { accounts },
      publicUrl: issuer,
      env: { NODE_ENV: 'test' },
    });
    app.get('/test/private', async (request) => hooks.authenticate(request, 'generate'));
    app.get('/test/browser', async (request) => hooks.authenticateBrowser(request));
    try {
      for (const authorization of [
        '',
        'Basic wrong-credential',
        'Bearer',
        'Bearer ',
        'Bearer token extra',
      ]) {
        expect(
          (
            await app.inject({
              url: '/test/private',
              headers: { cookie: 'og_session=fixture', authorization },
            })
          ).statusCode,
        ).toBe(401);
      }
      const cookieOnly = await app.inject({
        url: '/test/private',
        headers: { cookie: 'og_session=fixture' },
      });
      expect(cookieOnly.json().workspaceId).toBe('cookie-payer');
      const bearer = await app.inject({
        url: '/test/private',
        headers: { cookie: 'og_session=fixture', authorization: 'bearer valid-fixture-bearer' },
      });
      expect(bearer.json().workspaceId).toBe('bearer-payer');
      const browser = await app.inject({
        url: '/test/browser',
        headers: {
          cookie: 'og_session=fixture',
          authorization: 'Basic ignored-by-explicit-cookie-only-flow',
        },
      });
      expect(browser.json().workspaceId).toBe('cookie-payer');
    } finally {
      await app.close();
    }
  });

  it('rejects a different engine issuer at startup and advertises a matching explicit public origin', async () => {
    const engine = createEngine({
      databaseUrl: 'postgresql://unused.invalid/not-queried',
      publicUrl: issuer,
    });
    try {
      await expect(
        buildApp({ engine, publicUrl: 'https://different.example', env: { NODE_ENV: 'test' } }),
      ).rejects.toThrow('engine OAuth issuer must match');
      const app = await buildApp({ engine, publicUrl: issuer, env: { NODE_ENV: 'test' } });
      try {
        expect(
          (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json().issuer,
        ).toBe(issuer);
        expect(
          (await app.inject({ url: '/.well-known/oauth-protected-resource/mcp' })).json().resource,
        ).toBe(`${issuer}/mcp`);
      } finally {
        await app.close();
      }
    } finally {
      await engine.close();
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('native MCP authorization integration', () => {
  async function fixture(signIn = false) {
    const engine = createEngine({ databaseUrl: process.env.TEST_DATABASE_URL! });
    await engine.initialize();
    const store = new McpOAuthStore(engine.pool, engine.accounts, { issuer });
    const browser = await engine.accounts.identity('https://identity.example', randomUUID());
    const client = await store.registerClient(
      {
        clientName: 'Native hosted connector',
        redirectUris: ['https://client.example/callback'],
      },
      randomUUID(),
    );
    const app = Fastify();
    const hooks = await registerAccounts(app, {
      engine: { accounts: engine.accounts, mcpOAuth: store },
      apiToken: 'installation-operator-fixture',
      publicUrl: issuer,
      env: signIn
        ? {
            NODE_ENV: 'test',
            OIDC_ISSUER: 'https://identity.example',
            OIDC_CLIENT_ID: 'client-fixture',
            OIDC_CLIENT_SECRET: 'server-only-fixture',
            MR_SESSION_SECRET: 'a'.repeat(32),
          }
        : { NODE_ENV: 'test' },
    });
    await registerMcpAuthorization(app, {
      store,
      publicUrl: issuer,
      signInEnabled: hooks.oidcEnabled,
      authenticate: hooks.authenticate,
      authenticateBrowser: hooks.authenticateBrowser,
    });
    app.get('/test/private', async (request) => hooks.authenticate(request));
    const authorization = () =>
      store.beginAuthorization(
        {
          clientId: client.client_id,
          redirectUri: client.redirect_uris[0]!,
          responseType: 'code',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          scope: 'read generate',
          state: 'client-state',
          resource: `${issuer}/mcp`,
        },
        randomUUID(),
      );
    return { engine, store, browser, client, app, authorization };
  }

  it('uses cookie identity for consent and accepts public-client token/revoke exchanges across origins', async () => {
    const f = await fixture();
    try {
      const key = await f.engine.accounts.createKey(f.browser.workspaceId, {
        name: 'Agent key',
        scopes: ['read', 'generate'],
      });
      const auth = await f.authorization();
      const onlyBearer = await f.app.inject({
        url: `/oauth/consent?request=${auth.requestId}`,
        headers: { authorization: `Bearer ${key.token}` },
      });
      expect(onlyBearer.statusCode).toBe(401);
      expect(onlyBearer.json().loginUrl).toBeNull();
      const cookie = `og_session=${await f.engine.accounts.createSession(f.browser)}`;
      const view = await f.app.inject({
        url: `/oauth/consent?request=${auth.requestId}`,
        headers: { cookie, authorization: 'Bearer ignored-for-browser-consent' },
      });
      expect(view.statusCode).toBe(200);
      expect(view.json().workspaces).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: f.browser.workspaceId })]),
      );
      const payload = {
        requestId: auth.requestId,
        workspaceId: f.browser.workspaceId,
        scopes: ['read'],
        approve: true,
      };
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/oauth/consent',
            headers: { cookie, origin: 'https://client.example' },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/oauth/consent',
            headers: { cookie },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      const approved = await f.app.inject({
        method: 'POST',
        url: '/oauth/consent',
        headers: { cookie, origin: issuer },
        payload,
      });
      expect(approved.statusCode).toBe(200);
      const code = new URL(approved.json().redirectTo).searchParams.get('code')!;
      const exchanged = await f.app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: {
          origin: 'https://client.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: f.client.client_id,
          code,
          redirect_uri: f.client.redirect_uris[0]!,
          code_verifier: verifier,
          resource: `${issuer}/mcp`,
        }).toString(),
      });
      expect(exchanged.statusCode).toBe(200);
      expect(exchanged.headers['access-control-allow-origin']).toBe('*');
      const token = exchanged.json();
      expect(
        (
          await f.app.inject({
            url: '/test/private',
            headers: { authorization: `Bearer ${token.access_token}` },
          })
        ).json(),
      ).toMatchObject({
        workspaceId: f.browser.workspaceId,
        scopes: ['read'],
        keyKind: 'oauth',
      });
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/session',
            payload: { token: token.access_token },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/oauth/register',
            headers: { origin: 'https://client.example' },
            payload: {
              client_name: 'Another public client',
              redirect_uris: ['https://another-client.example/callback'],
            },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/keys',
            headers: {
              origin: 'https://client.example',
              authorization: `Bearer ${key.token}`,
            },
            payload: { name: 'Forbidden cross-origin mutation', scopes: ['read'] },
          })
        ).statusCode,
      ).toBe(403);
      const revoked = await f.app.inject({
        method: 'POST',
        url: '/oauth/revoke',
        headers: {
          origin: 'https://client.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          client_id: f.client.client_id,
          token: token.refresh_token,
        }).toString(),
      });
      expect(revoked.statusCode).toBe(200);
      expect(
        (
          await f.app.inject({
            url: '/test/private',
            headers: { authorization: `Bearer ${token.access_token}` },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await f.app.close();
      await f.engine.close();
    }
  });

  it('resumes only a valid fixed consent path after verified browser sign-in and clears the nonce cookie', async () => {
    const f = await fixture(true);
    try {
      const auth = await f.authorization();
      const login = await f.app.inject({ url: `/oauth/login?request=${auth.requestId}` });
      expect(login.headers.location).toBe(`${issuer}/auth/login`);
      const nonceCookie = cookies(login.headers)[0]!;
      expect(nonceCookie).toContain(auth.requestId);
      expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
      const begin = await continueBrowserLogin(f.app, auth.requestId);
      const oidcCookie = cookies(begin.headers).find((value) => value.startsWith('og_oidc='))!;
      const callback = await f.app.inject({
        url: '/auth/callback?code=fixture&returnTo=https://attacker.example',
        headers: { cookie: `${oidcCookie}; ${nonceCookie}` },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe(`${issuer}/oauth/consent?request=${auth.requestId}`);
      expect(cookies(callback.headers)).toContain('og_mcp_consent=');
      const again = await continueBrowserLogin(f.app);
      const againCookie = cookies(again.headers).find((value) => value.startsWith('og_oidc='))!;
      const invalid = await f.app.inject({
        url: '/auth/callback?code=fixture',
        headers: { cookie: `${againCookie}; og_mcp_consent=https%3A%2F%2Fattacker.example` },
      });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers.location).toBeUndefined();
      const unsigned = await f.app.inject({
        url: '/auth/callback?code=fixture',
        headers: { cookie: `og_mcp_consent=${auth.requestId}` },
      });
      expect(unsigned.statusCode).toBe(401);
      expect(cookies(unsigned.headers)).toContain('og_mcp_consent=');
    } finally {
      await f.app.close();
      await f.engine.close();
    }
  });
});
