import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as oidc from 'openid-client';
import type { AccountStore, McpOAuthStore, Principal } from '@media-router/engine';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import { registerAccounts } from '../apps/server/src/accounts';
import { registerMcpAuthorization } from '../apps/server/src/mcp-authorization';
import {
  currentHumanTermsPolicy,
  HUMAN_TERMS_NOTICE_VERSION,
  type HumanTermsPolicy,
} from '../apps/server/src/terms-login';

const provider = vi.hoisted(() => ({
  claims: {
    iss: 'https://identity.fixture.invalid',
    sub: 'verified-human',
    email: 'untrusted-display-email@example.invalid',
  } as Record<string, unknown> | undefined,
  fail: false,
  onVerified: () => {},
}));
// Exercise OpenGen's notice/transaction/receipt boundaries without contacting an IdP.
// Signature, state/nonce and token verification remain openid-client's own contract.
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(async () => ({})),
    buildAuthorizationUrl: vi.fn((_config, params: Record<string, string>) => {
      const url = new URL('https://identity.fixture.invalid/authorize');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    }),
    authorizationCodeGrant: vi.fn(async () => {
      if (provider.fail) throw new Error('synthetic-private-provider-failure');
      provider.onVerified();
      return { claims: () => provider.claims };
    }),
  };
});

const origin = 'https://opengen.fixture.invalid';
const pendingId = `og_req_${'p'.repeat(43)}`;
const apps: FastifyInstance[] = [];
const cookieParts = (headers: Record<string, unknown>): string[] => {
  const raw = headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => String(item).split(';')[0]!);
};
function cookieJar(...groups: string[][]) {
  const jar = new Map<string, string>();
  for (const item of groups.flat()) jar.set(item.slice(0, item.indexOf('=')), item);
  return [...jar.values()].join('; ');
}
function attributes(tag: string) {
  return Object.fromEntries(
    [...tag.matchAll(/([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [
      match[1]!,
      (match[2] ?? match[3] ?? '')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'"),
    ]),
  );
}
function noticeForm(html: string) {
  const formTag = html.match(/<form\b[^>]*>/i)?.[0];
  expect(formTag, 'server-rendered Continue form').toBeDefined();
  const form = attributes(formTag!);
  expect(form.action).toBe('/auth/login');
  expect(form.method?.toLowerCase()).toBe('post');
  const params = new URLSearchParams();
  for (const match of html.matchAll(/<(?:input|button)\b[^>]*>/gi)) {
    const field = attributes(match[0]);
    if (field.name) params.append(field.name, field.value ?? '');
  }
  expect([...params.keys()].sort()).toEqual(['action', 'actionToken']);
  expect(params.get('action')).toBe('continue');
  expect(params.get('actionToken')).toBeTruthy();
  return params;
}
function handoffTarget(html: string) {
  const anchor = [...html.matchAll(/<a\b[^>]*>/gi)]
    .map((match) => attributes(match[0]))
    .find((value) => value.id === 'oidc-handoff');
  expect(anchor?.href, 'explicit identity-provider handoff link').toBeTruthy();
  return new URL(anchor!.href!);
}
function corruptCookie(cookie: string) {
  const equals = cookie.indexOf('=');
  return (
    cookie.slice(0, equals + 1) +
    (cookie[equals + 1] === 'x' ? 'y' : 'x') +
    cookie.slice(equals + 2)
  );
}
const acceptFailure = (response: { statusCode: number }) =>
  expect(response.statusCode).toBeGreaterThanOrEqual(400);

beforeEach(() => {
  vi.clearAllMocks();
  provider.claims = {
    iss: 'https://identity.fixture.invalid',
    sub: 'verified-human',
    email: 'untrusted-display-email@example.invalid',
  };
  provider.fail = false;
  provider.onVerified = () => {};
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function fixture(active = false) {
  const app = Fastify();
  apps.push(app);
  const events: string[] = [];
  let policy: HumanTermsPolicy = active
    ? {
        version: 'fixture-adopted-v1',
        digest: 'a'.repeat(64),
        status: 'active',
        effectiveAt: '2026-11-01T00:00:00.000Z',
      }
    : currentHumanTermsPolicy();
  const principal: Principal = {
    workspaceId: 'personal-fixture',
    scopes: ['read', 'generate'],
    keyKind: 'browser',
    identity: { issuer: 'https://identity.fixture.invalid', subject: 'verified-human' },
  };
  const identity = vi.fn(async () => {
    events.push('identity');
    return principal;
  });
  const createSession = vi.fn(async () => {
    events.push('session');
    return 'b'.repeat(64);
  });
  const record = vi
    .spyOn(TermsReceiptStore.prototype, 'recordVerifiedAcceptance')
    .mockImplementation(async (input) => {
      events.push('receipt');
      return {
        ...input,
        noticeVersion: HUMAN_TERMS_NOTICE_VERSION,
        action: 'continue',
        method: 'oidc-verified',
        acceptedAt: new Date(),
      };
    });
  provider.onVerified = () => {
    events.push('verified');
  };
  const pending = new Set([pendingId]);
  const pendingAuthorization = vi.fn(async (id: string) =>
    pending.has(id) ? { requestId: id } : null,
  );
  const refresh = vi.fn(async () => ({
    token_type: 'Bearer',
    access_token: 'synthetic-protocol-fixture',
  }));
  const mcp = {
    pendingAuthorization,
    rateLimit: vi.fn(async () => {}),
    refresh,
  } as unknown as McpOAuthStore;
  const hooks = await registerAccounts(app, {
    engine: {
      accounts: { identity, createSession, pool: {} } as unknown as AccountStore,
      mcpOAuth: mcp,
    },
    publicUrl: origin,
    humanTermsPolicy: () => policy,
    env: {
      NODE_ENV: 'test',
      OIDC_ISSUER: 'https://identity.fixture.invalid',
      OIDC_CLIENT_ID: 'client-fixture',
      OIDC_CLIENT_SECRET: 'synthetic-server-secret',
      MR_SESSION_SECRET: 's'.repeat(32),
    },
  });
  await registerMcpAuthorization(app, {
    store: mcp,
    publicUrl: origin,
    signInEnabled: hooks.oidcEnabled,
    authenticate: hooks.authenticate,
    authenticateBrowser: hooks.authenticateBrowser,
  });
  async function notice(consent: string | null = null) {
    const consentCookies = consent ? [`og_mcp_consent=${consent}`] : [];
    const response = await app.inject({
      url: '/auth/login',
      headers: { cookie: consentCookies.join('; ') },
    });
    expect(response.statusCode).toBe(200);
    const fields = noticeForm(response.body);
    const cookies = cookieParts(response.headers);
    return { response, fields, cookies, cookie: cookieJar(consentCookies, cookies) };
  }
  async function proceed(
    start: Awaited<ReturnType<typeof notice>>,
    payload = start.fields.toString(),
    cookie = start.cookie,
  ) {
    return app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      payload,
    });
  }
  async function transaction(consent: string | null = null) {
    const start = await notice(consent);
    const continued = await proceed(start);
    expect(continued.statusCode).toBe(200);
    const callbackCookie = cookieJar(
      start.cookie.split('; ').filter(Boolean),
      cookieParts(continued.headers),
    );
    return { start, continued, cookie: callbackCookie };
  }
  const callback = (cookie: string, query = '') =>
    app.inject({ url: `/auth/callback?code=fixture${query}`, headers: { cookie } });
  return {
    app,
    record,
    identity,
    createSession,
    events,
    principal,
    pending,
    pendingAuthorization,
    refresh,
    notice,
    proceed,
    transaction,
    callback,
    policy: () => policy,
    changePolicy: (change: Partial<HumanTermsPolicy>) => {
      policy = { ...policy, ...change };
    },
  };
}

describe('human Terms notice and verified login receipt', () => {
  it('keeps the production policy draft and presents a server notice before initiating OIDC', async () => {
    expect(currentHumanTermsPolicy()).toMatchObject({ status: 'draft', effectiveAt: null });
    const f = await fixture();
    const start = await f.notice();
    expect(start.response.headers['content-type']).toContain('text/html');
    expect(start.response.headers['cache-control']).toContain('no-store');
    expect(start.response.body).toContain('/terms');
    expect(start.response.body).toContain('/privacy');
    expect(start.response.body.toLowerCase()).toContain('draft');
    expect(start.response.headers.location).toBeUndefined();
    expect(start.cookies.some((value) => value.startsWith('og_login_intent='))).toBe(true);
    expect(
      start.cookies.some((value) => value.startsWith('og_oidc=') && value !== 'og_oidc='),
    ).toBe(false);
    expect(String(start.response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(start.response.headers['set-cookie'])).toContain('Secure');
    expect(String(start.response.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(oidc.discovery).not.toHaveBeenCalled();
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    const continued = await f.proceed(start);
    expect(continued.statusCode).toBe(200);
    expect(continued.headers.location).toBeUndefined();
    expect(handoffTarget(continued.body).href).toMatch(
      /^https:\/\/identity\.fixture\.invalid\/authorize\?/,
    );
    expect(continued.body).not.toMatch(/<script\b|\son[a-z]+=/i);
    const callback = await f.callback(
      cookieJar(start.cookie.split('; '), cookieParts(continued.headers)),
    );
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${origin}/app#start`);
    expect(f.identity).toHaveBeenCalledWith('https://identity.fixture.invalid', 'verified-human');
    expect(f.createSession).toHaveBeenCalledWith(f.principal);
    expect(f.record).not.toHaveBeenCalled();
  });

  it('records only server-selected active-policy assent after verified claims and before a session', async () => {
    const f = await fixture(true);
    const tx = await f.transaction();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.identity).not.toHaveBeenCalled();
    const callback = await f.callback(
      tx.cookie,
      '&policyVersion=attacker&subject=attacker&email=attacker@example.invalid&returnTo=https://attacker.fixture.invalid',
    );
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${origin}/app#start`);
    expect(f.record).toHaveBeenCalledExactlyOnceWith({
      issuer: 'https://identity.fixture.invalid',
      subject: 'verified-human',
      policyVersion: f.policy().version,
      policyDigest: f.policy().digest,
    });
    expect(f.events.indexOf('verified')).toBeLessThan(f.events.indexOf('receipt'));
    expect(f.events.indexOf('receipt')).toBeLessThan(f.events.indexOf('session'));
    expect(cookieParts(callback.headers)).toContain(`og_session=${'b'.repeat(64)}`);
  });

  it.each([
    'http://identity.fixture.invalid/authorize',
    'https://user:synthetic-private-password@identity.fixture.invalid/authorize',
    'https://identity.fixture.invalid/authorize#synthetic-private-fragment',
    'javascript:synthetic-private-payload',
  ])('rejects an unsafe identity handoff target without reflecting it: %s', async (target) => {
    const f = await fixture(true);
    const start = await f.notice();
    vi.mocked(oidc.buildAuthorizationUrl).mockReturnValueOnce(new URL(target));
    const response = await f.proceed(start);
    acceptFailure(response);
    expect(response.statusCode).toBeLessThan(600);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).not.toContain('synthetic-private');
    expect(response.body).not.toContain(target);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('escapes a verified HTTPS handoff into a new no-script document with a normal link', async () => {
    const f = await fixture();
    const start = await f.notice();
    const target = new URL(
      'https://identity.fixture.invalid/authorize?state=x&next=%22%3E%3Cscript%3Efixture%3C/script%3E',
    );
    vi.mocked(oidc.buildAuthorizationUrl).mockReturnValueOnce(target);
    const response = await f.proceed(start);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.location).toBeUndefined();
    expect(handoffTarget(response.body).href).toBe(target.href);
    expect(response.body).toContain('&amp;');
    expect(response.body).toMatch(/<meta\b[^>]*http-equiv="refresh"/i);
    expect(response.body).not.toMatch(/<script\b|\son[a-z]+=/i);
    expect(f.record).not.toHaveBeenCalled();
  });

  it('preserves PKCE, state, nonce and the exact presented intent in its signed transaction', async () => {
    const f = await fixture(true);
    const tx = await f.transaction();
    const oidcCookie = cookieParts(tx.continued.headers).find((cookie) =>
      cookie.startsWith('og_oidc='),
    )!;
    const signed = f.app.unsignCookie(decodeURIComponent(oidcCookie.slice('og_oidc='.length)));
    expect(signed.valid).toBe(true);
    const data = JSON.parse(Buffer.from(signed.value!, 'base64url').toString('utf8'));
    expect(data.continueIntent).toMatchObject({ policy: f.policy(), consentRequest: null });
    expect(data.continueIntent.id).toBeTruthy();
    expect(data.continueIntent.expires).toBeGreaterThan(Date.now());
    const auth = handoffTarget(tx.continued.body);
    expect(auth.searchParams.get('redirect_uri')).toBe(`${origin}/auth/callback`);
    expect(auth.searchParams.get('scope')).toBe('openid profile email');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(data.verifier).digest('base64url'),
    );
    await f.callback(tx.cookie);
    expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(expect.anything(), expect.any(URL), {
      pkceCodeVerifier: data.verifier,
      expectedState: data.state,
      expectedNonce: data.nonce,
      idTokenExpected: true,
    });
  });

  it.each([
    undefined,
    'null',
    'https://attacker.fixture.invalid',
    `${origin}/`,
    'http://opengen.fixture.invalid',
    `${origin}:444`,
  ])('rejects Continue Origin %s even with a valid notice and matching Referer', async (value) => {
    const f = await fixture(true);
    const start = await f.notice();
    const response = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        cookie: start.cookie,
        ...(value === undefined ? {} : { origin: value }),
        referer: `${origin}/auth/login`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: start.fields.toString(),
    });
    expect(response.statusCode).toBe(403);
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('rejects arbitrary login query returns before presenting a notice', async () => {
    const f = await fixture();
    acceptFailure(
      await f.app.inject({ url: '/auth/login?returnTo=https://attacker.fixture.invalid' }),
    );
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('rejects unsupported, oversized, duplicate and client-expanded form bodies', async () => {
    const f = await fixture(true);
    const start = await f.notice();
    for (const payload of [
      '',
      start.fields.toString() + '&action=continue',
      start.fields.toString() + '&actionToken=duplicate',
      start.fields.toString() + '&policyVersion=client-selected',
      start.fields.toString().replace('action=continue', 'action=accept'),
      'action=continue&actionToken=' + 'x'.repeat(2048),
    ]) {
      const result = await f.proceed(start, payload);
      acceptFailure(result);
      expect(result.statusCode).toBeLessThan(500);
    }
    const json = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin, cookie: start.cookie, 'content-type': 'application/json' },
      payload: Object.fromEntries(start.fields),
    });
    expect(json.statusCode).toBe(415);
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('rejects missing, tampered and transaction-mixed action proofs', async () => {
    const f = await fixture(true);
    const a = await f.notice(),
      b = await f.notice();
    const tamperedToken = new URLSearchParams(a.fields);
    tamperedToken.set('actionToken', 'x' + tamperedToken.get('actionToken')!.slice(1));
    const missingToken = new URLSearchParams(a.fields);
    missingToken.delete('actionToken');
    const aIntent = a.cookies.find((cookie) => cookie.startsWith('og_login_intent='))!;
    for (const [body, cookie] of [
      [a.fields.toString(), ''],
      [a.fields.toString(), corruptCookie(aIntent)],
      [a.fields.toString(), b.cookie],
      [tamperedToken.toString(), a.cookie],
      [missingToken.toString(), a.cookie],
    ])
      acceptFailure(await f.proceed(a, body, cookie));
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('rejects expired notice actions and expired callback transactions', async () => {
    const f = await fixture(true);
    const start = await f.notice();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    acceptFailure(await f.proceed(start));
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    clock.mockRestore();
    const tx = await f.transaction();
    vi.spyOn(Date, 'now').mockReturnValue(now + 22 * 60_000);
    acceptFailure(await f.callback(tx.cookie));
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('rejects a policy changed after notice or after Continue', async () => {
    const f = await fixture(true);
    const start = await f.notice();
    f.changePolicy({ digest: 'c'.repeat(64) });
    acceptFailure(await f.proceed(start));
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    const tx = await f.transaction();
    f.changePolicy({ version: 'fixture-adopted-v2' });
    acceptFailure(await f.callback(tx.cookie));
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('never records assent or creates a session for a failed OIDC exchange', async () => {
    const f = await fixture(true);
    const tx = await f.transaction();
    provider.fail = true;
    const callback = await f.callback(tx.cookie);
    acceptFailure(callback);
    expect(callback.body).not.toContain('synthetic-private-provider-failure');
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('refuses session issuance when recording the active-policy receipt fails', async () => {
    const f = await fixture(true);
    const tx = await f.transaction();
    f.record.mockRejectedValueOnce(new Error('synthetic-private-receipt-failure'));
    const response = await f.callback(tx.cookie);
    acceptFailure(response);
    expect(response.body).not.toContain('synthetic-private-receipt-failure');
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('rejects missing and legacy signed callbacks without a completed notice action', async () => {
    const f = await fixture(true);
    acceptFailure(await f.callback(''));
    const legacy = Buffer.from(
      JSON.stringify({
        verifier: 'v'.repeat(43),
        state: 's'.repeat(32),
        nonce: 'n'.repeat(32),
        expires: Date.now() + 60_000,
      }),
    ).toString('base64url');
    const cookie = `og_oidc=${encodeURIComponent(f.app.signCookie(legacy))}`;
    acceptFailure(await f.callback(cookie));
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('binds and rechecks a real MCP login entry instead of trusting return URLs or later cookies', async () => {
    const f = await fixture(true);
    const mcp = await f.app.inject({ url: `/oauth/login?request=${pendingId}` });
    expect(mcp.statusCode).toBe(302);
    expect(mcp.headers.location).toBe(`${origin}/auth/login`);
    const tx = await f.transaction(pendingId);
    const callback = await f.callback(tx.cookie, '&returnTo=https://attacker.fixture.invalid');
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${origin}/oauth/consent?request=${pendingId}`);
    expect(f.pendingAuthorization).toHaveBeenCalledWith(pendingId);
    expect(cookieParts(callback.headers)).toContain('og_mcp_consent=');
  });

  it('rejects expired MCP returns at Continue and callback and rejects callback cookie substitution', async () => {
    const f = await fixture(true);
    const start = await f.notice(pendingId);
    f.pending.delete(pendingId);
    acceptFailure(await f.proceed(start));
    f.pending.add(pendingId);
    const tx = await f.transaction(pendingId);
    f.pending.delete(pendingId);
    acceptFailure(await f.callback(tx.cookie));
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
    f.pending.add(pendingId);
    const direct = await f.transaction();
    acceptFailure(
      await f.callback(cookieJar(direct.cookie.split('; '), [`og_mcp_consent=${pendingId}`])),
    );
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('clears expired login-only cookies so direct entry can restart without clearing a recovery session', async () => {
    const f = await fixture();
    const start = await f.notice(pendingId);
    f.pending.delete(pendingId);
    const failed = await f.proceed(start);
    expect(failed.statusCode).toBe(401);
    const cleared = cookieParts(failed.headers);
    for (const name of ['og_login_intent', 'og_oidc', 'og_mcp_consent'])
      expect(cleared).toContain(`${name}=`);
    expect(cleared.some((value) => value.startsWith('og_session='))).toBe(false);
    const expired = await f.app.inject({
      url: '/auth/login',
      headers: { cookie: `og_session=existing-recovery-session; og_mcp_consent=${pendingId}` },
    });
    expect(expired.statusCode).toBe(401);
    const restarted = await f.notice();
    expect(restarted.response.statusCode).toBe(200);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('rejects substitution or removal of a bound MCP cookie even if another request is valid', async () => {
    const f = await fixture(true);
    const another = `og_req_${'q'.repeat(43)}`;
    f.pending.add(another);
    const start = await f.notice(pendingId);
    acceptFailure(
      await f.proceed(
        start,
        start.fields.toString(),
        cookieJar(start.cookie.split('; '), [`og_mcp_consent=${another}`]),
      ),
    );
    expect(oidc.buildAuthorizationUrl).not.toHaveBeenCalled();
    const tx = await f.transaction(pendingId);
    acceptFailure(
      await f.callback(cookieJar(tx.cookie.split('; '), [`og_mcp_consent=${another}`])),
    );
    acceptFailure(
      await f.callback(
        tx.cookie
          .split('; ')
          .filter((cookie) => !cookie.startsWith('og_mcp_consent='))
          .join('; '),
      ),
    );
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('preserves the independent MCP URL-encoded token parser and rejects duplicate OAuth fields', async () => {
    const f = await fixture();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'fixture-client',
      refresh_token: 'fixture-refresh-token',
      resource: `${origin}/mcp`,
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        origin: 'https://client.fixture.invalid',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: body.toString(),
    });
    expect(response.statusCode).toBe(200);
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith({
      clientId: 'fixture-client',
      refreshToken: 'fixture-refresh-token',
      resource: `${origin}/mcp`,
      scope: undefined,
    });
    const repeated = await f.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        origin: 'https://client.fixture.invalid',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: body.toString() + '&client_id=duplicate',
    });
    expect(repeated.statusCode).toBe(400);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.record).not.toHaveBeenCalled();
  });
});
