import { describe, expect, it } from 'vitest';
import { catalog, getModel, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { SubmissionRejected } from '../packages/engine/src/adapters.js';
import { createBytePlusAdapter } from '../packages/engine/src/byteplus.js';
import { createFalAdapter } from '../packages/engine/src/fal.js';
import { createAlibabaMediaAdapter } from '../packages/engine/src/providers.js';

function catalogContext(routeId: string, input: GenerateInput) {
  const route = catalog.routes.find((entry) => entry.id === routeId)!;
  expect(route, `missing route ${routeId}`).toBeDefined();
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
  expect(deployment, `missing deployment ${route.deploymentId}`).toBeDefined();
  return {
    jobId: 'fixture-job',
    route,
    deployment,
    input: parseGenerationRequest(input),
  };
}

describe('Track 1: Alibaba Cloud Model Studio 6-region coverage', () => {
  const regions = [
    ['ap-southeast-1', 'AP_SOUTHEAST_1'],
    ['us-east-1', 'US_EAST_1'],
    ['eu-central-1', 'EU_CENTRAL_1'],
    ['cn-hongkong', 'CN_HONGKONG'],
    ['ap-northeast-1', 'AP_NORTHEAST_1'],
    ['cn-beijing', 'CN_BEIJING'],
  ] as const;

  it('registers all 5 hosted Alibaba/Qwen models across all 6 regional deployments with no unqualified deployment left', () => {
    expect(
      catalog.deployments.some(
        (deployment) => deployment.id === 'alibaba-model-studio-region-unqualified',
      ),
    ).toBe(false);
    for (const modelId of [
      'alibaba/wan-3.0',
      'alibaba/wan-3.0-prime',
      'qwen/image-2.1-turbo',
      'alibaba/qwen-image-2.1-pro',
      'alibaba/qwen-image-3.0-pro',
    ]) {
      const alibabaRoutes = catalog.routes.filter(
        (route) => route.modelId === modelId && route.adapter === 'alibaba',
      );
      expect(alibabaRoutes.map((route) => route.deploymentId).sort()).toEqual(
        regions.map(([region]) => `alibaba-model-studio-${region}`).sort(),
      );
    }
  });

  it.each(regions)(
    'submits Qwen Image 3.0 Pro via %s workspace MaAS endpoint',
    async (region, envSuffix) => {
      const urls: string[] = [];
      const adapter = createAlibabaMediaAdapter({
        env: {
          [`ALIBABA_${envSuffix}_API_KEY`]: `sk-${region}`,
          [`ALIBABA_${envSuffix}_WORKSPACE_ID`]: `ws-${region.replace(/-/g, '')}`,
        },
        fetch: async (url, init) => {
          urls.push(String(url));
          expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer sk-${region}`);
          return Response.json({
            output: {
              task_id: `task-${region}`,
              task_status: 'PENDING',
            },
          });
        },
      });
      const routeId = `alibaba-model-studio-${region}/alibaba-qwen-image-3.0-pro`;
      const ctx = catalogContext(routeId, {
        modelId: 'alibaba/qwen-image-3.0-pro',
        routeId,
        operation: 'text-to-image',
        input: { prompt: 'A porcelain teapot on a wooden table.', resolution: '1K' },
      });
      expect(adapter.isConfigured(ctx.route, ctx.deployment)).toBe(true);
      expect(await adapter.submit(ctx)).toEqual({ upstreamId: `task-${region}` });
      expect(urls).toEqual([
        `https://ws-${region.replace(/-/g, '')}.${region}.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation`,
      ]);
    },
  );
});

describe('Track 2: BytePlus ModelArk Seedream & Seedance expansion + token billing', () => {
  it.each([
    ['bytedance/seedream-5.5', '1K', false, 1024, 1024, 20_000],
    ['bytedance/seedream-5.0-flash', '1K', false, 1024, 1024, 18_000],
    ['bytedance/seedream-5.0-lite', '3K', false, 3072, 3072, 35_000],
    ['bytedance/seedream-4.5', '4K', true, 4096, 4096, 40_000],
    ['bytedance/seedream-4.0', '2K', true, 2048, 2048, 30_000],
  ] as const)(
    'quotes and settles %s (%s) on Singapore ModelArk',
    async (modelId, resolution, jpegOnly, width, height, expectedMicros) => {
      const routeId = `byteplus-modelark-ap-southeast-1/${modelId.replace('/', '-')}`;
      const request: GenerateInput = {
        modelId,
        routeId,
        operation: 'text-to-image',
        input: { prompt: 'An architectural courtyard at noon.', resolution },
      };
      const quoted = quote(request, { executableRouteIds: [routeId] });
      expect(quoted.selectedRouteId).toBe(routeId);
      expect(quoted.reservationMicros).toBe(expectedMicros);

      let postedOutputFormat: unknown = 'not-called';
      const adapter = createBytePlusAdapter({
        env: { BYTEPLUS_API_KEY: 'bp-key' },
        fetch: async (_url, init) => {
          const payload = JSON.parse(String(init?.body));
          postedOutputFormat = payload.output_format;
          return Response.json({
            data: [
              {
                url: 'https://assets.example.com/generated.jpg',
                size: `${width}x${height}`,
              },
            ],
            usage: { generated_images: 1 },
          });
        },
      });
      const ctx = catalogContext(routeId, request);
      const submitted = await adapter.submit(ctx);
      expect(postedOutputFormat).toBe(jpegOnly ? undefined : 'png');
      expect(submitted.immediateResult).toMatchObject({
        status: 'succeeded',
        billedCostMicros: expectedMicros,
        outputs: [
          {
            mediaType: jpegOnly ? 'image/jpeg' : 'image/png',
          },
        ],
      });
    },
  );

  it('rejects PNG output on JPEG-only Seedream 4.5 and 4.0', async () => {
    const adapter = createBytePlusAdapter({ env: { BYTEPLUS_API_KEY: 'bp-key' } });
    for (const modelId of ['bytedance/seedream-4.5', 'bytedance/seedream-4.0'] as const) {
      const routeId = `byteplus-modelark-ap-southeast-1/${modelId.replace('/', '-')}`;
      const ctx = catalogContext(routeId, {
        modelId,
        routeId,
        operation: 'text-to-image',
        input: { prompt: 'Still life.', resolution: '2K', outputFormat: 'png' },
      });
      await expect(adapter.submit(ctx)).rejects.toThrow(SubmissionRejected);
    }
  });

  it.each([
    ['bytedance/seedance-2.5', '1080p', false, 108_000, 1_263_600],
    ['bytedance/seedance-2.5', '720p', true, 108_000, 1_155_600],
    ['bytedance/seedance-2.0', '720p', false, 100_000, 700_000],
    ['bytedance/seedance-2.0-fast', '720p', true, 100_000, 560_000],
    ['bytedance/seedance-2.0-mini', '720p', false, 100_000, 350_000],
    ['bytedance/seedance-1.0-pro', '720p', undefined, 108_000, 270_000],
    ['bytedance/seedance-1.0-pro-fast', '720p', undefined, 108_000, 108_000],
  ] as const)(
    'quotes bounded non-video tokens for %s (%s, audio=%s) and settles exact completion_tokens (%i -> %i micro-USD)',
    async (modelId, resolution, audio, completionTokens, expectedSettledMicros) => {
      const routeId = `byteplus-modelark-ap-southeast-1/${modelId.replace('/', '-')}`;
      const request: GenerateInput = {
        modelId,
        routeId,
        operation: 'text-to-video',
        input: {
          prompt: 'Waves lapping against basalt rocks.',
          resolution,
          duration: 5,
          ...(audio !== undefined ? { audio } : {}),
        },
      };
      const quoted = quote(request, { executableRouteIds: [routeId] });
      expect(quoted.selectedRouteId).toBe(routeId);
      expect(quoted.reservationMicros).toBeGreaterThanOrEqual(expectedSettledMicros);

      const adapter = createBytePlusAdapter({
        env: { BYTEPLUS_API_KEY: 'bp-key' },
        fetch: async (url, init) => {
          if (init?.method === 'POST') {
            return Response.json({ id: 'cgt-task-1' });
          }
          expect(String(url)).toContain('/contents/generations/tasks/cgt-task-1');
          return Response.json({
            status: 'succeeded',
            content: { video_url: 'https://assets.example.com/video.mp4' },
            usage: { completion_tokens: completionTokens },
          });
        },
      });
      const ctx = catalogContext(routeId, request);
      expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'cgt-task-1' });
      expect(await adapter.poll({ ...ctx, upstreamId: 'cgt-task-1' })).toMatchObject({
        status: 'succeeded',
        billedCostMicros: expectedSettledMicros,
      });
    },
  );

  it('keeps Seedance reference-to-video with video inputs unquoted so partial output-only prices are never quoted', () => {
    const routeId = 'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5';
    const quoted = quote(
      {
        modelId: 'bytedance/seedance-2.5',
        routeId,
        operation: 'reference-to-video',
        input: {
          prompt: 'Follow camera motion.',
          resolution: '720p',
          duration: 5,
          references: [{ type: 'video', asset: { url: 'https://assets.example.com/ref.mp4' } }],
        },
      },
      { executableRouteIds: [routeId] },
    );
    expect(quoted.selectedRouteId).toBeNull();
    expect(quoted.candidates[0]!.estimatedCostMicros).toBeNull();
  });
});

describe('Track 3: fal route coverage across Google, OpenAI, ByteDance, Alibaba, xAI and MiniMax', () => {
  it('preserves distinct identity for fal/qwen-image-3 and excludes unhosted derivatives', () => {
    expect(getModel('fal/qwen-image-3')?.authorProviderIds).toEqual(['fal']);
    expect(getModel('alibaba/qwen-image-3.0-pro')?.id).toBe('alibaba/qwen-image-3.0-pro');
    for (const unhosted of [
      'qwen/image-2.1-turbo',
      'alibaba/qwen-image-2.1-pro',
      'minimax/h3-highspeed',
      'minimax/h3-lite',
    ]) {
      expect(
        catalog.routes.filter((route) => route.modelId === unhosted && route.adapter === 'fal'),
      ).toHaveLength(0);
    }
  });

  it('rejects silent duration override on fal Gemini Omni video-edit', async () => {
    const adapter = createFalAdapter({ env: { FAL_KEY: 'fal-fixture-key' } });
    const ctx = catalogContext('fal-undisclosed/google/gemini-omni-flash/v1.1/edit', {
      modelId: 'google/gemini-omni-1.1-flash',
      routeId: 'fal-undisclosed/google/gemini-omni-flash/v1.1/edit',
      operation: 'video-edit',
      input: {
        prompt: 'Add warm golden sunset lighting.',
        sourceVideo: { url: 'https://assets.example.com/source.mp4' },
        resolution: '720p',
        duration: 5,
      },
    });
    await expect(adapter.submit(ctx)).rejects.toThrow(SubmissionRejected);
  });

  it.each([
    {
      label: 'Google Gemini Omni 1.1 Flash image-to-video on fal',
      routeId: 'fal-undisclosed/google/gemini-omni-flash/v1.1/image-to-video',
      request: {
        modelId: 'google/gemini-omni-1.1-flash',
        operation: 'image-to-video' as const,
        input: {
          prompt: 'Camera pushes forward across the harbor.',
          firstFrame: { url: 'https://assets.example.com/harbor.png' },
          resolution: '720p',
          duration: 6,
          aspectRatio: '16:9',
        },
      },
      expectedPostUrl: 'https://queue.fal.run/google/gemini-omni-flash/v1.1/image-to-video',
      expectedStatusPrefix: 'https://queue.fal.run/google/gemini-omni-flash/requests/',
      expectedBody: {
        image_url: 'https://assets.example.com/harbor.png',
        resolution: '720p',
        duration: 6,
        aspect_ratio: '16:9',
      },
      isImage: false,
    },
    {
      label: 'OpenAI GPT Image 2 text-to-image on fal',
      routeId: 'fal-undisclosed/openai/gpt-image-2',
      request: {
        modelId: 'openai/gpt-image-2',
        operation: 'text-to-image' as const,
        input: {
          prompt: 'A minimalist desk lamp.',
          aspectRatio: '1:1',
          quality: 'high' as const,
        },
      },
      expectedPostUrl: 'https://queue.fal.run/openai/gpt-image-2',
      expectedStatusPrefix: 'https://queue.fal.run/openai/gpt-image-2/requests/',
      expectedBody: {
        image_size: { width: 1024, height: 1024 },
        quality: 'high',
      },
      isImage: true,
    },
    {
      label: 'ByteDance Seedance 1.0 Pro Fast image-to-video on fal',
      routeId: 'fal-undisclosed/fal-ai/bytedance/seedance/v1/pro/fast/image-to-video',
      request: {
        modelId: 'bytedance/seedance-1.0-pro-fast',
        operation: 'image-to-video' as const,
        input: {
          prompt: 'Gentle breeze through tall grass.',
          firstFrame: { url: 'https://assets.example.com/frame.jpg' },
          resolution: '720p',
          duration: 5,
        },
      },
      expectedPostUrl: 'https://queue.fal.run/fal-ai/bytedance/seedance/v1/pro/fast/image-to-video',
      expectedStatusPrefix: 'https://queue.fal.run/fal-ai/bytedance/requests/',
      expectedBody: {
        image_url: 'https://assets.example.com/frame.jpg',
        resolution: '720p',
        duration: '5',
      },
      isImage: false,
    },
    {
      label: 'ByteDance Seedream 4.5 text-to-image on fal',
      routeId: 'fal-undisclosed/fal-ai/bytedance/seedream/v4.5/text-to-image',
      request: {
        modelId: 'bytedance/seedream-4.5',
        operation: 'text-to-image' as const,
        input: {
          prompt: 'Botanical watercolor illustration.',
          resolution: '2K',
        },
      },
      expectedPostUrl: 'https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image',
      expectedStatusPrefix: 'https://queue.fal.run/fal-ai/bytedance/requests/',
      expectedBody: {
        image_size: { width: 2048, height: 2048 },
      },
      isImage: true,
    },
    {
      label: 'Alibaba Wan 3.0 Prime reference-to-video on fal',
      routeId: 'fal-undisclosed/alibaba/wan-3.0-prime/reference-to-video',
      request: {
        modelId: 'alibaba/wan-3.0-prime',
        operation: 'reference-to-video' as const,
        input: {
          prompt: 'Character walks across a sunlit plaza.',
          resolution: '720p',
          duration: 5,
          references: [
            { type: 'image' as const, asset: { url: 'https://assets.example.com/char.png' } },
          ],
        },
      },
      expectedPostUrl: 'https://queue.fal.run/alibaba/wan-3.0-prime/reference-to-video',
      expectedStatusPrefix: 'https://queue.fal.run/alibaba/wan-3.0-prime/requests/',
      expectedBody: {
        reference_image_urls: ['https://assets.example.com/char.png'],
        resolution: '720p',
        duration: 5,
      },
      isImage: false,
    },
    {
      label: 'Alibaba Qwen Image 3 text-to-image on fal',
      routeId: 'fal-undisclosed/alibaba/qwen-image-3/text-to-image',
      request: {
        modelId: 'fal/qwen-image-3',
        operation: 'text-to-image' as const,
        input: {
          prompt: 'Calligraphy poster on textured paper.',
          aspectRatio: '16:9',
        },
      },
      expectedPostUrl: 'https://queue.fal.run/alibaba/qwen-image-3/text-to-image',
      expectedStatusPrefix: 'https://queue.fal.run/alibaba/qwen-image-3/requests/',
      expectedBody: {
        image_size: { width: 1280, height: 720 },
      },
      isImage: true,
    },
    {
      label: 'xAI Grok Imagine Video edit-video on fal',
      routeId: 'fal-undisclosed/xai/grok-imagine-video/edit-video',
      request: {
        modelId: 'xai/grok-imagine-video',
        operation: 'video-edit' as const,
        input: {
          prompt: 'Convert lighting to dramatic twilight.',
          sourceVideo: { url: 'https://assets.example.com/clip.mp4' },
          resolution: '720p',
        },
      },
      expectedPostUrl: 'https://queue.fal.run/xai/grok-imagine-video/edit-video',
      expectedStatusPrefix: 'https://queue.fal.run/xai/grok-imagine-video/requests/',
      expectedBody: {
        video_url: 'https://assets.example.com/clip.mp4',
        resolution: '720p',
      },
      isImage: false,
    },
    {
      label: 'xAI Grok Imagine Video extend-video on fal',
      routeId: 'fal-undisclosed/xai/grok-imagine-video/extend-video',
      request: {
        modelId: 'xai/grok-imagine-video',
        operation: 'video-extend' as const,
        input: {
          prompt: 'Camera continues panning upward.',
          sourceVideo: { url: 'https://assets.example.com/clip.mp4' },
          duration: 6,
        },
      },
      expectedPostUrl: 'https://queue.fal.run/xai/grok-imagine-video/extend-video',
      expectedStatusPrefix: 'https://queue.fal.run/xai/grok-imagine-video/requests/',
      expectedBody: {
        video_url: 'https://assets.example.com/clip.mp4',
        duration: 6,
      },
      isImage: false,
    },
    {
      label: 'xAI Grok Imagine Image v2.0 text-to-image on fal',
      routeId: 'fal-undisclosed/xai/grok-imagine-image/v2.0/text-to-image',
      request: {
        modelId: 'xai/grok-imagine-image-2.0',
        operation: 'text-to-image' as const,
        input: {
          prompt: 'Geometric glass sculpture.',
          aspectRatio: '1:1',
          resolution: '1K',
        },
      },
      expectedPostUrl: 'https://queue.fal.run/xai/grok-imagine-image/v2.0/text-to-image',
      expectedStatusPrefix: 'https://queue.fal.run/xai/grok-imagine-image/requests/',
      expectedBody: {
        aspect_ratio: '1:1',
        resolution: '1k',
      },
      isImage: true,
    },
    {
      label: 'MiniMax H3 standard text-to-video on fal',
      routeId: 'fal-undisclosed/minimax/h3/text-to-video',
      request: {
        modelId: 'minimax/h3',
        operation: 'text-to-video' as const,
        input: {
          prompt: 'Paper lantern drifting over a river.',
          resolution: '768p',
          duration: 5,
        },
      },
      expectedPostUrl: 'https://queue.fal.run/minimax/h3/text-to-video',
      expectedStatusPrefix: 'https://queue.fal.run/minimax/h3/requests/',
      expectedBody: {
        resolution: '768P',
        duration: 5,
        prompt_expansion_mode: 'disabled',
      },
      isImage: false,
    },
  ])(
    'submits and polls $label',
    async ({ routeId, request, expectedPostUrl, expectedStatusPrefix, expectedBody, isImage }) => {
      const calls: Array<{ url: string; body: unknown }> = [];
      const adapter = createFalAdapter({
        env: { FAL_KEY: 'fal-fixture-key' },
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
          if (init?.method === 'POST') return Response.json({ request_id: 'req-123' });
          if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
          return isImage
            ? Response.json({
                images: [{ url: 'https://v3.fal.media/files/out.png', content_type: 'image/png' }],
              })
            : Response.json({
                video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' },
              });
        },
      });
      const ctx = catalogContext(routeId, { ...request, routeId });
      expect(adapter.isConfigured(ctx.route, ctx.deployment)).toBe(true);
      expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'req-123' });
      expect(await adapter.poll({ ...ctx, upstreamId: 'req-123' })).toMatchObject({
        status: 'succeeded',
        billedCostMicros: null,
      });
      expect(calls[0]?.url).toBe(expectedPostUrl);
      expect(calls[0]?.body).toMatchObject(expectedBody);
      expect(calls[1]?.url).toBe(`${expectedStatusPrefix}req-123/status`);
      expect(calls[2]?.url).toBe(`${expectedStatusPrefix}req-123`);
    },
  );
});
