import { describe, expect, it } from 'vitest';
import type { Deployment, GenerateInput, Route } from '@media-router/contracts';
import {
  alibabaCredentials,
  createAlibabaAdapter,
  createBytePlusAdapter,
  createEngine,
  SubmissionRejected,
  SubmissionUnknown,
} from '@media-router/engine';
const source = {
  url: 'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference',
  checkedAt: '2026-11-02',
};
const deployment: Deployment = {
  id: 'alibaba/singapore',
  providerId: 'alibaba',
  name: 'Singapore',
  endpointRegion: 'ap-southeast-1',
  scope: 'international',
  processingRegions: null,
  storageRegions: null,
  endpointTemplate: 'https://{workspace}.ap-southeast-1.maas.aliyuncs.com/api/v1',
  credentialEnv: 'ALIBABA_AP_SOUTHEAST_1_API_KEY',
  source,
};
const route: Route = {
  id: 'alibaba/singapore/wan-3.0',
  modelId: 'alibaba/wan-3.0',
  deploymentId: deployment.id,
  upstreamModelId: 'wan3.0-video',
  operations: ['text-to-video', 'image-to-video'],
  resolutions: ['720p'],
  durations: [5],
  fidelity: 'unknown',
  adapter: 'alibaba',
  status: 'documented',
  rates: [{ resolution: '720p', unit: 'output-second', usdMicros: 100000 }],
  source,
  pricingSource: source,
};
const input: GenerateInput = {
  modelId: route.modelId,
  operation: 'text-to-video',
  input: {
    prompt: 'A calm sea.',
    resolution: '720p',
    duration: 5,
  },
};
const context = { jobId: 'job', input, route, deployment };
const env = {
  ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture-key',
  ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID: 'fixture-workspace',
};
describe('Alibaba adapter protocol boundaries (no live calls)', () => {
  it('does not treat failed provider generation as an authoritative free charge', async () => {
    const adapter = createAlibabaAdapter({
      env,
      fetch: async () =>
        new Response(
          JSON.stringify({ output: { task_status: 'FAILED', code: 'private-provider-details' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const result = await adapter.poll({ ...context, upstreamId: 'failed-task' });
    expect(result.status).toBe('failed');
    expect(result.billedCostMicros).toBeNull();
    expect(result.error).not.toContain('private-provider-details');
  });
  it('does not reuse a shared key outside its explicitly configured region', () => {
    const shared = {
      DASHSCOPE_API_KEY: 'fixture',
      ALIBABA_WORKSPACE_ID: 'workspace',
      ALIBABA_REGION: 'cn-beijing',
    };
    expect(alibabaCredentials(deployment, shared)).toBeNull();
    expect(
      alibabaCredentials(deployment, { ...shared, ALIBABA_REGION: 'ap-southeast-1' })?.workspaceId,
    ).toBe('workspace');
    expect(alibabaCredentials(deployment, env)?.apiKey).toBe('fixture-key');
  });
  it('uses the regional endpoint and documented asynchronous request shape', async () => {
    let requestedUrl = '';
    let requestedBody: Record<string, unknown> = {};
    const adapter = createAlibabaAdapter({
      env,
      fetch: async (url, init) => {
        requestedUrl = String(url);
        requestedBody = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).get('X-DashScope-Async')).toBe('enable');
        return Response.json({ output: { task_id: 'provider-task' } });
      },
    });
    expect(await adapter.submit(context)).toEqual({ upstreamId: 'provider-task' });
    expect(requestedUrl).toBe(
      'https://fixture-workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    );
    expect(requestedBody).toMatchObject({
      model: 'wan3.0-video',
      input: { prompt: input.input.prompt },
      parameters: { resolution: '720P', duration: 5 },
    });
  });
  it('uses actual usage duration with the snapshotted regional rate', async () => {
    const adapter = createAlibabaAdapter({
      env,
      fetch: async () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: 'https://result.example.com/video.mp4' },
          usage: { duration: 4.5 },
        }),
    });
    const result = await adapter.poll({ ...context, upstreamId: 'task' });
    expect(result.status).toBe('succeeded');
    expect(result.billedCostMicros).toBe(450000);
    expect(result.outputs?.[0]?.fidelity).toBe('unverified');
  });
  it('does not present a quote as settled cost when provider usage is missing', async () => {
    const adapter = createAlibabaAdapter({
      env,
      fetch: async () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: 'https://result.example.com/video.mp4' },
        }),
    });
    expect((await adapter.poll({ ...context, upstreamId: 'task' })).billedCostMicros).toBeNull();
  });
  it('distinguishes definitive rejection from an ambiguous paid submission', async () => {
    const rejected = createAlibabaAdapter({
      env,
      fetch: async () => new Response('', { status: 422 }),
    });
    await expect(rejected.submit(context)).rejects.toBeInstanceOf(SubmissionRejected);
    const timedOut = createAlibabaAdapter({
      env,
      fetch: async () => {
        throw new Error('timeout');
      },
    });
    await expect(timedOut.submit(context)).rejects.toBeInstanceOf(SubmissionUnknown);
    const serverError = createAlibabaAdapter({
      env,
      fetch: async () => new Response('', { status: 503 }),
    });
    await expect(serverError.submit(context)).rejects.toBeInstanceOf(SubmissionUnknown);
  });
  it('refuses reference URLs that do not use public HTTPS hostnames', async () => {
    let calls = 0;
    const adapter = createAlibabaAdapter({
      env,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    for (const url of [
      'http://images.example.com/image.png',
      'https://127.0.0.1/a',
      'https://localhost/a',
      'https://user:secret@example.com/a',
    ]) {
      await expect(
        adapter.submit({
          ...context,
          input: {
            ...input,
            operation: 'image-to-video',
            input: {
              ...input.input,
              firstFrame: { url: url },
            },
          },
        }),
      ).rejects.toBeInstanceOf(SubmissionRejected);
    }
    expect(calls).toBe(0);
  });
  it('uses the same preflight for route eligibility and submission without connecting to a database', async () => {
    const alibaba = createAlibabaAdapter({ env });
    const byteplus = createBytePlusAdapter({ env: { BYTEPLUS_API_KEY: 'fixture' } });
    const engine = createEngine({
      databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
      adapters: [alibaba, byteplus],
      catalog: {
        providers: [],
        models: [],
        deployments: [deployment, imageDeployment],
        routes: [route, imageRoute],
      },
    });
    try {
      expect(engine.getExecutableRouteIds(input)).toEqual([route.id]);
      expect(
        engine.getExecutableRouteIds({
          ...input,
          operation: 'image-to-video',
          input: {
            ...input.input,
            firstFrame: { url: 'https://example.com/first.png' },
          },
        }),
      ).toEqual([route.id]);
      expect(
        engine.getExecutableRouteIds({
          ...input,
          operation: 'image-to-video',
          input: {
            ...input.input,
            firstFrame: { url: 'https://example.com/first.png' },
            lastFrame: { url: 'https://example.com/second.png' },
            references: [{ type: 'image', asset: { url: 'https://example.com/ref.png' } }],
          },
        }),
      ).toEqual([]);
      expect(engine.getExecutableRouteIds(imageInput)).toEqual([imageRoute.id]);
      expect(
        engine.getExecutableRouteIds({
          ...imageInput,
          input: {
            ...imageInput.input,
            aspectRatio: 'invalid',
          },
        }),
      ).toEqual([]);
    } finally {
      await engine.close();
    }
  });
});
const imageDeployment: Deployment = {
  ...deployment,
  id: 'byteplus/singapore',
  providerId: 'byteplus',
  credentialEnv: 'BYTEPLUS_API_KEY',
};
const imageRoute: Route = {
  ...route,
  id: 'byteplus/singapore/seedream-pro',
  modelId: 'bytedance/seedream-5.0-pro',
  deploymentId: imageDeployment.id,
  adapter: 'byteplus',
  upstreamModelId: 'dola-seedream-5-0-pro-260628',
  operations: ['text-to-image'],
  resolutions: ['1K', '1.5K', '2K'],
  durations: [],
  rates: [
    { resolution: '1K', unit: 'image', usdMicros: 45000 },
    { resolution: '1.5K', unit: 'image', usdMicros: 45000 },
    { resolution: '2K', unit: 'image', usdMicros: 90000 },
  ],
};
const imageInput: GenerateInput = {
  modelId: imageRoute.modelId,
  operation: 'text-to-image',
  input: {
    prompt: 'A ceramic cup in soft light.',
    resolution: '1K',
  },
};
const imageContext = {
  jobId: 'image-job',
  input: imageInput,
  route: imageRoute,
  deployment: imageDeployment,
};
describe('BytePlus synchronous image adapter (no live calls)', () => {
  it('uses the documented Seedream request and returns an immediate result, never a fabricated task ID', async () => {
    const adapter = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async (url, init) => {
        expect(String(url)).toBe(
          'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          model: imageRoute.upstreamModelId,
          prompt: imageInput.input.prompt,
          size: '1K',
          response_format: 'url',
          output_format: 'png',
          watermark: true,
        });
        return Response.json({
          data: [
            {
              url: 'https://result.example.com/image.png',
              size: '1024x1024',
              output_format: 'png',
            },
          ],
          usage: { generated_images: 1 },
        });
      },
    });
    const result = await adapter.submit(imageContext);
    expect(result.upstreamId).toBeUndefined();
    expect(result.immediateResult).toMatchObject({
      status: 'succeeded',
      billedCostMicros: 45000,
      outputs: [{ mediaType: 'image/png', fidelity: 'unverified' }],
    });
  });
  it('prices the actual returned pixel tier and leaves unqualified usage pending', async () => {
    const highResolution = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          data: [{ url: 'https://result.example.com/image.png', size: '2048x2048' }],
          usage: { generated_images: 1 },
        }),
    });
    expect((await highResolution.submit(imageContext)).immediateResult?.billedCostMicros).toBe(
      90000,
    );
    const missingDimensions = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async () =>
        Response.json({
          data: [{ url: 'https://result.example.com/image.png' }],
          usage: { generated_images: 1 },
        }),
    });
    expect(
      (await missingDimensions.submit(imageContext)).immediateResult?.billedCostMicros,
    ).toBeNull();
  });
  it('refuses unsupported inputs before calling the provider', async () => {
    let calls = 0;
    const adapter = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(
      adapter.submit({
        ...imageContext,
        input: {
          ...imageInput,
          input: {
            ...imageInput.input,
            aspectRatio: 'invalid',
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    await expect(
      adapter.submit({
        ...imageContext,
        input: {
          ...imageInput,
          input: {
            ...imageInput.input,
            references: ['https://example.com/input.png'].map((url) => ({
              type: 'image',
              asset: { url },
            })),
          },
        },
      }),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(calls).toBe(0);
  });
  it('does not retry an interrupted synchronous generation or assume it was free', async () => {
    const interrupted = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async () => {
        throw new Error('Connection interrupted.');
      },
    });
    await expect(interrupted.submit(imageContext)).rejects.toBeInstanceOf(SubmissionUnknown);
    const invalidResponse = createBytePlusAdapter({
      env: { BYTEPLUS_API_KEY: 'fixture' },
      fetch: async () => Response.json({ data: [] }),
    });
    await expect(invalidResponse.submit(imageContext)).rejects.toBeInstanceOf(SubmissionUnknown);
  });
});
