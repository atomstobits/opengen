import { describe, expect, it } from 'vitest';
import { catalog, getRoute, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { SubmissionRejected, SubmissionUnknown } from '../packages/engine/src/adapters.js';
import { snapshotCredentialEnvironment } from '../packages/engine/src/attempt-credentials.js';
import { createBflAdapter } from '../packages/engine/src/bfl.js';
import { createKlingAdapter } from '../packages/engine/src/kling.js';
import { createAlibabaMediaAdapter } from '../packages/engine/src/providers.js';
import { createXaiAdapter } from '../packages/engine/src/xai.js';
import { catalogSmokeCases } from '../scripts/live-smoke.js';

function routeAndDeployment(routeId: string) {
  const route = getRoute(routeId)!;
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
  return { route, deployment };
}

describe('Official Kling AI adapter (synthetic fixtures, no network)', () => {
  it('submits text-to-video with top-level prompt, polls GET /tasks, and settles USD cash billing', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const adapter = createKlingAdapter({
      env: { KLING_API_KEY: 'kling-fixture-key' },
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer kling-fixture-key');
        if (init?.method === 'POST') {
          return Response.json({
            code: 0,
            message: 'SUCCEED',
            data: { id: 'kling-task-1', status: 'submitted' },
          });
        }
        return Response.json({
          code: 0,
          message: 'SUCCEED',
          data: [
            {
              id: 'kling-task-1',
              status: 'succeeded',
              outputs: [{ type: 'video', url: 'https://cdn.klingai.com/out/kling-1.mp4' }],
              usage: { output_duration: '3' },
              billing: [
                {
                  charge_type: 'cash',
                  cash_type: 'balance',
                  amount: '0.471',
                  currency: 'USD',
                },
              ],
            },
          ],
        });
      },
    });
    const { route, deployment } = routeAndDeployment('kling-ap-southeast-1/kling-kling-4.0');
    const input = parseGenerationRequest({
      modelId: 'kling/kling-4.0',
      routeId: route.id,
      operation: 'text-to-video',
      input: {
        prompt: 'A red paper boat gliding across still water.',
        resolution: '720p',
        duration: 3,
        aspectRatio: '16:9',
      },
    });
    const ctx = { jobId: 'job-kling-1', route, deployment, input };
    expect(adapter.isConfigured(route, deployment)).toBe(true);
    expect(adapter.preflight?.(ctx)).toBeNull();
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'kling-task-1' });
    expect(calls[0]).toEqual({
      url: 'https://api-singapore.klingai.com/text-to-video/kling-4.0',
      method: 'POST',
      body: {
        prompt: 'A red paper boat gliding across still water.',
        settings: {
          resolution: '720p',
          duration: 3,
          aspect_ratio: '16:9',
          dynamic_range: 'sdr',
        },
        options: { external_task_id: 'job-kling-1' },
      },
    });
    expect(await adapter.poll({ ...ctx, upstreamId: 'kling-task-1' })).toEqual({
      status: 'succeeded',
      billedCostMicros: 471_000,
      outputs: [
        {
          url: 'https://cdn.klingai.com/out/kling-1.mp4',
          mediaType: 'video/mp4',
          fidelity: 'unverified',
        },
      ],
    });
    expect(calls[1]?.url).toBe('https://api-singapore.klingai.com/tasks?task_ids=kling-task-1');
  });

  it('omits dynamic_range on kling-4.0-flash, sends contents for image-to-video, and leaves unit-pack billing unresolved', async () => {
    const bodies: unknown[] = [];
    const adapter = createKlingAdapter({
      env: { KLING_API_KEY: 'kling-fixture-key' },
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ code: 0, data: { id: 'flash-task-1' } });
        }
        return Response.json({
          code: 0,
          data: [
            {
              id: 'flash-task-1',
              status: 'succeeded',
              outputs: [{ type: 'video', url: 'https://cdn.klingai.com/out/flash-1.mp4' }],
              billing: [{ charge_type: 'unit', amount: '1.8', package_type: 'video' }],
            },
          ],
        });
      },
    });
    const { route, deployment } = routeAndDeployment('kling-ap-southeast-1/kling-kling-4.0-flash');
    const t2v = parseGenerationRequest({
      modelId: 'kling/kling-4.0-flash',
      routeId: route.id,
      operation: 'text-to-video',
      input: {
        prompt: 'Soft daylight waves.',
        resolution: '720p',
        duration: 3,
        aspectRatio: '16:9',
      },
    });
    await adapter.submit({ jobId: 'j1', route, deployment, input: t2v });
    expect(
      (bodies[0] as { settings: Record<string, unknown> }).settings.dynamic_range,
    ).toBeUndefined();

    const i2v = parseGenerationRequest({
      modelId: 'kling/kling-4.0-flash',
      routeId: route.id,
      operation: 'image-to-video',
      input: {
        prompt: 'Gentle breeze.',
        resolution: '720p',
        duration: 3,
        firstFrame: { url: 'https://media.example.com/frame.png' },
      },
    });
    await adapter.submit({ jobId: 'j2', route, deployment, input: i2v });
    expect(bodies[1]).toMatchObject({
      contents: [
        { type: 'prompt', text: 'Gentle breeze.' },
        { type: 'first_frame', url: 'https://media.example.com/frame.png' },
      ],
    });
    const polled = await adapter.poll({
      jobId: 'j2',
      route,
      deployment,
      input: i2v,
      upstreamId: 'flash-task-1',
    });
    expect(polled).toMatchObject({ status: 'succeeded', billedCostMicros: null });
  });

  it('requires exact task ID match, never settles list-rate estimates without billing, and enforces omni-video prompt/ratio/ordering rules', async () => {
    const bodies: unknown[] = [];
    const adapter = createKlingAdapter({
      env: { KLING_API_KEY: 'kling-fixture-key' },
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ code: 0, data: { id: 'kling-omni-1' } });
        }
        return Response.json({
          code: 0,
          data: [
            {
              id: 'kling-other-task',
              status: 'succeeded',
              outputs: [{ type: 'video', url: 'https://cdn.klingai.com/out/other.mp4' }],
              usage: { output_duration: '3' },
              billing: [{ charge_type: 'cash', currency: 'USD', amount: '0.471' }],
            },
          ],
        });
      },
    });
    const { route, deployment } = routeAndDeployment('kling-ap-southeast-1/kling-kling-4.0');

    // Reference-to-video requires non-empty prompt and rejects aspectRatio: 'source'.
    const r2vNoPrompt = parseGenerationRequest({
      modelId: 'kling/kling-4.0',
      routeId: route.id,
      operation: 'reference-to-video',
      input: {
        resolution: '720p',
        duration: 3,
        aspectRatio: '16:9',
        references: [{ type: 'image', asset: { url: 'https://media.example.com/ref.png' } }],
      },
    });
    expect(adapter.preflight?.({ route, deployment, input: r2vNoPrompt })).toMatch(
      /requires a prompt/i,
    );

    const r2vSourceRatio = parseGenerationRequest({
      modelId: 'kling/kling-4.0',
      routeId: route.id,
      operation: 'reference-to-video',
      input: {
        prompt: 'Keep style from Image1.',
        resolution: '720p',
        duration: 3,
        aspectRatio: 'source',
        references: [{ type: 'image', asset: { url: 'https://media.example.com/ref.png' } }],
      },
    });
    expect(adapter.preflight?.({ route, deployment, input: r2vSourceRatio })).toMatch(
      /cannot guarantee source aspect-ratio preservation/i,
    );

    // video-edit defaults aspectRatio to 'source' in canonical parsing; adapter rejects it instead of mapping to adaptive.
    const editDefaultRatio = parseGenerationRequest({
      modelId: 'kling/kling-4.0',
      routeId: route.id,
      operation: 'video-edit',
      input: {
        prompt: 'Add rain.',
        resolution: '720p',
        duration: 3,
        sourceVideo: { url: 'https://media.example.com/clip.mp4' },
      },
    });
    expect(adapter.preflight?.({ route, deployment, input: editDefaultRatio })).toMatch(
      /cannot guarantee source aspect-ratio preservation/i,
    );

    // Combined firstFrame + references + lastFrame orders refer_image BEFORE last_frame and maps auto -> adaptive.
    const r2vCombined = parseGenerationRequest({
      modelId: 'kling/kling-4.0',
      routeId: route.id,
      operation: 'reference-to-video',
      input: {
        prompt: 'Transition smoothly using Image2 style.',
        resolution: '720p',
        duration: 3,
        aspectRatio: 'auto',
        firstFrame: { url: 'https://media.example.com/first.png' },
        lastFrame: { url: 'https://media.example.com/last.png' },
        references: [{ type: 'image', asset: { url: 'https://media.example.com/ref.png' } }],
      },
    });
    await adapter.submit({ jobId: 'job-omni-1', route, deployment, input: r2vCombined });
    expect(bodies[0]).toMatchObject({
      contents: [
        { type: 'prompt', text: 'Transition smoothly using Image2 style.' },
        { type: 'first_frame', url: 'https://media.example.com/first.png', id: 'Image1' },
        { type: 'refer_image', url: 'https://media.example.com/ref.png', id: 'Image2' },
        { type: 'last_frame', url: 'https://media.example.com/last.png', id: 'Image3' },
      ],
      settings: { aspect_ratio: 'adaptive' },
    });

    // Polling must not fall back to a singleton task with a mismatched ID.
    expect(
      await adapter.poll({
        jobId: 'job-omni-1',
        route,
        deployment,
        input: r2vCombined,
        upstreamId: 'kling-omni-1',
      }),
    ).toMatchObject({ status: 'unknown' });

    // Missing billing entries return null instead of settling a list-price estimate.
    const noBillingAdapter = createKlingAdapter({
      env: { KLING_API_KEY: 'kling-fixture-key' },
      fetch: async () =>
        Response.json({
          code: 0,
          data: [
            {
              id: 'kling-omni-1',
              status: 'succeeded',
              outputs: [{ type: 'video', url: 'https://cdn.klingai.com/out/no-bill.mp4' }],
              usage: { output_duration: '3' },
            },
          ],
        }),
    });
    expect(
      await noBillingAdapter.poll({
        jobId: 'job-omni-1',
        route,
        deployment,
        input: r2vCombined,
        upstreamId: 'kling-omni-1',
      }),
    ).toMatchObject({ status: 'succeeded', billedCostMicros: null });
  });
});

describe('Official Black Forest Labs FLUX 3 adapter (synthetic fixtures, no network)', () => {
  it('validates *.bfl.ai polling_url hosts, rejects spoofed hosts, and settles credits to micro-USD', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createBflAdapter({
      env: { BFL_API_KEY: 'bfl-fixture-key' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        expect(new Headers(init?.headers).get('x-key')).toBe('bfl-fixture-key');
        if (init?.method === 'POST') {
          return Response.json({
            id: 'bfl-task-1',
            polling_url: 'https://api.us2.bfl.ai/v1/get_result?id=bfl-task-1',
            cost: 4.1,
          });
        }
        return Response.json({
          id: 'bfl-task-1',
          status: 'Ready',
          cost: 4.1,
          result: { sample: 'https://delivery-us2.bfl.ai/results/bfl-task-1.jpg' },
        });
      },
    });
    const { route, deployment } = routeAndDeployment('bfl-undisclosed/bfl-flux-3-image');
    const input = parseGenerationRequest({
      modelId: 'bfl/flux-3-image',
      routeId: route.id,
      operation: 'text-to-image',
      input: { prompt: 'A red paper boat on calm water.', resolution: '768sq', aspectRatio: '1:1' },
    });
    const ctx = { jobId: 'job-bfl-img', route, deployment, input };
    expect(adapter.isConfigured(route, deployment)).toBe(true);
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'api.us2.bfl.ai/bfl-task-1' });
    expect(calls[0]).toEqual({
      url: 'https://api.bfl.ai/v1/flux-3-image',
      body: {
        prompt: 'A red paper boat on calm water.',
        resolution: '768sq',
        aspect_ratio: '1:1',
        version: 'latest',
      },
    });
    const polled = await adapter.poll({ ...ctx, upstreamId: 'api.us2.bfl.ai/bfl-task-1' });
    expect(calls[1]?.url).toBe('https://api.us2.bfl.ai/v1/get_result?id=bfl-task-1');
    expect(polled).toEqual({
      status: 'succeeded',
      billedCostMicros: 41_000,
      outputs: [
        {
          url: 'https://delivery-us2.bfl.ai/results/bfl-task-1.jpg',
          mediaType: 'image/jpeg',
          fidelity: 'unverified',
        },
      ],
    });

    const spoofed = createBflAdapter({
      env: { BFL_API_KEY: 'bfl-fixture-key' },
      fetch: async () =>
        Response.json({
          id: 'bfl-task-2',
          polling_url: 'https://attacker.example/v1/get_result?id=bfl-task-2',
        }),
    });
    await expect(spoofed.submit(ctx)).rejects.toBeInstanceOf(SubmissionUnknown);
  });

  it('maps FLUX 3 Video resolutions to hd/fhd/qhd/uhd and rejects unimplemented video-edit', async () => {
    const bodies: unknown[] = [];
    const adapter = createBflAdapter({
      env: { BFL_API_KEY: 'bfl-fixture-key' },
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({
            id: 'bfl-vid-1',
            polling_url: 'https://api.bfl.ai/v1/get_result?id=bfl-vid-1',
          });
        }
        return Response.json({
          id: 'bfl-vid-1',
          status: 'Ready',
          cost: 75,
          result: { sample: 'https://delivery.bfl.ai/results/bfl-vid-1.mp4' },
        });
      },
    });
    const { route, deployment } = routeAndDeployment('bfl-undisclosed/bfl-flux-3-video');
    const t2v = parseGenerationRequest({
      modelId: 'bfl/flux-3-video',
      routeId: route.id,
      operation: 'text-to-video',
      input: {
        prompt: 'Sunlight shimmering across still water.',
        resolution: '720p',
        duration: 5,
        aspectRatio: '16:9',
      },
    });
    const ctx = { jobId: 'job-bfl-vid', route, deployment, input: t2v };
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'api.bfl.ai/bfl-vid-1' });
    expect(bodies[0]).toEqual({
      mode: 't2v',
      prompt: 'Sunlight shimmering across still water.',
      resolution: 'hd',
      duration: 5,
      aspect_ratio: '16:9',
      generate_audio: true,
      version: 'latest',
    });
    expect(await adapter.poll({ ...ctx, upstreamId: 'api.bfl.ai/bfl-vid-1' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: 750_000,
      outputs: [{ mediaType: 'video/mp4' }],
    });

    const editInput = parseGenerationRequest({
      modelId: 'bfl/flux-3-video',
      routeId: route.id,
      operation: 'video-edit',
      input: {
        prompt: 'Make it twilight.',
        sourceVideo: { url: 'https://media.example.com/in.mp4' },
      },
    });
    await expect(
      adapter.submit({ jobId: 'job-bfl-edit', route, deployment, input: editInput }),
    ).rejects.toBeInstanceOf(SubmissionRejected);

    // Rejects aspectRatio: 'source' rather than converting it to prompt-controlled 'auto'.
    const i2vSource = parseGenerationRequest({
      modelId: 'bfl/flux-3-video',
      routeId: route.id,
      operation: 'image-to-video',
      input: {
        prompt: 'Subtle camera drift.',
        resolution: '720p',
        duration: 5,
        aspectRatio: 'source',
        firstFrame: { url: 'https://media.example.com/frame.png' },
      },
    });
    expect(adapter.preflight?.({ route, deployment, input: i2vSource })).toMatch(
      /cannot guarantee source aspect-ratio preservation/i,
    );

    const { route: imgRoute, deployment: imgDeployment } = routeAndDeployment(
      'bfl-undisclosed/bfl-flux-3-image',
    );
    const imgEditSource = parseGenerationRequest({
      modelId: 'bfl/flux-3-image',
      routeId: imgRoute.id,
      operation: 'image-edit',
      input: {
        prompt: 'Turn into dusk.',
        resolution: '1K',
        aspectRatio: 'source',
        references: [{ type: 'image', asset: { url: 'https://media.example.com/frame.png' } }],
      },
    });
    expect(
      adapter.preflight?.({ route: imgRoute, deployment: imgDeployment, input: imgEditSource }),
    ).toMatch(/cannot guarantee source aspect-ratio preservation/i);
    const imgEditExplicit = parseGenerationRequest({
      modelId: 'bfl/flux-3-image',
      routeId: imgRoute.id,
      operation: 'image-edit',
      input: {
        prompt: 'Turn into dusk.',
        resolution: '1K',
        aspectRatio: '3:4',
        references: [{ type: 'image', asset: { url: 'https://media.example.com/frame.png' } }],
      },
    });
    expect(
      adapter.preflight?.({ route: imgRoute, deployment: imgDeployment, input: imgEditExplicit }),
    ).toBeNull();
  });
});

describe('Official Alibaba HappyHorse 1.1 adapter (synthetic fixtures, no network)', () => {
  it('dispatches through Alibaba media adapter, maps operation model IDs, and settles regional cost', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createAlibabaMediaAdapter({
      env: {
        ALIBABA_AP_SOUTHEAST_1_API_KEY: 'dashscope-fixture',
        ALIBABA_AP_SOUTHEAST_1_ENDPOINT:
          'https://ws-fixture.ap-southeast-1.maas.aliyuncs.com/api/v1',
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (init?.method === 'POST') {
          expect(new Headers(init?.headers).get('X-DashScope-Async')).toBe('enable');
          return Response.json({ output: { task_id: 'hh-task-1', task_status: 'PENDING' } });
        }
        return Response.json({
          output: {
            task_id: 'hh-task-1',
            task_status: 'SUCCEEDED',
            video_url: 'https://dashscope-result.oss-ap-southeast-1.aliyuncs.com/hh-1.mp4',
          },
          usage: { duration: 3, output_video_duration: 3, SR: 480 },
        });
      },
    });
    const { route, deployment } = routeAndDeployment(
      'alibaba-model-studio-ap-southeast-1/alibaba-happy-horse-1.1',
    );
    const input = parseGenerationRequest({
      modelId: 'alibaba/happy-horse-1.1',
      routeId: route.id,
      operation: 'text-to-video',
      input: {
        prompt: 'A red paper boat on calm water.',
        resolution: '480p',
        duration: 3,
        aspectRatio: '16:9',
      },
    });
    const ctx = { jobId: 'job-hh-1', route, deployment, input };
    expect(adapter.isConfigured(route, deployment)).toBe(true);
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'hh-task-1' });
    expect(calls[0]).toEqual({
      url: 'https://ws-fixture.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
      body: {
        model: 'happyhorse-1.1-t2v',
        input: { prompt: 'A red paper boat on calm water.' },
        parameters: { resolution: '480P', duration: 3, ratio: '16:9' },
      },
    });
    expect(await adapter.poll({ ...ctx, upstreamId: 'hh-task-1' })).toEqual({
      status: 'succeeded',
      billedCostMicros: 210_000,
      outputs: [
        {
          url: 'https://dashscope-result.oss-ap-southeast-1.aliyuncs.com/hh-1.mp4',
          mediaType: 'video/mp4',
          fidelity: 'unverified',
        },
      ],
    });
  });

  it('rejects aspect ratio overrides on HappyHorse image-to-video', () => {
    const adapter = createAlibabaMediaAdapter({
      env: {
        ALIBABA_EU_CENTRAL_1_API_KEY: 'dashscope-fixture',
        ALIBABA_EU_CENTRAL_1_ENDPOINT: 'https://ws-fixture.eu-central-1.maas.aliyuncs.com/api/v1',
      },
    });
    const { route, deployment } = routeAndDeployment(
      'alibaba-model-studio-eu-central-1/alibaba-happy-horse-1.1',
    );
    const input: GenerateInput = parseGenerationRequest({
      modelId: 'alibaba/happy-horse-1.1',
      routeId: route.id,
      operation: 'image-to-video',
      input: {
        prompt: 'Gentle ripples.',
        resolution: '720p',
        duration: 3,
        aspectRatio: '9:16',
        firstFrame: { url: 'https://media.example.com/frame.png' },
      },
    });
    expect(adapter.preflight?.({ route, deployment, input })).toMatch(
      /does not support ratio overrides/i,
    );
    const sourceInput: GenerateInput = parseGenerationRequest({
      modelId: 'alibaba/happy-horse-1.1',
      routeId: route.id,
      operation: 'image-to-video',
      input: {
        prompt: 'Gentle ripples.',
        resolution: '720p',
        duration: 3,
        aspectRatio: 'source',
        firstFrame: { url: 'https://media.example.com/frame.png' },
      },
    });
    expect(adapter.preflight?.({ route, deployment, input: sourceInput })).toBeNull();
  });

  it('enforces HappyHorse 2,500-character Chinese and 5,000-character non-Chinese prompt limits across operations', () => {
    const adapter = createAlibabaMediaAdapter({
      env: {
        ALIBABA_AP_SOUTHEAST_1_API_KEY: 'dashscope-fixture',
        ALIBABA_AP_SOUTHEAST_1_ENDPOINT:
          'https://ws-fixture.ap-southeast-1.maas.aliyuncs.com/api/v1',
      },
    });
    const { route, deployment } = routeAndDeployment(
      'alibaba-model-studio-ap-southeast-1/alibaba-happy-horse-1.1',
    );
    const cases: Array<{
      operation: 'text-to-video' | 'image-to-video' | 'reference-to-video';
      extra: Record<string, unknown>;
    }> = [
      { operation: 'text-to-video', extra: { aspectRatio: '16:9' } },
      {
        operation: 'image-to-video',
        extra: { aspectRatio: 'source', firstFrame: { url: 'https://media.example.com/f.png' } },
      },
      {
        operation: 'reference-to-video',
        extra: {
          aspectRatio: '16:9',
          references: [{ type: 'image', asset: { url: 'https://media.example.com/r.png' } }],
        },
      },
    ];
    for (const { operation, extra } of cases) {
      const make = (prompt: string) =>
        parseGenerationRequest({
          modelId: 'alibaba/happy-horse-1.1',
          routeId: route.id,
          operation,
          input: { prompt, resolution: '720p', duration: 3, ...extra },
        });
      expect(adapter.preflight?.({ route, deployment, input: make('画'.repeat(2500)) })).toBeNull();
      expect(adapter.preflight?.({ route, deployment, input: make('画'.repeat(2501)) })).toMatch(
        /2,500/,
      );
      expect(adapter.preflight?.({ route, deployment, input: make('a'.repeat(5000)) })).toBeNull();
      expect(adapter.preflight?.({ route, deployment, input: make('a'.repeat(5001)) })).toMatch(
        /5,000/,
      );
    }
  });
});

describe('Official xAI Grok Imagine Video edit/extend adapter (synthetic fixtures, no network)', () => {
  it('submits video-edit to /v1/videos/edits and video-extend to /v1/videos/extensions and polls /v1/videos/{id}', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = createXaiAdapter({
      env: { XAI_API_KEY: 'xai-fixture-key' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (init?.method === 'POST') return Response.json({ request_id: 'xai-vid-req-1' });
        return Response.json({
          status: 'done',
          video: { url: 'https://api.x.ai/v1/files/outputs/out.mp4' },
          usage: { cost_in_usd_ticks: 1_500_000_000 },
        });
      },
    });
    const { route, deployment } = routeAndDeployment('xai-undisclosed/xai-grok-imagine-video');
    expect(adapter.isConfigured(route, deployment)).toBe(true);
    const edit = parseGenerationRequest({
      modelId: 'xai/grok-imagine-video',
      routeId: route.id,
      operation: 'video-edit',
      input: {
        prompt: 'Shift lighting to golden hour.',
        sourceVideo: { url: 'https://media.example.com/clip.mp4' },
      },
    });
    expect(edit.input.resolution).toBeUndefined();
    expect(adapter.inputFields?.({ route, deployment, input: edit })).not.toContain('resolution');
    const editWithResolution = parseGenerationRequest({
      modelId: 'xai/grok-imagine-video',
      routeId: route.id,
      operation: 'video-edit',
      input: {
        prompt: 'Shift lighting to golden hour.',
        sourceVideo: { url: 'https://media.example.com/clip.mp4' },
        resolution: '720p',
      },
    });
    expect(adapter.preflight?.({ route, deployment, input: editWithResolution })).toMatch(
      /resolution override/i,
    );
    expect(await adapter.submit({ jobId: 'job-xai-edit', route, deployment, input: edit })).toEqual(
      {
        upstreamId: 'xai-vid-req-1',
      },
    );
    expect(calls[0]).toEqual({
      url: 'https://api.x.ai/v1/videos/edits',
      body: {
        model: 'grok-imagine-video',
        prompt: 'Shift lighting to golden hour.',
        video: { url: 'https://media.example.com/clip.mp4' },
      },
    });
    const polled = await adapter.poll({
      jobId: 'job-xai-edit',
      route,
      deployment,
      input: edit,
      upstreamId: 'xai-vid-req-1',
    });
    expect(polled).toEqual({
      status: 'succeeded',
      billedCostMicros: 150_000,
      outputs: [
        {
          url: 'https://api.x.ai/v1/files/outputs/out.mp4',
          mediaType: 'video/mp4',
          fidelity: 'unverified',
        },
      ],
    });

    const extend = parseGenerationRequest({
      modelId: 'xai/grok-imagine-video',
      routeId: route.id,
      operation: 'video-extend',
      input: {
        prompt: 'Continue panning across the lake.',
        sourceVideo: { url: 'https://media.example.com/clip.mp4' },
        duration: 3,
      },
    });
    await adapter.submit({ jobId: 'job-xai-ext', route, deployment, input: extend });
    expect(calls[2]).toEqual({
      url: 'https://api.x.ai/v1/videos/extensions',
      body: {
        model: 'grok-imagine-video',
        prompt: 'Continue panning across the lake.',
        video: { url: 'https://media.example.com/clip.mp4' },
        duration: 3,
      },
    });
  });
});

describe('Credential snapshots and quotes for new official routes', () => {
  it('snapshots only deployment-scoped Kling and BFL credentials', () => {
    const env = {
      KLING_API_KEY: 'kling-secret',
      BFL_API_KEY: 'bfl-secret',
      OPENAI_API_KEY: 'unrelated-secret',
    };
    const klingDep = catalog.deployments.find((d) => d.id === 'kling-ap-southeast-1')!;
    const bflDep = catalog.deployments.find((d) => d.id === 'bfl-undisclosed')!;
    expect(snapshotCredentialEnvironment(klingDep, env)).toEqual({ KLING_API_KEY: 'kling-secret' });
    expect(snapshotCredentialEnvironment(bflDep, env)).toEqual({ BFL_API_KEY: 'bfl-secret' });
  });

  it('quotes and marks official Kling, BFL, and HappyHorse routes ready for bounded smoke execution', () => {
    const cases = catalogSmokeCases(catalog);
    for (const [routeId, expectedMicros] of [
      ['kling-ap-southeast-1/kling-kling-4.0', 471_000],
      ['kling-ap-southeast-1/kling-kling-4.0-flash', 282_000],
      ['alibaba-model-studio-ap-southeast-1/alibaba-happy-horse-1.1', 210_000],
      ['alibaba-model-studio-eu-central-1/alibaba-happy-horse-1.1', 185_655],
      ['bfl-undisclosed/bfl-flux-3-video', 750_000],
      ['bfl-undisclosed/bfl-flux-3-image', 41_000],
      ['bfl-undisclosed/bfl-flux-3-klein', 8_000],
    ] as const) {
      expect(cases.find((entry) => entry.routeId === routeId)).toMatchObject({
        state: 'ready',
        estimateMicros: expectedMicros,
      });
    }
    const q = quote(
      {
        modelId: 'kling/kling-4.0',
        routeId: 'kling-ap-southeast-1/kling-kling-4.0',
        operation: 'text-to-video',
        input: { prompt: 'Test', resolution: '720p', duration: 3 },
      },
      { executableRouteIds: ['kling-ap-southeast-1/kling-kling-4.0'] },
    );
    expect(q.selectedRouteId).toBe('kling-ap-southeast-1/kling-kling-4.0');
    expect(q.reservationMicros).toBe(471_000);
  });
});
