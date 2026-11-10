import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonJob, ComparisonRun, ComparisonSummary } from '@media-router/contracts';
import { createEngine } from '@media-router/engine';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import { comparisonQuoteRequestSchema } from '../apps/server/src/comparison';
import { callSchema, operationTargets } from '../apps/server/src/operations';
import { openApiDocument } from '../apps/server/src/openapi';

const specification = openApiDocument();
const id = '00000000-0000-4000-8000-000000000001';
const routeIds: [string, string] = ['fixture/first-route', 'fixture/second-route'];
const prompt = 'A synthetic stone sculpture.';
const firstChild = {
  input: {
    modelId: 'xai/grok-imagine-image-2.0',
    operation: 'text-to-image' as const,
    input: { prompt, count: 1 },
    billing: 'managed' as const,
    routeId: routeIds[0],
    routing: { fallback: false },
    maxCostMicros: 1000,
  },
  endpointRegion: 'undisclosed',
  providerId: 'fixture',
  estimatedMicros: 1000,
  ceilingMicros: 1000,
  notices: [],
};
const run: ComparisonRun = {
  id,
  expiresAt: '2026-11-06T12:10:00.000Z',
  admittedAt: null,
  children: [
    firstChild,
    {
      ...firstChild,
      input: {
        ...firstChild.input,
        modelId: 'bytedance/seedream-5.0-pro',
        routeId: routeIds[1],
      },
    },
  ],
  estimatedMicros: 2000,
  ceilingMicros: 2000,
  jobs: [],
};
const childJob: ComparisonJob = {
  id: '00000000-0000-4000-8000-000000000002',
  workspaceId: 'fixture',
  status: 'queued',
  input: firstChild.input,
  routeId: routeIds[0],
  deploymentId: 'fixture',
  upstreamId: null,
  outputs: [],
  error: null,
  createdAt: '2026-11-06T12:00:00.000Z',
  updatedAt: '2026-11-06T12:00:00.000Z',
  reservedMicros: 1000,
  settledMicros: null,
  attemptCount: 0,
  executionTiming: null,
};
const admitted: ComparisonRun = {
  ...run,
  admittedAt: '2026-11-06T12:01:00.000Z',
  jobs: [
    childJob,
    {
      ...childJob,
      id: '00000000-0000-4000-8000-000000000003',
      input: run.children[1].input,
      routeId: routeIds[1],
    },
  ],
};
const summary: ComparisonSummary = { id, admittedAt: admitted.admittedAt!, routeIds };
type Schema = Record<string, unknown>;
type DocumentedOperation = {
  operationId: string;
  security: Record<string, string[]>[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  parameters?: { name: string; schema: Schema }[];
  responses: Record<string, { content: Record<string, { schema: Schema }> }>;
};
function operation(path: string, method: string): DocumentedOperation {
  return specification.paths[path]![method] as DocumentedOperation;
}
function compile(schema: Schema) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile({ ...schema, components: specification.components });
}
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const quoteComparison = vi.fn(async () => run);
  const submitComparison = vi.fn(async () => admitted);
  const getComparison = vi.fn(async (workspaceId: string, savedId: string) =>
    workspaceId === 'fixture' && savedId === id ? admitted : null,
  );
  const listComparisons = vi.fn(async () => [summary]);
  const engine: EngineLike = {
    accounts: {
      authenticate: async (token: string) => ({
        workspaceId: token === 'foreign' ? 'foreign' : 'fixture',
        scopes: token === 'generate-only' ? ['generate'] : ['read'],
      }),
    } as EngineLike['accounts'],
    getExecutableRouteIds: () => [],
    submit: async () => {
      throw new Error('Documentation fixtures must not submit a generation.');
    },
    getJob: async () => null,
    listJobs: async () => [],
    cancel: async () => null,
    getBalance: async () => ({}),
    routeMetrics: async () => [],
    quoteComparison,
    submitComparison,
    getComparison,
    listComparisons,
  };
  const app = await buildApp({ engine });
  apps.push(app);
  return { app, quoteComparison, submitComparison, getComparison, listComparisons };
}

describe('HTTP-only private comparison documentation', () => {
  it.each([
    [{ prompt, routeIds }, true],
    [{ prompt, routeIds: [routeIds[0]] }, false],
    [{ prompt, routeIds: [...routeIds, 'fixture/third-route'] }, false],
    [{ prompt: '', routeIds }, false],
    [{ prompt: 'x'.repeat(32_001), routeIds }, false],
    [{ prompt, routeIds: ['', routeIds[1]] }, false],
    [{ prompt, routeIds, billing: 'byok' }, false],
  ])('reuses handler bounds for request %j', (input, valid) => {
    const validate = compile(
      operation('/v1/comparisons/quote', 'post').requestBody!.content['application/json']!.schema,
    );
    expect(validate(input)).toBe(valid);
    expect(comparisonQuoteRequestSchema.safeParse(input).success).toBe(valid);
  });

  it('keeps comparison operations outside the MCP call registry and approval body', () => {
    for (const [path, method, operationId] of [
      ['/v1/comparisons/quote', 'post', 'comparisons.quote'],
      ['/v1/comparisons', 'get', 'comparisons.list'],
      ['/v1/comparisons/{id}', 'get', 'comparisons.get'],
      ['/v1/comparisons/{id}/approve', 'post', 'comparisons.approve'],
    ] as const) {
      const documented = operation(path, method);
      expect(documented.operationId).toBe(operationId);
      expect(documented.security).toEqual([{ bearerAuth: [] }, { browserSession: [] }]);
      expect(Object.hasOwn(operationTargets, operationId)).toBe(false);
      expect(callSchema.safeParse({ operationId, input: {} }).success).toBe(false);
    }
    const approval = operation('/v1/comparisons/{id}/approve', 'post');
    expect(approval).not.toHaveProperty('requestBody');
    expect(approval.parameters?.map((parameter) => parameter.name)).toEqual(['id']);
  });

  it('documents the saved quote, retained child jobs and bounded private history', () => {
    const validateRun = compile(specification.components.schemas.ComparisonRun);
    expect(validateRun(run), JSON.stringify(validateRun.errors)).toBe(true);
    expect(validateRun(admitted), JSON.stringify(validateRun.errors)).toBe(true);
    expect(validateRun({ ...admitted, jobs: [childJob] })).toBe(true);
    const output = {
      url: 'https://owned.invalid/synthetic-output.png',
      mediaType: 'image/png',
      fidelity: 'unverified',
    };
    const delivered = (outputIndex?: number) => ({
      ...admitted,
      jobs: [
        {
          ...childJob,
          status: 'succeeded',
          deliveryStatus: 'partial',
          outputs: [{ ...output, outputIndex }],
          outputEvidence: [{ index: 1, state: 'available', outputIndex: 0 }],
        },
      ],
    });
    expect(validateRun(delivered(1))).toBe(true);
    expect(validateRun(delivered())).toBe(true);
    expect(validateRun(delivered(-1))).toBe(false);
    expect(validateRun(delivered(20))).toBe(false);
    expect(validateRun(delivered(1.5))).toBe(false);
    expect(validateRun({ ...run, children: [firstChild] })).toBe(false);
    expect(validateRun({ ...run, ceilingMicros: -1 })).toBe(false);
    expect(validateRun({ ...run, jobs: [{ ...childJob, executionTiming: {} }] })).toBe(false);
    expect(
      validateRun({
        ...run,
        jobs: [{ ...childJob, executionTiming: { durationMs: 12, source: 'provider' } }],
      }),
    ).toBe(true);
    expect(validateRun({ ...run, jobs: [{ ...childJob, executionTiming: undefined }] })).toBe(
      false,
    );
    const validateList = compile(
      operation('/v1/comparisons', 'get').responses['200']!.content['application/json']!.schema,
    );
    expect(validateList({ data: [summary] })).toBe(true);
    expect(validateList({ data: [{ ...summary, routeIds: [routeIds[0]] }] })).toBe(false);
    expect(validateList({ data: Array.from({ length: 21 }, () => summary) })).toBe(false);
  });

  it('matches engine ID syntax without imposing a UUID version or variant', async () => {
    const validate = compile(operation('/v1/comparisons/{id}', 'get').parameters![0]!.schema);
    const engine = createEngine({ databaseUrl: 'postgresql://fixture.invalid/unused' });
    const query = vi.spyOn(engine.pool, 'query').mockResolvedValue({ rows: [] } as never);
    try {
      for (const savedId of [id, 'ABCDEFAB-0000-0000-0000-ABCDEFABCDEF']) {
        expect(validate(savedId)).toBe(true);
        expect(await engine.getComparison('fixture', savedId)).toBeNull();
      }
      query.mockClear();
      expect(validate('malformed')).toBe(false);
      await expect(engine.getComparison('fixture', 'malformed')).rejects.toMatchObject({
        code: 'not_found',
        statusCode: 404,
      });
      expect(query).not.toHaveBeenCalled();
    } finally {
      await engine.close();
    }
  });

  it('matches synthetic quote, list and retrieval responses behind read authentication', async () => {
    const { app, quoteComparison, getComparison, listComparisons, submitComparison } =
      await fixture();
    const headers = { authorization: 'Bearer read-only' };
    const quoted = await app.inject({
      method: 'POST',
      url: '/v1/comparisons/quote',
      headers,
      payload: { prompt: `  ${prompt}  `, routeIds },
    });
    expect(quoted.statusCode).toBe(201);
    expect(quoteComparison).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'fixture', scopes: ['read'] }),
      prompt,
      routeIds,
    );
    const validateRun = compile(
      operation('/v1/comparisons/quote', 'post').responses['201']!.content['application/json']!
        .schema,
    );
    expect(validateRun(quoted.json()), JSON.stringify(validateRun.errors)).toBe(true);
    const listed = await app.inject({ url: '/v1/comparisons', headers });
    expect(listed.json()).toEqual({ data: [summary] });
    expect(listComparisons).toHaveBeenCalledWith('fixture');
    const retrieved = await app.inject({ url: `/v1/comparisons/${id}`, headers });
    expect(retrieved.statusCode).toBe(200);
    expect(validateRun(retrieved.json()), JSON.stringify(validateRun.errors)).toBe(true);
    expect(getComparison).toHaveBeenCalledWith('fixture', id);
    expect(
      (
        await app.inject({
          url: `/v1/comparisons/${id}`,
          headers: { authorization: 'Bearer foreign' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: '/v1/comparisons' })).statusCode).toBe(401);
    expect(submitComparison).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'GET' as const, url: '/v1/comparisons' },
    { method: 'GET' as const, url: `/v1/comparisons/${id}` },
    { method: 'POST' as const, url: '/v1/comparisons/quote', payload: { prompt, routeIds } },
  ])('requires read scope for $method $url', async (request) => {
    const { app, quoteComparison, getComparison, listComparisons } = await fixture();
    const response = await app.inject({
      ...request,
      headers: { authorization: 'Bearer generate-only' },
    });
    expect(response.statusCode).toBe(403);
    expect(quoteComparison).not.toHaveBeenCalled();
    expect(getComparison).not.toHaveBeenCalled();
    expect(listComparisons).not.toHaveBeenCalled();
  });

  it('requires generate scope and no body to approve the saved run', async () => {
    const { app, submitComparison } = await fixture();
    const url = `/v1/comparisons/${id}/approve`;
    expect(
      (await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer read-only' } }))
        .statusCode,
    ).toBe(403);
    const headers = { authorization: 'Bearer generate-only' };
    expect((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(400);
    expect(submitComparison).not.toHaveBeenCalled();
    const accepted = await app.inject({ method: 'POST', url, headers });
    expect(accepted.statusCode).toBe(202);
    expect(submitComparison).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'fixture', scopes: ['generate'] }),
      id,
    );
    const validate = compile(
      operation('/v1/comparisons/{id}/approve', 'post').responses['202']!.content[
        'application/json'
      ]!.schema,
    );
    expect(validate(accepted.json()), JSON.stringify(validate.errors)).toBe(true);
  });
});
