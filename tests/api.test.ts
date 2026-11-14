import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/server/src/app';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const input = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A red kite in the wind', resolution: '720p', duration: 10 },
};
async function setup() {
  const app = await buildApp({ apiToken: 'test-only-not-a-production-token' });
  apps.push(app);
  return app;
}

describe('public catalog and quote API', () => {
  it('serves company catalogs without confusing series ownership with variant authorship', async () => {
    const app = await setup();
    const response = await app.inject({ url: '/v1/companies/minimax' });
    expect(response.statusCode).toBe(200);
    const entry = response.json();
    expect(entry.company.id).toBe('minimax');
    expect(entry.series.map((series: { id: string }) => series.id)).toEqual([
      'minimax/h3',
      'minimax/h3-image',
    ]);
    expect(entry.models).toHaveLength(8);
    expect(
      entry.models.find((model: { id: string }) => model.id === 'minimax/h3-max'),
    ).toMatchObject({
      name: 'MiniMax H3 Max',
      creator: 'MiniMax',
    });
    expect(entry.models.some((model: { id: string }) => model.id === 'fal/h3-max')).toBe(false);
    expect((await app.inject({ url: '/v1/companies/no-such-company' })).statusCode).toBe(404);
  });
  it('exposes exact variant routes under the canonical series and keeps regional rows separate', async () => {
    const app = await setup();
    const wan = (await app.inject({ url: '/v1/series/alibaba/wan-3.0' })).json();
    expect(wan.models).toHaveLength(2);
    expect(wan.routes).toHaveLength(18);
    expect(wan.deployments).toHaveLength(7);
    expect(new Set(wan.routes.map((route: { modelId: string }) => route.modelId)).size).toBe(2);
    const h3 = (await app.inject({ url: '/v1/series/minimax/h3' })).json();
    expect(h3.models).toHaveLength(6);
    expect(h3.providers.map((provider: { id: string }) => provider.id)).toEqual(
      expect.arrayContaining(['minimax', 'fal', 'pika']),
    );
    expect((await app.inject({ url: '/v1/series/minimax/not-a-model' })).statusCode).toBe(404);
  });
  it('lists one H3 Max variant while retaining both independent provider routes', async () => {
    const app = await setup();
    const models = (await app.inject({ url: '/v1/models' })).json().data;
    expect(models).toHaveLength(49);
    expect(models.filter((model: { id: string }) => model.id === 'minimax/h3-max')).toHaveLength(1);
    expect(models.some((model: { id: string }) => model.id === 'fal/h3-max')).toBe(false);
    const routes = (await app.inject({ url: '/v1/routes?modelId=minimax%2Fh3-max' })).json().data;
    expect(routes).toHaveLength(4);
    expect(new Set(routes.map((route: { deploymentId: string }) => route.deploymentId))).toEqual(
      new Set(['minimax-undisclosed', 'fal-undisclosed']),
    );
    expect(routes.every((route: { modelId: string }) => route.modelId === 'minimax/h3-max')).toBe(
      true,
    );
    expect(
      routes.find((route: { id: string }) => route.id === 'fal-undisclosed/fal-h3-max'),
    ).toMatchObject({
      id: 'fal-undisclosed/fal-h3-max',
      upstreamModelId: 'minimax/h3-max/text-to-video',
    });
  });
  it('returns independent regional routes and honest empty observations', async () => {
    const app = await setup();
    const result = (await app.inject({ url: '/v1/routes?modelId=alibaba%2Fwan-3.0' })).json();
    expect(result.data).toHaveLength(9);
    const metrics = (await app.inject({ url: '/v1/metrics' })).json();
    expect(
      metrics.data.every(
        (m: { technicalSuccessRate: unknown; sampleCount: number }) =>
          m.sampleCount === 0 && m.technicalSuccessRate === null,
      ),
    ).toBe(true);
    expect(metrics.data[0]).toMatchObject({
      p50CompletionMs: null,
      p75CompletionMs: null,
      p90CompletionMs: null,
      p95CompletionMs: null,
      p99CompletionMs: null,
    });
  });
  it('quotes exact regional prices without claiming credential-free execution', async () => {
    const app = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: { ...input, routing: { endpointRegions: ['ap-southeast-1'] } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toHaveLength(1);
    expect(response.json().candidates[0]).toMatchObject({
      endpointRegion: 'ap-southeast-1',
      estimatedCostMicros: 1_000_000,
      executable: false,
    });
  });
  it('validates every batch member and caps request fan-out', async () => {
    const app = await setup();
    expect(
      (
        await app.inject({ method: 'POST', url: '/v1/quotes/batch', payload: [input, input] })
      ).json().data,
    ).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/quotes/batch',
          payload: Array(21).fill(input),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/quotes',
          payload: { ...input, input: { ...input.input, duration: -1 } },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('requires authentication and an idempotency key before mutation', async () => {
    const app = await setup();
    expect(
      (await app.inject({ method: 'POST', url: '/v1/generations', payload: input })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/generations',
          headers: { authorization: 'Bearer test-only-not-a-production-token' },
          payload: input,
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: {
        authorization: 'Bearer test-only-not-a-production-token',
        'idempotency-key': 'stable',
      },
      payload: input,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('database_not_configured');
  });
  it('rejects unknown request fields rather than silently discarding them', async () => {
    const app = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: { ...input, providerBaseUrl: 'http://localhost' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('MCP shares the catalog contract', () => {
  it('discovers and compares regional routes through a real Streamable HTTP client', async () => {
    const app = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', app.listeningOrigin)));
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('quote');
      const result = await client.callTool({
        name: 'quote',
        arguments: { input: { ...input, routing: { endpointRegions: ['eu-central-1'] } } },
      });
      const content = result.content as { type: string; text?: string }[];
      expect(JSON.parse(content[0]!.text!).candidates[0]).toMatchObject({
        endpointRegion: 'eu-central-1',
        estimatedCostMicros: 825_130,
      });
      const entry = await client.callTool({ name: 'catalog_get', arguments: { id: 'minimax/h3' } });
      const detail = JSON.parse((entry.content as { text: string }[])[0]!.text);
      expect(detail.company.id).toBe('minimax');
      expect(detail.models).toHaveLength(6);
      expect(
        detail.routes.some((route: { modelId: string }) => route.modelId === 'pika/h3-flex'),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
