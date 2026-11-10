import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { catalog } from '@media-router/catalog';
import type { GenerateInput, Job } from '@media-router/contracts';
import {
  parseGenerationRequest,
  getGenerationDefinition,
} from '@media-router/contracts/generation';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import { callSchema } from '../apps/server/src/operations';
import { JobStatusError, JobStatusStore } from '../packages/engine/src/job-status';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
// The executable HTTP example is intentionally plain JavaScript without an SDK dependency.
// @ts-expect-error JavaScript example is consumed directly by Node and Vitest.
import {
  featureFailure,
  featureRequest,
  fixtureAssetKey,
  httpClient,
  lookupSubmission,
  main,
  mcpCall,
  resumeJob,
  runFeatureExample,
  schemaPath,
} from '../examples/http-feature-contracts.mjs';

const id = '00000000-0000-4000-8000-000000000002';
const privateUrl = 'https://owned.invalid/output.png?fixture-capability=synthetic';

async function fixture(status: Job['status'] = 'queued', configure?: (engine: EngineLike) => void) {
  const jobs = new Map<string, Job>();
  const requests = new Map<string, string>();
  const submit = vi.fn(
    async ({
      workspaceId,
      input,
      idempotencyKey,
    }: {
      workspaceId: string;
      input: GenerateInput;
      idempotencyKey: string;
    }) => {
      const identity = `${workspaceId}:${idempotencyKey}`;
      const body = JSON.stringify(input);
      if (requests.has(identity)) {
        if (requests.get(identity) !== body)
          throw Object.assign(new Error('The idempotency key belongs to a different request.'), {
            statusCode: 409,
            code: 'idempotency_conflict',
          });
        return jobs.get(workspaceId)!;
      }
      requests.set(identity, body);
      const job: Job = {
        id,
        workspaceId,
        status,
        input,
        routeId: 'fixture/route',
        deploymentId: 'fixture/region',
        upstreamId: null,
        outputs: [],
        error: status === 'failed' ? 'Synthetic failure.' : null,
        createdAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:00:00.000Z',
        reservedMicros: 100,
        settledMicros: null,
        attemptCount: 1,
      };
      jobs.set(workspaceId, job);
      return job;
    },
  );
  const getJob = vi.fn(async (workspaceId: string, jobId: string) =>
    jobId === id ? (jobs.get(workspaceId) ?? null) : null,
  );
  const resolveInput = vi.fn(async (workspaceId: string, input: GenerateInput) => {
    const assets = [
      input.input.firstFrame,
      ...(input.input.references ?? []).map((ref) => ref.asset),
    ].filter(Boolean);
    if (
      assets.some(
        (asset) => asset?.assetKey && !asset.assetKey.startsWith(`inputs/${workspaceId}/`),
      )
    )
      throw Object.assign(new Error('Asset not found.'), { statusCode: 404, code: 'not_found' });
    return input;
  });
  const engine: EngineLike = {
    accounts: {
      authenticate: async (token: string) =>
        token === 'fixture-token'
          ? { workspaceId: 'fixture', scopes: ['read', 'generate'], keyId: 'fixture-key' }
          : token === 'foreign-token'
            ? { workspaceId: 'foreign', scopes: ['read', 'generate'], keyId: 'foreign-key' }
            : token === 'read-only'
              ? { workspaceId: 'fixture', scopes: ['read'], keyId: 'reader' }
              : token === 'generate-only'
                ? { workspaceId: 'fixture', scopes: ['generate'], keyId: 'writer' }
                : null,
    } as EngineLike['accounts'],
    getExecutableRouteIds: () =>
      catalog.routes.filter((route) => route.adapter).map((route) => route.id),
    executableForWorkspace: async () =>
      catalog.routes.filter((route) => route.adapter).map((route) => route.id),
    resolveInput,
    submit,
    getJob,
    lookupJob: async (workspaceId, key) =>
      requests.has(`${workspaceId}:${key}`) ? (jobs.get(workspaceId) ?? null) : null,
    jobStatus: new JobStatusStore({
      query: async (_sql, [workspaceId, jobId]) => {
        const job = jobId === id ? jobs.get(workspaceId as string) : undefined;
        return {
          rows: job
            ? [
                {
                  id: job.id,
                  status: job.status,
                  delivery_status: job.deliveryStatus ?? 'pending',
                  route_id: job.routeId,
                  deployment_id: job.deploymentId,
                  created_at: job.createdAt,
                  updated_at: job.updatedAt,
                  reserved_micros: job.reservedMicros,
                  settled_micros: job.settledMicros,
                },
              ]
            : [],
        };
      },
    }),
    listJobs: async () => [],
    cancel: async (workspaceId: string) => jobs.get(workspaceId),
    getBalance: async () => ({}),
    routeMetrics: async () => [],
    ownedAssets: {
      prepareUpload: async (workspaceId: string, mediaType: string, size: number) => ({
        key: `inputs/${workspaceId}/${fixtureAssetKey.split('/').at(-1)}`,
        uploadUrl: 'https://owned.invalid/synthetic-upload',
        headers: { 'Content-Type': mediaType },
        size,
      }),
      completeUpload: async (workspaceId: string, key: string) => {
        if (!key.startsWith(`inputs/${workspaceId}/`))
          throw Object.assign(new Error('Asset not found.'), { statusCode: 404 });
        return {
          assetKey: key,
          state: 'ready',
          mediaType: 'image/png',
          byteLength: 8,
          sha256: 'a'.repeat(64),
          expiresAt: null,
          deletionPending: false,
        };
      },
    } as EngineLike['ownedAssets'],
  };
  configure?.(engine);
  const app = await buildApp({
    engine,
    publicUrl: 'https://opengen.dev',
    env: { NODE_ENV: 'test' },
  });

  const fetchImpl = vi.fn(async (url: URL, options: RequestInit) => {
    const response = await app.inject({
      method: options.method as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers: options.headers as Record<string, string>,
      ...(options.body === undefined ? {} : { payload: options.body as string }),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  });
  const send = httpClient({ token: 'fixture-token', fetchImpl });
  const rpc = async (message: unknown, token = 'fixture-token') => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload: message as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    const result = response.json().result;
    return {
      ...result,
      value: result.content?.[0]?.text ? JSON.parse(result.content[0].text) : undefined,
    };
  };
  return { app, engine, submit, getJob, jobs, send, rpc, fetchImpl };
}

describe('source-validated raw HTTP feature examples', () => {
  it('parses the public docs request examples with the canonical contract', async () => {
    const source = await readFile(
      new URL('../apps/web/app/docs/page.tsx', import.meta.url),
      'utf8',
    );
    const ast = ts.createSourceFile(
      'page.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const requests: unknown[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isNoSubstitutionTemplateLiteral(node)) {
        const value = node.text.trim();
        if (value.startsWith('{')) requests.push(JSON.parse(value));
        for (const match of value.matchAll(/-d '(\{[\s\S]*?\})'/g))
          requests.push(JSON.parse(match[1]!));
        if (value.includes('curl '))
          expect(() =>
            execFileSync('/bin/sh', ['-n'], { input: value, timeout: 1000 }),
          ).not.toThrow();
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) expect(() => parseGenerationRequest(request)).not.toThrow();
  });
  it('validates every copyable JSON request and local reference link against source contracts', async () => {
    const document = await readFile(
      new URL('../docs/FEATURE-API-REFERENCE.md', import.meta.url),
      'utf8',
    );
    const blocks = [...document.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const block of blocks) {
      if (block.modelId && block.operation)
        expect(() => parseGenerationRequest(block)).not.toThrow();
      if (block.method === 'tools/call') {
        expect(callSchema.safeParse(block.params.arguments).success).toBe(true);
        if (block.params.arguments.operationId === 'media.generate')
          expect(() => parseGenerationRequest(block.params.arguments.input)).not.toThrow();
      }
    }
    for (const match of document.matchAll(/\]\(([^)#]+\.md)\)/g)) {
      if (!match[1]!.includes('://'))
        await expect(
          readFile(new URL(`../docs/${match[1]}`, import.meta.url), 'utf8'),
        ).resolves.toBeTypeOf('string');
    }
  });

  it.each(['text-to-image', 'image-to-video', 'image-edit'])(
    'keeps %s examples within the exact canonical schema and MCP allowlist',
    async (kind) => {
      const request = featureRequest(kind);
      expect(parseGenerationRequest(request).operation).toBe(kind);
      expect(
        callSchema.safeParse(
          mcpCall(1, 'media.generate', request, 'persisted-key').params.arguments,
        ).success,
      ).toBe(true);
      const f = await fixture();
      try {
        const profile = await f.send('GET', schemaPath(request));
        expect(profile.modelId).toBe(request.modelId);
        expect(profile.operation).toBe(request.operation);
        expect(profile.defaults).toEqual(
          getGenerationDefinition(request.modelId, request.operation)?.defaults,
        );
        expect(profile.inputSchema.additionalProperties).toBe(false);
        const mcp = await f.rpc(
          mcpCall(1, 'models.schema', { modelId: request.modelId, operation: request.operation }),
        );
        expect(mcp.value).toEqual(profile);
        const inspected = await runFeatureExample({ request, send: f.send });
        expect(inspected.quote.estimateOnly).toBe(true);
        expect(f.submit).not.toHaveBeenCalled();
        expect(inspected.routes.data.length).toBeGreaterThan(0);
      } finally {
        await f.app.close();
      }
    },
  );

  it('runs owned upload, image-to-video schema, quote, one submit and same-job HTTP/MCP recovery', async () => {
    const f = await fixture();
    try {
      const upload = await f.send('POST', '/v1/assets', { mediaType: 'image/png', size: 8 });
      expect(upload.key).toBe(fixtureAssetKey);
      await f.send('POST', '/v1/assets/complete', { key: upload.key });
      const request = featureRequest('image-to-video', { assetKey: upload.key });
      const result = await runFeatureExample({
        request,
        send: f.send,
        submit: true,
        idempotencyKey: 'persisted-before-submit',
      });
      expect(result.job.id).toBe(id);
      expect(result.current.id).toBe(id);
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.submit.mock.calls[0]![0].input.input.firstFrame).toEqual({ assetKey: upload.key });
      const mcpQuote = await f.rpc(mcpCall(1, 'quotes.single', request));
      expect(mcpQuote.value).toEqual(result.quote);
      const mcpRead = await f.rpc(mcpCall(2, 'jobs.get', { id }));
      expect(mcpRead.value).toEqual(result.current);
      const foreign = await f.rpc(mcpCall(3, 'jobs.get', { id }), 'foreign-token');
      expect(foreign.isError).toBe(true);
      expect(foreign.value.error.code).toBe('not_found');
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it('submits the text-image example once and never submits a comparison-only edit quote', async () => {
    const f = await fixture();
    try {
      const image = await runFeatureExample({
        request: featureRequest('text-to-image'),
        send: f.send,
        submit: true,
        idempotencyKey: 'image-key',
      });
      expect(image.current.id).toBe(id);
      expect(f.submit).toHaveBeenCalledOnce();
      // Current input-reference pricing is not qualified. The example must stop here.
      await expect(
        runFeatureExample({
          request: featureRequest('image-edit'),
          send: f.send,
          submit: true,
          idempotencyKey: 'edit-key',
        }),
      ).rejects.toThrow('No executable quote');
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it.each(['failed', 'submission-unknown'] as const)(
    'resumes %s without automatic replacement spending',
    async (status) => {
      const f = await fixture(status);
      try {
        const result = await runFeatureExample({
          request: featureRequest('text-to-image'),
          send: f.send,
          submit: true,
          idempotencyKey: 'same-existing-generation',
        });
        expect(result.current.status).toBe(status);
        await resumeJob(f.send, result.job.id);
        await f.rpc(mcpCall(1, 'jobs.get', { id: result.job.id }));
        expect(f.submit).toHaveBeenCalledOnce();
        expect(f.getJob).toHaveBeenCalledTimes(3);
      } finally {
        await f.app.close();
      }
    },
  );

  it('preserves the original key after a lost submit response without replacement spending', async () => {
    const f = await fixture();
    try {
      const interrupted = vi.fn(async (...args: Parameters<typeof f.send>) => {
        const response = await f.send(...args);
        if (args[0] === 'POST' && args[1] === '/v1/generations')
          throw new Error('Synthetic connection lost after admission.');
        return response;
      });
      await expect(
        runFeatureExample({
          request: featureRequest('text-to-image'),
          send: interrupted,
          submit: true,
          idempotencyKey: 'persisted-for-replay',
        }),
      ).rejects.toMatchObject({
        stage: 'submission',
        idempotencyKey: 'persisted-for-replay',
        cause: expect.objectContaining({ message: 'Synthetic connection lost after admission.' }),
      });
      expect(f.submit).toHaveBeenCalledOnce();
      const existing = await resumeJob(f.send, id);
      expect(existing.id).toBe(id);
      expect((await lookupSubmission(f.send, 'persisted-for-replay')).id).toBe(id);
      const lookup = await f.rpc(
        mcpCall(5, 'jobs.lookup', { idempotencyKey: 'persisted-for-replay' }),
      );
      expect(lookup.value.id).toBe(id);
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it('uses read-only lookup without interpreting a missing result as rejection', async () => {
    const f = await fixture();
    try {
      await expect(lookupSubmission(f.send, 'original key/&?')).rejects.toMatchObject({
        status: 404,
        code: 'submission_not_found',
      });
      const foreign = await f.rpc(
        mcpCall(1, 'jobs.lookup', { idempotencyKey: 'original key/&?' }),
        'foreign-token',
      );
      expect(foreign.isError).toBe(true);
      expect(foreign.value.error.code).toBe('submission_not_found');
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.fetchImpl.mock.calls[0]![0].searchParams.get('idempotencyKey')).toBe(
        'original key/&?',
      );
    } finally {
      await f.app.close();
    }
  });

  it('exposes compact status through HTTP/MCP without input or output capabilities', async () => {
    const f = await fixture('submission-unknown');
    try {
      await f.send('POST', '/v1/generations', featureRequest('text-to-image'), 'original-key');
      const snapshot = await f.send('GET', `/v1/generations/${id}/status`);
      expect(snapshot).toMatchObject({
        changed: true,
        timedOut: false,
        job: { id, status: 'submission-unknown', deliveryStatus: 'pending' },
      });
      expect(snapshot.job.revision).toMatch(/^[a-f0-9]{64}$/);
      for (const field of ['input', 'outputs', 'upstreamId', 'workspaceId'])
        expect(snapshot.job).not.toHaveProperty(field);
      const mcp = await f.rpc(mcpCall(1, 'jobs.status', { id }));
      expect(mcp.value).toEqual(snapshot);
      const unchanged = await f.send(
        'GET',
        `/v1/generations/${id}/status?afterRevision=${snapshot.job.revision}&waitMs=0`,
      );
      expect(unchanged).toMatchObject({ changed: false, timedOut: false });
      const invalid = await f.app.inject({
        method: 'GET',
        url: `/v1/generations/${id}/status?waitMs=25001`,
        headers: { authorization: 'Bearer fixture-token' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it('preserves structured HTTP error/action codes for MCP status failures', async () => {
    const f = await fixture();
    try {
      const missing = await f.app.inject({
        method: 'GET',
        url: `/v1/generations/${id}/status`,
        headers: { authorization: 'Bearer fixture-token' },
      });
      expect(missing.statusCode).toBe(404);
      const mcp = await f.rpc(mcpCall(1, 'jobs.status', { id }));
      expect(mcp.isError).toBe(true);
      expect(mcp.value).toEqual(missing.json());
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it.each([
    ['missing', 'fixture-token', 404],
    ['foreign', 'foreign-token', 404],
    ['scope', 'generate-only', 403],
    ['revoked', 'revoked-token', 401],
    ['backpressure', 'fixture-token', 429],
    ['unconfigured', 'fixture-token', 503],
  ] as const)(
    'keeps %s compact-status errors consistent across transports',
    async (kind, token, status) => {
      const f = await fixture('queued', (engine) => {
        if (kind === 'backpressure')
          engine.jobStatus = {
            wait: async () => {
              throw new JobStatusError(
                'status_backpressure',
                'Too many status waits; retry this read.',
                429,
              );
            },
          };
        if (kind === 'unconfigured') engine.jobStatus = undefined;
      });
      try {
        if (kind === 'foreign')
          await f.send('POST', '/v1/generations', featureRequest('text-to-image'), 'owned-only');
        const http = await f.app.inject({
          method: 'GET',
          url: `/v1/generations/${id}/status`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(http.statusCode).toBe(status);
        const mcp = await f.rpc(mcpCall(1, 'jobs.status', { id }), token);
        expect(mcp.isError).toBe(true);
        expect(mcp.structuredContent).toEqual(http.json());
        expect(mcp.value).toEqual(http.json());
        expect(f.submit).toHaveBeenCalledTimes(kind === 'foreign' ? 1 : 0);
      } finally {
        await f.app.close();
      }
    },
  );

  it('awaits receipt persistence before a failed first read and preserves accepted identity', async () => {
    const f = await fixture();
    const receipts: Record<string, string>[] = [];
    let persisted = false;
    const readFailure = new Error('Synthetic read network failure containing a private cause.');
    const interrupted = vi.fn(async (...args: Parameters<typeof f.send>) => {
      if (args[0] === 'GET' && args[1].startsWith('/v1/generations/')) {
        expect(persisted).toBe(true);
        throw readFailure;
      }
      return f.send(...args);
    });
    try {
      const failure = await runFeatureExample({
        request: featureRequest('text-to-image'),
        send: interrupted,
        submit: true,
        idempotencyKey: 'persisted-before-read',
        onAccepted: async (receipt: Record<string, string>) => {
          await Promise.resolve();
          receipts.push(receipt);
          persisted = true;
        },
      }).catch((error: unknown) => error);
      expect(receipts).toEqual([
        { jobId: id, idempotencyKey: 'persisted-before-read', resumePath: `/v1/generations/${id}` },
      ]);
      expect(failure).toMatchObject({
        stage: 'read',
        jobId: id,
        idempotencyKey: 'persisted-before-read',
        cause: readFailure,
      });
      expect(featureFailure(failure)).toMatchObject({
        jobId: id,
        idempotencyKey: 'persisted-before-read',
        recovery: { method: 'GET', path: `/v1/generations/${id}` },
      });
      expect(JSON.stringify(featureFailure(failure))).not.toContain('private cause');
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it('retains accepted identity and skips reads when a receipt callback cannot persist', async () => {
    const f = await fixture();
    try {
      const failure = await runFeatureExample({
        request: featureRequest('text-to-image'),
        send: f.send,
        submit: true,
        idempotencyKey: 'persist-with-original-request',
        onAccepted: async () => {
          throw new Error('Synthetic disk failure.');
        },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        stage: 'receipt',
        jobId: id,
        idempotencyKey: 'persist-with-original-request',
      });
      expect(f.getJob).not.toHaveBeenCalled();
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it("prints the safe accepted receipt before the command's first failing read", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL, options: RequestInit) => {
      if (url.pathname.startsWith('/v1/generations/')) {
        expect(log).toHaveBeenCalledOnce();
        expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
          accepted: {
            jobId: id,
            idempotencyKey: 'command-receipt-key',
            resumePath: `/v1/generations/${id}`,
          },
        });
        throw new Error('Synthetic read failure.');
      }
      return f.fetchImpl(url, options);
    }) as typeof fetch;
    try {
      const failure = await main(['text-to-image', '--submit'], {
        OPENGEN_API_URL: 'https://opengen.dev',
        OPENGEN_TOKEN: 'fixture-token',
        OPENGEN_IDEMPOTENCY_KEY: 'command-receipt-key',
      }).catch((error: unknown) => error);
      const output = JSON.stringify(featureFailure(failure));
      expect(output).toContain('--resume');
      expect(output).toContain(id);
      expect(output).not.toContain('paper lighthouse');
      expect(output).not.toContain('fixture-token');
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
      log.mockRestore();
      await f.app.close();
    }
  });

  it('uses same-job reads for private delivery and respects owner/scope/input failures', async () => {
    const f = await fixture();
    try {
      await runFeatureExample({
        request: featureRequest('text-to-image'),
        send: f.send,
        submit: true,
        idempotencyKey: 'capability-fixture',
      });
      Object.assign(f.jobs.get('fixture')!, {
        status: 'succeeded',
        deliveryStatus: 'available',
        outputs: [
          {
            url: privateUrl,
            expiresAt: '2026-11-04T00:15:00.000Z',
            mediaType: 'image/png',
            fidelity: 'unverified',
          },
        ],
      });
      const refreshed = await resumeJob(f.send, id);
      expect(refreshed.outputs[0].url).toBe(privateUrl);
      expect(f.submit).toHaveBeenCalledOnce();
      const headers = { authorization: 'Bearer read-only' };
      const denied = await f.app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers,
        payload: featureRequest('text-to-image'),
      });
      expect(denied.statusCode).toBe(403);
      const invalid = featureRequest('image-to-video');
      invalid.input.duration = 500;
      const bad = await f.app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: invalid,
        headers: { authorization: 'Bearer fixture-token' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatchObject({
        code: 'invalid_generation',
        issues: expect.arrayContaining([expect.objectContaining({ field: 'input.duration' })]),
      });
      const foreign = featureRequest('image-to-video', {
        assetKey: fixtureAssetKey.replace('fixture', 'foreign'),
      });
      await expect(f.send('POST', '/v1/quotes', foreign)).rejects.toMatchObject({ status: 404 });
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it('preserves exact regional pinning and immutable private metadata outside model input', async () => {
    const f = await fixture();
    const request = {
      modelId: 'alibaba/wan-3.0',
      operation: 'text-to-video',
      input: { prompt: 'A synthetic paper lighthouse.', resolution: '480p', duration: 5 },
      routeId: 'alibaba/ap-southeast-1/wan-3.0',
      routing: { endpointRegions: ['ap-southeast-1'] },
      metadata: { project: 'synthetic-qa', tags: { feature: 'docs' } },
      queueStartDeadlineAt: '2099-11-04T00:00:00.000Z',
      maxCostMicros: 1_000_000,
    };
    try {
      const quote = await f.send('POST', '/v1/quotes', request);
      expect(quote.selectedRouteId).toBe(request.routeId);
      await f.send('POST', '/v1/generations', request, 'regional-request');
      const admitted = f.submit.mock.calls[0]![0].input;
      expect(admitted).toMatchObject(request);
      expect(admitted.input).not.toHaveProperty('metadata');
      await expect(
        f.send(
          'POST',
          '/v1/generations',
          { ...request, metadata: { project: 'changed' } },
          'regional-request',
        ),
      ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
      expect(() =>
        parseGenerationRequest({ ...request, metadata: { tags: { 'invalid key': 'value' } } }),
      ).toThrow();
    } finally {
      await f.app.close();
    }
  });

  it('requires explicit spending identity and cap, and rejects arbitrary API targets', async () => {
    const f = await fixture();
    try {
      expect(() => featureRequest('text-to-image', { capMicros: Number.NaN })).toThrow('micro-USD');
      await expect(
        runFeatureExample({ request: featureRequest('text-to-image'), send: f.send, submit: true }),
      ).rejects.toThrow('Persist an Idempotency-Key');
      await expect(f.send('GET', '//attacker.invalid/private')).rejects.toThrow('API-relative');
      await expect(f.send('GET', '/\\attacker.invalid/private')).rejects.toThrow('API-relative');
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.fetchImpl.mock.calls.every(([url]) => url.origin === 'https://opengen.dev')).toBe(
        true,
      );
    } finally {
      await f.app.close();
    }
  });
});
