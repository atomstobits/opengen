import { afterEach, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { catalog, generationProfiles, quote, searchCatalog } from '@media-router/catalog';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { buildApp } from '../apps/server/src/app';
import { localCatalog } from '../apps/web/app/native-gateway';
import { OpenGen } from '@media-router/sdk';
import { openApiDocument } from '../apps/server/src/openapi';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const app = await buildApp({ env: { NODE_ENV: 'test' } });
  apps.push(app);
  return app;
}
const data = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { text: string }[])[0]!.text);

describe('actionable, compact catalog discovery', () => {
  it('composes operation/role/provider/region filters without hiding comparison-only models', () => {
    const filters = {
      modality: 'video' as const,
      operation: 'image-to-video' as const,
      inputRole: 'firstFrame' as const,
      providerId: 'alibaba',
      region: 'eu-central-1',
    };
    const found = searchCatalog('', filters);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((model) => model.id.startsWith('alibaba/wan-3.0'))).toBe(true);
    expect(searchCatalog('', { ...filters, providerId: 'byteplus' })).toEqual([]);
    expect(searchCatalog('', { ...filters, inputRole: 'references.audio' })).toEqual([]);
    expect(searchCatalog('qwen image 2.1').map((model) => model.id)).toContain('qwen/image-2.1');
    expect(searchCatalog('image to video', { modality: 'image' })).toEqual([]);
    expect(searchCatalog('', { operation: 'text-to-video', inputRole: 'firstFrame' })).toEqual([]);
    expect(
      searchCatalog('', { operation: 'reference-to-video', inputRole: 'references.audio' }).length,
    ).toBeGreaterThan(0);
  });
  it('derives valid request and read-only quote templates for every registered model operation', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    let count = 0;
    for (const model of catalog.models)
      for (const profile of generationProfiles(model.id)) {
        count++;
        const { examples } = profile;
        expect(parseGenerationRequest(examples.request)).toEqual(examples.request);
        const validate = ajv.compile(profile.inputSchema!);
        expect(
          validate(examples.request.input),
          `${model.id}/${profile.operation}: ${ajv.errorsText(validate.errors)}`,
        ).toBe(true);
        expect(examples.quote).toEqual({ operationId: 'quotes.single', input: examples.request });
        expect(examples.request.billing).toBe('managed');
        expect(JSON.stringify(examples)).not.toContain('https://');
        expect(examples.notices.join(' ')).toContain('authorizing a separate billable submission');
        if (profile.operation === 'image-to-video')
          expect(examples.placeholders.length).toBeGreaterThan(0);
        if (catalog.routes.some((route) => route.modelId === model.id)) {
          const result = quote(examples.request);
          expect(result.selectedRouteId).toBeNull();
          expect(result.candidates.every((candidate) => candidate.executable === false)).toBe(true);
        }
      }
    expect(count).toBe(76);
  });
  it('preserves REST/local-fallback/SDK/MCP filter and schema-example parity', async () => {
    const app = await fixture();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const filters = {
      operation: 'image-to-video' as const,
      inputRole: 'firstFrame' as const,
      providerId: 'alibaba',
      region: 'eu-central-1',
      modality: 'video' as const,
    };
    const path = '/v1/catalog/search?' + new URLSearchParams(filters).toString();
    const expected = searchCatalog('', filters);
    expect((await app.inject({ url: path })).json()).toEqual(expected);
    expect(await localCatalog(new Request('https://opengen.example' + path))!.json()).toEqual(
      expected,
    );
    expect(
      await new OpenGen({ baseUrl: app.listeningOrigin }).search('', undefined, filters),
    ).toEqual(expected);
    const client = new Client({ name: 'fixture-discovery', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', app.listeningOrigin)));
      expect(data(await client.callTool({ name: 'catalog_search', arguments: filters }))).toEqual(
        expected,
      );
      const tools = (await client.listTools()).tools;
      for (const name of ['catalog_search', 'catalog_get', 'quote', 'job_get', 'balance'])
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        });
      expect(tools.find((tool) => tool.name === 'call')?.annotations?.readOnlyHint).toBe(false);
      const inspected = await client.callTool({
        name: 'catalog_get',
        arguments: { id: 'minimax/h3-max' },
      });
      const exact = data(inspected);
      expect(inspected.structuredContent).toEqual(exact);
      expect(exact.generationProfiles).toBeUndefined();
      expect(exact.model.generationProfiles).toHaveLength(3);
      const ids = [
        ...new Set(exact.routes.map((route: { deploymentId: string }) => route.deploymentId)),
      ];
      expect(exact.deployments.map((deployment: { id: string }) => deployment.id).sort()).toEqual(
        ids.sort(),
      );
      expect(exact.deployments.length).toBeLessThan(catalog.deployments.length);
      const collision = data(
        await client.callTool({ name: 'catalog_get', arguments: { id: 'minimax/h3' } }),
      );
      expect(collision.model).toBeUndefined();
      expect(collision.models.some((model: { id: string }) => model.id === 'minimax/h3')).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });
  it('rejects invalid filters identically in REST/fallback and documents every filter', async () => {
    const app = await fixture();
    for (const query of [
      'operation=unknown',
      'inputRole=rawUrl',
      'modality=audio',
      'operation=text-to-image&operation=image-to-video',
      'url=https://other.example',
    ]) {
      const path = '/v1/catalog/search?' + query;
      const response = await app.inject({ url: path });
      const fallback = localCatalog(new Request('https://opengen.example' + path))!;
      expect(response.statusCode).toBe(400);
      expect(fallback.status).toBe(400);
      expect(await fallback.json()).toEqual(response.json());
    }
    const spec = openApiDocument();
    const parameters = spec.paths['/v1/catalog/search']!.get!.parameters as { name: string }[];
    expect(parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['q', 'modality', 'providerId', 'region', 'operation', 'inputRole']),
    );
  });
});
