import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { billingOperationTargets } from '@media-router/contracts';
import { billingOperationMetadata } from '../apps/server/src/billing';
import { registerMcp } from '../apps/server/src/mcp';
import { openApiDocument } from '../apps/server/src/openapi';
import { describeOperations } from '../apps/server/src/operations';
import { createForwarder } from '../apps/web/app/proxy';
import { registeredBackendPath } from '../apps/web/app/registered-http';
import { BILLING_POLICY_DEFAULTS } from '../packages/engine/src/billing-policy';

const billingIds = Object.keys(billingOperationTargets) as (keyof typeof billingOperationTargets)[];
const policyUpdate = {
  expectedVersion: 1,
  expectedAuthorityVersion: 1,
  policy: BILLING_POLICY_DEFAULTS,
};

it('advertises the same four scoped billing operations only when the runtime exists', () => {
  expect(billingIds).toEqual(Object.keys(billingOperationMetadata));
  expect(describeOperations().filter(({ id }) => id.startsWith('billing.'))).toEqual([]);
  const active = describeOperations(true).filter(({ id }) => id.startsWith('billing.'));
  expect(active).toEqual(
    billingIds.map((id) => ({
      id,
      ...billingOperationTargets[id],
      ...billingOperationMetadata[id],
    })),
  );
  const legacySpec = openApiDocument();
  const spec = openApiDocument(true);
  expect(Object.keys(legacySpec.paths).filter((path) => path.startsWith('/v1/billing'))).toEqual(
    [],
  );
  expect(Object.keys(spec.paths).filter((path) => path.startsWith('/v1/billing'))).toEqual([
    '/v1/billing/policy',
    '/v1/billing/recharges',
    '/v1/billing/documents',
  ]);
  for (const id of billingIds) {
    const { method, path } = billingOperationTargets[id];
    const metadata = billingOperationMetadata[id];
    expect(spec.paths[path]![method.toLowerCase()]).toMatchObject({
      operationId: id,
      'x-opengen-required-scope': metadata.scope,
      'x-opengen-financial-effects': metadata.financialEffects,
      'x-opengen-read-only': metadata.readOnly,
    });
  }
});

it.each([false, true])(
  'gates MCP billing and uses the shared HTTP handlers with bearer only (%s)',
  async (billingAvailable) => {
    const app = Fastify();
    const invoke = vi.fn();
    for (const id of billingIds) {
      const { method, path } = billingOperationTargets[id];
      app.route({
        method,
        url: path,
        handler(request, reply) {
          invoke({ id, url: request.url, headers: request.headers, body: request.body });
          if (!request.headers.authorization)
            return reply.code(401).send({ error: 'unauthorized' });
          return { id };
        },
      });
    }
    const unused = () => {
      throw new Error('Unexpected independent MCP authority path.');
    };
    await registerMcp(app, {
      env: { NODE_ENV: 'test' },
      billingAvailable,
      authenticate: unused,
      parseInput: unused,
      makeQuote: unused,
      requireEngine: unused,
    });
    const mcp = async (
      method: string,
      params?: object,
      authorization = 'Bearer fixture-delegation',
    ) => {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json, text/event-stream',
          ...(authorization ? { authorization } : {}),
          cookie: 'og_session=fixture-browser-cookie',
          origin: 'https://fixture.example',
        },
        payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const call = (operationId: string, input: object, authorization?: string) =>
      mcp('tools/call', { name: 'call', arguments: { operationId, input } }, authorization);
    try {
      const listed = await mcp('tools/list');
      const tool = listed.result.tools.find((tool: { name: string }) => tool.name === 'call');
      const metadata = tool._meta?.['opengen/billing-operations'];
      expect(Object.keys(metadata ?? {})).toEqual(billingAvailable ? billingIds : []);
      for (const id of billingIds) {
        const operation = billingOperationMetadata[id];
        if (billingAvailable)
          expect(metadata[id]).toMatchObject({
            ...operation,
            annotations: { readOnlyHint: operation.readOnly, openWorldHint: !operation.readOnly },
          });
        const input =
          id === 'billing.policy.update'
            ? policyUpdate
            : id === 'billing.documents.list'
              ? { type: 'receipt', limit: 2 }
              : {};
        const output = await call(id, input);
        if (billingAvailable) expect(output.result.structuredContent).toEqual({ id });
        else expect(output.result.isError).toBe(true);
      }
      expect(invoke).toHaveBeenCalledTimes(billingAvailable ? 4 : 0);
      for (const [request] of invoke.mock.calls) {
        expect(request.headers.authorization).toBe('Bearer fixture-delegation');
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers.origin).toBeUndefined();
        if (request.id === 'billing.policy.update') expect(request.body).toEqual(policyUpdate);
        if (request.id === 'billing.documents.list') {
          const query = new URL(request.url, 'https://fixture.example').searchParams;
          expect(query.get('type')).toBe('receipt');
          expect(query.get('limit')).toBe('2');
        }
      }
      for (const forbidden of [
        'billing.access',
        'billing.delegations.update',
        'billing.setup',
        'billing.mandate.revoke',
        'billing.portal',
        'billing.documents.sync',
        'billing.recharges.authenticate',
        'operator.billing.resolve',
      ])
        expect((await call(forbidden, {})).result.isError).toBe(true);
      expect(
        (
          await call('billing.policy.update', {
            ...policyUpdate,
            consentReference: 'fixture-human-consent',
          })
        ).result.isError,
      ).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(billingAvailable ? 4 : 0);
      if (billingAvailable) {
        expect((await call('billing.policy.get', {}, '')).result.isError).toBe(true);
        expect(invoke).toHaveBeenCalledTimes(5);
      }
    } finally {
      await app.close();
    }
  },
);

it('relays only fixed private billing paths and retains session, Origin and rate-limit data', async () => {
  const paths = [
    ['GET', '/v1/billing/access'],
    ['GET', '/v1/billing/policy'],
    ['PUT', '/v1/billing/policy'],
    ['PUT', '/v1/billing/delegations'],
    ['DELETE', '/v1/billing/delegations'],
    ['GET', '/v1/billing/recharges'],
    ['GET', '/v1/billing/documents?type=receipt'],
    ['POST', '/v1/billing/setup'],
    ['GET', '/v1/billing/setups/fixture'],
    ['DELETE', '/v1/billing/mandate'],
    ['POST', '/v1/billing/portal'],
    ['POST', '/v1/billing/documents/sync'],
    ['POST', '/v1/billing/recharges/fixture/authentication'],
    ['GET', '/v1/operator/billing'],
    ['POST', '/v1/operator/billing/holds/resolve'],
    ['POST', '/v1/operator/billing/recharges/resolve'],
  ];
  for (const [method, path] of paths)
    expect(registeredBackendPath(path!, method!), path).toBe(true);
  expect(registeredBackendPath('/v1/billing/access', 'PUT')).toBe(false);
  expect(registeredBackendPath('/v1/billing/delegations', 'POST')).toBe(false);
  expect(registeredBackendPath('/v1/billing/delegations/key/fixture', 'DELETE')).toBe(false);
  expect(registeredBackendPath('/v1/billing/anything-else', 'GET')).toBe(false);
  const headers = {
    cookie: 'og_session=fixture-browser-cookie',
    origin: 'https://fixture.example',
    'x-opengen-workspace': 'fixture-workspace',
    'x-opengen-recovery-scope': 'fixture-member-recovery',
    'content-type': 'application/json',
  };
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    for (const [name, value] of Object.entries(headers))
      expect(new Headers(init?.headers).get(name)).toBe(value);
    return Response.json(
      { error: 'fixture rate limit' },
      { status: 429, headers: { 'Retry-After': '7' } },
    );
  });
  const forward = createForwarder({
    env: { MEDIA_ROUTER_API_URL: 'http://fixture-backend.invalid' },
    transport: async () => undefined,
    request,
  });
  const response = await forward(
    new Request('https://fixture.example/api/billing/setup', {
      method: 'POST',
      headers,
      body: '{}',
    }),
    '/v1/billing/setup',
  );
  expect(request).toHaveBeenCalledOnce();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
