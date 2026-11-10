import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import { openApiDocument } from '../apps/server/src/openapi';
import { operationTargets } from '../apps/server/src/operations';
import { keyScopes, type AccountStore, type EventStore } from '@media-router/engine';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const input = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A quiet sea.', resolution: '720p', duration: 5 },
};
const id = 'acb44a4c-3cc8-4c24-a44c-8c78829d585d';
async function appFixture() {
  const writes: unknown[] = [];
  const accounts = {
    authenticate: async () => ({ workspaceId: 'customer', scopes: [...keyScopes] }),
    putConnection: async (...args: unknown[]) => {
      writes.push(args);
    },
  } as unknown as AccountStore;
  const events = {
    setEnabled: async (...args: unknown[]) => {
      writes.push(args);
      return { id, enabled: false };
    },
    configureAlerts: async (...args: unknown[]) => {
      writes.push(args);
      return { enabled: true };
    },
    getAlertSettings: async () => ({ enabled: false }),
    rotateSecret: async () => ({ id, secret: 'fixture-secret-once' }),
  } as unknown as EventStore;
  const engine: EngineLike = {
    accounts,
    events,
    getExecutableRouteIds: () => [],
    submit: async () => {
      throw new Error('Read-only tests must not submit a generation.');
    },
    getJob: async () => null,
    listJobs: async () => [],
    cancel: async () => {
      throw new Error('No job to cancel.');
    },
    getBalance: async () => ({ availableMicros: 0, reservedMicros: 0, currency: 'USD' }),
    routeMetrics: async () => [],
    ensureWorkspace: async () => {
      writes.push('operator-create');
      return {};
    },
    creditWorkspace: async () => {
      writes.push('operator-credit');
      return {};
    },
  };
  const app = await buildApp({ engine, apiToken: 'fixture-operator' });
  apps.push(app);
  return { app, writes };
}
async function mcp(app: Awaited<ReturnType<typeof buildApp>>, token?: string) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'operation-coverage-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', app.listeningOrigin), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    }),
  );
  return client;
}
const data = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { text: string }[])[0]!.text);

describe('machine-readable REST contract', () => {
  it('documents actual body/path separation, paid headers and typed job/quote responses', async () => {
    const spec = openApiDocument();
    const connection = spec.paths['/v1/connections/{deploymentId}']!.put as {
      parameters: { name: string; in: string }[];
      requestBody: {
        content: {
          'application/json': {
            schema: { properties: Record<string, unknown>; required: string[] };
          };
        };
      };
    };
    const schema = connection.requestBody.content['application/json'].schema;
    expect(schema.properties).not.toHaveProperty('deploymentId');
    expect(schema.required).not.toContain('deploymentId');
    expect(connection.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'deploymentId', in: 'path' })]),
    );
    const { app, writes } = await appFixture();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/connections/fal-undisclosed',
      headers: { authorization: 'Bearer fixture-customer' },
      payload: { apiKey: 'fixture-private-provider' },
    });
    expect(response.statusCode).toBe(200);
    expect(writes[0]).toEqual([
      'customer',
      'fal-undisclosed',
      { apiKey: 'fixture-private-provider' },
    ]);
    for (const path of ['/v1/generations', '/v1/images/generations', '/v1/videos'])
      expect((spec.paths[path]!.post as { parameters: unknown[] }).parameters).toContainEqual({
        $ref: '#/components/parameters/IdempotencyKey',
      });
    expect(spec.components.parameters.IdempotencyKey).toMatchObject({
      required: true,
      in: 'header',
      name: 'Idempotency-Key',
    });
    expect(
      (spec.paths['/v1/generations']!.post as { responses: Record<string, unknown> }).responses[
        '202'
      ],
    ).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } },
    });
    expect(
      (spec.paths['/v1/quotes']!.post as { responses: Record<string, unknown> }).responses['200'],
    ).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Quote' } } },
    });
    expect(spec.paths).toHaveProperty('/v1/catalog/search');
    expect(spec.paths).toHaveProperty('/v1/workspaces/{id}/credits');
    expect(spec.paths).toHaveProperty('/v1/videos/{id}/content');
    expect(
      (spec.paths['/v1/workspaces/{id}/credits']!.post as Record<string, unknown>)[
        'x-opengen-operator-only'
      ],
    ).toBe(true);
  });
  it('covers every registered business endpoint and resolves all local response references', () => {
    const spec = openApiDocument(true);
    for (const target of Object.values(operationTargets))
      expect(spec.paths[target.path.replace(/:([a-zA-Z]+)/g, '{$1}')]).toHaveProperty(
        target.method.toLowerCase(),
      );
    const scan = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if ('$ref' in node) {
        const reference = (node as { $ref: string }).$ref;
        expect(reference.startsWith('#/components/')).toBe(true);
        let resolved: unknown = spec;
        for (const part of reference.slice(2).split('/'))
          resolved = (resolved as Record<string, unknown>)[part];
        expect(resolved).toBeDefined();
      }
      for (const value of Object.values(node)) scan(value);
    };
    scan(spec);
  });
});

describe('MCP registered operations reuse native handlers', () => {
  it('authenticates a protected resource without adding read scope to a generate-only caller', async () => {
    let submissions = 0;
    const accounts = {
      authenticate: async () => ({ workspaceId: 'customer', scopes: ['generate'] }),
    } as unknown as AccountStore;
    const engine: EngineLike = {
      accounts,
      getExecutableRouteIds: () => [],
      submit: async () => {
        submissions++;
        return { id, status: 'queued' };
      },
      getJob: async () => null,
      listJobs: async () => [],
      cancel: async () => null,
      getBalance: async () => ({}),
      routeMetrics: async () => [],
    };
    const app = await buildApp({
      engine,
      publicUrl: 'https://gateway.example',
      env: {
        NODE_ENV: 'test',
        OIDC_ISSUER: 'https://issuer.example',
        OIDC_JWKS_URI: 'https://issuer.example/jwks',
        OIDC_API_AUDIENCE: 'https://gateway.example/mcp',
      },
    });
    apps.push(app);
    const client = await mcp(app, 'fixture-generate-only-key');
    try {
      const result = await client.callTool({
        name: 'call',
        arguments: { operationId: 'media.generate', input, idempotencyKey: 'persisted-key' },
      });
      expect(result.isError).not.toBe(true);
      expect(data(result)).toMatchObject({ id, status: 'queued' });
      expect(submissions).toBe(1);
      const denied = await client.callTool({
        name: 'call',
        arguments: { operationId: 'jobs.list', input: {} },
      });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
  it('preserves batch arrays and encoded GET filters without spending provider credit', async () => {
    const { app } = await appFixture();
    const client = await mcp(app);
    try {
      const quotes = await client.callTool({
        name: 'call',
        arguments: { operationId: 'quotes.batch', input: [input, input] },
      });
      expect(quotes.isError).not.toBe(true);
      expect(data(quotes).data).toHaveLength(2);
      const routes = await client.callTool({
        name: 'call',
        arguments: { operationId: 'routes.list', input: { modelId: 'minimax/h3' } },
      });
      expect(data(routes).data.length).toBeGreaterThan(0);
      expect(
        data(routes).data.every((route: { modelId: string }) => route.modelId === 'minimax/h3'),
      ).toBe(true);
      const search = await client.callTool({
        name: 'call',
        arguments: { operationId: 'catalog.search', input: { q: 'Kling 4.0' } },
      });
      expect(data(search).every((model: { name: string }) => model.name.includes('Kling'))).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });
  it('keeps webhook/alert scope enforcement and installation-only funding on the REST path', async () => {
    const { app, writes } = await appFixture();
    const client = await mcp(app, 'fixture-customer');
    try {
      const update = await client.callTool({
        name: 'call',
        arguments: { operationId: 'webhooks.update', input: { id, enabled: false } },
      });
      expect(update.isError).not.toBe(true);
      expect(writes[0]).toEqual(['customer', id, false]);
      const settings = {
        enabled: true,
        lowBalanceMicros: 100,
        keyExpiryHours: 24,
        webhookFailures: true,
      };
      const alerts = await client.callTool({
        name: 'call',
        arguments: { operationId: 'alerts.settings.put', input: settings },
      });
      expect(alerts.isError).not.toBe(true);
      expect(writes[1]).toEqual(['customer', settings]);
      const funding = await client.callTool({
        name: 'call',
        arguments: {
          operationId: 'workspaces.credit',
          input: { id: 'customer', amountMicros: 100, reference: 'operator-reference' },
        },
      });
      expect(funding.isError).toBe(true);
      expect(writes).not.toContain('operator-credit');
      const invalid = await client.callTool({
        name: 'call',
        arguments: { operationId: 'https://untrusted.example', input: {} },
      });
      expect(invalid.isError).toBe(true);
      expect(writes).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
