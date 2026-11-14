import { describe, expect, it, vi } from 'vitest';
import { catalog, quote } from '@media-router/catalog';
import {
  GenerationValidationError,
  parseGenerationRequest,
} from '@media-router/contracts/generation';
import type { GenerateInput, GenerationArguments, Operation } from '@media-router/contracts';
import type { AdapterContext } from '../packages/engine/src/adapters.js';
import { createOpenAIAdapter, observedOpenAICostMicros } from '../packages/engine/src/openai.js';
import { createGoogleMediaAdapter } from '../packages/engine/src/providers.js';
import {
  observedGoogleImageCostMicros,
  observedGoogleVideoCostMicros,
} from '../packages/engine/src/google-usage.js';
import {
  createMiniMaxImageAdapter,
  observedMiniMaxImageCostMicros,
} from '../packages/engine/src/minimax-image.js';
import { createFalAdapter } from '../packages/engine/src/fal.js';
import { createRunwayAdapter } from '../packages/engine/src/runway.js';
import { createPikaAdapter } from '../packages/engine/src/pika.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

function findRoute(key: string) {
  const route = catalog.routes.find(
    (entry) => entry.id === key || `${entry.deploymentId}/${entry.upstreamModelId}` === key,
  );
  if (!route) throw new Error(`Missing route ${key}`);
  return route;
}

function routeEstimate(input: GenerateInput): number | null {
  const result = quote(input, {
    executableRouteIds: input.routeId ? [input.routeId] : [],
  });
  return result.reservationMicros;
}

function ctx(routeKey: string, operation: Operation, input: GenerationArguments): AdapterContext {
  const route = findRoute(routeKey);
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
  return {
    jobId: 'job-2026-11',
    workspaceId: 'ws-2026-11',
    route,
    deployment,
    input: {
      modelId: route.modelId,
      operation,
      input,
    } satisfies GenerateInput,
  };
}

describe('November 2026 frontier models & provider routes', () => {
  it('catalogs 49 exact variants, 12 companies, 19 deployments and 182 documented/live routes without merging derivatives', () => {
    expect(catalog.models).toHaveLength(49);
    expect(catalog.providers).toHaveLength(12);
    expect(catalog.deployments).toHaveLength(19);
    expect(catalog.routes).toHaveLength(182);

    for (const distinctPair of [
      ['openai/gpt-image-2.6-sunburst', 'openai/gpt-image-2.6-flare'],
      ['openai/gpt-image-2.6-sunburst', 'openai/gpt-image-2.5-sunburst'],
      ['google/gemini-omni-1.2-flash', 'google/gemini-omni-1.1-flash'],
      ['google/nano-banana-pro', 'google/nano-banana-2'],
      ['google/nano-banana-2', 'google/nano-banana-2-lite'],
      ['minimax/h3-image', 'minimax/h3-image-highspeed'],
      ['kling/kling-4.0', 'kling/kling-4.0-flash'],
      ['bfl/flux-3-video', 'fal/flux-3-max-video'],
      ['bfl/flux-3-image', 'bfl/flux-3-klein'],
    ] as const) {
      expect(catalog.models.some((m) => m.id === distinctPair[0])).toBe(true);
      expect(catalog.models.some((m) => m.id === distinctPair[1])).toBe(true);
    }
    expect(catalog.models.find((m) => m.id === 'bfl/flux-3-klein')?.openness).toBe('open-weights');
  });

  it('supports GPT Image 2.6 complexity on OpenAI Direct and reasoning_effort on fal with higher 2.6 low/medium token ceilings', async () => {
    const r25 = findRoute('openai-undisclosed/gpt-image-2.5-sunburst');
    const r26 = findRoute('openai-undisclosed/gpt-image-2.6-sunburst');
    const q25Low = routeEstimate({
      modelId: 'openai/gpt-image-2.5-sunburst',
      operation: 'text-to-image',
      routeId: r25.id,
      input: { prompt: 'Studio portrait', resolution: '1K', quality: 'low' },
    });
    const q26Low = routeEstimate({
      modelId: 'openai/gpt-image-2.6-sunburst',
      operation: 'text-to-image',
      routeId: r26.id,
      input: { prompt: 'Studio portrait', resolution: '1K', quality: 'low', complexity: 'high' },
    });
    expect(q26Low).toBeGreaterThan(q25Low!);

    let capturedOpenAIBody: Record<string, unknown> | undefined;
    const openai = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'sk-test' },
      captureOutputs: async () => [
        {
          url: 'https://owned.example/0.png',
          storageKey: 'outputs/0.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
        },
      ],
      fetch: vi.fn(async (_url, init) => {
        capturedOpenAIBody = JSON.parse(String(init?.body));
        return Response.json({
          data: [{ b64_json: png.toString('base64') }],
          usage: {
            input_tokens: 100,
            output_tokens: 1536,
            total_tokens: 1636,
            input_tokens_details: { text_tokens: 100, image_tokens: 0 },
          },
        });
      }),
    });
    const submitted = await openai.submit(
      ctx('openai-undisclosed/gpt-image-2.6-sunburst', 'text-to-image', {
        prompt: 'Blueprint poster',
        resolution: '1K',
        quality: 'medium',
        complexity: 'low',
      }),
    );
    expect(capturedOpenAIBody).toMatchObject({
      model: 'gpt-image-2.6-sunburst',
      complexity: 'low',
      quality: 'medium',
    });
    expect(submitted.immediateResult).toMatchObject({
      status: 'succeeded',
      billedCostMicros: 46_580,
    });
    // Fail closed if svg_usage is ever present on a response.
    expect(
      observedOpenAICostMicros({
        svg_usage: { output_tokens: 500 },
        usage: {
          input_tokens: 100,
          output_tokens: 1536,
          total_tokens: 1636,
          input_tokens_details: { text_tokens: 100, image_tokens: 0 },
        },
      }),
    ).toBeNull();

    let capturedFalBody: Record<string, unknown> | undefined;
    const fal = createFalAdapter({
      env: { FAL_KEY: 'fal-test' },
      fetch: vi.fn(async (_url, init) => {
        capturedFalBody = JSON.parse(String(init?.body));
        return Response.json({ request_id: 'fal-gpt26-1' });
      }),
    });
    await fal.submit(
      ctx('fal-undisclosed/openai/gpt-image-2.6/flare/text-to-image', 'text-to-image', {
        prompt: 'Editorial layout',
        resolution: '2K',
        aspectRatio: '16:9',
        quality: 'high',
        complexity: 'medium',
      }),
    );
    expect(capturedFalBody).toMatchObject({
      image_size: { width: 2048, height: 1152 },
      quality: 'high',
      reasoning_effort: 'medium',
    });
  });

  it('supports Gemini Omni 1.2 Flash 15s generation, 10s extend/lastFrame cap, $12/1M settlement and fal v1.2 bounded quotes', async () => {
    const parsed15 = parseGenerationRequest({
      modelId: 'google/gemini-omni-1.2-flash',
      operation: 'text-to-video',
      input: { prompt: 'Ocean sunset', resolution: '720p', duration: 15, aspectRatio: '16:9' },
    });
    expect(parsed15.input.duration).toBe(15);

    expect(() =>
      parseGenerationRequest({
        modelId: 'google/gemini-omni-1.2-flash',
        operation: 'video-extend',
        input: {
          prompt: 'Continue panning',
          sourceVideo: { url: 'https://example.com/clip.mp4' },
          resolution: '720p',
          duration: 12,
        },
      }),
    ).toThrow(GenerationValidationError);

    // $12/1M on 1.2 vs $17.50/1M on 1.1
    const sampleBody = {
      usage: {
        total_input_tokens: 200,
        total_output_tokens: 60_000,
        total_thought_tokens: 500,
        total_tokens: 60_700,
        output_tokens_by_modality: [
          { modality: 'video', tokens: 58_000 },
          { modality: 'text', tokens: 2_000 },
        ],
      },
    };
    expect(observedGoogleVideoCostMicros(sampleBody, 'gemini-omni-1.2-flash')).toBe(718_800);
    expect(observedGoogleVideoCostMicros(sampleBody, 'gemini-omni-1.1-flash')).toBe(1_037_800);

    const falOmniQuote = routeEstimate({
      modelId: 'google/gemini-omni-1.2-flash',
      operation: 'text-to-video',
      routeId: 'fal-undisclosed/google/gemini-omni-flash/v1.2/text-to-video',
      input: { prompt: 'Aerial mountains', resolution: '720p', duration: 12, aspectRatio: '16:9' },
    });
    expect(falOmniQuote).toBeGreaterThan(0);

    let capturedExtendPayload: Record<string, unknown> | undefined;
    const fal = createFalAdapter({
      env: { FAL_KEY: 'fal-test' },
      fetch: vi.fn(async (_url, init) => {
        capturedExtendPayload = JSON.parse(String(init?.body));
        return Response.json({ request_id: 'fal-omni12-ext' });
      }),
    });
    await fal.submit(
      ctx('fal-undisclosed/google/gemini-omni-flash/v1.2/extend', 'video-extend', {
        prompt: 'Reveal the skyline',
        sourceVideo: { url: 'https://example.com/in.mp4' },
        resolution: '1080p',
        duration: 8,
      }),
    );
    expect(capturedExtendPayload).toEqual({
      prompt: 'Reveal the skyline',
      video_url: 'https://example.com/in.mp4',
      duration: 8,
      resolution: '1080p',
    });
  });

  it('supports Nano Banana Pro, Nano Banana 2 and Nano Banana 2 Lite across Google Direct and fal', async () => {
    const google = createGoogleMediaAdapter({
      env: { GEMINI_API_KEY: 'gem-test' },
      captureOutputs: async () => [],
    });
    // Nano Banana Pro allows only 'high' thinkingLevel
    expect(
      google.preflight!(
        ctx('google-undisclosed/gemini-3-pro-image', 'text-to-image', {
          prompt: 'Watch macro',
          resolution: '2K',
          thinkingLevel: 'minimal',
        }),
      ),
    ).toContain('thinkingLevel');
    expect(
      google.preflight!(
        ctx('google-undisclosed/gemini-3-pro-image', 'text-to-image', {
          prompt: 'Watch macro',
          resolution: '2K',
          thinkingLevel: 'high',
        }),
      ),
    ).toBeNull();
    // Nano Banana 2 Lite forbids search grounding
    expect(
      google.preflight!(
        ctx('google-undisclosed/gemini-3.1-flash-lite-image', 'text-to-image', {
          prompt: 'Sticker icon',
          resolution: '1K',
          grounding: true,
        }),
      ),
    ).toBeTruthy();

    const usageBody = {
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 1120,
        total_thought_tokens: 200,
        total_tokens: 1420,
        input_tokens_by_modality: [{ modality: 'text', tokens: 100 }],
        output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }],
      },
    };
    expect(observedGoogleImageCostMicros(usageBody, 'gemini-3-pro-image')).toBe(137_000);
    expect(observedGoogleImageCostMicros(usageBody, 'gemini-3.1-flash-image')).toBe(67_850);
    expect(observedGoogleImageCostMicros(usageBody, 'gemini-3.1-flash-lite-image')).toBe(33_925);

    const proFalQuote = routeEstimate({
      modelId: 'google/nano-banana-pro',
      operation: 'text-to-image',
      routeId: 'fal-undisclosed/fal-ai/nano-banana-pro',
      input: { prompt: 'Product hero', resolution: '1K' },
    });
    expect(proFalQuote).toBe(150_000);

    const nb2FalQuote = routeEstimate({
      modelId: 'google/nano-banana-2',
      operation: 'text-to-image',
      routeId: 'fal-undisclosed/fal-ai/nano-banana-2',
      input: { prompt: 'Fast concept', resolution: '1K' },
    });
    expect(nb2FalQuote).toBe(80_000);

    let liteFalPayload: Record<string, unknown> | undefined;
    const fal = createFalAdapter({
      env: { FAL_KEY: 'fal-test' },
      fetch: vi.fn(async (_url, init) => {
        liteFalPayload = JSON.parse(String(init?.body));
        return Response.json({ request_id: 'fal-nblite-1' });
      }),
    });
    await fal.submit(
      ctx('fal-undisclosed/google/nano-banana-2-lite', 'text-to-image', {
        prompt: 'Minimal badge',
        resolution: '1K',
        aspectRatio: '4:1',
        thinkingLevel: 'minimal',
      }),
    );
    expect(liteFalPayload).toEqual({
      prompt: 'Minimal badge',
      num_images: 1,
      output_format: 'png',
      sync_mode: false,
      aspect_ratio: '4:1',
      thinking_level: 'minimal',
      limit_generations: true,
    });
  });

  it('enforces MiniMax H3 Image & Highspeed wire mutual exclusion, disable_prompt_enhanced rules, 600s synchronous submit and token settlement', async () => {
    const rStd = findRoute('minimax-undisclosed/MiniMax-H3-Image');
    const rHs = findRoute('minimax-undisclosed/MiniMax-H3-Image-Highspeed');
    const qStd = routeEstimate({
      modelId: 'minimax/h3-image',
      operation: 'text-to-image',
      routeId: rStd.id,
      input: { prompt: 'Isometric room', resolution: '2K', aspectRatio: '16:9' },
    });
    const qHs = routeEstimate({
      modelId: 'minimax/h3-image-highspeed',
      operation: 'text-to-image',
      routeId: rHs.id,
      input: { prompt: 'Isometric room', resolution: '2K', aspectRatio: '16:9' },
    });
    expect(qStd).toBeGreaterThan(0);
    expect(qHs).toBeGreaterThan(qStd!);

    const bodies: Record<string, unknown>[] = [];
    const minimax = createMiniMaxImageAdapter({
      env: { MINIMAX_API_KEY: 'mm-test' },
      fetch: vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          data: [{ url: 'https://cdn.minimax.io/out/0.png' }],
          usage: {
            generated_images: 1,
            input_tokens: 1500,
            output_tokens: 5000,
            total_tokens: 6500,
            input_tokens_details: { text_tokens: 1500, image_tokens: 0 },
            output_tokens_details: { image_tokens: 5000 },
          },
        });
      }),
    });

    // Rejects disabling prompt enhancement when aspect_ratio is omitted/auto without custom size
    expect(
      minimax.preflight!(
        ctx('minimax-undisclosed/MiniMax-H3-Image', 'text-to-image', {
          prompt: 'Literal prompt',
          resolution: '2K',
          promptExpansion: false,
        }),
      ),
    ).toContain('explicit X:Y aspect ratio');

    // Tier mode sends size: 'auto', area, aspect_ratio and disable_prompt_enhanced
    const tierRes = await minimax.submit(
      ctx('minimax-undisclosed/MiniMax-H3-Image', 'text-to-image', {
        prompt: 'Literal prompt',
        resolution: '2K',
        aspectRatio: '16:9',
        promptExpansion: false,
      }),
    );
    expect(bodies[0]).toEqual({
      model: 'MiniMax-H3-Image',
      prompt: 'Literal prompt',
      n: 1,
      output_format: 'png',
      response_format: 'url',
      size: 'auto',
      area: '2K',
      aspect_ratio: '16:9',
      disable_prompt_enhanced: true,
    });
    // 1500 * $2.30/1M + 5000 * $3.80/1M = $0.00345 + $0.019 = 22,450 micros
    expect(tierRes.immediateResult).toMatchObject({
      status: 'succeeded',
      billedCostMicros: 22_450,
    });
    expect(
      observedMiniMaxImageCostMicros(
        {
          usage: {
            generated_images: 1,
            input_tokens: 1500,
            output_tokens: 5000,
            total_tokens: 6500,
            input_tokens_details: { text_tokens: 500, image_tokens: 1000 },
            output_tokens_details: { image_tokens: 5000 },
          },
        },
        'MiniMax-H3-Image-Highspeed',
        1,
      ),
    ).toBe(42_150);

    // Custom pixel size omits BOTH area and aspect_ratio, and image-edit omits disable_prompt_enhanced
    await minimax.submit(
      ctx('minimax-undisclosed/MiniMax-H3-Image-Highspeed', 'image-edit', {
        prompt: 'Relight at dusk',
        size: { width: 1600, height: 1200 },
        references: [{ type: 'image', asset: { url: 'https://example.com/src.png' } }],
      }),
    );
    expect(bodies[1]).toEqual({
      model: 'MiniMax-H3-Image-Highspeed',
      prompt: 'Relight at dusk',
      n: 1,
      output_format: 'png',
      response_format: 'url',
      size: '1600x1200',
      images: [{ image_url: 'https://example.com/src.png' }],
    });
    expect(bodies[1]).not.toHaveProperty('area');
    expect(bodies[1]).not.toHaveProperty('aspect_ratio');
    expect(bodies[1]).not.toHaveProperty('disable_prompt_enhanced');
  });

  it('wires Kling 4.0 fal, Kling 4.0 Flash (fal + Runway), FLUX 3 suite, Alibaba HappyHorse 1.1 and Pika H3 Flex I2V', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fal = createFalAdapter({
      env: { FAL_KEY: 'fal-test' },
      fetch: vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ request_id: `req-${requests.length}` });
      }),
    });

    // 1. Kling 4.0 fal reference-to-video with elements and multi-shot
    await fal.submit(
      ctx('fal-undisclosed/kling/v4/reference-to-video', 'reference-to-video', {
        prompt: '@Element1 walks through neon rain',
        resolution: '1080p',
        duration: 8,
        aspectRatio: '21:9',
        elements: [
          {
            id: 'hero',
            images: [
              { url: 'https://example.com/front.png' },
              { url: 'https://example.com/side.png' },
            ],
          },
        ],
        shots: [
          { prompt: 'Wide street shot', duration: 4 },
          { prompt: 'Close-up reflection', duration: 4 },
        ],
      }),
    );
    expect(requests[0]).toEqual({
      url: 'https://queue.fal.run/kling/v4/reference-to-video',
      body: {
        prompt: '@Element1 walks through neon rain',
        resolution: '1080p',
        duration: 8,
        aspect_ratio: '21:9',
        multi_prompt: [
          { prompt: 'Wide street shot', duration: 4 },
          { prompt: 'Close-up reflection', duration: 4 },
        ],
        elements: [
          {
            frontal_image_url: 'https://example.com/front.png',
            reference_image_urls: ['https://example.com/side.png'],
          },
        ],
      },
    });

    // 2. Kling 4.0 Flash on Runway (720p, 3..20s, model: 'kling_4_flash')
    let runwayBody: Record<string, unknown> | undefined;
    const runway = createRunwayAdapter({
      env: { RUNWAYML_API_SECRET: 'rw-test' },
      fetch: vi.fn(async (_url, init) => {
        runwayBody = JSON.parse(String(init?.body));
        return Response.json({ id: 'rw-flash-1' });
      }),
    });
    expect(
      runway.preflight!(
        ctx('runway-undisclosed/kling_4_flash', 'text-to-video', {
          prompt: 'Fast dash',
          resolution: '1080p',
          duration: 5,
        }),
      ),
    ).toContain('720p only');
    await runway.submit(
      ctx('runway-undisclosed/kling_4_flash', 'text-to-video', {
        prompt: 'Fast dash',
        resolution: '720p',
        duration: 10,
      }),
    );
    expect(runwayBody).toMatchObject({
      model: 'kling_4_flash',
      duration: 10,
      ratio: '1280:720',
    });

    // 3. FLUX 3 Image (JPEG default, no num_images) & FLUX 3 Max Video (2K uppercase, reasoning_level)
    await fal.submit(
      ctx('fal-undisclosed/blackforestlabs/flux-3/text-to-image', 'text-to-image', {
        prompt: 'Architectural courtyard',
        resolution: '768sq',
        aspectRatio: '7:5',
      }),
    );
    expect(requests[1]?.body).toEqual({
      prompt: 'Architectural courtyard',
      resolution: '768sq',
      aspect_ratio: '7:5',
      output_format: 'jpeg',
      enable_prompt_expansion: false,
      sync_mode: false,
    });
    expect(requests[1]?.body).not.toHaveProperty('num_images');

    await fal.submit(
      ctx('fal-undisclosed/blackforestlabs/flux-3-max/image-to-video', 'image-to-video', {
        prompt: 'Camera dolly forward',
        firstFrame: { url: 'https://example.com/start.png' },
        lastFrame: { url: 'https://example.com/end.png' },
        resolution: '2K',
        duration: 6,
        complexity: 'low',
        audio: false,
      }),
    );
    expect(requests[2]?.body).toEqual({
      prompt: 'Camera dolly forward',
      resolution: '2K',
      duration: 6,
      aspect_ratio: 'auto',
      generate_audio: false,
      reasoning_level: 'low',
      image_url: 'https://example.com/start.png',
      end_image_url: 'https://example.com/end.png',
    });

    // 4. Alibaba HappyHorse 1.1 quote ($0.14/s * 5s = $0.70) & fal submission
    const hhQuote = routeEstimate({
      modelId: 'alibaba/happy-horse-1.1',
      operation: 'text-to-video',
      routeId: 'fal-undisclosed/alibaba/happy-horse/v1.1/text-to-video',
      input: { prompt: 'Lantern festival', resolution: '1080p', duration: 5, aspectRatio: '9:21' },
    });
    expect(hhQuote).toBe(700_000);
    await fal.submit(
      ctx('fal-undisclosed/alibaba/happy-horse/v1.1/text-to-video', 'text-to-video', {
        prompt: 'Lantern festival',
        resolution: '1080p',
        duration: 5,
        aspectRatio: '9:21',
      }),
    );
    expect(requests[3]?.body).toEqual({
      prompt: 'Lantern festival',
      resolution: '1080p',
      duration: 5,
      aspect_ratio: '9:21',
      enable_safety_checker: true,
    });

    // 5. Pika H3 Flex image-to-video ($0.02/s * 5s = $0.10 at 768p)
    const pikaRoute = findRoute('pika-undisclosed/pika-h3-flex-image-to-video');
    const pikaQuote = routeEstimate({
      modelId: 'pika/h3-flex',
      operation: 'image-to-video',
      routeId: pikaRoute.id,
      input: {
        prompt: 'Subtle breeze',
        firstFrame: { url: 'https://example.com/frame.png' },
        resolution: '768p',
        duration: 5,
      },
    });
    expect(pikaQuote).toBe(100_000);
    let pikaUrl = '';
    const pika = createPikaAdapter({
      env: { PIKA_API_KEY: 'pk-test' },
      fetch: vi.fn(async (url) => {
        pikaUrl = String(url);
        return Response.json({ id: 'pk-i2v-1' });
      }),
    });
    await pika.submit(
      ctx(pikaRoute.id, 'image-to-video', {
        prompt: 'Subtle breeze',
        firstFrame: { url: 'https://example.com/frame.png' },
        resolution: '768p',
        duration: 5,
        aspectRatio: 'source',
      }),
    );
    expect(pikaUrl).toContain('pika/pika-h3-flex/image-to-video');
  });
});
