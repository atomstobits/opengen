import { describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput, GenerationArguments, Route } from '@media-router/contracts';
import { createRunwayAdapter } from '../packages/engine/src/runway.js';
import { createPikaAdapter } from '../packages/engine/src/pika.js';
import {
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
} from '../packages/engine/src/adapters.js';
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function context(
  provider: 'runway' | 'pika',
  input: Partial<GenerationArguments> &
    Pick<Partial<GenerateInput>, 'operation' | 'previousJobId'> = {},
): AdapterContext {
  const { operation = 'text-to-video', previousJobId, ...args } = input;
  const route = catalog.routes.find(
    (item) =>
      item.upstreamModelId ===
      (provider === 'runway' ? 'kling_4' : 'pika/pika-h3-flex/text-to-video'),
  )!;
  const deployment = catalog.deployments.find((item) => item.id === route.deploymentId)!;
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    route: { ...route, adapter: provider },
    deployment,
    input: {
      modelId: route.modelId,
      operation,
      previousJobId,
      input: {
        prompt: 'A paper boat floats across still water.',
        resolution: provider === 'runway' ? '720p' : '768p',
        duration: operation.includes('image') && operation !== 'image-to-video' ? undefined : 5,
        aspectRatio:
          operation === 'image-to-video' ||
          operation === 'video-extend' ||
          operation === 'video-edit'
            ? 'source'
            : operation === 'text-to-video' || operation === 'reference-to-video'
              ? '16:9'
              : undefined,
        ...args,
      },
    },
  };
}
describe('Runway Kling4 protocol', () => {
  it('preserves requested resolution, aspect ratio and duration through the strict native request', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'task-1' }));
    const adapter = createRunwayAdapter({
      env: { RUNWAYML_API_SECRET: 'synthetic-key' },
      fetch: request,
    });
    const ctx = context('runway', { resolution: '1080p', aspectRatio: '9:16', duration: 30 });
    await expect(adapter.submit(ctx)).resolves.toEqual({ upstreamId: 'task-1' });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://api.dev.runwayml.com/v1/text_to_video');
    expect(JSON.parse(options!.body as string)).toEqual({
      model: 'kling_4',
      promptText: ctx.input.input.prompt,
      duration: 30,
      ratio: '1080:1920',
    });
    expect(options!.headers).toMatchObject({
      Authorization: 'Bearer synthetic-key',
      'X-Runway-Version': '2024-11-06',
    });
  });
  it('uses input framing for one first frame and rejects a conflicting explicit shape or unsupported editing before dispatch', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'task-2' }));
    const adapter = createRunwayAdapter({
      env: { RUNWAYML_API_SECRET: 'synthetic-key' },
      fetch: request,
    });
    const ctx = context('runway', {
      operation: 'image-to-video',
      firstFrame: { url: 'https://assets.example/first.png' },
    });
    await adapter.submit(ctx);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
      ratio: 'auto_720p',
      promptImage: 'https://assets.example/first.png',
    });
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          input: {
            ...ctx.input.input,
            aspectRatio: '16:9',
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    await expect(
      adapter.submit({ ...ctx, input: { ...ctx.input, operation: 'video-edit' } }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not treat throttling as failure or an estimated credit count as actual settled spend', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ status: 'THROTTLED' }))
      .mockResolvedValueOnce(
        response({
          status: 'SUCCEEDED',
          output: ['https://cdn.example/output.mp4'],
          estimatedCost: { credits: 100 },
        }),
      );
    const adapter = createRunwayAdapter({
      env: { RUNWAYML_API_SECRET: 'synthetic-key' },
      fetch: request,
    });
    const ctx = { ...context('runway'), upstreamId: 'task-3' };
    await expect(adapter.poll(ctx)).resolves.toEqual({ status: 'running' });
    await expect(adapter.poll(ctx)).resolves.toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ url: 'https://cdn.example/output.mp4' }],
    });
  });
  it('preserves unknown submit acceptance and never retries a server error', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: 'synthetic private body' }, 500));
    const adapter = createRunwayAdapter({
      env: { RUNWAYML_API_SECRET: 'synthetic-key' },
      fetch: request,
    });
    await expect(adapter.submit(context('runway'))).rejects.toBeInstanceOf(SubmissionUnknown);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
describe('Pika H3 Flex protocol', () => {
  it('disables prompt rewriting and stem surcharges and retains the stable upstream idempotency key', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: 'media_1', status: 'queued' }));
    const adapter = createPikaAdapter({ env: { PIKA_API_KEY: 'synthetic-key' }, fetch: request });
    const ctx = context('pika', { resolution: '2K', aspectRatio: '4:3', duration: 12 });
    await adapter.submit(ctx);
    expect(request.mock.calls[0]![0]).toBe(
      'https://api.dev.pika.art/v1/media/pika/pika-h3-flex/text-to-video',
    );
    expect(request.mock.calls[0]![1]!.headers).toMatchObject({
      'X-API-Key': 'synthetic-key',
      'Idempotency-Key': ctx.jobId,
    });
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      prompt: ctx.input.input.prompt,
      duration: 12,
      resolution: '2k',
      aspect_ratio: '4:3',
      rewrite: false,
      output_mode: 'video',
    });
    expect(
      adapter.preflight!({ ...ctx, input: { ...ctx.input, routing: { fidelity: 'native' } } }),
    ).toContain('upscaler');
  });
  it('preserves reference-image order and rejects unsupported reference counts before dispatch', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'media_2' }));
    const adapter = createPikaAdapter({ env: { PIKA_API_KEY: 'synthetic-key' }, fetch: request });
    const ctx = context('pika', {
      operation: 'reference-to-video',
      references: ['https://assets.example/a.png', 'https://assets.example/b.png'].map((url) => ({
        type: 'image',
        asset: { url },
      })),
    });
    ctx.route = { ...ctx.route, upstreamModelId: 'pika/pika-h3-flex/reference-to-video' } as Route;
    await adapter.submit(ctx);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string).references).toEqual([
      { type: 'image', url: 'https://assets.example/a.png' },
      { type: 'image', url: 'https://assets.example/b.png' },
    ]);
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          input: {
            ...ctx.input.input,
            references: Array.from(
              { length: 10 },
              (_, index) => `https://assets.example/${index}.png`,
            ).map((url) => ({ type: 'image', asset: { url } })),
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('delivers completed media while pending billing requests later reconciliation, and records final zero as a real charge', async () => {
    const output = { media_type: 'video', video: { url: 'https://cdn.example/flex.mp4' } };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          status: 'completed',
          output,
          billing: { state: 'pending', charge_micro_usd: 99999 },
        }),
      )
      .mockResolvedValueOnce(
        response({
          status: 'completed',
          output,
          billing: { state: 'settled', charge_micro_usd: 0 },
        }),
      );
    const adapter = createPikaAdapter({ env: { PIKA_API_KEY: 'synthetic-key' }, fetch: request });
    const ctx = { ...context('pika'), upstreamId: 'media_3' };
    await expect(adapter.poll(ctx)).resolves.toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      retryAfterMs: 30000,
      outputs: [{ url: 'https://cdn.example/flex.mp4' }],
    });
    await expect(adapter.poll(ctx)).resolves.toMatchObject({
      status: 'succeeded',
      billedCostMicros: 0,
    });
  });
  it('does not expose provider error text or assume a refund before billing settles', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        status: 'failed',
        error: 'synthetic private prompt and secret',
        billing: { state: 'unavailable' },
      }),
    );
    const adapter = createPikaAdapter({ env: { PIKA_API_KEY: 'synthetic-key' }, fetch: request });
    const result = await adapter.poll({ ...context('pika'), upstreamId: 'media_4' });
    expect(result).toMatchObject({
      status: 'failed',
      failureCategory: 'unknown',
      billedCostMicros: null,
      retryAfterMs: 30000,
    });
    expect(JSON.stringify(result)).not.toContain('private prompt');
  });
});
