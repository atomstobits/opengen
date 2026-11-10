import { describe, expect, it } from 'vitest';
import type {
  Deployment,
  GenerateInput,
  GenerationArguments,
  Route,
} from '@media-router/contracts';
import { SubmissionRejected, SubmissionUnknown } from '../packages/engine/src/adapters.js';
import { createFalAdapter } from '../packages/engine/src/fal.js';
import { createOpenAIAdapter, openAIImageSize } from '../packages/engine/src/openai.js';
import { createXaiAdapter } from '../packages/engine/src/xai.js';
const evidence = { url: 'https://example.com/provider-docs', checkedAt: '2026-11-02' };
function context(
  providerId: string,
  upstreamModelId: string,
  input: Partial<GenerationArguments> &
    Pick<Partial<GenerateInput>, 'operation' | 'previousJobId'> = {},
) {
  const { operation = 'text-to-video', previousJobId, ...args } = input;
  const deployment: Deployment = {
    id: `${providerId}-undisclosed`,
    providerId,
    name: providerId,
    endpointRegion: 'undisclosed',
    scope: 'undisclosed',
    processingRegions: null,
    storageRegions: null,
    endpointTemplate: null,
    credentialEnv: null,
    source: evidence,
  };
  const route: Route = {
    id: `${providerId}/fixture`,
    modelId: `${providerId}/fixture`,
    deploymentId: deployment.id,
    upstreamModelId,
    operations: ['text-to-video', 'text-to-image'],
    resolutions: ['768p', '1K'],
    durations: [5],
    fidelity: 'unknown',
    adapter: providerId as Route['adapter'],
    status: 'documented',
    rates: [],
    pricingSource: evidence,
    source: evidence,
  };
  return {
    jobId: 'fixture-job',
    route,
    deployment,
    input: {
      modelId: route.modelId,
      operation,
      previousJobId,
      input: {
        prompt: 'A ceramic cup in morning light.',
        resolution: '768p',
        duration: operation.endsWith('image') || operation === 'image-edit' ? undefined : 5,
        aspectRatio:
          operation === 'image-to-video'
            ? 'source'
            : operation === 'text-to-video' || operation === 'reference-to-video'
              ? '16:9'
              : undefined,
        ...args,
      },
    } satisfies GenerateInput,
  };
}
describe('fal durable queue protocol (synthetic fixtures, no network)', () => {
  it('submits once and reconstructs queue management from owner/app, ignoring returned URLs', async () => {
    const calls: Array<{
      url: string;
      body: unknown;
    }> = [];
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture-key' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        expect(new Headers(init?.headers).get('Authorization')).toBe('Key fixture-key');
        if (init?.method === 'POST')
          return Response.json({
            request_id: 'task/a',
            status_url: 'https://attacker.example/path',
          });
        if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ video: { url: 'https://media.example.com/result.mp4' } });
      },
    });
    const ctx = context('fal', 'minimax/h3-max/text-to-video');
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'task/a' });
    expect(await adapter.poll({ ...ctx, upstreamId: 'task/a' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://queue.fal.run/minimax/h3-max/text-to-video',
      'https://queue.fal.run/minimax/h3-max/requests/task%2Fa/status',
      'https://queue.fal.run/minimax/h3-max/requests/task%2Fa',
    ]);
    expect(calls[0]?.body).toMatchObject({
      duration: 5,
      resolution: '768P',
      prompt_expansion_mode: 'disabled',
      enable_safety_checker: true,
    });
  });
  it('does not fetch results while queued and never treats inference time as money', async () => {
    let calls = 0;
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async () => {
        calls++;
        return Response.json({ status: 'IN_QUEUE', metrics: { inference_time: 1.2 } });
      },
    });
    expect(
      await adapter.poll({ ...context('fal', 'minimax/h3-max/text-to-video'), upstreamId: 'id' }),
    ).toEqual({ status: 'running' });
    expect(calls).toBe(1);
  });
  it('redacts upstream errors and does not claim a failed generation is free', async () => {
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async () => Response.json({ status: 'COMPLETED', error: 'private prompt / key' }),
    });
    const result = await adapter.poll({
      ...context('fal', 'minimax/h3-max/text-to-video'),
      upstreamId: 'id',
    });
    expect(result).toMatchObject({ status: 'failed', billedCostMicros: null });
    expect(JSON.stringify(result)).not.toContain('private prompt');
  });
  it('rejects unsupported endpoints and references before any external request', async () => {
    let calls = 0;
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(
      adapter.submit(context('fal', 'arbitrary/private/endpoint')),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    await expect(
      adapter.submit(
        context('fal', 'minimax/h3-max/text-to-video', {
          references: ['https://example.com/input.jpg'].map((url) => ({
            type: 'image',
            asset: { url },
          })),
        }),
      ),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(calls).toBe(0);
  });
});
describe('xAI deferred image and video protocol (no network)', () => {
  it.each(['auto', 'low', 'medium'])(
    'preserves documented image quality %s for generation and editing',
    async (quality) => {
      const bodies: Record<string, unknown>[] = [];
      const adapter = createXaiAdapter({
        env: { XAI_API_KEY: 'fixture' },
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ request_id: 'image-task' });
        },
      });
      for (const operation of ['text-to-image', 'image-edit'] as const) {
        const ctx = context('xai', 'grok-imagine-image-2.0', {
          operation,
          resolution: '1K',
          quality,
          ...(operation === 'image-edit'
            ? {
                references: [
                  {
                    type: 'image' as const,
                    asset: { url: 'https://media.example.com/source.png' },
                  },
                ],
              }
            : {}),
        });
        expect(adapter.preflight?.(ctx)).toBeNull();
        await adapter.submit(ctx);
      }
      expect(bodies.map((body) => body.quality)).toEqual([quality, quality]);
    },
  );
  it('rejects unsupported image quality before any provider submission', async () => {
    let calls = 0;
    const adapter = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async () => {
        calls++;
        return Response.json({ request_id: 'image-task' });
      },
    });
    for (const operation of ['text-to-image', 'image-edit'] as const) {
      await expect(
        adapter.submit(
          context('xai', 'grok-imagine-image-2.0', {
            operation,
            resolution: '1K',
            quality: 'high',
            ...(operation === 'image-edit'
              ? {
                  references: [
                    {
                      type: 'image' as const,
                      asset: { url: 'https://media.example.com/source.png' },
                    },
                  ],
                }
              : {}),
          }),
        ),
      ).rejects.toBeInstanceOf(SubmissionRejected);
    }
    expect(calls).toBe(0);
  });
  it('persists deferred image requests instead of holding an image render open', async () => {
    const calls: string[] = [];
    const adapter = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async (url, init) => {
        calls.push(String(url));
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toMatchObject({
            model: 'grok-imagine-image-2.0',
            deferred: true,
            resolution: '2k',
            quality: 'low',
          });
          return Response.json({ request_id: 'image-task' });
        }
        return Response.json({
          status: 'done',
          data: [{ url: 'https://media.example.com/image.jpg' }],
        });
      },
    });
    const ctx = context('xai', 'grok-imagine-image-2.0', {
      operation: 'text-to-image',
      resolution: '2K',
      duration: undefined,
    });
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'image-task' });
    expect(await adapter.poll({ ...ctx, upstreamId: 'image-task' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
    });
    expect(calls).toEqual([
      'https://api.x.ai/v1/images/generations',
      'https://api.x.ai/v1/images/image-task',
    ]);
  });
  it('uses JSON image edits with exactly the selected reference', async () => {
    const adapter = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.x.ai/v1/images/edits');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          image: { url: 'https://media.example.com/source.png', type: 'image_url' },
          quality: 'medium',
        });
        return Response.json({ request_id: 'edit' });
      },
    });
    await adapter.submit(
      context('xai', 'grok-imagine-image-2.0', {
        operation: 'image-edit',
        resolution: '1K',
        references: ['https://media.example.com/source.png'].map((url) => ({
          type: 'image',
          asset: { url },
        })),
      }),
    );
  });
  it('preserves reference mode and refuses ignored aspect ratios or downgraded resolution', async () => {
    let calls = 0;
    const adapter = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body))).toMatchObject({
          reference_images: [{ url: 'https://media.example.com/source.png' }],
          generate_audio: true,
        });
        return Response.json({ request_id: 'video' });
      },
    });
    const ref = {
      operation: 'reference-to-video' as const,
      resolution: '720p',
      references: ['https://media.example.com/source.png'].map((url) => ({
        type: 'image',
        asset: { url },
      })),
    };
    const ctx = context('xai', 'grok-imagine-video-1.5', ref);
    await adapter.submit(ctx);
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          input: {
            ...ctx.input.input,
            resolution: '1080p',
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          operation: 'image-to-video',
          input: {
            ...ctx.input.input,
            aspectRatio: '16:9',
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(calls).toBe(1);
  });
  it('retains uncertain billing for expired tasks and withholds moderated videos', async () => {
    const ctx = {
      ...context('xai', 'grok-imagine-video-1.5', { resolution: '720p' }),
      upstreamId: 'id',
    };
    const expired = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async () => Response.json({ status: 'expired' }),
    });
    expect(await expired.poll(ctx)).toMatchObject({ status: 'unknown' });
    const moderated = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          status: 'done',
          video: { url: 'https://media.example.com/x.mp4', respect_moderation: false },
        }),
    });
    const result = await moderated.poll(ctx);
    expect(result).toMatchObject({
      status: 'failed',
      failureCategory: 'policy',
      billedCostMicros: null,
    });
    expect(result.outputs).toBeUndefined();
  });
});
describe('OpenAI image bytes and safe synchronous submission (no network)', () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const ctx = context('openai', 'gpt-image-2.5-flare', {
    operation: 'text-to-image',
    resolution: '1K',
  });
  it('requires output storage before a route is configured', () => {
    expect(
      createOpenAIAdapter({ env: { OPENAI_API_KEY: 'fixture' } }).isConfigured(
        ctx.route,
        ctx.deployment,
      ),
    ).toBe(false);
    expect(
      createOpenAIAdapter({
        env: { OPENAI_API_KEY: 'fixture' },
        storeOutput: async () => ({
          url: 'https://assets.example.com/result.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
        }),
      }).isConfigured(ctx.route, ctx.deployment),
    ).toBe(true);
  });
  it('stores decoded output bytes and keeps image bytes and credentials out of the job result', async () => {
    const adapter = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'fixture-secret' },
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'gpt-image-2.5-flare',
          size: '1024x1024',
          quality: 'medium',
          output_format: 'png',
          n: 1,
        });
        return Response.json({
          data: [{ b64_json: png.toString('base64') }],
          usage: { output_tokens: 100 },
        });
      },
      storeOutput: async (image) => {
        expect(image.jobId).toBe('fixture-job');
        expect(Buffer.from(image.bytes)).toEqual(png);
        return {
          url: 'https://assets.example.com/result.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
        };
      },
    });
    const result = await adapter.submit(ctx);
    expect(result).toMatchObject({
      immediateResult: {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [{ url: 'https://assets.example.com/result.png', fidelity: 'unverified' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain(png.toString('base64'));
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('keeps failed output storage ambiguous rather than re-rendering a paid image', async () => {
    let calls = 0;
    const adapter = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'fixture' },
      fetch: async () => {
        calls++;
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      },
      storeOutput: async () => {
        throw new Error('storage down');
      },
    });
    await expect(adapter.submit(ctx)).rejects.toBeInstanceOf(SubmissionUnknown);
    expect(calls).toBe(1);
  });
  it('does not silently select different dimensions or accept malformed PNG output', async () => {
    expect(openAIImageSize('4K', '1:1')).toBeNull();
    expect(openAIImageSize('4K', '16:9')).toBe('3840x2160');
    expect(openAIImageSize('2K', '9:16')).toBe('1152x2048');
    const adapter = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({ data: [{ b64_json: Buffer.from('not a png').toString('base64') }] }),
      storeOutput: async () => ({
        url: 'https://assets.example.com/result.png',
        mediaType: 'image/png',
        fidelity: 'unverified',
      }),
    });
    await expect(adapter.submit(ctx)).rejects.toBeInstanceOf(SubmissionUnknown);
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          input: {
            ...ctx.input.input,
            resolution: '4K',
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
  });
  it('distinguishes definitive 4xx rejection from timeouts and server errors without retry', async () => {
    for (const status of [400, 401, 429, 408, 500]) {
      let calls = 0;
      const adapter = createOpenAIAdapter({
        env: { OPENAI_API_KEY: 'fixture' },
        fetch: async () => {
          calls++;
          return new Response('private upstream error', { status });
        },
        storeOutput: async () => ({
          url: 'https://assets.example.com/result.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
        }),
      });
      await expect(adapter.submit(ctx)).rejects.toBeInstanceOf(
        status < 500 && status !== 408 ? SubmissionRejected : SubmissionUnknown,
      );
      expect(calls).toBe(1);
    }
  });
});
describe('MiniMax H3 and Google Nano Banana protocol boundaries (no network)', () => {
  it('keeps MiniMax first/last frames distinct from reference images', async () => {
    const { createMiniMaxAdapter } = await import('../packages/engine/src/minimax.js');
    const adapter = createMiniMaxAdapter({
      env: { MINIMAX_API_KEY: 'fixture' },
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.minimax.io/v2/video_generation');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'MiniMax-H3',
          ratio: 'adaptive',
          content: [
            { type: 'text' },
            {
              type: 'image_url',
              image_url: { url: 'https://media.example.com/first.png' },
              role: 'first_frame',
            },
            {
              type: 'image_url',
              image_url: { url: 'https://media.example.com/last.png' },
              role: 'last_frame',
            },
          ],
        });
        return Response.json({ task_id: 'minimax-task' });
      },
    });
    const ctx = context('minimax', 'MiniMax-H3', {
      operation: 'image-to-video',
      firstFrame: { url: 'https://media.example.com/first.png' },
      lastFrame: { url: 'https://media.example.com/last.png' },
    });
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'minimax-task' });
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
  });
  it('enforces exact H3 variant constraints and parses the v2 task response', async () => {
    const { createMiniMaxAdapter } = await import('../packages/engine/src/minimax.js');
    const adapter = createMiniMaxAdapter({
      env: { MINIMAX_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          task: {
            status: 'succeeded',
            content: { url: 'https://media.example.com/h3.mp4' },
            usage: { total_tokens: 500 },
          },
        }),
    });
    const ctx = context('minimax', 'MiniMax-H3-Max', { resolution: '2K' });
    await expect(adapter.submit(ctx)).rejects.toBeInstanceOf(SubmissionRejected);
    const result = await adapter.poll({ ...ctx, upstreamId: 'id' });
    expect(result).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ url: 'https://media.example.com/h3.mp4' }],
    });
  });
  it('persists the Google interaction ID and stores only final model output, excluding thought images', async () => {
    const { createGoogleImageAdapter } = await import('../packages/engine/src/google.js');
    const finalPng = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const adapter = createGoogleImageAdapter({
      env: { GEMINI_API_KEY: 'fixture-secret' },
      fetch: async (url, init) => {
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('fixture-secret');
        expect(String(url)).not.toContain('fixture-secret');
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toMatchObject({
            model: 'gemini-nano-banana-2.1',
            store: true,
            response_format: { type: 'image', image_size: '2K', aspect_ratio: '16:9' },
          });
          return Response.json({ id: 'interaction' });
        }
        return Response.json({
          id: 'interaction',
          status: 'completed',
          steps: [
            { type: 'thought', summary: [{ type: 'image', data: 'untrusted-thought' }] },
            {
              type: 'model_output',
              content: [
                { type: 'image', mime_type: 'image/png', data: finalPng.toString('base64') },
              ],
            },
          ],
        });
      },
      storeOutput: async (image) => {
        expect(Buffer.from(image.bytes)).toEqual(finalPng);
        return {
          url: 'https://assets.example.com/google.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
          expiresAt: '2026-11-03T01:00:00Z',
        };
      },
    });
    const ctx = context('google', 'gemini-nano-banana-2.1', {
      operation: 'text-to-image',
      resolution: '2K',
      aspectRatio: '16:9',
    });
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'interaction' });
    expect(await adapter.poll({ ...ctx, upstreamId: 'interaction' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ expiresAt: '2026-11-03T01:00:00Z' }],
    });
  });
  it('leaves unimplemented Google video and image editing unavailable before submission', async () => {
    const { createGoogleImageAdapter } = await import('../packages/engine/src/google.js');
    const adapter = createGoogleImageAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      storeOutput: async () => ({
        url: 'https://assets.example.com/x.png',
        mediaType: 'image/png',
        fidelity: 'unverified',
      }),
    });
    const omni = context('google', 'gemini-omni-1.1-flash');
    expect(adapter.isConfigured(omni.route, omni.deployment)).toBe(false);
    await expect(adapter.submit(omni)).rejects.toBeInstanceOf(SubmissionRejected);
  });
});
describe('fal Seedance exact endpoint and regional admission (no network)', () => {
  it('keeps exact operation, first/last frame order and stable hashed end-user identity', async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ request_id: 'seedance' });
      },
    });
    const ctx = {
      ...context('fal', 'bytedance/seedance-2.5/image-to-video', {
        operation: 'image-to-video',
        resolution: '720p',
        firstFrame: { url: 'https://media.example.com/first.png' },
        lastFrame: { url: 'https://media.example.com/last.png' },
      }),
      workspaceId: 'private-workspace',
    };
    await adapter.submit(ctx);
    await adapter.submit({ ...ctx, jobId: 'other-job' });
    expect(bodies[0]).toMatchObject({
      image_url: 'https://media.example.com/first.png',
      end_image_url: 'https://media.example.com/last.png',
      duration: '5',
      resolution: '720p',
      aspect_ratio: 'auto',
      generate_audio: true,
    });
    expect(bodies[0]?.end_user_id).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[0]?.end_user_id).toBe(bodies[1]?.end_user_id);
    expect(bodies[0]?.end_user_id).not.toBe('private-workspace');
    await expect(
      adapter.submit({ ...ctx, input: { ...ctx.input, operation: 'text-to-video' } }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
  });
  it('does not use an ordinary fal key to execute an account-enabled US route', async () => {
    const adapter = createFalAdapter({ env: { FAL_KEY: 'fixture' } });
    const ctx = context('fal', 'bytedance/seedance-2.0/text-to-video', { resolution: '720p' });
    const regional = {
      ...ctx,
      deployment: {
        ...ctx.deployment,
        id: 'fal-seedance-us-account-enabled',
        processingRegions: ['US'],
      },
    };
    expect(adapter.isConfigured(regional.route, regional.deployment)).toBe(false);
    await expect(adapter.submit(regional)).rejects.toBeInstanceOf(SubmissionRejected);
  });
});
describe('fal image reseller schema preservation (no network)', () => {
  it('uses exact GPT dimensions and retains every reference in its original order', async () => {
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://queue.fal.run/openai/gpt-image-2.5/sunburst/edit');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          image_size: { width: 2048, height: 1152 },
          image_urls: ['https://media.example.com/one.png', 'https://media.example.com/two.png'],
          num_images: 1,
          output_format: 'png',
          quality: 'medium',
          enable_safety_checker: true,
        });
        return Response.json({ request_id: 'gpt' });
      },
    });
    await adapter.submit(
      context('fal', 'openai/gpt-image-2.5/sunburst/edit', {
        operation: 'image-edit',
        resolution: '2K',
        aspectRatio: '16:9',
        references: ['https://media.example.com/one.png', 'https://media.example.com/two.png'].map(
          (url) => ({ type: 'image', asset: { url } }),
        ),
      }),
    );
  });
  it('refuses over-limit Seedream inputs instead of letting upstream discard earlier images', async () => {
    let calls = 0;
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(
      adapter.submit(
        context('fal', 'bytedance/seedream/v5/pro/edit', {
          operation: 'image-edit',
          resolution: '1K',
          references: Array.from(
            { length: 11 },
            (_, i) => `https://media.example.com/${i}.png`,
          ).map((url) => ({ type: 'image', asset: { url } })),
        }),
      ),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(calls).toBe(0);
  });
  it('uses Nano Banana resolution fields and reads exactly one final image', async () => {
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture' },
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toMatchObject({
            resolution: '4K',
            aspect_ratio: '1:1',
            thinking_level: 'medium',
            limit_generations: true,
            enable_web_search: false,
          });
          return Response.json({ request_id: 'banana' });
        }
        if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ images: [{ url: 'https://media.example.com/result.png' }] });
      },
    });
    const ctx = context('fal', 'google/nano-banana-2.1', {
      operation: 'text-to-image',
      resolution: '4K',
    });
    await adapter.submit(ctx);
    expect(await adapter.poll({ ...ctx, upstreamId: 'banana' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ mediaType: 'image/png' }],
    });
  });
});
describe('BytePlus Seedance complete family protocol (no network)', () => {
  it('dispatches every qualified Singapore variant through the durable video branch', async () => {
    const { createBytePlusAdapter } = await import('../packages/engine/src/byteplus.js');
    for (const model of [
      'dreamina-seedance-2-5-260628',
      'dreamina-seedance-2-0-260128',
      'dreamina-seedance-2-0-fast-260128',
      'dreamina-seedance-2-0-mini-260615',
    ]) {
      const adapter = createBytePlusAdapter({
        env: { BYTEPLUS_API_KEY: 'fixture' },
        fetch: async (url, init) => {
          expect(String(url)).toBe(
            'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
          );
          expect(JSON.parse(String(init?.body))).toMatchObject({
            model,
            content: [{ type: 'text' }],
            resolution: '720p',
            duration: 5,
            ratio: '16:9',
            generate_audio: true,
            watermark: true,
          });
          return Response.json({ id: 'byteplus-task' });
        },
      });
      const ctx = context('byteplus', model, { resolution: '720p' });
      ctx.deployment.id = 'byteplus-modelark-ap-southeast-1';
      ctx.deployment.endpointRegion = 'ap-southeast-1';
      expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'byteplus-task' });
    }
  });
  it('sets explicit reference task type for2.5 and preserves first/last frame inputs', async () => {
    const { createBytePlusAdapter } = await import('../packages/engine/src/byteplus.js');
    const bodies: Record<string, unknown>[] = [];
    const adapter = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ id: 'task' });
      },
    });
    const ctx = context('byteplus', 'dreamina-seedance-2-5-260628', {
      resolution: '720p',
      operation: 'reference-to-video',
      references: ['https://media.example.com/one.png'].map((url) => ({
        type: 'image',
        asset: { url },
      })),
    });
    ctx.deployment.id = 'byteplus-modelark-ap-southeast-1';
    ctx.deployment.endpointRegion = 'ap-southeast-1';
    await adapter.submit(ctx);
    expect(bodies[0]).toMatchObject({
      omni_reference_task_type: 'reference',
      content: [
        { type: 'text' },
        {
          type: 'image_url',
          image_url: { url: 'https://media.example.com/one.png' },
          role: 'reference_image',
        },
      ],
    });
    await adapter.submit({
      ...ctx,
      input: {
        ...ctx.input,
        operation: 'image-to-video',
        input: {
          ...ctx.input.input,
          references: [],
          aspectRatio: 'source',
          firstFrame: { url: 'https://media.example.com/one.png' },
          lastFrame: { url: 'https://media.example.com/two.png' },
        },
      },
    });
    expect(bodies[1]).toMatchObject({
      ratio: 'adaptive',
      content: [{ type: 'text' }, { role: 'first_frame' }, { role: 'last_frame' }],
    });
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          operation: 'image-to-video',
          input: {
            ...ctx.input.input,
            aspectRatio: '16:9',
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
  });
  it('returns the task asset and holds billing when token-based cost has not been qualified', async () => {
    const { createBytePlusAdapter } = await import('../packages/engine/src/byteplus.js');
    const adapter = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          id: 'task',
          status: 'succeeded',
          content: { video_url: 'https://media.example.com/seedance.mp4' },
          usage: { completion_tokens: 108900 },
        }),
    });
    const ctx = context('byteplus', 'dreamina-seedance-2-0-mini-260615', { resolution: '720p' });
    expect(await adapter.poll({ ...ctx, upstreamId: 'task' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ url: 'https://media.example.com/seedance.mp4' }],
    });
  });
});
describe('Alibaba Qwen exact model and region protocol (no network)', () => {
  it('uses the image-generation asynchronous endpoint and preserves edit reference order', async () => {
    const { createAlibabaMediaAdapter } = await import('../packages/engine/src/providers.js');
    const adapter = createAlibabaMediaAdapter({
      env: {
        ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture',
        ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID: 'workspace',
      },
      fetch: async (url, init) => {
        expect(String(url)).toBe(
          'https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
        );
        expect(new Headers(init?.headers).get('X-DashScope-Async')).toBe('enable');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'qwen-image-3.0-pro',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  { image: 'https://media.example.com/one.png' },
                  { image: 'https://media.example.com/two.png' },
                  { text: 'A ceramic cup in morning light.' },
                ],
              },
            ],
          },
          parameters: { size: '2048*1152', n: 1 },
        });
        return Response.json({ output: { task_id: 'qwen-task' } });
      },
    });
    const ctx = context('alibaba', 'qwen-image-3.0-pro', {
      operation: 'image-edit',
      resolution: '2K',
      aspectRatio: '16:9',
      references: ['https://media.example.com/one.png', 'https://media.example.com/two.png'].map(
        (url) => ({ type: 'image', asset: { url } }),
      ),
    });
    ctx.deployment.id = 'alibaba-model-studio-ap-southeast-1';
    ctx.deployment.endpointRegion = 'ap-southeast-1';
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'qwen-task' });
    await expect(
      adapter.submit({
        ...ctx,
        deployment: {
          ...ctx.deployment,
          id: 'alibaba-model-studio-eu-central-1',
          endpointRegion: 'eu-central-1',
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
  });
  it('keeps upstream billing unknown when a terminal response reports only output dimensions', async () => {
    const { createQwenImageAdapter } = await import('../packages/engine/src/qwen.js');
    const adapter = createQwenImageAdapter({
      env: {
        ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture',
        ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID: 'workspace',
      },
      fetch: async () =>
        Response.json({
          output: {
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [{ image: 'https://media.example.com/qwen.png' }] } }],
          },
          usage: { output_width: 2048, output_height: 1152, output_image_count: 1 },
        }),
    });
    const ctx = context('alibaba', 'qwen-image-3.0-pro', {
      operation: 'text-to-image',
      resolution: '2K',
    });
    ctx.deployment.id = 'alibaba-model-studio-ap-southeast-1';
    ctx.deployment.endpointRegion = 'ap-southeast-1';
    expect(await adapter.poll({ ...ctx, upstreamId: 'id' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ mediaType: 'image/png' }],
    });
    await expect(
      adapter.submit({
        ...ctx,
        input: {
          ...ctx.input,
          operation: 'image-edit',
          input: {
            ...ctx.input.input,
            references: Array.from(
              { length: 4 },
              (_, i) => `https://media.example.com/${i}.png`,
            ).map((url) => ({ type: 'image', asset: { url } })),
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
  });
});
