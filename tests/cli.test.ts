import { mkdtemp, writeFile, rm, open, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenGen } from '@media-router/sdk';
import { runCommand } from '../apps/cli/src/index';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function localFile(name: string, content: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), 'opengen-cli-fixture-'));
  directories.push(dir);
  const file = join(dir, name);
  await writeFile(file, content, { mode: 0o600 });
  return file;
}
const generation = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A quiet sea.', resolution: '720p', duration: 5, aspectRatio: '16:9' },
};
const jobId = '0cc4fdd7-dcec-4ae1-afc3-b4d7545f2e69';
const json = (value: unknown, init?: ResponseInit) => Response.json(value, init);
describe('CLI journeys over the shared SDK', () => {
  it('runs browser login, safe status, authenticated requests and revocation without returning tokens', async () => {
    const profilePath = await localFile('auth-location', '');
    await rm(profilePath);
    const baseUrl = 'https://gateway.example';
    const accessToken = `og_mcp_a_${'a'.repeat(43)}`;
    const refreshToken = `og_mcp_r_${'a'.repeat(43)}`;
    const paths: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/.well-known/oauth-protected-resource/mcp')
        return json({
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          bearer_methods_supported: ['header'],
        });
      if (path === '/.well-known/oauth-authorization-server')
        return json({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          revocation_endpoint: `${baseUrl}/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['read', 'generate'],
        });
      if (path === '/oauth/register') return json({ client_id: 'cli-fixture' });
      if (path === '/oauth/token')
        return json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read generate',
          workspace_id: 'team-studio',
        });
      if (path === '/oauth/revoke') {
        expect(new URLSearchParams(String(init?.body)).get('token')).toBe(refreshToken);
        return new Response(null, { status: 200 });
      }
      if (path === '/v1/doctor')
        return json({
          authenticated: true,
          authorized: true,
          payingWorkspace: { id: 'team-studio', name: 'Studio' },
          scopes: ['read', 'generate'],
        });
      expect(path).toBe('/v1/balance');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
      return json({ availableMicros: 50, reservedMicros: 0, currency: 'USD' });
    };
    const options = {
      env: { NODE_ENV: 'test' as const, MEDIA_ROUTER_URL: baseUrl },
      profilePath,
      request,
    };
    const signedIn = await runCommand(['login'], {
      ...options,
      openBrowser: async (value) => {
        const authorize = new URL(value);
        const callback = new URL(authorize.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', authorize.searchParams.get('state')!);
        callback.searchParams.set('code', 'one-time-code');
        expect((await fetch(callback)).status).toBe(200);
      },
    });
    const status = await runCommand(['status'], options);
    const balance = await runCommand(['balance'], options);
    const signedOut = await runCommand(['logout'], options);
    expect(status).toMatchObject({
      connected: true,
      workspaceId: 'team-studio',
      authentication: 'browser',
    });
    expect(balance).toMatchObject({ availableMicros: 50 });
    expect(signedOut).toEqual({ signedOut: true, environmentTokenConfigured: false });
    const output = JSON.stringify([signedIn, status, balance, signedOut]);
    expect(output).not.toContain(accessToken);
    expect(output).not.toContain(refreshToken);
    await expect(access(profilePath)).rejects.toThrow();
    expect(paths).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/token',
      '/v1/doctor',
      '/v1/balance',
      '/oauth/revoke',
    ]);
  });

  it('gives explicit environment credentials precedence over an unusable saved profile', async () => {
    const profilePath = await localFile('invalid-profile.json', '{not private profile JSON');
    const env = {
      NODE_ENV: 'test' as const,
      MEDIA_ROUTER_URL: 'https://gateway.example',
      MEDIA_ROUTER_TOKEN: 'environment-private-fixture',
    };
    const calls: string[] = [];
    const options = {
      env,
      profilePath,
      request: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(new Headers(init?.headers).get('authorization')!);
        if (new URL(String(url)).pathname === '/v1/doctor')
          return json({ error: { code: 'unauthorized', message: 'Rejected.' } }, { status: 401 });
        return json({ availableMicros: 0 });
      },
    };
    expect(await runCommand(['status'], options)).toMatchObject({
      connected: false,
      authenticated: false,
      credentialPresent: true,
      baseUrl: env.MEDIA_ROUTER_URL,
      authentication: 'environment',
      nextBlocker: { code: 'credential_rejected' },
    });
    await runCommand(['balance'], options);
    expect(calls).toEqual([
      'Bearer environment-private-fixture',
      'Bearer environment-private-fixture',
    ]);
    expect(await readFile(profilePath, 'utf8')).toBe('{not private profile JSON');
    expect(await runCommand(['--help'], options)).toContain('login');
    await expect(runCommand(['balance', '--token', 'never-accepted'], options)).rejects.toThrow();
  });

  it('uses the canonical schema for raw JSON and registered calls before making a request', async () => {
    const bodies: unknown[] = [];
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ data: [] });
      },
    });
    const native = {
      modelId: 'minimax/h3-max',
      operation: 'reference-to-video',
      input: {
        prompt: 'A push in.',
        references: [{ type: 'image', asset: { assetKey: 'inputs/owned/subject.png' } }],
        duration: 5.5,
        resolution: '768p',
        aspectRatio: '16:9',
        promptExpansion: 'quality',
      },
    };
    await runCommand(['quote', JSON.stringify(native)], { client });
    const file = await localFile('batch.json', JSON.stringify([native]));
    await runCommand(['call', 'quotes.batch', '--input', file], { client });
    expect(bodies).toEqual([native, [native]]);
    await expect(
      runCommand(
        [
          'quote',
          JSON.stringify({
            modelId: generation.modelId,
            operation: generation.operation,
            prompt: 'Legacy shape.',
          }),
        ],
        { client },
      ),
    ).rejects.toThrow();
    const invalid = await localFile(
      'invalid-generation.json',
      JSON.stringify({
        ...native,
        input: { ...native.input, arbitraryProviderBody: { secret: 'not-supported' } },
      }),
    );
    await expect(
      runCommand(
        ['call', 'media.generate', '--input', invalid, '--idempotency-key', 'never-submitted'],
        { client },
      ),
    ).rejects.toThrow('Unknown argument');
    expect(bodies).toHaveLength(2);
  });

  it('requires a persisted key before generation and never repeats a paid POST on a disconnect', async () => {
    const file = await localFile('request.json', JSON.stringify(generation));
    let requests = 0;
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      apiKey: 'fixture-workspace-key',
      fetch: async (_url, options) => {
        requests++;
        expect(new Headers(options?.headers).get('Idempotency-Key')).toBe('saved-before-submit');
        expect(JSON.parse(String(options?.body))).toEqual(generation);
        throw new Error('Network disconnected after sending');
      },
    });
    await expect(runCommand(['generate', '--input', file], { client })).rejects.toThrow(
      'idempotency-key',
    );
    expect(requests).toBe(0);
    await expect(
      runCommand(['generate', '--input', file, '--idempotency-key', 'saved-before-submit'], {
        client,
      }),
    ).rejects.toMatchObject({
      name: 'SubmissionUncertainError',
      idempotencyKey: 'saved-before-submit',
    });
    expect(requests).toBe(1);
  });
  it('executes only registered targets and reads private connection values from a file', async () => {
    const file = await localFile(
      'connection.json',
      JSON.stringify({ deploymentId: 'fal-undisclosed', apiKey: 'fixture-private-provider' }),
    );
    const requests: { path: string; body: unknown }[] = [];
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (url, options) => {
        requests.push({
          path: new URL(String(url)).pathname,
          body: JSON.parse(String(options?.body)),
        });
        return json({ configured: true });
      },
    });
    await expect(
      runCommand(['call', 'https://untrusted.example', '--input', file], { client }),
    ).rejects.toThrow('registered operation');
    expect(requests).toHaveLength(0);
    await expect(
      runCommand(['call', 'connections.put', '{"apiKey":"no-argv"}'], { client }),
    ).rejects.toThrow('not inline argv');
    await runCommand(['call', 'connections.put', '--input', file], { client });
    expect(requests).toEqual([
      { path: '/v1/connections/fal-undisclosed', body: { apiKey: 'fixture-private-provider' } },
    ]);
  });
  it('uploads exact bytes through the signed storage boundary and returns only a stable owned key', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const file = await localFile('source.png', bytes);
    const gatewayPaths: string[] = [];
    let uploadCalls = 0;
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      apiKey: 'fixture-workspace-key',
      fetch: async (url, options) => {
        const path = new URL(String(url)).pathname;
        gatewayPaths.push(path);
        if (path === '/v1/assets') {
          expect(JSON.parse(String(options?.body))).toEqual({
            mediaType: 'image/png',
            size: bytes.length,
          });
          return json({
            key: 'inputs/owned/file.png',
            uploadUrl: 'https://storage.example/file?X-Amz-Signature=private-fixture',
            headers: { 'Content-Type': 'image/png' },
            expiresAt: '2026-11-03T00:00:00Z',
          });
        }
        expect(path).toBe('/v1/assets/complete');
        return json({
          assetKey: 'inputs/owned/file.png',
          state: 'ready',
          mediaType: 'image/png',
          byteLength: bytes.length,
          sha256: 'a'.repeat(64),
          expiresAt: null,
          deletionPending: false,
        });
      },
    });
    const uploadFetch: typeof fetch = async (url, options) => {
      uploadCalls++;
      expect(String(url)).toContain('storage.example');
      expect(new Headers(options?.headers).has('Authorization')).toBe(false);
      expect(Buffer.from(options?.body as Uint8Array)).toEqual(bytes);
      expect(options?.redirect).toBe('error');
      return new Response(null, { status: 200 });
    };
    const result = await runCommand(['upload', file], { client, uploadFetch });
    expect(result).toEqual({
      asset: { assetKey: 'inputs/owned/file.png' },
      mediaType: 'image/png',
      byteLength: bytes.length,
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(uploadCalls).toBe(1);
    expect(gatewayPaths).toEqual(['/v1/assets', '/v1/assets/complete']);
  });
  it('does not retry or print signed URLs when upload fails and removes its newly prepared object', async () => {
    const file = await localFile('source.webp', Buffer.from('synthetic upload bytes'));
    const methods: string[] = [];
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (_url, options) => {
        methods.push(options?.method!);
        return options?.method === 'DELETE'
          ? json({ deleted: true })
          : json({
              key: 'inputs/owned/file.webp',
              uploadUrl: 'https://storage.example/?signature=private-query',
              headers: { 'Content-Type': 'image/webp' },
            });
      },
    });
    let calls = 0;
    try {
      await runCommand(['upload', file], {
        client,
        uploadFetch: async () => {
          calls++;
          throw new Error('Request failed at https://storage.example/?signature=private-query');
        },
      });
      throw new Error('Expected failure');
    } catch (error) {
      expect(String(error)).toContain('No generation was submitted');
      expect(String(error)).not.toContain('private-query');
    }
    expect(calls).toBe(1);
    expect(methods).toEqual(['POST', 'DELETE']);
  });
  it('resumes an existing job using status reads only, including an unresolved outcome', async () => {
    const requests: string[] = [];
    let polls = 0;
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (url, options) => {
        requests.push(`${options?.method} ${new URL(String(url)).pathname}`);
        return json({ id: jobId, status: ++polls === 1 ? 'running' : 'submission-unknown' });
      },
    });
    const result = await runCommand(
      ['job', 'resume', jobId, '--poll-interval-ms', '1', '--timeout-ms', '1000'],
      { client },
    );
    expect(result).toMatchObject({ id: jobId, status: 'submission-unknown' });
    expect(requests).toEqual([`GET /v1/generations/${jobId}`, `GET /v1/generations/${jobId}`]);
  });
  it('rejects oversized input before network access and redacts malformed private JSON', async () => {
    const path = await localFile('large.mp4', 'x');
    const handle = await open(path, 'r+');
    await handle.truncate(100 * 1024 * 1024 + 1);
    await handle.close();
    let requests = 0;
    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async () => {
        requests++;
        return json({});
      },
    });
    await expect(runCommand(['upload', path], { client })).rejects.toThrow('100 MiB');
    const broken = await localFile('private.json', '{"apiKey":"do-not-print-private-value"');
    try {
      await runCommand(['call', 'connections.put', '--input', broken], { client });
      throw new Error('Expected failure');
    } catch (error) {
      expect(String(error)).toContain('valid JSON');
      expect(String(error)).not.toContain('do-not-print-private-value');
    }
    expect(requests).toBe(0);
  });
});
