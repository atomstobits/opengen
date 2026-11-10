import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserLogin, savedLogin, loginStatus, logout } from '../apps/cli/src/login';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const baseUrl = 'https://opengen.example';
const accessToken = `og_mcp_a_${'a'.repeat(43)}`,
  refreshToken = `og_mcp_r_${'a'.repeat(43)}`;
const tokens = (suffix = 'a') => ({
  access_token: `og_mcp_a_${suffix.repeat(43)}`,
  refresh_token: `og_mcp_r_${suffix.repeat(43)}`,
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'read generate',
  workspace_id: 'team-studio',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const resourceMetadata = (issuer: string) => ({
  resource: `${issuer}/mcp`,
  authorization_servers: [issuer],
  bearer_methods_supported: ['header'],
});
const serverMetadata = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  registration_endpoint: `${issuer}/oauth/register`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['read', 'generate'],
});
async function fixture(options: { apiBase?: string; issuer?: string } = {}) {
  const apiBase = options.apiBase ?? baseUrl,
    issuer = options.issuer ?? baseUrl;
  const dir = await mkdtemp(join(tmpdir(), 'opengen-login-test-'));
  directories.push(dir);
  const profilePath = join(dir, 'config', 'auth.json');
  let redirect = '',
    challenge = '';
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input),
      headers = new Headers(init?.headers);
    calls.push({ url, headers, body: init?.body });
    expect(init?.redirect).toBe('error');
    if (url === `${apiBase}/.well-known/oauth-protected-resource/mcp`)
      return json(resourceMetadata(issuer));
    if (url === `${issuer}/.well-known/oauth-authorization-server`)
      return json(serverMetadata(issuer));
    if (url === `${issuer}/oauth/register`) {
      redirect = JSON.parse(String(init?.body)).redirect_uris[0];
      return json({ client_id: 'fixture-client' });
    }
    if (url === `${issuer}/oauth/token`) {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('code')).toBe('one-time-code');
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(
        challenge,
      );
      expect(params.get('redirect_uri')).toBe(redirect);
      expect(params.get('resource')).toBe(`${issuer}/mcp`);
      return json(tokens());
    }
    throw new Error('Unexpected request; never call a generation provider.');
  };
  const openBrowser = async (value: string) => {
    const url = new URL(value);
    challenge = url.searchParams.get('code_challenge')!;
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get('resource')).toBe(`${issuer}/mcp`);
    expect(url.pathname).toBe('/oauth/authorize');
    const callback = new URL(redirect);
    callback.searchParams.set('state', 'wrong-state');
    callback.searchParams.set('code', 'bad-code');
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'one-time-code');
    expect((await fetch(callback)).status).toBe(200);
  };
  return { profilePath, request, openBrowser, calls, apiBase, issuer };
}
describe('local browser onboarding', () => {
  it('binds callback state and PKCE, saves private credentials and returns only safe account metadata', async () => {
    const f = await fixture();
    const result = await browserLogin({
      baseUrl,
      profilePath: f.profilePath,
      request: f.request,
      openBrowser: f.openBrowser,
    });
    expect(result).toMatchObject({ connected: true, workspaceId: 'team-studio' });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain(refreshToken);
    const profile = JSON.parse(await readFile(f.profilePath, 'utf8'));
    expect(profile.accessToken).toBe(accessToken);
    expect(profile.refreshToken).toBe(refreshToken);
    expect((await stat(f.profilePath)).mode & 0o077).toBe(0);
    const status = await loginStatus({ baseUrl, profilePath: f.profilePath, request: f.request });
    expect(status).toMatchObject({
      connected: false,
      authenticated: false,
      credentialPresent: true,
      verification: 'not-checked',
      workspaceId: 'team-studio',
    });
    expect(JSON.stringify(status)).not.toContain(refreshToken);
    expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/token',
    ]);
    expect(f.calls.every((call) => !call.headers.has('authorization'))).toBe(true);
  });
  it('serializes credential refresh so concurrent commands cannot replay a rotating token', async () => {
    const f = await fixture();
    await browserLogin({
      baseUrl,
      profilePath: f.profilePath,
      request: f.request,
      openBrowser: f.openBrowser,
    });
    const profile = JSON.parse(await readFile(f.profilePath, 'utf8'));
    profile.expiresAt = new Date(0).toISOString();
    await writeFile(f.profilePath, JSON.stringify(profile));
    let start: () => void = () => {},
      release: () => void = () => {};
    const started = new Promise<void>((resolve) => (start = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    let exchanges = 0;
    const request: typeof fetch = async (input, init) => {
      exchanges++;
      expect(String(input)).toBe(`${baseUrl}/oauth/token`);
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('refresh_token')).toBe(refreshToken);
      start();
      await gate;
      return json(tokens('b'));
    };
    const first = savedLogin({ baseUrl, profilePath: f.profilePath, request });
    await started;
    await expect(savedLogin({ baseUrl, profilePath: f.profilePath, request })).rejects.toThrow(
      'Another OpenGen process',
    );
    release();
    expect((await first)?.refreshToken).toBe(tokens('b').refresh_token);
    expect((await savedLogin({ baseUrl, profilePath: f.profilePath, request }))?.accessToken).toBe(
      tokens('b').access_token,
    );
    expect(exchanges).toBe(1);
  });
  it('revokes the server authorization before removing the local profile', async () => {
    const f = await fixture();
    await browserLogin({
      baseUrl,
      profilePath: f.profilePath,
      request: f.request,
      openBrowser: f.openBrowser,
    });
    let called = 0;
    const request: typeof fetch = async (input, init) => {
      called++;
      expect(String(input)).toBe(`${baseUrl}/oauth/revoke`);
      expect(new URLSearchParams(String(init?.body)).get('token')).toBe(refreshToken);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(null, { status: 200 });
    };
    expect(await logout({ profilePath: f.profilePath, request })).toEqual({ signedOut: true });
    await expect(access(f.profilePath)).rejects.toThrow();
    expect(called).toBe(1);
  });
  it('refuses publicly readable profiles without making an authentication request', async () => {
    const f = await fixture();
    await browserLogin({
      baseUrl,
      profilePath: f.profilePath,
      request: f.request,
      openBrowser: f.openBrowser,
    });
    await chmod(f.profilePath, 0o644);
    let called = false;
    const request: typeof fetch = async () => {
      called = true;
      throw new Error('No network.');
    };
    await expect(savedLogin({ baseUrl, profilePath: f.profilePath, request })).rejects.toThrow(
      '0600',
    );
    expect(called).toBe(false);
  });
  it('does not persist or print a private token-endpoint error response', async () => {
    const f = await fixture();
    const request: typeof fetch = async (input, init) =>
      String(input).endsWith('/oauth/token')
        ? json({ error_description: 'synthetic-private-response-details' }, 400)
        : f.request(input, init);
    await expect(
      browserLogin({ baseUrl, profilePath: f.profilePath, request, openBrowser: f.openBrowser }),
    ).rejects.toThrow('No tokens or private response details');
    await expect(access(f.profilePath)).rejects.toThrow();
  });
  it('discovers the public issuer while preserving a separate API alias, then pins refresh and revoke to that grant', async () => {
    const f = await fixture({ apiBase: 'http://127.0.0.1:4310', issuer: 'http://127.0.0.1:4320' });
    const result = await browserLogin({
      baseUrl: f.apiBase,
      profilePath: f.profilePath,
      request: f.request,
      openBrowser: f.openBrowser,
    });
    expect(result).toMatchObject({
      baseUrl: f.apiBase,
      issuer: f.issuer,
      resource: `${f.issuer}/mcp`,
      workspaceId: 'team-studio',
    });
    const profile = JSON.parse(await readFile(f.profilePath, 'utf8'));
    expect(profile).toMatchObject({
      baseUrl: f.apiBase,
      issuer: f.issuer,
      resource: `${f.issuer}/mcp`,
      clientId: 'fixture-client',
      workspaceId: 'team-studio',
    });
    profile.expiresAt = new Date(0).toISOString();
    await writeFile(f.profilePath, JSON.stringify(profile));
    const calls: string[] = [];
    const request: typeof fetch = async (input, init) => {
      const url = String(input),
        params = new URLSearchParams(String(init?.body));
      calls.push(url);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(params.get('client_id')).toBe('fixture-client');
      if (url === `${f.issuer}/oauth/token`) {
        expect(params.get('resource')).toBe(`${f.issuer}/mcp`);
        expect(params.get('refresh_token')).toBe(refreshToken);
        return json(tokens('b'));
      }
      expect(url).toBe(`${f.issuer}/oauth/revoke`);
      expect(params.get('token')).toBe(tokens('b').refresh_token);
      return new Response(null, { status: 200 });
    };
    const refreshed = await savedLogin({ baseUrl: f.apiBase, profilePath: f.profilePath, request });
    expect(refreshed).toMatchObject({
      baseUrl: f.apiBase,
      issuer: f.issuer,
      resource: `${f.issuer}/mcp`,
      workspaceId: 'team-studio',
      refreshToken: tokens('b').refresh_token,
    });
    expect(
      await savedLogin({ baseUrl: 'http://127.0.0.1:9999', profilePath: f.profilePath, request }),
    ).toBeUndefined();
    await logout({ profilePath: f.profilePath, request });
    expect(calls).toEqual([`${f.issuer}/oauth/token`, `${f.issuer}/oauth/revoke`]);
    await expect(access(f.profilePath)).rejects.toThrow();
  });

  it('rejects a refresh that changes the consenting payer or expands its permissions', async () => {
    for (const change of [
      { workspace_id: 'other-payer' },
      { scope: 'read generate', workspace_id: 'team-studio' },
    ]) {
      const f = await fixture();
      await browserLogin({
        baseUrl,
        profilePath: f.profilePath,
        request: f.request,
        openBrowser: f.openBrowser,
      });
      const profile = JSON.parse(await readFile(f.profilePath, 'utf8'));
      profile.expiresAt = new Date(0).toISOString();
      profile.scope = 'read';
      await writeFile(f.profilePath, JSON.stringify(profile));
      await expect(
        savedLogin({
          baseUrl,
          profilePath: f.profilePath,
          request: async () => json({ ...tokens('b'), scope: 'read', ...change }),
        }),
      ).rejects.toThrow('No tokens or private response details');
      const retained = JSON.parse(await readFile(f.profilePath, 'utf8'));
      expect(retained.workspaceId).toBe('team-studio');
      expect(retained.refreshToken).toBe(refreshToken);
    }
  });

  it('fails closed on unsafe or conflicting discovery documents before registering or opening a browser', async () => {
    const cases = [
      { resource: { ...resourceMetadata(baseUrl), resource: 'https://different.example/mcp' } },
      {
        resource: {
          ...resourceMetadata(baseUrl),
          authorization_servers: [baseUrl, 'https://different.example'],
        },
      },
      { resource: resourceMetadata('http://127.0.0.1:4320') },
      { resource: resourceMetadata('https://private.internal') },
      {
        metadata: {
          ...serverMetadata(baseUrl),
          token_endpoint: 'https://different.example/oauth/token',
        },
      },
      { metadata: { ...serverMetadata(baseUrl), issuer: 'https://different.example' } },
      { metadata: { ...serverMetadata(baseUrl), code_challenge_methods_supported: ['plain'] } },
    ];
    for (const item of cases) {
      const f = await fixture();
      let opened = false,
        registrations = 0;
      const request: typeof fetch = async (input, init) => {
        expect(init?.redirect).toBe('error');
        const url = String(input);
        if (url === `${baseUrl}/.well-known/oauth-protected-resource/mcp`)
          return json(item.resource ?? resourceMetadata(baseUrl));
        if (url === `${baseUrl}/.well-known/oauth-authorization-server`)
          return json(item.metadata ?? serverMetadata(baseUrl));
        registrations++;
        throw new Error('Untrusted metadata must not select another endpoint.');
      };
      await expect(
        browserLogin({
          baseUrl,
          profilePath: f.profilePath,
          request,
          openBrowser: () => {
            opened = true;
          },
        }),
      ).rejects.toThrow();
      expect(opened).toBe(false);
      expect(registrations).toBe(0);
      await expect(access(f.profilePath)).rejects.toThrow();
    }
  });

  it('bounds metadata JSON and does not follow redirects or expose malformed response bodies', async () => {
    for (const response of [
      new Response('{private-discovery-body', { headers: { 'content-type': 'application/json' } }),
      json({ padding: 'x'.repeat(16385) }),
      new Response(null, {
        status: 302,
        headers: { location: 'https://different.example/metadata' },
      }),
    ]) {
      const f = await fixture();
      let requests = 0;
      const request: typeof fetch = async (_input, init) => {
        requests++;
        expect(init?.redirect).toBe('error');
        return response;
      };
      await expect(
        browserLogin({
          baseUrl,
          profilePath: f.profilePath,
          request,
          openBrowser: () => {
            throw new Error('Must not open.');
          },
        }),
      ).rejects.toThrow('No tokens or private response details');
      expect(requests).toBe(1);
      await expect(access(f.profilePath)).rejects.toThrow();
    }
  });
});
