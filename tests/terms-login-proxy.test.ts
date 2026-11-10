import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForwarder } from '../apps/web/app/proxy';
import { registeredBackendPath, nativeRoute } from '../apps/web/app/registered-http';
import { GET, POST } from '../apps/web/app/auth/login/route';

const { routeForward } = vi.hoisted(() => ({ routeForward: vi.fn() }));
vi.mock('../apps/web/app/proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/app/proxy')>()),
  forward: routeForward,
}));
afterEach(() => vi.clearAllMocks());

const publicOrigin = 'https://opengen.example';
const backend = 'https://gateway.example';
const formType = 'application/x-www-form-urlencoded';
const sample = 'action=continue&token=synthetic-signed-intent';
function fixture(response?: () => Response) {
  const request = vi.fn<typeof fetch>(
    async () => response?.() ?? new Response(null, { status: 204 }),
  );
  const transport = vi.fn(async () => 'service-identity-fixture');
  const forward = createForwarder({
    env: {
      NODE_ENV: 'test',
      MEDIA_ROUTER_API_URL: backend,
      MR_API_TOKEN: 'operator-never-injected',
    },
    request,
    transport,
  });
  return { request, transport, forward };
}
function post(body: BodyInit | undefined = sample, headers: HeadersInit = {}) {
  return new Request(`${publicOrigin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': formType, origin: publicOrigin, ...headers },
    body,
  });
}

describe('human Terms notice frontend transport', () => {
  it('registers POST only at the exact login protocol endpoint without exposing it as a business operation', () => {
    expect(registeredBackendPath('/auth/login', 'GET')).toBe(true);
    expect(registeredBackendPath('/auth/login', 'POST')).toBe(true);
    expect(registeredBackendPath('/auth/login?request=unchanged', 'POST')).toBe(true);
    expect(nativeRoute('/auth/login')).toBeUndefined();
    for (const method of ['DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'])
      expect(registeredBackendPath('/auth/login', method)).toBe(false);
    for (const path of [
      '/auth/callback',
      '/auth/login/continue',
      '/auth/login-extra',
      '/auth/%6Cogin',
      '/oauth/../auth/login',
      '/auth/login#fragment',
      '//attacker.example/auth/login',
    ])
      expect(registeredBackendPath(path, 'POST')).toBe(false);
  });

  it('forwards GET notice and POST Continue through the existing explicit Next route', async () => {
    for (const [method, handler] of [
      ['GET', GET],
      ['POST', POST],
    ] as const) {
      const request = new Request(`${publicOrigin}/auth/login?request=pending%2Fopaque`, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': formType }, body: sample } : {}),
      });
      const response = new Response('notice-or-redirect');
      routeForward.mockResolvedValueOnce(response);
      expect(await handler(request)).toBe(response);
      expect(routeForward).toHaveBeenLastCalledWith(
        request,
        '/auth/login?request=pending%2Fopaque',
      );
    }
  });

  it.each([formType, `${formType}; charset=UTF-8`, `${formType}; charset="utf-8"`])(
    'preserves raw action bytes, duplicates and encoded fields for server validation with %s',
    async (contentType) => {
      const f = fixture();
      const body =
        'action=continue&token=first&%74oken=second&token=third%2Bvalue&label=hello+there%20again';
      expect(
        (await f.forward(post(body, { 'content-type': contentType }), '/auth/login')).status,
      ).toBe(204);
      const call = f.request.mock.calls[0]!;
      expect(call[0]).toBe(`${backend}/auth/login`);
      expect(call[1]?.method).toBe('POST');
      expect(Buffer.from(call[1]!.body as ArrayBuffer)).toEqual(Buffer.from(body));
      expect(new Headers(call[1]?.headers).get('content-type')).toBe(contentType);
      expect(call[1]?.redirect).toBe('manual');
      expect(call[1]?.cache).toBe('no-store');
    },
  );

  it('preserves actual Origin/cookies/bearer and separates server transport identity without inventing authority', async () => {
    const f = fixture();
    for (const origin of [publicOrigin, 'https://attacker.example', 'null', undefined]) {
      const headers = new Headers({
        'content-type': formType,
        cookie: 'og_login_intent=signed; og_mcp_consent=pending; unrelated=keep',
        authorization: 'Bearer caller-value',
        'x-serverless-authorization': 'spoofed-service-token',
        'x-http-method-override': 'GET',
        'x-forwarded-origin': publicOrigin,
      });
      if (origin !== undefined) headers.set('origin', origin);
      const response = await f.forward(
        new Request(`${publicOrigin}/auth/login`, { method: 'POST', headers, body: sample }),
        '/auth/login',
      );
      expect(response.status).toBe(204);
      const sent = new Headers(f.request.mock.calls.at(-1)?.[1]?.headers);
      expect(sent.get('origin')).toBe(origin ?? null);
      expect(sent.get('cookie')).toBe(
        'og_login_intent=signed; og_mcp_consent=pending; unrelated=keep',
      );
      expect(sent.get('authorization')).toBe('Bearer caller-value');
      expect(sent.get('x-serverless-authorization')).toBe('Bearer service-identity-fixture');
      expect(sent.has('x-http-method-override')).toBe(false);
      expect(sent.has('x-forwarded-origin')).toBe(false);
    }
  });

  it('preserves an absent bearer even when operator configuration exists', async () => {
    const f = fixture();
    await f.forward(post(), '/auth/login');
    const sent = new Headers(f.request.mock.calls[0]?.[1]?.headers);
    expect(sent.has('authorization')).toBe(false);
    expect(sent.has('cookie')).toBe(false);
  });

  it('accepts exactly 2 KiB and rejects larger streamed UTF-8 bytes before service identity or backend requests', async () => {
    const f = fixture();
    const prefix = 'action=continue&token=';
    const exact = prefix + 'a'.repeat(2048 - Buffer.byteLength(prefix));
    expect((await f.forward(post(exact), '/auth/login')).status).toBe(204);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.transport).toHaveBeenCalledTimes(1);
    f.request.mockClear();
    f.transport.mockClear();
    for (const content of [exact + 'a', 'x=' + 'é'.repeat(1024)]) {
      const bytes = Buffer.from(content);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 1000));
          controller.enqueue(bytes.subarray(1000));
          controller.close();
        },
      });
      const request = new Request(`${publicOrigin}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': formType, 'content-length': '1' },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      const response = await f.forward(request, '/auth/login');
      expect(response.status).toBe(413);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([
    'application/json',
    'text/plain',
    'multipart/form-data; boundary=fixture',
    `${formType}; charset=iso-8859-1`,
    `${formType}; charset=utf-8; charset=utf-8`,
    `${formType}; extra=value`,
  ])('rejects the unsupported form media type %s without forwarding', async (contentType) => {
    const f = fixture();
    const response = await f.forward(post(sample, { 'content-type': contentType }), '/auth/login');
    expect(response.status).toBe(415);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rejects missing media type even for an empty POST and leaves valid empty form semantics to the server', async () => {
    const f = fixture();
    expect(
      (
        await f.forward(
          new Request(`${publicOrigin}/auth/login`, { method: 'POST' }),
          '/auth/login',
        )
      ).status,
    ).toBe(415);
    expect(f.request).not.toHaveBeenCalled();
    expect(
      (
        await f.forward(
          new Request(`${publicOrigin}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': formType },
          }),
          '/auth/login',
        )
      ).status,
    ).toBe(204);
    expect(new Headers(f.request.mock.calls[0]?.[1]?.headers).get('content-type')).toBe(formType);
    expect(f.request.mock.calls[0]?.[1]?.body).toBe('');
  });

  it('rejects malformed UTF-8 without replacement decoding and preserves valid non-ASCII bytes', async () => {
    const f = fixture();
    const response = await f.forward(post(new Uint8Array([0x61, 0x3d, 0xff])), '/auth/login');
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    const valid = Buffer.from('action=continue&token=synthetic&label=résumé');
    expect((await f.forward(post(valid), '/auth/login')).status).toBe(204);
    expect(Buffer.from(f.request.mock.calls[0]![1]!.body as ArrayBuffer)).toEqual(valid);
  });

  it.each(['GET', 'POST'])(
    'preserves server HTML security headers and HttpOnly cookies on %s',
    async (method) => {
      const csp =
        "default-src 'none'; style-src 'nonce-fixture'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
      const f = fixture(() => {
        const headers = new Headers({
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'content-security-policy': csp,
          'referrer-policy': 'same-origin',
          'x-content-type-options': 'nosniff',
          'x-serverless-authorization': 'must-not-return',
          'access-control-allow-origin': '*',
        });
        headers.append('set-cookie', 'og_login_intent=signed; HttpOnly; Secure; SameSite=Lax');
        headers.append('set-cookie', 'og_oidc=; HttpOnly; Secure; Max-Age=0');
        return new Response('<!doctype html><form method="post" action="/auth/login"></form>', {
          headers,
        });
      });
      const request = method === 'POST' ? post() : new Request(`${publicOrigin}/auth/login`);
      const response = await f.forward(request, '/auth/login');
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-security-policy')).toBe(csp);
      expect(response.headers.get('referrer-policy')).toBe('same-origin');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.getSetCookie()).toHaveLength(2);
      expect(response.headers.getSetCookie().every((cookie) => cookie.includes('HttpOnly'))).toBe(
        true,
      );
      expect(response.headers.has('x-serverless-authorization')).toBe(false);
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
      expect(await response.text()).toContain('action="/auth/login"');
    },
  );

  it.each([302, 401])(
    'preserves callback no-referrer on %s while retaining cookies, no-store and the redirect location',
    async (status) => {
      const path = '/auth/callback?code=synthetic-code&state=synthetic-state';
      const f = fixture(() => {
        const headers = new Headers({
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff',
          'x-serverless-authorization': 'must-not-return',
        });
        headers.append('set-cookie', 'og_oidc=; HttpOnly; Secure; Max-Age=0');
        headers.append('set-cookie', 'og_mcp_consent=; HttpOnly; Secure; Max-Age=0');
        if (status === 302) {
          headers.set('location', `${publicOrigin}/app#start`);
          headers.append('set-cookie', 'og_session=synthetic; HttpOnly; Secure; SameSite=Lax');
        }
        return new Response(status === 401 ? '{"error":{"code":"unauthorized"}}' : null, {
          status,
          headers,
        });
      });
      const response = await f.forward(
        new Request(`${publicOrigin}${path}`, {
          headers: { cookie: 'og_oidc=synthetic-transaction' },
        }),
        path,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('location')).toBe(
        status === 302 ? `${publicOrigin}/app#start` : null,
      );
      expect(response.headers.getSetCookie()).toHaveLength(status === 302 ? 3 : 2);
      expect(response.headers.getSetCookie()).toContain('og_oidc=; HttpOnly; Secure; Max-Age=0');
      expect(response.headers.getSetCookie().every((value) => value.includes('HttpOnly'))).toBe(
        true,
      );
      expect(response.headers.has('content-security-policy')).toBe(false);
      expect(response.headers.has('x-content-type-options')).toBe(false);
      expect(response.headers.has('x-serverless-authorization')).toBe(false);
      expect(f.request.mock.calls[0]?.[0]).toBe(`${backend}${path}`);
      expect(f.request.mock.calls[0]?.[1]?.redirect).toBe('manual');
      if (status === 401)
        expect(await response.json()).toEqual({ error: { code: 'unauthorized' } });
    },
  );

  it('keeps callback referrer forwarding limited to the exact login/callback protocol paths', async () => {
    const f = fixture(
      () =>
        new Response(null, {
          status: 204,
          headers: {
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'none'",
          },
        }),
    );
    const response = await f.forward(new Request(`${publicOrigin}/health`), '/health');
    expect(response.status).toBe(204);
    expect(response.headers.has('referrer-policy')).toBe(false);
    expect(response.headers.has('content-security-policy')).toBe(false);
    for (const path of ['/auth/callback/extra', '/auth/callback-extra', '/auth/%63allback'])
      expect((await f.forward(new Request(`${publicOrigin}${path}`), path)).status).toBe(404);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('preserves a manual IdP redirect after Continue and prevents upstream cache headers making the notice public', async () => {
    const f = fixture(
      () =>
        new Response(null, {
          status: 303,
          headers: {
            location: 'https://identity.example/authorize?state=synthetic',
            'cache-control': 'public, max-age=600',
            'referrer-policy': 'no-referrer',
          },
        }),
    );
    const response = await f.forward(post(), '/auth/login');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://identity.example/authorize?state=synthetic',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(f.request.mock.calls[0]![1]?.redirect).toBe('manual');
  });

  it('keeps form forwarding scoped to the login and existing OAuth token/revoke endpoints', async () => {
    const f = fixture();
    for (const path of ['/oauth/consent', '/oauth/register', '/v1/session', '/v1/generations']) {
      const response = await f.forward(
        new Request(`${publicOrigin}${path}`, {
          method: 'POST',
          headers: { 'content-type': formType },
          body: sample,
        }),
        path,
      );
      expect(response.status).toBe(415);
    }
    for (const path of ['/auth/callback', '/auth/login/extra'])
      expect((await f.forward(post(), path)).status).toBe(404);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
});
