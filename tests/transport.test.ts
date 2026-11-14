import { afterEach, describe, expect, it, vi } from 'vitest';
import { operationTargets, agentSkill } from '@media-router/contracts';
import { catalog } from '@media-router/catalog';
import { createGcpTransport } from '../apps/web/app/gcp-transport';
import { createForwarder } from '../apps/web/app/proxy';
import { nativeGateway, localCatalog, nativeRoute } from '../apps/web/app/native-gateway';
import { registeredBackendPath } from '../apps/web/app/registered-http';

afterEach(() => vi.unstubAllEnvs());
const env = {
  NODE_ENV: 'test',
  GCP_WORKLOAD_IDENTITY_PROVIDER:
    'projects/123456789/locations/global/workloadIdentityPools/vercel/providers/opengen',
  GCP_SERVICE_ACCOUNT_EMAIL: 'vercel@fixture-project.iam.gserviceaccount.com',
} satisfies NodeJS.ProcessEnv;
const backend = 'https://fixture-api-abc-uc.a.run.app';
const idToken = (audience: string, expires: number) =>
  `header.${Buffer.from(JSON.stringify({ aud: audience, exp: expires })).toString('base64url')}.signature`;
const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('hosted native API routing', () => {
  it('serves the shared public catalog before the backend is provisioned and returns real missing entries', async () => {
    vi.stubEnv('MEDIA_ROUTER_API_URL', '');
    const response = await nativeGateway(new Request('https://opengen.example/v1/models'));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toHaveLength(catalog.models.length);
    const series = localCatalog(new Request('https://opengen.example/v1/series/minimax/h3'))!;
    expect((await series.json()).models).toHaveLength(6);
    const legacy = localCatalog(
      new Request('https://opengen.example/v1/routes?modelId=fal%2Fh3-max'),
    )!;
    const maxRoutes = (await legacy.json()).data;
    expect(maxRoutes).toHaveLength(4);
    expect(
      maxRoutes.every((route: { modelId: string }) => route.modelId === 'minimax/h3-max'),
    ).toBe(true);
    expect(
      maxRoutes.map((route: { providerModelName: string }) => route.providerModelName),
    ).toEqual(expect.arrayContaining(['MiniMax H3 Max', 'H3 Max']));
    expect(localCatalog(new Request('https://opengen.example/v1/companies/unknown'))!.status).toBe(
      404,
    );
    expect(
      localCatalog(new Request('https://opengen.example/v1/series/minimax/unknown'))!.status,
    ).toBe(404);
    const regional = localCatalog(
      new Request('https://opengen.example/v1/routes?modelId=alibaba%2Fwan-3.0'),
    )!;
    expect((await regional.json()).data).toHaveLength(9);
    expect(localCatalog(new Request('https://opengen.example/v1/metrics'))).toBeUndefined();
    expect(localCatalog(new Request('https://opengen.example/v1/generations'))).toBeUndefined();
    const head = await nativeGateway(
      new Request('https://opengen.example/v1/models', { method: 'HEAD' }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
  it('matches only registered methods/paths and cannot reinterpret encoded values as an origin or path', async () => {
    for (const target of Object.values(operationTargets)) {
      const path = target.path.replace(/:[a-zA-Z]+/g, 'fixture-id');
      expect(nativeRoute(path)?.methods).toContain(target.method);
      expect(registeredBackendPath(path, target.method)).toBe(true);
    }
    for (const path of [
      '/v1/not-registered',
      '/v1/companies/%2Fetc',
      '/v1/companies/%5cetc',
      '/v1//models',
      '/v1/companies/..',
      '/v1/companies/%E0%A4%A',
    ])
      expect(nativeRoute(path)).toBeUndefined();
    for (const path of [
      'https://metadata.invalid/v1/models',
      '//metadata.invalid/v1/models',
      '/v1/../health',
      '/v1/models#fragment',
    ])
      expect(registeredBackendPath(path, 'GET')).toBe(false);
    const missing = await nativeGateway(new Request('https://opengen.example/v1/arbitrary-proxy'));
    expect(missing.status).toBe(404);
    const method = await nativeGateway(
      new Request('https://opengen.example/v1/models', { method: 'DELETE' }),
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toContain('GET');
    expect(agentSkill('https://opengen.example')).toContain('https://opengen.example/mcp');
    expect(agentSkill('https://opengen.example')).toContain('fail closed');
    expect(agentSkill('https://opengen.example')).toContain(
      'https://opengen.example/v1/operations',
    );
  });
});

describe('frontend proxy authorization and media negotiation', () => {
  it('preserves caller authorization, idempotency, sessions and protocol headers while separating service identity', async () => {
    let outbound: RequestInit | undefined;
    let destination: string | undefined;
    const request: typeof fetch = async (url, init) => {
      outbound = init;
      destination = String(url);
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate':
            'Bearer resource_metadata="https://opengen.example/.well-known/oauth-protected-resource/mcp"',
          'Set-Cookie': 'og_session=rotated; HttpOnly; Secure',
          'Mcp-Protocol-Version': '2025-06-18',
          'X-Serverless-Authorization': 'must-not-return-service-token',
        },
      });
    };
    const forward = createForwarder({
      env: {
        NODE_ENV: 'test',
        MEDIA_ROUTER_API_URL: backend,
        MR_API_TOKEN: 'operator-must-not-be-injected',
      },
      request,
      transport: async () => 'service-identity',
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const response = await forward(
      new Request('https://opengen.example/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer caller-key',
          'Idempotency-Key': 'stable-request',
          Cookie: 'og_session=private-session',
          Origin: 'https://opengen.example',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Mcp-Protocol-Version': '2025-06-18',
          'Mcp-Session-Id': 'caller-session',
          'X-Serverless-Authorization': 'attacker-selected-service-token',
          'X-HTTP-Method-Override': 'DELETE',
        },
        body,
      }),
      '/mcp',
    );
    const headers = new Headers(outbound!.headers);
    expect(destination).toBe(backend + '/mcp');
    expect(outbound!.redirect).toBe('manual');
    expect(outbound!.body).toBe(body);
    expect(headers.get('authorization')).toBe('Bearer caller-key');
    expect(headers.get('x-serverless-authorization')).toBe('Bearer service-identity');
    expect(headers.get('idempotency-key')).toBe('stable-request');
    expect(headers.get('cookie')).toBe('og_session=private-session');
    expect(headers.get('origin')).toBe('https://opengen.example');
    expect(headers.get('accept')).toBe('application/json, text/event-stream');
    expect(headers.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(headers.get('mcp-session-id')).toBe('caller-session');
    expect(headers.has('x-http-method-override')).toBe(false);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(response.headers.get('set-cookie')).toContain('og_session=rotated');
    expect(response.headers.get('x-serverless-authorization')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('does not inject an operator credential, preserves non-JSON output and fails closed when transport fails', async () => {
    let headers: Headers | undefined;
    const forward = createForwarder({
      env: { NODE_ENV: 'test', MR_API_TOKEN: 'operator-private-value' },
      transport: async () => undefined,
      request: async (_url, init) => {
        headers = new Headers(init?.headers);
        return new Response('id,amount\nfixture,1\n', {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="ledger.csv"',
            'X-Next-Cursor': 'next-page',
          },
        });
      },
    });
    const response = await forward(
      new Request('https://opengen.example/v1/ledger/export'),
      '/v1/ledger/export?format=json',
    );
    expect(headers!.has('authorization')).toBe(false);
    expect(headers!.has('x-serverless-authorization')).toBe(false);
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(response.headers.get('content-disposition')).toContain('ledger.csv');
    expect(response.headers.get('x-next-cursor')).toBe('next-page');
    expect(await response.text()).toBe('id,amount\nfixture,1\n');
    let calls = 0;
    const closed = createForwarder({
      transport: async () => {
        throw new Error('secret-subject-token-must-not-return');
      },
      request: async () => {
        calls++;
        return json({});
      },
    });
    const rejected = await closed(
      new Request('https://opengen.example/v1/generations'),
      '/v1/generations',
    );
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).not.toContain('secret-subject-token');
    expect(calls).toBe(0);
  });
  it('rejects unregistered targets, non-JSON mutations and oversized bodies before transport or backend calls', async () => {
    let calls = 0;
    const forward = createForwarder({
      request: async () => {
        calls++;
        return json({});
      },
      transport: async () => {
        calls++;
        return undefined;
      },
    });
    expect(
      (
        await forward(
          new Request('https://opengen.example/v1/models'),
          '//attacker.invalid/v1/models',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await forward(
          new Request('https://opengen.example/v1/models', { method: 'DELETE' }),
          '/v1/models',
        )
      ).status,
    ).toBe(404);
    const text = new Request('https://opengen.example/v1/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect((await forward(text, '/v1/generations')).status).toBe(415);
    const large = new Request('https://opengen.example/v1/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ' '.repeat(1_000_001),
    });
    expect((await forward(large, '/v1/generations')).status).toBe(413);
    expect(calls).toBe(0);
  });
  it('allows only fixed OAuth protocol paths and bounded token/revoke forms, preserving public-client CORS', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const forward = createForwarder({
      env: { NODE_ENV: 'test', MEDIA_ROUTER_API_URL: backend, MR_API_TOKEN: 'never-inject' },
      transport: async () => undefined,
      request: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '600',
            'Access-Control-Allow-Credentials': 'true',
          },
        });
      },
    });
    for (const path of ['/oauth/token', '/oauth/revoke']) {
      const body = new URLSearchParams({
        client_id: 'public-client',
        token: 'opaque-token',
      }).toString();
      const response = await forward(
        new Request(`https://opengen.example${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://client.example',
          },
          body,
        }),
        path,
      );
      const call = calls.at(-1)!;
      expect(call.url).toBe(backend + path);
      expect(call.init?.body).toBe(body);
      expect(new Headers(call.init?.headers).get('content-type')).toBe(
        'application/x-www-form-urlencoded',
      );
      expect(new Headers(call.init?.headers).has('authorization')).toBe(false);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    }
    for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/register']) {
      const response = await forward(
        new Request(`https://opengen.example${path}`, { method: 'OPTIONS' }),
        path,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    }
    expect(registeredBackendPath('/.well-known/oauth-authorization-server', 'GET')).toBe(true);
    expect(registeredBackendPath('/oauth/authorize?client_id=public-client', 'GET')).toBe(true);
    expect(nativeRoute('/v1/oauth/grants')?.methods).toContain('GET');
    const count = calls.length;
    for (const path of ['/oauth/register', '/oauth/consent', '/v1/generations'])
      expect(
        (
          await forward(
            new Request(`https://opengen.example${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: 'anything=value',
            }),
            path,
          )
        ).status,
      ).toBe(415);
    expect(
      (
        await forward(
          new Request('https://opengen.example/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: ' '.repeat(16385),
          }),
          '/oauth/token',
        )
      ).status,
    ).toBe(413);
    for (const path of ['/oauth/anything', '/oauth/../auth/login', '/oauth/token/extra'])
      expect(
        (
          await forward(
            new Request('https://opengen.example/oauth/token', { method: 'POST' }),
            path,
          )
        ).status,
      ).toBe(404);
    expect(calls.length).toBe(count);
  });
});

describe('keyless Vercel-to-GCP identity transport', () => {
  it('exchanges only with fixed Google endpoints, deduplicates refresh, and bounds its ID-token cache', async () => {
    let clock = 1_000_000,
      reads = 0;
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const request: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      expect(init?.redirect).toBe('error');
      return String(url).includes('sts.googleapis.com')
        ? json({ access_token: 'sts-short-lived-fixture', expires_in: 3600 })
        : json({ token: idToken(backend, clock / 1000 + 3600) });
    };
    const token = createGcpTransport({
      env,
      request,
      now: () => clock,
      getOidcToken: async (options) => {
        reads++;
        expect(options.audience).toBe(
          `https://iam.googleapis.com/${env.GCP_WORKLOAD_IDENTITY_PROVIDER}`,
        );
        return 'vercel-subject-fixture';
      },
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => token(backend)));
    expect(new Set(results).size).toBe(1);
    expect(calls).toHaveLength(2);
    expect(reads).toBe(1);
    expect(calls[0]!.url).toBe('https://sts.googleapis.com/v1/token');
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(calls[0]!.body).toMatchObject({
      audience: `//iam.googleapis.com/${env.GCP_WORKLOAD_IDENTITY_PROVIDER}`,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subjectToken: 'vercel-subject-fixture',
    });
    expect(calls[1]!.url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.GCP_SERVICE_ACCOUNT_EMAIL)}:generateIdToken`,
    );
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer sts-short-lived-fixture');
    expect(calls[1]!.body).toEqual({ audience: backend, includeEmail: true });
    clock += 300_001;
    await token(backend);
    expect(calls).toHaveLength(4);
    expect(reads).toBe(2);
  });
  it('does nothing without federation config and rejects partial config, arbitrary targets and failed exchanges', async () => {
    let calls = 0;
    const noNetwork: typeof fetch = async () => {
      calls++;
      throw new Error('No real GCP request is permitted in this test.');
    };
    expect(
      await createGcpTransport({ env: { NODE_ENV: 'test' }, request: noNetwork })(backend),
    ).toBeUndefined();
    await expect(
      createGcpTransport({
        env: { NODE_ENV: 'test', GCP_SERVICE_ACCOUNT_EMAIL: env.GCP_SERVICE_ACCOUNT_EMAIL },
        request: noNetwork,
      })(backend),
    ).rejects.toThrow('not configured');
    for (const name of ['GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_SERVICE_ACCOUNT_EMAIL'] as const)
      for (const suffix of ['\n', ' '])
        await expect(
          createGcpTransport({
            env: { ...env, [name]: env[name] + suffix },
            request: noNetwork,
            getOidcToken: async () => {
              calls++;
              return 'must-not-read';
            },
          })(backend),
        ).rejects.toThrow('not configured');
    for (const target of ['http://127.0.0.1:4310', 'https://attacker.example', backend + '/path'])
      await expect(createGcpTransport({ env, request: noNetwork })(target)).rejects.toThrow(
        'not configured',
      );
    expect(calls).toBe(0);
    const failed = createGcpTransport({
      env,
      getOidcToken: async () => 'subject-never-log',
      request: async () => json({ error: 'secret-error-body-never-log' }, 403),
    });
    await expect(failed(backend)).rejects.toThrow('not configured');
    const expired = createGcpTransport({
      env,
      getOidcToken: async () => 'subject',
      request: async (url) =>
        String(url).includes('sts.googleapis.com')
          ? json({ access_token: 'sts' })
          : json({ token: idToken(backend, 1) }),
    });
    await expect(expired(backend)).rejects.toThrow('not configured');
  });
});
