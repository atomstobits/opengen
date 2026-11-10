import { afterEach, describe, expect, it, vi } from 'vitest';
import { operationTargets } from '@media-router/contracts';
import { buildApp } from '../apps/server/src/app';
import { createStripeClient, STRIPE_API_VERSION } from '../apps/server/src/payments';
import { createGcpTransport } from '../apps/web/app/gcp-transport';
import { createForwarder, forward } from '../apps/web/app/proxy';
import { registeredBackendPath } from '../apps/web/app/registered-http';
import * as route from '../apps/web/app/webhooks/stripe/route';

vi.mock('../apps/web/app/proxy', async (original) => ({
  ...(await original<typeof import('../apps/web/app/proxy')>()),
  forward: vi.fn(),
}));
const backend = 'https://fixture-api-abc-uc.a.run.app';
const signature = 't=123,v1=fixture-signature';
const env = { MEDIA_ROUTER_API_URL: backend };
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
function incoming(bytes: Uint8Array, extra: Record<string, string> = {}) {
  return new Request('https://opengen.example/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'stripe-signature': signature,
      ...extra,
    },
    body: bytes as BodyInit,
  });
}
async function bodyBytes(body: BodyInit | null | undefined) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe('fixed private-backend Stripe webhook relay', () => {
  it('exports only a POST handler and always uses the fixed backend path', async () => {
    const handler = vi.mocked(forward);
    handler.mockResolvedValueOnce(Response.json({ received: true }));
    const request = incoming(Buffer.from('{}'));
    const response = await route.POST(request);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenLastCalledWith(request, '/webhooks/stripe');
    expect(route).not.toHaveProperty('GET');
    expect(route).not.toHaveProperty('OPTIONS');
    expect(registeredBackendPath('/webhooks/stripe', 'POST')).toBe(true);
    for (const path of [
      '/webhooks/stripe?target=other',
      '/webhooks/%73tripe',
      '/%77ebhooks/stripe',
      '/webhooks/stripe/extra',
      '/webhooks/stripe/',
      'https://other.example/webhooks/stripe',
    ])
      expect(registeredBackendPath(path, 'POST')).toBe(false);
    for (const method of ['GET', 'HEAD', 'PUT', 'OPTIONS'])
      expect(registeredBackendPath('/webhooks/stripe', method)).toBe(false);
    expect(
      Object.values(operationTargets).some((target) => target.path === '/webhooks/stripe'),
    ).toBe(false);
  });
  it('preserves UTF-8, BOM, whitespace and chunk boundaries as the exact original bytes', async () => {
    const payload = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(' {\n  "message": "花 🌸 café",\r\n  "amount": 1\n } \n\t'),
    ]);
    let sent: Uint8Array | undefined;
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(typeof init?.body).not.toBe('string');
      sent = await bodyBytes(init?.body);
      return Response.json({ received: true });
    });
    const relay = createForwarder({ env, transport: async () => 'trusted-identity', request });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.subarray(0, 1));
        controller.enqueue(payload.subarray(1, 7));
        controller.enqueue(payload.subarray(7));
        controller.close();
      },
    });
    const response = await relay(
      new Request('https://opengen.example/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      '/webhooks/stripe',
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(sent!)).toEqual(payload);
    expect(sent!.byteLength).toBe(payload.byteLength);
  });
  it('isolates headers and replaces caller service identity with the trusted keyless identity', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"received":true}', {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'og_session=must-not-return',
          location: 'https://other.example',
          'x-serverless-authorization': 'must-not-return-service-token',
        },
      }),
    );
    const transport = vi.fn(async () => 'trusted-identity');
    const relay = createForwarder({ env, transport, request });
    const response = await relay(
      incoming(Buffer.from('{}'), {
        authorization: 'Bearer caller',
        cookie: 'og_session=caller',
        origin: 'https://caller.example',
        'idempotency-key': 'caller-key',
        'x-opengen-workspace': 'caller-workspace',
        'x-serverless-authorization': 'Bearer caller-identity',
        'mcp-session-id': 'caller-session',
        accept: 'text/html',
        'x-http-method-override': 'DELETE',
      }),
      '/webhooks/stripe',
    );
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(backend + '/webhooks/stripe');
    expect(init!.redirect).toBe('manual');
    expect(init!.cache).toBe('no-store');
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'stripe-signature': signature,
      'x-serverless-authorization': 'Bearer trusted-identity',
    });
    expect(transport).toHaveBeenCalledWith(backend);
    expect(response.headers.get('cache-control')).toBe('no-store');
    for (const header of ['set-cookie', 'location', 'x-serverless-authorization'])
      expect(response.headers.has(header)).toBe(false);
  });
  it('bounds signature, content type and body before exchanging identity or calling the backend', async () => {
    const transport = vi.fn(async () => 'trusted-identity');
    const request = vi.fn<typeof fetch>();
    const relay = createForwarder({ env, transport, request });
    for (const [body, headers, status] of [
      [Buffer.from('{}'), { 'stripe-signature': '' }, 400],
      [Buffer.from('{}'), { 'stripe-signature': 'a'.repeat(4097) }, 400],
      [Buffer.alloc(1000001), {}, 413],
      [Buffer.from('{}'), { 'content-type': 'text/plain' }, 415],
    ] as const) {
      const response = await relay(incoming(body, headers), '/webhooks/stripe');
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(transport).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('fails closed without configured backend or trusted identity, and on unreachable backend', async () => {
    const request = vi.fn<typeof fetch>();
    for (const relay of [
      createForwarder({ env: {}, transport: async () => 'identity', request }),
      createForwarder({ env, request }),
      createForwarder({
        env,
        request,
        transport: async () => {
          throw new Error('private-transport-secret');
        },
      }),
    ]) {
      const response = await relay(incoming(Buffer.from('{}')), '/webhooks/stripe');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private-transport-secret');
    }
    expect(request).not.toHaveBeenCalled();
    const denied = createForwarder({
      env,
      transport: async () => 'trusted-identity',
      request: async () => new Response('private IAM details', { status: 403 }),
    });
    const permissionFailure = await denied(incoming(Buffer.from('{}')), '/webhooks/stripe');
    expect(permissionFailure.status).toBe(503);
    expect(await permissionFailure.text()).not.toContain('private IAM details');
    const unreachable = createForwarder({
      env,
      transport: async () => 'trusted-identity',
      request: async () => {
        throw new Error('private-backend-details');
      },
    });
    const response = await unreachable(incoming(Buffer.from('{}')), '/webhooks/stripe');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-backend-details');
  });
  it('relays a signed event through mocked keyless federation to the private backend verifier', async () => {
    const stripe = createStripeClient('fixture-server-only-credential');
    const secret = 'fixture-backend-only-signing-secret';
    const reconcile = vi.fn(async () => ({ received: true as const }));
    const app = await buildApp({
      env: {},
      publicUrl: 'https://opengen.example',
      payments: {
        createOrder: vi.fn(),
        getOrder: vi.fn(),
        listOrders: vi.fn(),
        hasBillingHold: vi.fn(),
        checkout: vi.fn(),
        reconcile,
      },
      paymentConfig: { stripe, webhookSecret: secret, livemode: false },
    });
    apps.push(app);
    const payload =
      JSON.stringify(
        {
          id: 'evt_relay_fixture',
          object: 'event',
          api_version: STRIPE_API_VERSION,
          type: 'checkout.session.completed',
          livemode: false,
          data: { object: { id: 'cs_test_fixture', description: '花 🌸' } },
        },
        null,
        2,
      ) + '\n\t';
    const signed = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const serviceToken = `header.${Buffer.from(JSON.stringify({ aud: backend, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
    const calls: string[] = [];
    const request: typeof fetch = async (url, init) => {
      calls.push(String(url));
      if (String(url) === 'https://sts.googleapis.com/v1/token')
        return Response.json({ access_token: 'fixture-exchanged-token' });
      if (String(url).startsWith('https://iamcredentials.googleapis.com/'))
        return Response.json({ token: serviceToken });
      expect(String(url)).toBe(backend + '/webhooks/stripe');
      expect(new Headers(init!.headers).get('x-serverless-authorization')).toBe(
        `Bearer ${serviceToken}`,
      );
      const bytes = Buffer.from(await bodyBytes(init!.body));
      expect(bytes).toEqual(Buffer.from(calls.length === 3 ? payload : payload + ' '));
      const result = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: Object.fromEntries(new Headers(init!.headers)),
        payload: bytes,
      });
      return new Response(result.body, {
        status: result.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    const configured = {
      ...env,
      GCP_WORKLOAD_IDENTITY_PROVIDER:
        'projects/123456789/locations/global/workloadIdentityPools/vercel/providers/opengen',
      GCP_SERVICE_ACCOUNT_EMAIL: 'vercel@fixture-project.iam.gserviceaccount.com',
    };
    const transport = createGcpTransport({
      env: configured,
      request,
      getOidcToken: async () => 'fixture-vercel-identity',
    });
    const relay = createForwarder({ env: configured, request, transport });
    const response = await relay(
      incoming(Buffer.from(payload), {
        'stripe-signature': signed,
        authorization: 'Bearer must-drop',
        cookie: 'og_session=must-drop',
      }),
      '/webhooks/stripe',
    );
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(3);
    const tampered = await relay(
      incoming(Buffer.from(payload + ' '), { 'stripe-signature': signed }),
      '/webhooks/stripe',
    );
    expect(tampered.status).toBe(400);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
