import { describe, expect, it } from 'vitest';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { createOpenAIAdapter, observedOpenAICostMicros } from '../packages/engine/src/openai.js';
import { createGoogleImageAdapter } from '../packages/engine/src/google.js';
import { createGoogleVideoAdapter } from '../packages/engine/src/google-video.js';
import {
  observedGoogleImageCostMicros,
  observedGoogleVideoCostMicros,
} from '../packages/engine/src/google-usage.js';
import { catalogSmokeCases } from '../scripts/live-smoke.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d00000200', 'hex');

describe('fal H3 Max and xAI Grok Imagine Video 1.5 scoped text-to-video tariffs', () => {
  it.each([
    ['480p', 250_000],
    ['768p', 400_000],
    ['1080p', 800_000],
  ] as const)('quotes fal H3 Max five-second text-to-video at %s', (resolution, expected) => {
    const routeId = 'fal-undisclosed/fal-h3-max';
    const result = quote(
      {
        modelId: 'minimax/h3-max',
        routeId,
        operation: 'text-to-video',
        input: { prompt: 'A paper lantern drifting.', duration: 5, resolution },
        routing: { fallback: false },
      },
      { executableRouteIds: [routeId] },
    );
    expect(result.selectedRouteId).toBe(routeId);
    expect(result.reservationMicros).toBe(expected);
    expect(result.candidates[0]!.notices.join(' ')).toContain('0.7 seconds longer');

    const expanded = quote(
      {
        modelId: 'minimax/h3-max',
        routeId,
        operation: 'text-to-video',
        input: {
          prompt: 'A paper lantern drifting.',
          duration: 5,
          resolution,
          promptExpansion: 'quality',
        },
        routing: { fallback: false },
      },
      { executableRouteIds: [routeId] },
    );
    expect(expanded.selectedRouteId).toBeNull();
    expect(expanded.candidates[0]!.estimatedCostMicros).toBeNull();
  });

  it.each([
    [
      'xai/grok-imagine-video-1.5',
      'xai-undisclosed/xai-grok-imagine-video-1.5',
      '480p',
      5,
      400_000,
    ],
    [
      'xai/grok-imagine-video-1.5',
      'xai-undisclosed/xai-grok-imagine-video-1.5',
      '720p',
      5,
      700_000,
    ],
    [
      'xai/grok-imagine-video-1.5',
      'xai-undisclosed/xai-grok-imagine-video-1.5',
      '1080p',
      5,
      1_250_000,
    ],
    [
      'xai/grok-imagine-video-1.5-lite',
      'xai-undisclosed/xai-grok-imagine-video-1.5-lite',
      '480p',
      5,
      100_000,
    ],
    [
      'xai/grok-imagine-video-1.5-lite',
      'xai-undisclosed/xai-grok-imagine-video-1.5-lite',
      '720p',
      5,
      150_000,
    ],
    [
      'xai/grok-imagine-video-1.5-lite',
      'xai-undisclosed/xai-grok-imagine-video-1.5-lite',
      '1080p',
      5,
      700_000,
    ],
  ] as const)(
    'quotes %s (%s) at %s for %ss and keeps media-input operations unpriced',
    (modelId, routeId, resolution, duration, expected) => {
      const textResult = quote(
        {
          modelId,
          routeId,
          operation: 'text-to-video',
          input: { prompt: 'Ocean waves at dusk.', duration, resolution },
          routing: { fallback: false },
        },
        { executableRouteIds: [routeId] },
      );
      expect(textResult.selectedRouteId).toBe(routeId);
      expect(textResult.reservationMicros).toBe(expected);

      const frameResult = quote(
        {
          modelId,
          routeId,
          operation: 'image-to-video',
          input: {
            prompt: 'Ocean waves at dusk.',
            duration,
            resolution,
            aspectRatio: 'source',
            firstFrame: { url: 'https://media.example.com/frame.png' },
          },
          routing: { fallback: false },
        },
        { executableRouteIds: [routeId] },
      );
      expect(frameResult.selectedRouteId).toBeNull();
      expect(frameResult.candidates[0]!.estimatedCostMicros).toBeNull();
    },
  );

  it('registers conservative smoke cases for fal H3 Max and xAI Video 1.5 / Lite', () => {
    const smoke = catalogSmokeCases(catalog);
    expect(smoke.find((entry) => entry.routeId === 'fal-undisclosed/fal-h3-max')).toMatchObject({
      state: 'ready',
      estimateMicros: 250_000,
      reserveMicros: 500_000,
    });
    expect(
      smoke.find((entry) => entry.routeId === 'xai-undisclosed/xai-grok-imagine-video-1.5'),
    ).toMatchObject({
      state: 'ready',
      estimateMicros: 80_000,
      reserveMicros: 160_000,
    });
    expect(
      smoke.find((entry) => entry.routeId === 'xai-undisclosed/xai-grok-imagine-video-1.5-lite'),
    ).toMatchObject({
      state: 'ready',
      estimateMicros: 20_000,
      reserveMicros: 40_000,
    });
  });
});

describe('OpenAI GPT Image 2 and 2.5 bounded max-token quotes and exact usage settlement', () => {
  it.each([
    ['openai/gpt-image-2', '1K', 'low', 1, 'Boat', 30_340],
    ['openai/gpt-image-2', '1K', 'medium', 1, 'Boat', 75_340],
    ['openai/gpt-image-2', '2K', 'high', 2, 'Boat', 840_340],
    ['openai/gpt-image-2.5-flare', '1K', 'medium', 1, 'Boat', 105_340],
    ['openai/gpt-image-2.5-sunburst', '4K', 'max', 1, 'Boat', 1_920_340],
  ] as const)(
    'computes conservative bounded max-token reservation for %s %s %s x%s',
    (modelId, resolution, quality, count, prompt, expectedMicros) => {
      const route = catalog.routes.find(
        (entry) => entry.modelId === modelId && entry.adapter === 'openai',
      )!;
      expect(route.rates).toEqual([]);
      const input: GenerateInput = {
        modelId,
        routeId: route.id,
        operation: 'text-to-image',
        input: {
          prompt,
          resolution,
          quality,
          count,
          ...(resolution === '4K' ? { aspectRatio: '16:9' } : {}),
        },
        routing: { fallback: false },
      };
      const result = quote(input, { executableRouteIds: [route.id] });
      expect(result.selectedRouteId).toBe(route.id);
      expect(result.reservationMicros).toBe(expectedMicros);
      expect(result.candidates[0]!.notices.join(' ')).toContain('Bounded max-token reservation');
    },
  );

  it('keeps OpenAI image-edit, custom pixel size and unsupported 4K square unpriced', () => {
    const route = catalog.routes.find(
      (entry) => entry.modelId === 'openai/gpt-image-2' && entry.adapter === 'openai',
    )!;
    const options = { executableRouteIds: [route.id] };

    expect(
      quote(
        {
          modelId: route.modelId,
          routeId: route.id,
          operation: 'image-edit',
          input: {
            prompt: 'Edit sky.',
            resolution: '1K',
            references: [{ type: 'image', asset: { url: 'https://media.example.com/ref.png' } }],
          },
        },
        options,
      ).selectedRouteId,
    ).toBeNull();

    expect(
      quote(
        {
          modelId: route.modelId,
          routeId: route.id,
          operation: 'text-to-image',
          input: { prompt: 'Custom box.', size: { width: 1024, height: 1024 } },
        },
        options,
      ).selectedRouteId,
    ).toBeNull();

    expect(
      quote(
        {
          modelId: route.modelId,
          routeId: route.id,
          operation: 'text-to-image',
          input: { prompt: 'Square 4K.', resolution: '4K', aspectRatio: '1:1' },
        },
        options,
      ).selectedRouteId,
    ).toBeNull();
  });

  it('settles exact OpenAI token usage via captureOutputs and fails closed on partial usage', async () => {
    // 56 text input tokens * $5/1M = $0.00028; 1,000 image output tokens * $30/1M = $0.03000 -> 30,280 micros
    expect(
      observedOpenAICostMicros({
        usage: {
          total_tokens: 1_056,
          input_tokens: 56,
          output_tokens: 1_000,
          input_tokens_details: { text_tokens: 56, image_tokens: 0 },
        },
      }),
    ).toBe(30_280);

    // Cached text input: 40 cached ($1.25/1M = 50,000 pico) + 16 uncached ($5/1M = 80,000 pico) + 440 output ($30/1M = 13,200,000 pico) = 13,330,000 pico -> 13,330 micros
    expect(
      observedOpenAICostMicros({
        usage: {
          total_tokens: 496,
          input_tokens: 56,
          output_tokens: 440,
          input_tokens_details: { text_tokens: 56, image_tokens: 0, cached_tokens: 40 },
        },
      }),
    ).toBe(13_330);

    // Ambiguous cached modality mix fails closed to null
    expect(
      observedOpenAICostMicros({
        usage: {
          total_tokens: 300,
          input_tokens: 100,
          output_tokens: 200,
          input_tokens_details: { text_tokens: 50, image_tokens: 50, cached_tokens: 20 },
        },
      }),
    ).toBeNull();

    const route = catalog.routes.find(
      (entry) => entry.modelId === 'openai/gpt-image-2.5-flare' && entry.adapter === 'openai',
    )!;
    const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
    const input = parseGenerationRequest({
      modelId: route.modelId,
      routeId: route.id,
      operation: 'text-to-image',
      input: { prompt: 'A red paper sailboat.', resolution: '1K' },
    });
    const adapter = createOpenAIAdapter({
      env: { OPENAI_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          data: [{ b64_json: png.toString('base64') }],
          usage: {
            total_tokens: 451,
            input_tokens: 11,
            output_tokens: 440,
            input_tokens_details: { text_tokens: 11, image_tokens: 0 },
          },
        }),
      captureOutputs: async () => [
        {
          url: 'https://assets.example.com/out.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
        },
      ],
    });
    const submitted = await adapter.submit({ jobId: 'job-1', input, route, deployment });
    // 11 * 5_000 + 440 * 30_000 = 13_255_000 pico -> 13,255 micros (much lower than bounded reservation!)
    expect(submitted.immediateResult).toMatchObject({
      status: 'succeeded',
      billedCostMicros: 13_255,
    });
  });
});

describe('Google Nano Banana 2.1 and Gemini Omni 1.1 Flash bounded max-token quotes and usage settlement', () => {
  it('quotes bounded max-token reservations for Nano Banana text-to-image and Omni text-to-video', () => {
    const nanoRoute = catalog.routes.find(
      (entry) => entry.modelId === 'google/nano-banana-2.1' && entry.adapter === 'google',
    )!;
    expect(nanoRoute.rates).toEqual([]);
    const nanoQuote = quote(
      {
        modelId: nanoRoute.modelId,
        routeId: nanoRoute.id,
        operation: 'text-to-image',
        input: { prompt: 'Boat', resolution: '1K', thinkingLevel: 'minimal' },
        routing: { fallback: false },
      },
      { executableRouteIds: [nanoRoute.id] },
    );
    // (68 * 1,500 + 2,048 * 7,500 + 1,120 * 30,000) pico = 102,000 + 15,360,000 + 33,600,000 = 49,062,000 pico -> 49,062 micros
    expect(nanoQuote.selectedRouteId).toBe(nanoRoute.id);
    expect(nanoQuote.reservationMicros).toBe(49_062);

    // Multi-output and edit remain unpriced on Google Nano Banana
    expect(
      quote(
        {
          modelId: nanoRoute.modelId,
          routeId: nanoRoute.id,
          operation: 'text-to-image',
          input: { prompt: 'Boat', resolution: '1K', count: 2 },
        },
        { executableRouteIds: [nanoRoute.id] },
      ).selectedRouteId,
    ).toBeNull();

    const omniRoute = catalog.routes.find(
      (entry) => entry.modelId === 'google/gemini-omni-1.1-flash' && entry.adapter === 'google',
    )!;
    expect(omniRoute.rates).toEqual([]);
    const omniQuote = quote(
      {
        modelId: omniRoute.modelId,
        routeId: omniRoute.id,
        operation: 'text-to-video',
        input: { prompt: 'Boat', resolution: '720p', duration: 5 },
        routing: { fallback: false },
      },
      { executableRouteIds: [omniRoute.id] },
    );
    // (68 * 1,500 + 8,192 * 9,000 + 30,000 * 17,500) pico = 102,000 + 73,728,000 + 525,000,000 = 598,830,000 pico -> 598,830 micros
    expect(omniQuote.selectedRouteId).toBe(omniRoute.id);
    expect(omniQuote.reservationMicros).toBe(598_830);

    // Reference-to-video and image-to-video remain unpriced on Omni
    expect(
      quote(
        {
          modelId: omniRoute.modelId,
          routeId: omniRoute.id,
          operation: 'image-to-video',
          input: {
            prompt: 'Boat',
            resolution: '720p',
            duration: 5,
            firstFrame: { url: 'https://media.example.com/f.png' },
          },
        },
        { executableRouteIds: [omniRoute.id] },
      ).selectedRouteId,
    ).toBeNull();
  });

  it('settles conserved Google modality token usage and leaves incomplete or cached usage unresolved', async () => {
    // Nano Banana: 20 input ($1.50/1M = 30,000 pico) + (10 text + 300 thought) * $7.50/1M (2,325,000 pico) + 1,120 image * $30/1M (33,600,000 pico) = 35,955,000 pico -> 35,955 micros
    const nanoUsage = {
      total_tokens: 1_450,
      total_input_tokens: 20,
      total_output_tokens: 1_130,
      total_thought_tokens: 300,
      output_tokens_by_modality: [
        { modality: 'text', tokens: 10 },
        { modality: 'image', tokens: 1_120 },
      ],
    };
    expect(observedGoogleImageCostMicros({ usage: nanoUsage })).toBe(35_955);

    // Non-conserved total_tokens or missing modality breakdown fails closed to null
    expect(
      observedGoogleImageCostMicros({ usage: { ...nanoUsage, total_tokens: 1_451 } }),
    ).toBeNull();
    expect(
      observedGoogleImageCostMicros({
        usage: { ...nanoUsage, output_tokens_by_modality: undefined },
      }),
    ).toBeNull();
    expect(
      observedGoogleVideoCostMicros({
        usage: { ...nanoUsage, total_cached_tokens: 5, total_tokens: 1_455 },
      }),
    ).toBeNull();

    const nanoRoute = catalog.routes.find(
      (entry) => entry.modelId === 'google/nano-banana-2.1' && entry.adapter === 'google',
    )!;
    const deployment = catalog.deployments.find((entry) => entry.id === nanoRoute.deploymentId)!;
    const imageAdapter = createGoogleImageAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          id: 'ix-1',
          status: 'completed',
          usage: nanoUsage,
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'image', mime_type: 'image/png', data: png.toString('base64') }],
            },
          ],
        }),
      captureOutputs: async () => [
        {
          url: 'https://assets.example.com/nano.png',
          mediaType: 'image/png',
          fidelity: 'unverified',
        },
      ],
    });
    const polledNano = await imageAdapter.poll({
      jobId: 'job-nano',
      upstreamId: 'ix-1',
      input: parseGenerationRequest({
        modelId: nanoRoute.modelId,
        operation: 'text-to-image',
        input: { prompt: 'Boat', resolution: '1K' },
      }),
      route: nanoRoute,
      deployment,
    });
    expect(polledNano).toMatchObject({ status: 'succeeded', billedCostMicros: 35_955 });

    // Omni: 20 input ($1.50/1M = 30,000 pico) + 400 thought ($9/1M = 3,600,000 pico) + 28,960 video ($17.50/1M = 506,800,000 pico) = 510,430,000 pico -> 510,430 micros
    const omniRoute = catalog.routes.find(
      (entry) => entry.modelId === 'google/gemini-omni-1.1-flash' && entry.adapter === 'google',
    )!;
    const videoAdapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          id: 'ix-2',
          status: 'completed',
          usage: {
            total_tokens: 29_380,
            total_input_tokens: 20,
            total_output_tokens: 28_960,
            total_thought_tokens: 400,
            output_tokens_by_modality: [{ modality: 'video', tokens: 28_960 }],
          },
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') }],
            },
          ],
        }),
      captureOutputs: async () => [
        {
          url: 'https://assets.example.com/omni.mp4',
          mediaType: 'video/mp4',
          fidelity: 'unverified',
        },
      ],
    });
    const polledOmni = await videoAdapter.poll({
      jobId: 'job-omni',
      upstreamId: 'ix-2',
      input: parseGenerationRequest({
        modelId: omniRoute.modelId,
        operation: 'text-to-video',
        input: { prompt: 'Boat', resolution: '720p', duration: 5 },
      }),
      route: omniRoute,
      deployment,
    });
    expect(polledOmni).toMatchObject({ status: 'succeeded', billedCostMicros: 510_430 });
  });
});
