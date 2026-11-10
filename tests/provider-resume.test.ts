import { describe, expect, it } from 'vitest';
import type {
  Deployment,
  GenerateInput,
  GenerationArguments,
  Route,
} from '@media-router/contracts';
import { SubmissionRejected } from '../packages/engine/src/adapters.js';
import { createReplicateAdapter } from '../packages/engine/src/replicate.js';
import { createGoogleVideoAdapter } from '../packages/engine/src/google-video.js';
const source = { url: 'https://example.com/docs', checkedAt: '2026-11-02' };
function context(
  provider: string,
  model: string,
  change: Partial<GenerationArguments> &
    Pick<Partial<GenerateInput>, 'operation' | 'previousJobId'> = {},
) {
  const { operation = 'text-to-video', previousJobId, ...args } = change;
  const deployment: Deployment = {
    id: `${provider}-undisclosed`,
    providerId: provider,
    name: provider,
    endpointRegion: 'undisclosed',
    scope: 'undisclosed',
    processingRegions: null,
    storageRegions: null,
    endpointTemplate: null,
    credentialEnv: null,
    source,
  };
  const route: Route = {
    id: `${provider}/fixture`,
    modelId: `${provider}/fixture`,
    deploymentId: deployment.id,
    upstreamModelId: model,
    operations: ['text-to-video'],
    resolutions: ['720p'],
    durations: [5],
    fidelity: 'unknown',
    adapter: provider as Route['adapter'],
    status: 'documented',
    rates: [],
    source,
    pricingSource: source,
  };
  return {
    jobId: 'fixture-job',
    workspaceId: 'fixture-workspace',
    route,
    deployment,
    input: {
      modelId: route.modelId,
      operation,
      previousJobId,
      input: {
        prompt: 'A calm sea.',
        resolution: '720p',
        duration: operation.includes('image') && operation !== 'image-to-video' ? undefined : 5,
        aspectRatio:
          operation === 'video-extend' || (provider !== 'google' && operation === 'image-to-video')
            ? 'source'
            : operation === 'text-to-video' ||
                operation === 'reference-to-video' ||
                operation === 'image-to-video' ||
                operation === 'video-edit'
              ? '16:9'
              : undefined,
        ...args,
      },
    } satisfies GenerateInput,
  };
}
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex');
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const storeOutput = async ({ mediaType }: { mediaType: 'image/png' | 'video/mp4' }) => ({
  url: 'https://assets.example.com/output',
  mediaType,
  fidelity: 'unverified' as const,
  expiresAt: '2026-11-03T00:00:00Z',
});
describe('Replicate explicit model resume and credential delivery', () => {
  it('persists prediction ID and archives authenticated delivery before returning browser-safe output', async () => {
    const adapter = createReplicateAdapter({
      env: { REPLICATE_API_TOKEN: 'fixture-key' },
      storeOutput,
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          expect(String(url)).toBe(
            'https://api.replicate.com/v1/models/bytedance/seedance-2.5/predictions',
          );
          expect(JSON.parse(String(init.body))).toMatchObject({
            input: { duration: 5, resolution: '720p', output_format: 'mp4', generate_audio: true },
          });
          return Response.json({ id: 'prediction' });
        }
        return Response.json({
          status: 'succeeded',
          output: 'https://media.replicate.delivery/result.mp4',
          urls: { get: 'https://attacker.example.com/' },
        });
      },
      readAsset: async (url, options) => {
        expect(url).toBe('https://media.replicate.delivery/result.mp4');
        expect(options?.headers).toEqual({ Authorization: 'Bearer fixture-key' });
        expect(options?.credentialHosts).toEqual(['.replicate.delivery']);
        return { bytes: mp4, mediaType: 'video/mp4' };
      },
    });
    const ctx = context('replicate', 'bytedance/seedance-2.5');
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'prediction' });
    const result = await adapter.poll({ ...ctx, upstreamId: 'prediction' });
    expect(result).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ url: 'https://assets.example.com/output', expiresAt: '2026-11-03T00:00:00Z' }],
    });
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });
  it('does not send delivery credentials to a provider-returned arbitrary host', async () => {
    let downloads = 0;
    const adapter = createReplicateAdapter({
      env: { REPLICATE_API_TOKEN: 'fixture' },
      storeOutput,
      fetch: async () =>
        Response.json({ status: 'succeeded', output: 'https://attacker.example.com/result.mp4' }),
      readAsset: async () => {
        downloads++;
        return { bytes: mp4, mediaType: 'video/mp4' };
      },
    });
    await expect(
      adapter.poll({ ...context('replicate', 'bytedance/seedance-2.5'), upstreamId: 'id' }),
    ).rejects.toThrow('Credentials were not sent');
    expect(downloads).toBe(0);
  });
  it('does not reinterpret1.5K layer decomposition as standard image generation', async () => {
    const adapter = createReplicateAdapter({
      env: { REPLICATE_API_TOKEN: 'fixture' },
      storeOutput,
    });
    await expect(
      adapter.submit(
        context('replicate', 'bytedance/seedream-5-pro', {
          operation: 'text-to-image',
          resolution: '1.5K',
        }),
      ),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(
      adapter.isConfigured(
        { ...context('replicate', 'unapproved/model').route },
        context('replicate', 'unapproved/model').deployment,
      ),
    ).toBe(false);
  });
});
describe('Google Omni exact duration and continued interactions', () => {
  it('requests background generation with the documented seconds suffix and persists the interaction ID', async () => {
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      storeOutput,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'gemini-omni-1.1-flash',
          background: true,
          store: true,
          generation_config: { video_config: { task: 'text_to_video' } },
          response_format: {
            type: 'video',
            duration: '5s',
            resolution: '720p',
            aspect_ratio: '16:9',
          },
        });
        return Response.json({ id: 'interaction' });
      },
    });
    expect(await adapter.submit(context('google', 'gemini-omni-1.1-flash'))).toEqual({
      upstreamId: 'interaction',
    });
  });
  it('loads safe reference bytes and keeps first/last image ordering', async () => {
    const read: string[] = [];
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      storeOutput,
      readAsset: async (url) => {
        read.push(url);
        return { bytes: png, mediaType: 'image/png' };
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.input.slice(0, 2)).toEqual([
          { type: 'image', mime_type: 'image/png', data: png.toString('base64') },
          { type: 'image', mime_type: 'image/png', data: png.toString('base64') },
        ]);
        return Response.json({ id: 'frames' });
      },
    });
    await adapter.submit(
      context('google', 'gemini-omni-1.1-flash', {
        operation: 'image-to-video',
        firstFrame: { url: 'https://media.example.com/first.png' },
        lastFrame: { url: 'https://media.example.com/last.png' },
      }),
    );
    expect(read).toEqual([
      'https://media.example.com/first.png',
      'https://media.example.com/last.png',
    ]);
  });
  it('never submits after a reference fails safe loading', async () => {
    let requests = 0;
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      storeOutput,
      readAsset: async () => {
        throw new Error('private DNS');
      },
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    });
    await expect(
      adapter.submit(
        context('google', 'gemini-omni-1.1-flash', {
          operation: 'image-to-video',
          firstFrame: { url: 'https://media.example.com/source.png' },
        }),
      ),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    expect(requests).toBe(0);
  });
  it('uses only an engine-verified previous interaction for continuation', async () => {
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      storeOutput,
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          previous_interaction_id: 'original-interaction',
          generation_config: { video_config: { task: 'edit' } },
        });
        return Response.json({ id: 'edited-interaction' });
      },
    });
    const ctx = context('google', 'gemini-omni-1.1-flash', {
      operation: 'video-edit',
      previousJobId: 'owned-job',
    });
    await expect(adapter.submit(ctx)).rejects.toBeInstanceOf(SubmissionRejected);
    expect(await adapter.submit({ ...ctx, previousUpstreamId: 'original-interaction' })).toEqual({
      upstreamId: 'edited-interaction',
    });
  });
  it('archives the final video while excluding thought/other output blocks', async () => {
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture' },
      storeOutput,
      fetch: async () =>
        Response.json({
          status: 'completed',
          steps: [
            { type: 'thought', content: [{ type: 'video', data: 'untrusted' }] },
            {
              type: 'model_output',
              content: [{ type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') }],
            },
          ],
        }),
    });
    expect(
      await adapter.poll({ ...context('google', 'gemini-omni-1.1-flash'), upstreamId: 'id' }),
    ).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      outputs: [{ mediaType: 'video/mp4', expiresAt: '2026-11-03T00:00:00Z' }],
    });
  });
});
