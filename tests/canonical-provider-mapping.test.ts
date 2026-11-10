import { describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput, GenerationArguments } from '@media-router/contracts';
import type { AdapterContext, ProviderAdapter } from '../packages/engine/src/adapters.js';
import { createAlibabaAdapter, SubmissionRejected } from '../packages/engine/src/adapters.js';
import { createBytePlusAdapter } from '../packages/engine/src/byteplus.js';
import { createFalAdapter } from '../packages/engine/src/fal.js';
import { createReplicateAdapter } from '../packages/engine/src/replicate.js';
import { createRunwayAdapter } from '../packages/engine/src/runway.js';
import { createOpenAIAdapter } from '../packages/engine/src/openai.js';
import { createMiniMaxAdapter } from '../packages/engine/src/minimax.js';
import { parseGenerationRequest } from '@media-router/contracts/generation';

function context(
  upstreamModelId: string,
  adapter: string,
  input: GenerationArguments,
  operation: GenerateInput['operation'],
): AdapterContext {
  const route = catalog.routes.find(
    (route) => route.upstreamModelId === upstreamModelId && route.adapter === adapter,
  )!;
  if (!route) throw new Error(`Missing qualified route ${adapter}/${upstreamModelId}`);
  const deployment = catalog.deployments.find(
    (deployment) => deployment.id === route.deploymentId,
  )!;
  return {
    jobId: 'fixture',
    route,
    deployment,
    input: { modelId: route.modelId, operation, input },
  };
}
const first = 'https://assets.example.com/first.png',
  last = 'https://assets.example.com/last.png';
const imageToVideo: GenerationArguments = {
  prompt: 'A paper boat drifts across a calm lake.',
  firstFrame: { url: first },
  duration: 5,
  resolution: '720p',
  aspectRatio: 'source',
};

describe('canonical common arguments across provider protocols (no network)', () => {
  it('maps one canonical H3 Max request to both providers without changing their wire IDs', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ task_id: 'native-task', request_id: 'fal-task' });
    });
    const request = parseGenerationRequest({
      modelId: 'minimax/h3-max',
      operation: 'text-to-video',
      input: { prompt: 'A quiet lake.', resolution: '768p', duration: 5, aspectRatio: '16:9' },
    });
    const native = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'fixture' }, fetch });
    const fal = createFalAdapter({ env: { FAL_KEY: 'fixture' }, fetch });
    for (const [adapter, upstream, id] of [
      [native, 'MiniMax-H3-Max', 'minimax'],
      [fal, 'minimax/h3-max/text-to-video', 'fal'],
    ] as const) {
      const ctx = context(upstream, id, request.input, request.operation);
      expect(ctx.route.modelId).toBe(request.modelId);
      expect(adapter.preflight?.(ctx)).toBeNull();
      await adapter.submit({ ...ctx, input: request });
    }
    expect(bodies[0]).toMatchObject({
      model: 'MiniMax-H3-Max',
      duration: 5,
      resolution: '768P',
      content: [{ type: 'text', text: request.input.prompt }],
    });
    expect(bodies[1]).toMatchObject({
      prompt: request.input.prompt,
      duration: 5,
      resolution: '768P',
    });
    const expanded = parseGenerationRequest({
      ...request,
      input: { ...request.input, resolution: '1080p', duration: 5.5, seed: 8 },
    });
    await expect(
      native.submit(context('MiniMax-H3-Max', 'minimax', expanded.input, expanded.operation)),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    await fal.submit(
      context('minimax/h3-max/text-to-video', 'fal', expanded.input, expanded.operation),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodies[2]).toMatchObject({ resolution: '1080P', duration: 5.5, seed: 8 });
  });
  it('maps one image-to-video request to Seedance 2.5 native, fal and Replicate, and Kling 4', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'id', request_id: 'id' });
    });
    const adapters: [ProviderAdapter, string, string][] = [
      [
        createBytePlusAdapter({ env: { BYTEPLUS_API_KEY: 'fixture' }, fetch }),
        'dreamina-seedance-2-5-260628',
        'byteplus',
      ],
      [
        createFalAdapter({ env: { FAL_KEY: 'fixture' }, fetch }),
        'bytedance/seedance-2.5/image-to-video',
        'fal',
      ],
      [
        createReplicateAdapter({
          env: { REPLICATE_API_TOKEN: 'fixture' },
          fetch,
          storeOutput: async () => ({ url: 'https://assets.example.com/out' }),
        }),
        'bytedance/seedance-2.5',
        'replicate',
      ],
      [
        createRunwayAdapter({ env: { RUNWAYML_API_SECRET: 'fixture' }, fetch }),
        'kling_4',
        'runway',
      ],
    ];
    for (const [adapter, upstream, id] of adapters)
      await adapter.submit(context(upstream, id, structuredClone(imageToVideo), 'image-to-video'));
    expect(bodies[0]).toMatchObject({
      duration: 5,
      resolution: '720p',
      ratio: 'adaptive',
      content: [{ type: 'text' }, { image_url: { url: first }, role: 'first_frame' }],
    });
    expect(bodies[1]).toMatchObject({
      duration: '5',
      resolution: '720p',
      aspect_ratio: 'auto',
      image_url: first,
    });
    expect(bodies[2]).toMatchObject({
      input: { duration: 5, resolution: '720p', aspect_ratio: 'adaptive', image: first },
    });
    expect(bodies[3]).toMatchObject({ duration: 5, ratio: 'auto_720p', promptImage: first });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('preserves named first and last roles through all qualified Seedance 2.5 adapters', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'id', request_id: 'id' });
    });
    const args = { ...imageToVideo, lastFrame: { url: last } };
    await createBytePlusAdapter({ env: { BYTEPLUS_API_KEY: 'fixture' }, fetch }).submit(
      context('dreamina-seedance-2-5-260628', 'byteplus', args, 'image-to-video'),
    );
    await createFalAdapter({ env: { FAL_KEY: 'fixture' }, fetch }).submit(
      context('bytedance/seedance-2.5/image-to-video', 'fal', args, 'image-to-video'),
    );
    await createReplicateAdapter({
      env: { REPLICATE_API_TOKEN: 'fixture' },
      fetch,
      storeOutput: async () => ({ url: 'https://assets.example.com/out' }),
    }).submit(context('bytedance/seedance-2.5', 'replicate', args, 'image-to-video'));
    expect(bodies[0]).toMatchObject({
      content: [
        { type: 'text' },
        { image_url: { url: first }, role: 'first_frame' },
        { image_url: { url: last }, role: 'last_frame' },
      ],
    });
    expect(bodies[1]).toMatchObject({ image_url: first, end_image_url: last });
    expect(bodies[2]).toMatchObject({ input: { image: first, last_frame_image: last } });
  });
  it('maps identical GPT Image 2.5 common image controls to official and fal APIs', async () => {
    const bodies: Record<string, unknown>[] = [];
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return String(url).includes('openai.com')
        ? Response.json({ data: [{ b64_json: png.toString('base64') }] })
        : Response.json({ request_id: 'id' });
    });
    const args: GenerationArguments = {
      prompt: 'A ceramic cup.',
      resolution: '1K',
      aspectRatio: '1:1',
      quality: 'medium',
      count: 1,
      outputFormat: 'png',
    };
    const storeOutput = async () => ({ url: 'https://assets.example.com/out.png' });
    await createOpenAIAdapter({ env: { OPENAI_API_KEY: 'fixture' }, fetch, storeOutput }).submit(
      context('gpt-image-2.5-sunburst', 'openai', args, 'text-to-image'),
    );
    await createFalAdapter({ env: { FAL_KEY: 'fixture' }, fetch }).submit(
      context('openai/gpt-image-2.5/sunburst/text-to-image', 'fal', args, 'text-to-image'),
    );
    expect(bodies[0]).toMatchObject({
      prompt: args.prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    });
    expect(bodies[1]).toMatchObject({
      prompt: args.prompt,
      num_images: 1,
      image_size: { width: 1024, height: 1024 },
      quality: 'medium',
      output_format: 'png',
    });
  });
  it('uses matching exact Seedream dimensions for native and fal generation', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return String(url).includes('bytepluses.com')
        ? Response.json({
            data: [{ url: 'https://assets.example.com/out.png', size: '720x1280' }],
            usage: { generated_images: 1 },
          })
        : Response.json({ request_id: 'id' });
    });
    const args: GenerationArguments = {
      prompt: 'A ceramic cup.',
      resolution: '1K',
      aspectRatio: '9:16',
      outputFormat: 'png',
      count: 1,
    };
    await createBytePlusAdapter({ env: { BYTEPLUS_API_KEY: 'fixture' }, fetch }).submit(
      context('dola-seedream-5-0-pro-260628', 'byteplus', args, 'text-to-image'),
    );
    await createFalAdapter({ env: { FAL_KEY: 'fixture' }, fetch }).submit(
      context('bytedance/seedream/v5/pro/text-to-image', 'fal', args, 'text-to-image'),
    );
    expect(bodies[0]).toMatchObject({ size: '720x1280', output_format: 'png' });
    expect(bodies[1]).toMatchObject({
      image_size: { width: 720, height: 1280 },
      output_format: 'png',
    });
  });
  it('keeps Wan video-reference cost unresolved when usage combines input and output seconds', async () => {
    const ctx = context(
      'wan3.0-video',
      'alibaba',
      {
        prompt: 'Continue the camera motion.',
        duration: 5,
        resolution: '720p',
        references: [{ type: 'video', asset: { url: 'https://assets.example.com/ref.mp4' } }],
      },
      'reference-to-video',
    );
    ctx.route = {
      ...ctx.route,
      rates: [
        {
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 100_000,
          operation: 'reference-to-video',
        },
      ],
    };
    const region = ctx.deployment.endpointRegion.toUpperCase().replaceAll('-', '_');
    const adapter = createAlibabaAdapter({
      env: {
        [`ALIBABA_${region}_API_KEY`]: 'fixture',
        [`ALIBABA_${region}_WORKSPACE_ID`]: 'workspace',
      },
      fetch: async () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: 'https://assets.example.com/out.mp4' },
          usage: { duration: 10 },
        }),
    });
    expect(await adapter.poll({ ...ctx, upstreamId: 'id' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
    });
  });
  it('rejects an unhandled option or unresolved owned asset before paid submission', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createRunwayAdapter({ env: { RUNWAYML_API_SECRET: 'fixture' }, fetch });
    for (const input of [
      { ...imageToVideo, negativePrompt: 'blur' },
      { ...imageToVideo, firstFrame: { assetKey: 'owned-image' } },
      { ...imageToVideo, lastFrame: { url: last } },
    ]) {
      await expect(
        adapter.submit(context('kling_4', 'runway', input, 'image-to-video')),
      ).rejects.toBeInstanceOf(SubmissionRejected);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
