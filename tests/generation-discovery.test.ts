import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { catalog, generationProfiles } from '@media-router/catalog';
import { operationRequest, operationTargets, type Operation } from '@media-router/contracts';
import { OpenGen } from '@media-router/sdk';
import { buildApp } from '../apps/server/src/app';
import { callSchema } from '../apps/server/src/operations';
import { openApiDocument } from '../apps/server/src/openapi';
import { localCatalog, nativeGateway, nativeRoute } from '../apps/web/app/native-gateway';
import { runCommand } from '../apps/cli/src/index';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const app = await buildApp({ env: { NODE_ENV: 'test' } });
  apps.push(app);
  return app;
}
const query = (modelId: string, operation: Operation) =>
  operationRequest('models.schema', { modelId, operation }).path;
const content = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { text: string }[])[0]!.text);

describe('canonical generation discovery transport parity', () => {
  it('returns the exact operation profile and argument JSON Schema over REST and local fallback', async () => {
    const app = await fixture();
    for (const [modelId, operation] of [
      ['bytedance/seedance-2.5', 'image-to-video'],
      ['kling/kling-4.0', 'image-to-video'],
      ['openai/gpt-image-2.5-sunburst', 'text-to-image'],
      ['google/nano-banana-2.1', 'image-edit'],
      ['qwen/image-2.1', 'text-to-image'],
    ] as const) {
      const path = query(modelId, operation);
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(200);
      const expected = generationProfiles(modelId).find(
        (profile) => profile.operation === operation,
      );
      expect(response.json()).toEqual(expected);
      const fallback = localCatalog(new Request(`https://opengen.example${path}`))!;
      expect(fallback.status).toBe(200);
      expect(await fallback.json()).toEqual(expected);
    }
  });
  it('publishes argument profiles on catalog models, companies and series without claiming live availability', async () => {
    const app = await fixture();
    const models = (await app.inject({ url: '/v1/models' })).json().data;
    expect(models).toHaveLength(catalog.models.length);
    for (const model of models) {
      expect(model.generationProfiles).toEqual(generationProfiles(model.id));
      for (const profile of model.generationProfiles) {
        expect(profile.sources.length).toBeGreaterThan(0);
        expect(profile.inputSchema['x-opengen'].capabilities).toEqual(profile.capabilities);
        expect(profile.inputSchema.additionalProperties).toBe(false);
      }
    }
    for (const path of ['/v1/catalog', '/v1/companies/minimax', '/v1/series/minimax/h3']) {
      const rest = (await app.inject({ url: path })).json();
      expect(await localCatalog(new Request(`https://opengen.example${path}`))!.json()).toEqual(
        rest,
      );
      expect(
        rest.models.every(
          (model: { generationProfiles: unknown[] }) => model.generationProfiles.length > 0,
        ),
      ).toBe(true);
    }
    expect(
      models.find((model: { id: string }) => model.id === 'qwen/image-2.1').generationProfiles[0]
        .verification,
    ).toBe('weights-only');
  });
  it('resolves the former fal H3 Max schema ID to the shared canonical model profile', async () => {
    const app = await fixture();
    const canonicalPath = query('minimax/h3-max', 'text-to-video');
    const aliasPath = query('fal/h3-max', 'text-to-video');
    const canonical = await app.inject({ url: canonicalPath });
    const alias = await app.inject({ url: aliasPath });
    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toEqual(canonical.json());
    expect(alias.json().modelId).toBe('minimax/h3-max');
    const canonicalRoutes = (
      await app.inject({ url: '/v1/routes?modelId=minimax%2Fh3-max' })
    ).json().data;
    const aliasRoutes = (await app.inject({ url: '/v1/routes?modelId=fal%2Fh3-max' })).json().data;
    expect(aliasRoutes).toEqual(canonicalRoutes);
    expect(aliasRoutes).toHaveLength(4);
    const fallback = localCatalog(new Request(`https://opengen.example${aliasPath}`))!;
    expect(await fallback.json()).toEqual(canonical.json());
  });
  it('exposes the same schema through MCP registered call, MCP catalog_get and CLI call', async () => {
    const app = await fixture();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'generation-schema-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', app.listeningOrigin)));
      const input = { modelId: 'minimax/h3-max', operation: 'text-to-video' as const };
      const profile = (await app.inject({ url: query(input.modelId, input.operation) })).json();
      expect(
        content(
          await client.callTool({
            name: 'call',
            arguments: { operationId: 'models.schema', input },
          }),
        ),
      ).toEqual(profile);
      const exact = content(
        await client.callTool({ name: 'catalog_get', arguments: { id: input.modelId } }),
      );
      expect(exact.model.generationProfiles).toContainEqual(profile);
      const legacy = content(
        await client.callTool({ name: 'catalog_get', arguments: { id: 'fal/h3-max' } }),
      );
      expect(legacy).toEqual(exact);
      expect(legacy.model.id).toBe('minimax/h3-max');
      expect(legacy.routes).toHaveLength(4);
      const series = content(
        await client.callTool({ name: 'catalog_get', arguments: { id: 'minimax/h3' } }),
      );
      expect(
        series.models.find((model: { id: string }) => model.id === input.modelId)
          .generationProfiles,
      ).toContainEqual(profile);
      const sdk = new OpenGen({ baseUrl: app.listeningOrigin });
      expect(
        await runCommand(['catalog', 'get', 'fal/h3-max'], {
          client: sdk,
          env: { NODE_ENV: 'test' },
        }),
      ).toMatchObject({ id: 'minimax/h3-max', name: 'MiniMax H3 Max' });
      const stdin = (async function* () {
        yield Buffer.from(JSON.stringify(input));
      })();
      expect(
        await runCommand(['call', 'models.schema', '--input', '-'], {
          client: sdk,
          stdin,
          env: { NODE_ENV: 'test' },
        }),
      ).toEqual(profile);
    } finally {
      await client.close();
    }
  });
  it('rejects malformed or unregistered model operations consistently and never adds arbitrary targets', async () => {
    const app = await fixture();
    for (const [parameters, status] of [
      ['operation=image-to-video', 400],
      ['modelId=bytedance%2Fseedance-2.5&operation=unknown', 400],
      [
        'modelId=bytedance%2Fseedance-2.5&operation=image-to-video&url=https%3A%2F%2Fother.example',
        400,
      ],
      ['modelId=bytedance%2Fseedance-2.5&modelId=other&operation=image-to-video', 400],
      ['modelId=unknown%2Fmodel&operation=image-to-video', 404],
      ['modelId=https%3A%2F%2Fother.example%2Fmodels&operation=image-to-video', 404],
      ['modelId=bytedance%2Fseedance-2.5&operation=image-edit', 404],
    ] as const) {
      const path = `/v1/models/schema?${parameters}`;
      const response = await app.inject({ url: path });
      const fallback = localCatalog(new Request(`https://opengen.example${path}`))!;
      expect(response.statusCode).toBe(status);
      expect(fallback.status).toBe(status);
      expect(await fallback.json()).toEqual(response.json());
    }
    expect(
      callSchema.safeParse({
        operationId: 'models.schema',
        input: { modelId: 'minimax/h3', operation: 'text-to-video', url: 'https://other.example' },
      }).success,
    ).toBe(false);
    expect(nativeRoute('/v1/models/schema')?.methods).toEqual(['GET']);
    expect(
      (
        await nativeGateway(
          new Request('https://opengen.example/v1/models/schema', { method: 'POST' }),
        )
      ).status,
    ).toBe(405);
    const head = localCatalog(
      new Request(`https://opengen.example${query('minimax/h3', 'text-to-video')}`, {
        method: 'HEAD',
      }),
    )!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
  it('documents a public registered schema operation and typed profile metadata', () => {
    expect(operationTargets['models.schema']).toEqual({ method: 'GET', path: '/v1/models/schema' });
    const spec = openApiDocument();
    expect(spec.paths['/v1/models/schema']!.get).toMatchObject({
      operationId: 'models.schema',
      security: [],
      parameters: [
        { name: 'modelId', in: 'query', required: true },
        { name: 'operation', in: 'query', required: true },
      ],
      responses: {
        200: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/GenerationProfile' } },
          },
        },
      },
    });
    expect(spec.components.schemas.GenerationProfile).toMatchObject({
      properties: {
        commonArguments: { type: 'array' },
        modelSpecificArguments: { type: 'array' },
        capabilities: { type: 'object' },
        sources: { type: 'array' },
        notices: { type: 'array' },
        inputSchema: { type: 'object' },
      },
    });
  });
});
