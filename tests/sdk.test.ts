import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateInput, Job } from '@media-router/contracts';
import {
  JobWaitTimeoutError,
  OpenGen,
  OpenGenAPIError,
  SubmissionUncertainError,
} from '../packages/sdk/src/index';
import { buildApp } from '../apps/server/src/app';

const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A quiet sea.', resolution: '720p', duration: 5, aspectRatio: '16:9' },
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  maxCostMicros: 2_000_000,
};
const job: Job = {
  id: 'd269eb51-5da6-4ba5-a7e6-42202dd45266',
  workspaceId: 'test',
  status: 'queued',
  input,
  routeId: input.routeId!,
  deploymentId: 'alibaba/ap-southeast-1',
  upstreamId: null,
  outputs: [],
  error: null,
  createdAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  reservedMicros: 825125,
  settledMicros: null,
  attemptCount: 0,
};
afterEach(() => vi.useRealTimers());

describe('OpenGen SDK request and recovery contract', () => {
  it('uses the real gateway contract for discovery, quotes, authenticated admission and job lookup', async () => {
    const submitted: GenerateInput[] = [];
    const app = await buildApp({
      apiToken: 'fixture-sdk-only',
      engine: {
        getExecutableRouteIds: () => [input.routeId!],
        submit: async (args) => {
          expect(args.idempotencyKey).toBe('persisted-before-submit');
          submitted.push(args.input);
          return job;
        },
        getJob: async (_workspace, id) => (id === job.id ? job : null),
        listJobs: async () => [job],
        cancel: async () => ({ ...job, status: 'cancelled' }),
        getBalance: async () => ({ availableMicros: 100, reservedMicros: 825125, currency: 'USD' }),
        routeMetrics: async () => [],
      },
    });
    const transport: typeof fetch = async (url, options) => {
      const response = await app.inject({
        url: new URL(String(url)).pathname + new URL(String(url)).search,
        method: options?.method as 'GET' | 'POST',
        headers: Object.fromEntries(new Headers(options?.headers)),
        payload: options?.body as string | undefined,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      apiKey: 'fixture-sdk-only',
      fetch: transport,
    });
    try {
      expect((await sdk.company('minimax')).company.id).toBe('minimax');
      expect((await sdk.series('minimax', 'h3')).models).toHaveLength(6);
      expect((await sdk.quote(input)).selectedRouteId).toBe(input.routeId);
      expect((await sdk.submit(input, { idempotencyKey: 'persisted-before-submit' })).id).toBe(
        job.id,
      );
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject(input);
      expect((await sdk.job(job.id)).routeId).toBe(input.routeId);
      expect(await sdk.call('jobs.list', {})).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('preserves canonical common and model-specific fields through every native generation operation', async () => {
    const sent: unknown[] = [];
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ ...job, input: canonical });
      },
    });
    const canonical: GenerateInput = {
      modelId: 'minimax/h3-max',
      operation: 'reference-to-video',
      input: {
        prompt: 'A slow push in.',
        references: [{ type: 'image', asset: { assetKey: 'inputs/owned/subject.png' } }],
        duration: 5.5,
        resolution: '768p',
        aspectRatio: '16:9',
        promptExpansion: 'quality',
      },
      routing: { preference: 'cost' },
      billing: 'byok',
      maxCostMicros: 2_000_000,
    };
    await sdk.quote(canonical);
    await sdk.quotes([canonical]);
    await sdk.submit(canonical, { idempotencyKey: 'canonical-shared-body' });
    expect(sent).toEqual([canonical, [canonical], canonical]);
  });

  it('retains structured canonical input rejections from the gateway', async () => {
    const issues = [
      {
        code: 'too_many_references',
        field: 'input.references',
        message: 'This model accepts at most 9 image references.',
        limit: 9,
        received: 10,
      },
    ];
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async () =>
        Response.json(
          { error: { code: 'invalid_generation', message: 'Unsupported inputs.', issues } },
          { status: 400 },
        ),
    });
    await expect(sdk.quote(input)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_generation',
      issues,
    });
  });

  it('never repeats a paid POST after a disconnect, unreadable result or server error', async () => {
    for (const response of [
      undefined,
      new Response('not JSON', { status: 202 }),
      new Response(JSON.stringify({ error: { code: 'service_failed', message: 'Try later.' } }), {
        status: 503,
      }),
    ]) {
      let calls = 0;
      const sdk = new OpenGen({
        baseUrl: 'https://gateway.example',
        fetch: async () => {
          calls++;
          if (!response) throw new Error('disconnect');
          return response;
        },
      });
      await expect(
        sdk.submit(input, { idempotencyKey: 'same-key-after-recovery' }),
      ).rejects.toMatchObject({
        name: 'SubmissionUncertainError',
        idempotencyKey: 'same-key-after-recovery',
      });
      expect(calls).toBe(1);
    }
  });

  it('validates the stable key before network access and preserves the caller abort before admission', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const sdk = new OpenGen({ baseUrl: 'https://gateway.example', fetch: fetcher });
    expect(() => sdk.submit(input, { idempotencyKey: '' })).toThrow('idempotencyKey');
    const signal = AbortSignal.abort(new Error('Cancelled before sending'));
    await expect(sdk.submit(input, { idempotencyKey: 'unused', signal })).rejects.toThrow(
      'Cancelled before sending',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves definitive 4xx rejections even when the gateway error body cannot be parsed', async () => {
    for (const status of [400, 401, 402, 403, 409, 422, 429]) {
      let calls = 0;
      const sdk = new OpenGen({
        baseUrl: 'https://gateway.example',
        fetch: async () => {
          calls++;
          return new Response('private raw gateway body', { status });
        },
      });
      try {
        await sdk.submit(input, { idempotencyKey: 'same-key' });
        throw new Error('Expected rejection.');
      } catch (error) {
        expect(error).toBeInstanceOf(OpenGenAPIError);
        expect(error).not.toBeInstanceOf(SubmissionUncertainError);
        expect(error).toMatchObject({ status, code: 'request_failed' });
        expect(String(error)).not.toContain('private raw');
      }
      expect(calls).toBe(1);
    }
  });

  it('keeps 408/5xx acceptance unknown and rejects a successful native response without a recoverable receipt', async () => {
    for (const [status, body, expectedId] of [
      [408, 'private unreadable body', undefined],
      [503, 'private unreadable body', undefined],
      [202, '{}', undefined],
      [202, JSON.stringify({ id: job.id, status: 'unsupported-status' }), job.id],
    ] as const) {
      let calls = 0;
      const sdk = new OpenGen({
        baseUrl: 'https://gateway.example',
        fetch: async () => {
          calls++;
          return new Response(body, { status });
        },
      });
      await expect(sdk.submit(input, { idempotencyKey: 'persisted-key' })).rejects.toMatchObject({
        name: 'SubmissionUncertainError',
        status,
        idempotencyKey: 'persisted-key',
        jobId: expectedId,
      });
      expect(calls).toBe(1);
    }
  });

  it('does not call a quote a paid admission or infer acceptance from an accidental idempotency header', async () => {
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async () =>
        Response.json(
          { error: { code: 'quote_unavailable', message: 'Try a read later.' } },
          { status: 503 },
        ),
    });
    await expect(
      sdk.quote(input, { idempotencyKey: 'not-a-paid-call' } as never),
    ).rejects.toMatchObject({
      name: 'OpenGenAPIError',
      status: 503,
      code: 'quote_unavailable',
    });
  });

  it('uses the fixed private feedback and catalog request paths with reviewed content only', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (url, init) => {
        seen.push({
          method: init?.method!,
          path: new URL(String(url)).pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({
          id: job.id,
          status: 'received',
          visibility: 'workspace-and-operator',
        });
      },
    });
    const feedback = {
      kind: 'feedback' as const,
      category: 'setup' as const,
      summary: 'The route filter needs a clearer label.',
      reviewedForPrivacy: true as const,
    };
    await sdk.call('feedback.submit', feedback);
    await sdk.call('catalog.request', {
      ...feedback,
      kind: 'catalog-request',
      category: 'missing-route',
    });
    await sdk.call('feedback.get', { id: job.id });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/feedback', body: feedback },
      {
        method: 'POST',
        path: '/v1/catalog/requests',
        body: { ...feedback, kind: 'catalog-request', category: 'missing-route' },
      },
      { method: 'GET', path: `/v1/feedback/${job.id}`, body: undefined },
    ]);
  });

  it('rejects an unserializable local request before sending rather than reporting unknown acceptance', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const sdk = new OpenGen({ baseUrl: 'https://gateway.example', fetch: fetcher });
    const cyclic = { ...input } as typeof input & { circular?: unknown };
    cyclic.circular = cyclic;
    await expect(sdk.submit(cyclic, { idempotencyKey: 'never-sent' })).rejects.toThrow(
      'No request was sent',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces structured rejection without exposing the configured credential in the error', async () => {
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      apiKey: 'fixture-private-value',
      fetch: async () =>
        Response.json(
          { error: { code: 'policy_denied', message: 'The route is forbidden.' } },
          { status: 403 },
        ),
    });
    try {
      await sdk.submit(input, { idempotencyKey: 'denied' });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenGenAPIError);
      expect(error).not.toBeInstanceOf(SubmissionUncertainError);
      expect(error).toMatchObject({ status: 403, code: 'policy_denied' });
      expect(String(error)).not.toContain('fixture-private-value');
    }
  });

  it('pins a configured gateway prefix and encodes deployment IDs inside registered paths', async () => {
    const seen: { url: string; headers: Headers; body: unknown }[] = [];
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example/opengen',
      apiKey: 'fixture-key',
      fetch: async (url, options) => {
        seen.push({
          url: String(url),
          headers: new Headers(options?.headers),
          body: JSON.parse(String(options?.body)),
        });
        return Response.json({ configured: true });
      },
    });
    await sdk.call('connections.put', {
      deploymentId: 'alibaba/ap-southeast-1',
      apiKey: 'private-provider-fixture',
      workspaceId: 'regional-account',
    });
    expect(seen[0]?.url).toBe(
      'https://gateway.example/opengen/v1/connections/alibaba%2Fap-southeast-1',
    );
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer fixture-key');
    expect(seen[0]?.body).toEqual({
      apiKey: 'private-provider-fixture',
      workspaceId: 'regional-account',
    });
    expect(() => Reflect.apply(sdk.call, sdk, ['https://untrusted.example', {}])).toThrow(
      'registered operation',
    );
    expect(seen).toHaveLength(1);
    expect(() => new OpenGen({ baseUrl: 'https://secret@gateway.example' })).toThrow('baseUrl');
  });

  it('waits using GET only, and stops at an unresolved submission without resubmitting', async () => {
    const methods: string[] = [];
    let polls = 0;
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (_url, options) => {
        methods.push(options?.method!);
        return Response.json({ ...job, status: ++polls === 1 ? 'running' : 'submission-unknown' });
      },
    });
    expect((await sdk.wait(job.id, { pollIntervalMs: 1, timeoutMs: 1000 })).status).toBe(
      'submission-unknown',
    );
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('returns successful media without pretending delayed settlement is complete', async () => {
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async () => Response.json({ ...job, status: 'succeeded', settledMicros: null }),
    });
    const result = await sdk.wait(job.id);
    expect(result.status).toBe('succeeded');
    expect(result.settledMicros).toBeNull();
  });

  it('preserves batch bodies and reads content redirects without forwarding gateway credentials', async () => {
    const seen: {
      method: string;
      path: string;
      redirect: RequestRedirect | undefined;
      body: unknown;
    }[] = [];
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      apiKey: 'fixture-workspace-key',
      fetch: async (url, options) => {
        seen.push({
          method: options?.method!,
          path: new URL(String(url)).pathname,
          redirect: options?.redirect,
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
        });
        return new URL(String(url)).pathname.endsWith('/content')
          ? new Response(null, {
              status: 303,
              headers: { location: 'https://storage.example/short-lived-output.mp4' },
            })
          : Response.json({ data: [] });
      },
    });
    await sdk.quotes([input, input]);
    expect(seen[0]?.body).toEqual([input, input]);
    expect(await sdk.call('videos.content', { id: job.id })).toEqual({
      statusCode: 303,
      location: 'https://storage.example/short-lived-output.mp4',
    });
    expect(seen[1]?.redirect).toBe('manual');
    expect(seen).toHaveLength(2);
    expect(() =>
      sdk.call(
        'images.generate',
        { model: 'openai/gpt-image-2', prompt: 'A sea.' },
        { idempotencyKey: '' },
      ),
    ).toThrow('idempotencyKey');
    expect(seen).toHaveLength(2);
  });

  it('times out with the existing job ID and latest state, without submitting or cancelling', async () => {
    const methods: string[] = [];
    const sdk = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (_url, options) => {
        methods.push(options?.method!);
        return Response.json(job);
      },
    });
    await expect(sdk.wait(job.id, { pollIntervalMs: 1000, timeoutMs: 10 })).rejects.toMatchObject({
      name: 'JobWaitTimeoutError',
      jobId: job.id,
      lastJob: { id: job.id, status: 'queued' },
    });
    expect(methods).toEqual(['GET']);
    expect(new JobWaitTimeoutError(job.id)).toBeInstanceOf(Error);
  });
});
