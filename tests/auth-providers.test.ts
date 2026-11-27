import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build as buildEsbuild } from 'esbuild';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStore, McpOAuthStore, Principal } from '@media-router/engine';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import { registerAccounts } from '../apps/server/src/accounts.js';
import { registerMcpAuthorization } from '../apps/server/src/mcp-authorization.js';
import {
  HUMAN_TERMS_NOTICE_VERSION,
  currentHumanTermsPolicy,
  formatHumanEffectiveDate,
  renderHumanLoginNotice,
  validateSafeReturnTo,
  type HumanTermsPolicy,
} from '../apps/server/src/terms-login.js';
import { GITHUB_OAUTH_ISSUER } from '../apps/server/src/github-oauth.js';
import {
  InMemoryEmailOtpStore,
  emailOtpSubject,
  type EmailOtpDeliveryInput,
} from '../apps/server/src/email-otp.js';

// Next preserves JSX in apps/web/tsconfig.json; bundle the real web helpers with esbuild.
const tempWebDir = mkdtempSync(join(process.cwd(), 'node_modules/.auth-providers-web-'));
const webBundlePath = join(tempWebDir, 'helpers.cjs');
await buildEsbuild({
  stdin: {
    contents: `export { buildLoginHref, formatRemainingUsd, safeReturnToPath } from './apps/web/app/header-session';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: webBundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next/navigation'],
  loader: { '.css': 'empty' },
});
const { buildLoginHref, formatRemainingUsd, safeReturnToPath } = createRequire(import.meta.url)(
  webBundlePath,
) as {
  buildLoginHref: typeof import('../apps/web/app/header-session.js').buildLoginHref;
  formatRemainingUsd: typeof import('../apps/web/app/header-session.js').formatRemainingUsd;
  safeReturnToPath: typeof import('../apps/web/app/header-session.js').safeReturnToPath;
};

afterAll(() => {
  rmSync(tempWebDir, { recursive: true, force: true });
});

vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(async () => ({})),
    buildAuthorizationUrl: vi.fn((_config, params: Record<string, string>) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    }),
    authorizationCodeGrant: vi.fn(async () => ({
      claims: () => ({
        iss: 'https://accounts.google.com',
        sub: 'google-human-1',
        email: 'google-human@example.invalid',
        email_verified: true,
      }),
    })),
  };
});

const origin = 'https://opengen.fixture.invalid';
const pendingId = `og_req_${'g'.repeat(43)}`;
const apps: FastifyInstance[] = [];

const cookieParts = (headers: Record<string, unknown>): string[] => {
  const raw = headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => String(item).split(';')[0]!);
};

function cookieJar(...groups: string[][]) {
  const jar = new Map<string, string>();
  for (const item of groups.flat()) {
    const idx = item.indexOf('=');
    if (idx > 0) jar.set(item.slice(0, idx), item);
  }
  return [...jar.values()].join('; ');
}

function extractFormToken(html: string, actionValue: string): string {
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)];
  for (const formMatch of forms) {
    const body = formMatch[1]!;
    if (body.includes(`name="action" value="${actionValue}"`)) {
      const tokenMatch = body.match(/name="actionToken" value="([^"]+)"/);
      if (tokenMatch) return tokenMatch[1]!.replaceAll('&amp;', '&');
    }
  }
  throw new Error(`Form with action="${actionValue}" not found in HTML.`);
}

function handoffUrl(html: string): URL {
  const match = html.match(/<a\b[^>]*id="oidc-handoff"[^>]*href="([^"]+)"/i);
  expect(match?.[1]).toBeTruthy();
  return new URL(match![1]!.replaceAll('&amp;', '&'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function buildAuthFixture(options: {
  env: Record<string, string>;
  activeTerms?: boolean;
  githubFetch?: typeof fetch;
  emailOtpTransport?: (input: EmailOtpDeliveryInput) => Promise<{ statusCode: number }>;
  emailOtpStore?: InMemoryEmailOtpStore;
}) {
  const app = Fastify();
  apps.push(app);
  const events: string[] = [];
  const policy: HumanTermsPolicy = options.activeTerms
    ? {
        version: 'hosted-terms-2026-11-16',
        digest: 'a'.repeat(64),
        status: 'active',
        effectiveAt: '2026-11-16T00:00:00.000Z',
      }
    : currentHumanTermsPolicy();

  const identity = vi.fn(async (issuer: string, subject: string): Promise<Principal> => {
    events.push(`identity:${issuer}`);
    return {
      workspaceId: `user-${createHash('sha256').update(`${issuer}:${subject}`).digest('hex').slice(0, 12)}`,
      scopes: ['read', 'generate'],
      keyKind: 'browser',
      identity: { issuer, subject },
    };
  });
  const createSession = vi.fn(async () => {
    events.push('session');
    return 'c'.repeat(64);
  });
  const record = vi
    .spyOn(TermsReceiptStore.prototype, 'recordVerifiedAcceptance')
    .mockImplementation(async (input) => {
      events.push(`receipt:${input.issuer}`);
      return {
        ...input,
        noticeVersion: HUMAN_TERMS_NOTICE_VERSION,
        action: 'continue',
        method: 'oidc-verified',
        acceptedAt: new Date(),
      };
    });

  const pending = new Set([pendingId]);
  const mcp = {
    pendingAuthorization: vi.fn(async (id: string) => (pending.has(id) ? { requestId: id } : null)),
  } as unknown as McpOAuthStore;

  const hooks = await registerAccounts(app, {
    engine: {
      accounts: { identity, createSession, pool: {} } as unknown as AccountStore,
      mcpOAuth: mcp,
    },
    publicUrl: origin,
    humanTermsPolicy: () => policy,
    env: { NODE_ENV: 'test', ...options.env },
    githubFetch: options.githubFetch,
    emailOtpTransport: options.emailOtpTransport,
    emailOtpStore: options.emailOtpStore,
  });

  await registerMcpAuthorization(app, {
    store: mcp,
    publicUrl: origin,
    signInEnabled: hooks.oidcEnabled,
    authenticate: hooks.authenticate,
    authenticateBrowser: hooks.authenticateBrowser,
  });

  return { app, identity, createSession, record, events, policy, hooks };
}

describe('auth provider session discovery and branded login notice', () => {
  it('exposes accurate authProviders and backwards-compatible oidcEnabled across env combinations', async () => {
    const none = await buildAuthFixture({ env: {} });
    expect((await none.app.inject('/v1/session')).json()).toEqual({
      authenticated: false,
      oidcEnabled: false,
      authProviders: { oidc: false, github: false, emailOtp: false },
    });

    const googleOnly = await buildAuthFixture({
      env: {
        OIDC_ISSUER: 'https://accounts.google.com',
        OIDC_CLIENT_ID: 'google-client',
        OIDC_CLIENT_SECRET: 'google-secret',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
    });
    expect((await googleOnly.app.inject('/v1/session')).json()).toEqual({
      authenticated: false,
      oidcEnabled: true,
      authProviders: { oidc: true, oidcLabel: 'Google', github: false, emailOtp: false },
    });
    const googleHtml = (await googleOnly.app.inject('/auth/login')).body;
    expect(googleHtml).toContain('Continue with Google');
    expect(googleHtml).not.toContain('Continue with GitHub');
    expect(googleHtml).not.toContain('Email me a sign-in code');

    const allThree = await buildAuthFixture({
      activeTerms: true,
      env: {
        OIDC_ISSUER: 'https://accounts.google.com',
        OIDC_CLIENT_ID: 'google-client',
        OIDC_CLIENT_SECRET: 'google-secret',
        OPENGEN_GITHUB_CLIENT_ID: 'gh-client',
        OPENGEN_GITHUB_CLIENT_SECRET: 'gh-secret',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
      emailOtpTransport: async () => ({ statusCode: 200 }),
    });
    expect((await allThree.app.inject('/v1/session')).json()).toEqual({
      authenticated: false,
      oidcEnabled: true,
      authProviders: { oidc: true, oidcLabel: 'Google', github: true, emailOtp: true },
    });
    const allHtml = (await allThree.app.inject('/auth/login')).body;
    expect(allHtml).toContain('Continue with Google');
    expect(allHtml).toContain('Continue with GitHub');
    expect(allHtml).toContain('Email me a sign-in code');
    expect(allHtml).toContain('Effective November 16, 2026');
    expect(allHtml).toContain('<small>Effective: 2026-11-16T00:00:00.000Z</small>');
    expect(allHtml).toContain('<details><summary>Policy fingerprint</summary>');
    expect(allHtml).not.toMatch(/<script\b|\son[a-z]+=|\sstyle=/i);
  });

  it('formats human effective dates cleanly in UTC and respects custom OIDC display names', () => {
    expect(formatHumanEffectiveDate('2026-11-16T00:00:00.000Z')).toBe('November 16, 2026');
    const html = renderHumanLoginNotice(
      {
        version: 'hosted-terms-2026-11-16',
        digest: 'a'.repeat(64),
        status: 'active',
        effectiveAt: '2026-11-16T00:00:00.000Z',
      },
      'tok',
      { providers: { oidc: true, oidcLabel: 'Acme SSO' } },
    );
    expect(html).toContain('Continue with Acme SSO');
    expect(html).toContain('Effective November 16, 2026');
    expect(html).toContain('<small>Effective: 2026-11-16T00:00:00.000Z</small>');
  });
});

describe('GitHub OAuth sign-in', () => {
  function mockGitHubFetch(options: {
    userId?: number;
    emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
    onTokenRequest?: (params: URLSearchParams) => void;
  }): typeof fetch {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        const params = new URLSearchParams(String(init?.body ?? ''));
        options.onTokenRequest?.(params);
        return new Response(
          JSON.stringify({ access_token: 'gho_synthetic_token', token_type: 'bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: options.userId ?? 987654, login: 'octodev' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify(
            options.emails ?? [
              { email: 'secondary@example.invalid', primary: false, verified: true },
              { email: 'Primary@Example.Invalid', primary: true, verified: true },
            ],
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as unknown as typeof fetch;
  }

  it('completes GitHub OAuth with PKCE/state, verified primary email, 029 Terms receipt and returnTo', async () => {
    let observedTokenParams: URLSearchParams | undefined;
    const f = await buildAuthFixture({
      activeTerms: true,
      env: {
        OPENGEN_GITHUB_CLIENT_ID: 'gh-client-1',
        OPENGEN_GITHUB_CLIENT_SECRET: 'gh-secret-1',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
      githubFetch: mockGitHubFetch({
        userId: 424242,
        onTokenRequest: (params) => {
          observedTokenParams = params;
        },
      }),
    });

    const start = await f.app.inject(
      '/auth/login?returnTo=%2Fplayground%3Fmodel%3Dopenai%252Fgpt-image-2',
    );
    expect(start.statusCode).toBe(200);
    const token = extractFormToken(start.body, 'continue_github');
    const startCookies = cookieParts(start.headers);

    const continued = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(startCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ action: 'continue_github', actionToken: token }).toString(),
    });
    expect(continued.statusCode).toBe(200);
    const target = handoffUrl(continued.body);
    expect(target.origin).toBe('https://github.com');
    expect(target.pathname).toBe('/login/oauth/authorize');
    expect(target.searchParams.get('client_id')).toBe('gh-client-1');
    expect(target.searchParams.get('redirect_uri')).toBe(`${origin}/auth/callback`);
    expect(target.searchParams.get('scope')).toBe('read:user user:email');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    const state = target.searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(16);

    const cb = await f.app.inject({
      url: `/auth/callback?code=gh-auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieJar(startCookies, cookieParts(continued.headers)) },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`${origin}/playground?model=openai%2Fgpt-image-2`);
    expect(cookieParts(cb.headers)).toContain(`og_session=${'c'.repeat(64)}`);
    expect(observedTokenParams?.get('code')).toBe('gh-auth-code');
    expect(observedTokenParams?.get('code_verifier')).toBeTruthy();
    expect(
      createHash('sha256').update(observedTokenParams!.get('code_verifier')!).digest('base64url'),
    ).toBe(target.searchParams.get('code_challenge'));
    expect(f.identity).toHaveBeenCalledExactlyOnceWith(GITHUB_OAUTH_ISSUER, '424242');
    expect(f.record).toHaveBeenCalledExactlyOnceWith({
      issuer: GITHUB_OAUTH_ISSUER,
      subject: '424242',
      policyVersion: f.policy.version,
      policyDigest: f.policy.digest,
    });
    expect(f.events.indexOf(`receipt:${GITHUB_OAUTH_ISSUER}`)).toBeLessThan(
      f.events.indexOf('session'),
    );
  });

  it('rejects GitHub accounts without a verified primary email and rejects state mismatches', async () => {
    const f = await buildAuthFixture({
      activeTerms: true,
      env: {
        OPENGEN_GITHUB_CLIENT_ID: 'gh-client-1',
        OPENGEN_GITHUB_CLIENT_SECRET: 'gh-secret-1',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
      githubFetch: mockGitHubFetch({
        emails: [
          { email: 'unverified@example.invalid', primary: true, verified: false },
          { email: 'verified-secondary@example.invalid', primary: false, verified: true },
        ],
      }),
    });

    const start = await f.app.inject('/auth/login');
    const token = extractFormToken(start.body, 'continue_github');
    const startCookies = cookieParts(start.headers);
    const continued = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(startCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ action: 'continue_github', actionToken: token }).toString(),
    });
    const state = handoffUrl(continued.body).searchParams.get('state')!;
    const txCookie = cookieJar(startCookies, cookieParts(continued.headers));

    const badState = await f.app.inject({
      url: `/auth/callback?code=gh-auth-code&state=wrong-state`,
      headers: { cookie: txCookie },
    });
    expect(badState.statusCode).toBe(401);

    const unverified = await f.app.inject({
      url: `/auth/callback?code=gh-auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: txCookie },
    });
    expect(unverified.statusCode).toBe(401);
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });
});

describe('Email OTP sign-in', () => {
  it('returns explicit 503 email_otp_unavailable when Email OTP is unconfigured', async () => {
    const oidcOnly = await buildAuthFixture({
      env: {
        OIDC_ISSUER: 'https://accounts.google.com',
        OIDC_CLIENT_ID: 'google-client',
        OIDC_CLIENT_SECRET: 'google-secret',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
    });
    const start = await oidcOnly.app.inject('/auth/login');
    const token = extractFormToken(start.body, 'continue');
    const res = await oidcOnly.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(cookieParts(start.headers)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_send',
        actionToken: token,
        email: 'user@example.invalid',
      }).toString(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('email_otp_unavailable');

    const requestedNoTransport = await buildAuthFixture({
      env: {
        OPENGEN_EMAIL_OTP_ENABLED: '1',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
    });
    expect(
      (await requestedNoTransport.app.inject('/v1/session')).json().authProviders.emailOtp,
    ).toBe(false);
    const unavailableGet = await requestedNoTransport.app.inject('/auth/login');
    expect(unavailableGet.statusCode).toBe(503);
    expect(unavailableGet.json().error.code).toBe('email_otp_unavailable');
  });

  it('completes single-use Email OTP sign-in with Terms receipt, returnTo, replay protection, attempt lockout and rate limits', async () => {
    const delivered: EmailOtpDeliveryInput[] = [];
    const store = new InMemoryEmailOtpStore({
      maxSendsPerEmail: 2,
      maxSendsPerIp: 5,
      maxVerifiesPerIp: 10,
    });
    const f = await buildAuthFixture({
      activeTerms: true,
      env: {
        OPENGEN_EMAIL_OTP_ENABLED: '1',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
      emailOtpTransport: async (input) => {
        delivered.push(input);
        return { statusCode: 200 };
      },
      emailOtpStore: store,
    });

    // 1. Send OTP with safe returnTo
    const start = await f.app.inject('/auth/login?returnTo=%2Fbilling');
    expect(start.statusCode).toBe(200);
    const sendToken = extractFormToken(start.body, 'email_otp_send');
    const startCookies = cookieParts(start.headers);

    // Invalid email syntax returns 400 without delivering
    const badEmail = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(startCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_send',
        actionToken: sendToken,
        email: 'not-an-email',
      }).toString(),
    });
    expect(badEmail.statusCode).toBe(400);
    expect(delivered).toHaveLength(0);

    // Valid email sends single-use 6-digit code
    const sent = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(startCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_send',
        actionToken: sendToken,
        email: 'Producer@Example.Invalid',
      }).toString(),
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('pr***@example.invalid');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to).toBe('producer@example.invalid');
    const codeMatch = delivered[0]!.text.match(/\b(\d{6})\b/);
    expect(codeMatch?.[1]).toBeTruthy();
    const otpCode = codeMatch![1]!;
    expect(sent.body).not.toContain(otpCode);

    const verifyToken = extractFormToken(sent.body, 'email_otp_verify');
    const otpCookies = cookieParts(sent.headers);
    const verifyCookieHeader = cookieJar(otpCookies);

    // Wrong code fails 401 and does not create session or receipt
    const wrong = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: verifyCookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_verify',
        actionToken: verifyToken,
        code: otpCode === '000000' ? '111111' : '000000',
      }).toString(),
    });
    expect(wrong.statusCode).toBe(401);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();

    // Correct code verifies, records 029 Terms receipt, issues session, redirects 303 to returnTo
    const verified = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: verifyCookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_verify',
        actionToken: verifyToken,
        code: otpCode,
      }).toString(),
    });
    expect(verified.statusCode).toBe(303);
    expect(verified.headers.location).toBe(`${origin}/billing`);
    expect(cookieParts(verified.headers)).toContain(`og_session=${'c'.repeat(64)}`);
    const expectedIssuer = `${origin}/auth/email-otp`;
    const expectedSubject = emailOtpSubject('producer@example.invalid');
    expect(f.identity).toHaveBeenCalledExactlyOnceWith(expectedIssuer, expectedSubject);
    expect(f.record).toHaveBeenCalledExactlyOnceWith({
      issuer: expectedIssuer,
      subject: expectedSubject,
      policyVersion: f.policy.version,
      policyDigest: f.policy.digest,
    });
    expect(f.events.indexOf(`receipt:${expectedIssuer}`)).toBeLessThan(f.events.indexOf('session'));

    // Replaying the exact same code + saved cookie must fail closed (single-use)
    const replay = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: verifyCookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_verify',
        actionToken: verifyToken,
        code: otpCode,
      }).toString(),
    });
    expect(replay.statusCode).toBe(401);
    expect(f.createSession).toHaveBeenCalledOnce();

    // 2. Second send to same email succeeds; 3rd send hits strict 429 rate limit with Retry-After
    const start2 = await f.app.inject('/auth/login');
    const sent2 = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(cookieParts(start2.headers)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_send',
        actionToken: extractFormToken(start2.body, 'email_otp_send'),
        email: 'producer@example.invalid',
      }).toString(),
    });
    expect(sent2.statusCode).toBe(200);

    const start3 = await f.app.inject('/auth/login');
    const limited = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar(cookieParts(start3.headers)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_send',
        actionToken: extractFormToken(start3.body, 'email_otp_send'),
        email: 'producer@example.invalid',
      }).toString(),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('email_otp_rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // 3. Five consecutive wrong codes lock/burn the challenge permanently
    const code2 = delivered[1]!.text.match(/\b(\d{6})\b/)![1]!;
    const verifyToken2 = extractFormToken(sent2.body, 'email_otp_verify');
    const otpCookie2 = cookieJar(cookieParts(sent2.headers));
    const wrongCode = code2 === '123456' ? '654321' : '123456';
    for (let attempt = 0; attempt < 5; attempt++) {
      const attemptRes = await f.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: {
          origin,
          cookie: otpCookie2,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          action: 'email_otp_verify',
          actionToken: verifyToken2,
          code: wrongCode,
        }).toString(),
      });
      expect(attemptRes.statusCode).toBe(401);
    }
    // Even the real code now fails because the challenge was permanently locked/burned
    const afterLock = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: otpCookie2,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_verify',
        actionToken: verifyToken2,
        code: code2,
      }).toString(),
    });
    expect(afterLock.statusCode).toBe(401);
    expect(f.createSession).toHaveBeenCalledOnce();
  });

  it('preserves MCP consent priority during Email OTP sign-in', async () => {
    const delivered: EmailOtpDeliveryInput[] = [];
    const f = await buildAuthFixture({
      activeTerms: true,
      env: {
        OPENGEN_EMAIL_OTP_ENABLED: '1',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
      emailOtpTransport: async (input) => {
        delivered.push(input);
        return { statusCode: 200 };
      },
    });
    const start = await f.app.inject({
      url: '/auth/login?returnTo=%2Fbilling',
      headers: { cookie: `og_mcp_consent=${pendingId}` },
    });
    const startCookie = cookieJar([`og_mcp_consent=${pendingId}`], cookieParts(start.headers));
    const sent = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: startCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_send',
        actionToken: extractFormToken(start.body, 'email_otp_send'),
        email: 'mcp@example.invalid',
      }).toString(),
    });
    expect(sent.statusCode).toBe(200);
    const code = delivered[0]!.text.match(/\b(\d{6})\b/)![1]!;
    const verified = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin,
        cookie: cookieJar([`og_mcp_consent=${pendingId}`], cookieParts(sent.headers)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        action: 'email_otp_verify',
        actionToken: extractFormToken(sent.body, 'email_otp_verify'),
        code,
      }).toString(),
    });
    expect(verified.statusCode).toBe(303);
    expect(verified.headers.location).toBe(`${origin}/oauth/consent?request=${pendingId}`);
  });
});

describe('header balance formatting and client returnTo URL helpers', () => {
  it('formats balances cleanly to 2 decimals >= $0.01 and up to 4 decimals for small positive amounts without rounding down to $0.00', () => {
    expect(formatRemainingUsd(null)).toBe('—');
    expect(formatRemainingUsd(undefined)).toBe('—');
    expect(formatRemainingUsd(Number.NaN)).toBe('—');
    expect(formatRemainingUsd(0)).toBe('$0.00');
    expect(formatRemainingUsd(94_257_920)).toBe('$94.26');
    expect(formatRemainingUsd(9_600_000)).toBe('$9.60');
    expect(formatRemainingUsd(1_234_560_000)).toBe('$1,234.56');
    expect(formatRemainingUsd(10_000)).toBe('$0.01');
    expect(formatRemainingUsd(5_970)).toBe('$0.006');
    expect(formatRemainingUsd(1_234)).toBe('$0.0012');
    expect(formatRemainingUsd(100)).toBe('$0.0001');
    expect(formatRemainingUsd(50)).toBe('<$0.0001');
    expect(formatRemainingUsd(1)).toBe('<$0.0001');
  });

  it('validates client and server safe returnTo paths identically and builds login links safely', () => {
    for (const safe of [
      '/playground?model=openai%2Fgpt-image-2',
      '/billing',
      '/app#activity',
      '/agents/claude-code',
      '/models',
      '/start',
    ]) {
      expect(safeReturnToPath(safe)).toBe(safe);
      expect(validateSafeReturnTo(safe)).toBe(safe);
    }
    for (const unsafe of [
      '',
      '//evil.example/path',
      'https://evil.example',
      '/api/session',
      '/auth/login',
      '/oauth/consent',
      '/playground/../api/session',
      '/' + 'x'.repeat(513),
    ]) {
      expect(safeReturnToPath(unsafe)).toBeNull();
      expect(validateSafeReturnTo(unsafe)).toBeNull();
    }

    expect(buildLoginHref({ currentLocation: '/start' })).toBe('/auth/login');
    expect(buildLoginHref({ currentLocation: '/' })).toBe('/auth/login');
    expect(buildLoginHref({ currentLocation: '/playground?model=openai%2Fgpt-image-2' })).toBe(
      '/auth/login?returnTo=%2Fplayground%3Fmodel%3Dopenai%252Fgpt-image-2',
    );
    expect(buildLoginHref({ currentLocation: '/app#activity' })).toBe(
      '/auth/login?returnTo=%2Fapp%23activity',
    );
    expect(
      buildLoginHref({
        loginUrl: '/oauth/login?request=og_req_123',
        currentLocation: '/oauth/consent?request=og_req_123',
      }),
    ).toBe('/oauth/login?request=og_req_123');
    expect(buildLoginHref({ returnTo: 'https://evil.example' })).toBe('/auth/login');
  });
});
