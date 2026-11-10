import { describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import type {
  GenerateInput,
  GenerationArguments,
  Operation,
  OutputAsset,
} from '@media-router/contracts';
import type { AdapterContext } from '../packages/engine/src/adapters.js';
import type { DeliverySource } from '../packages/engine/src/delivery.js';
import { createOpenAIAdapter } from '../packages/engine/src/openai.js';
import { createGoogleImageAdapter } from '../packages/engine/src/google.js';
import { createGoogleVideoAdapter } from '../packages/engine/src/google-video.js';
import { createReplicateAdapter } from '../packages/engine/src/replicate.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex');
const owned: OutputAsset = {
  url: 'https://owned.example.com/signed-output',
  storageKey: 'outputs/delivery-job/0.png',
  mediaType: 'image/png',
  fidelity: 'unverified',
};
function context(
  provider: string,
  upstream: string,
  operation: Operation,
  args: GenerationArguments = {},
): AdapterContext {
  const route = catalog.routes.find(
    (entry) => entry.adapter === provider && entry.upstreamModelId === upstream,
  )!;
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
  return {
    jobId: 'delivery-job',
    workspaceId: 'private-workspace',
    route,
    deployment,
    input: {
      modelId: route.modelId,
      operation,
      input: {
        prompt: 'Synthetic private fixture.',
        resolution: operation.includes('video') ? '720p' : '1K',
        ...(operation.includes('video') ? { duration: 5, aspectRatio: '16:9' } : {}),
        ...args,
      },
    } satisfies GenerateInput,
  };
}
function googleResponse(type: 'image' | 'video', bytes: Buffer) {
  return Response.json({
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [
          {
            type,
            mime_type: type === 'image' ? 'image/png' : 'video/mp4',
            data: bytes.toString('base64'),
          },
        ],
      },
    ],
  });
}

describe('adapter private delivery checkpoint', () => {
  it('captures all OpenAI inline slots together before the first PUT and never exposes inline data', async () => {
    const storeOutput = vi.fn(async () => {
      throw new Error('legacy storage must not run');
    });
    const fetch = vi.fn(async () =>
      Response.json({
        data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }],
      }),
    );
    const captureOutputs = vi.fn(
      async (ctx: AdapterContext & { upstreamId?: string }, sources: DeliverySource[]) => {
        expect(ctx).toMatchObject({ jobId: 'delivery-job', workspaceId: 'private-workspace' });
        expect(ctx.upstreamId).toBeUndefined();
        expect(sources).toHaveLength(2);
        expect(sources).toEqual([
          { kind: 'inline', bytes: png, mediaType: 'image/png' },
          { kind: 'inline', bytes: png, mediaType: 'image/png' },
        ]);
        return [owned, { ...owned, storageKey: 'outputs/delivery-job/1.png' }];
      },
    );
    const adapter = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'synthetic-key' },
      fetch,
      storeOutput,
      captureOutputs,
    });
    const result = await adapter.submit(
      context('openai', 'gpt-image-2', 'text-to-image', { count: 2 }),
    );
    expect(result).toMatchObject({
      immediateResult: {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [owned, { storageKey: 'outputs/delivery-job/1.png' }],
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(captureOutputs).toHaveBeenCalledOnce();
    expect(storeOutput).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(png.toString('base64'));
    expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });

  it('keeps known OpenAI success and honest inline-loss uncertainty when the checkpoint fails', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: [{ b64_json: png.toString('base64') }] }),
    );
    const adapter = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'synthetic-key' },
      fetch,
      captureOutputs: async () => {
        throw new Error('https://private.provider/secret-output synthetic-key');
      },
    });
    const ctx = context('openai', 'gpt-image-2', 'text-to-image');
    expect(adapter.isConfigured(ctx.route, ctx.deployment)).toBe(true);
    const result = await adapter.submit(ctx);
    expect(result).toMatchObject({
      immediateResult: {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [],
        error: expect.stringContaining('may be unrecoverable'),
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private.provider');
    expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });

  it.each([
    ['image', 'gemini-nano-banana-2.1', 'text-to-image', png, createGoogleImageAdapter],
    ['video', 'gemini-omni-1.1-flash', 'text-to-video', mp4, createGoogleVideoAdapter],
  ] as const)(
    'captures Google %s inline bytes with the original interaction identity',
    async (kind, model, operation, bytes, createAdapter) => {
      const captured: DeliverySource[][] = [];
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({ id: 'original-interaction' })
          : googleResponse(kind, bytes),
      );
      const adapter = createAdapter({
        env: { GEMINI_API_KEY: 'synthetic-key' },
        fetch,
        captureOutputs: async (ctx, sources) => {
          expect(ctx.upstreamId).toBe('original-interaction');
          expect(sources).toEqual([
            { kind: 'inline', bytes, mediaType: kind === 'image' ? 'image/png' : 'video/mp4' },
          ]);
          captured.push(sources);
          if (captured.length === 1) throw new Error('storage temporarily unavailable');
          return [{ ...owned, mediaType: kind === 'image' ? 'image/png' : 'video/mp4' }];
        },
      });
      const ctx = context('google', model, operation);
      expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'original-interaction' });
      expect(await adapter.poll({ ...ctx, upstreamId: 'original-interaction' })).toMatchObject({
        status: 'succeeded',
        outputs: [],
        error: expect.stringContaining('Recover the same job'),
      });
      expect(await adapter.poll({ ...ctx, upstreamId: 'original-interaction' })).toMatchObject({
        status: 'succeeded',
        outputs: [{ url: owned.url }],
      });
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(fetch.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2);
    },
  );

  it('captures a host-checked Replicate URL before any authenticated download or PUT', async () => {
    const readAsset = vi.fn(async () => {
      throw new Error('legacy downloader must not run');
    });
    const captureOutputs = vi.fn(
      async (ctx: AdapterContext & { upstreamId?: string }, sources: DeliverySource[]) => {
        expect(ctx.upstreamId).toBe('original-prediction');
        expect(sources).toEqual([
          {
            kind: 'url',
            url: 'https://media.replicate.delivery/private.mp4',
            mediaType: 'video/mp4',
            refreshable: true,
          },
        ]);
        expect(JSON.stringify(sources)).not.toContain('synthetic-key');
        return [{ ...owned, mediaType: 'video/mp4' as const }];
      },
    );
    const adapter = createReplicateAdapter({
      env: { REPLICATE_API_TOKEN: 'synthetic-key' },
      readAsset,
      captureOutputs,
      fetch: async () =>
        Response.json({
          status: 'succeeded',
          output: 'https://media.replicate.delivery/private.mp4',
        }),
    });
    const result = await adapter.poll({
      ...context('replicate', 'bytedance/seedance-2.5', 'text-to-video'),
      upstreamId: 'original-prediction',
    });
    expect(result).toMatchObject({ status: 'succeeded', outputs: [{ url: owned.url }] });
    expect(readAsset).not.toHaveBeenCalled();
    expect(captureOutputs).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('replicate.delivery');
  });

  it('rejects arbitrary Replicate hosts before checkpointing a recovery source', async () => {
    const captureOutputs = vi.fn(async () => [owned]);
    const adapter = createReplicateAdapter({
      env: { REPLICATE_API_TOKEN: 'synthetic-key' },
      captureOutputs,
      fetch: async () =>
        Response.json({ status: 'succeeded', output: 'https://attacker.example.com/private.mp4' }),
    });
    await expect(
      adapter.poll({
        ...context('replicate', 'bytedance/seedance-2.5', 'text-to-video'),
        upstreamId: 'original-prediction',
      }),
    ).rejects.toThrow('Credentials were not sent');
    expect(captureOutputs).not.toHaveBeenCalled();
  });
});
