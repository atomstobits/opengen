import { describe, expect, it } from 'vitest';
import type { GenerateInput, GenerationArguments, Operation } from '@media-router/contracts';
import { catalog } from '@media-router/catalog';
import { createGoogleImageAdapter } from '../packages/engine/src/google.js';
import { createGoogleVideoAdapter } from '../packages/engine/src/google-video.js';
import { SubmissionRejected } from '../packages/engine/src/adapters.js';

type GoogleBody = {
  input: { type: string; text?: string }[];
  response_format: Record<string, unknown>;
};
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpeg = Buffer.from('ffd8ff00000000', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex');
function context(kind: 'image' | 'video', operation: Operation, args: GenerationArguments) {
  const upstream = kind === 'image' ? 'gemini-nano-banana-2.1' : 'gemini-omni-1.1-flash';
  const route = catalog.routes.find(
    (candidate) => candidate.adapter === 'google' && candidate.upstreamModelId === upstream,
  )!;
  const deployment = catalog.deployments.find((candidate) => candidate.id === route.deploymentId)!;
  return {
    jobId: 'canonical-google',
    workspaceId: 'fixture-workspace',
    route,
    deployment,
    input: {
      modelId: route.modelId,
      operation,
      input: {
        prompt: 'A slow cinematic push in.',
        resolution: kind === 'image' ? '1K' : '720p',
        ...(kind === 'video' ? { duration: 5, aspectRatio: '16:9' } : {}),
        ...args,
      },
    } satisfies GenerateInput,
  };
}
const storeOutput = async ({
  mediaType,
}: {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
}) => ({ url: 'https://assets.example.com/output', mediaType, fidelity: 'unverified' as const });

describe('Google canonical adapters', () => {
  it('maps Nano Banana model controls without guessing reference geometry', async () => {
    let posted!: GoogleBody;
    const seen: string[] = [];
    const adapter = createGoogleImageAdapter({
      env: { GEMINI_API_KEY: 'fixture-key' },
      storeOutput,
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return Response.json({ id: 'interaction-image' });
      },
      readAsset: async (url) => {
        seen.push(url);
        return { bytes: png, mediaType: 'image/png' };
      },
    });
    const ctx = context('image', 'image-edit', {
      references: [{ type: 'image', asset: { url: 'https://media.example.com/first.png' } }],
      aspectRatio: 'source',
      outputFormat: 'jpeg',
      seed: 27,
      thinkingLevel: 'high',
      systemPrompt: 'Use a warm palette.',
      grounding: false,
      count: 1,
    });
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'interaction-image' });
    expect(seen).toEqual(['https://media.example.com/first.png']);
    expect(posted).toMatchObject({
      system_instruction: 'Use a warm palette.',
      generation_config: { seed: 27, thinking_level: 'high' },
      tools: [],
      response_format: { type: 'image', mime_type: 'image/jpeg', image_size: '1K' },
    });
    expect(posted.response_format).not.toHaveProperty('aspect_ratio');
    expect(posted.input.map((part: { type: string }) => part.type)).toEqual(['text', 'image']);
  });
  it('verifies and stores the explicitly requested image output format', async () => {
    const adapter = createGoogleImageAdapter({
      env: { GEMINI_API_KEY: 'fixture-key' },
      storeOutput,
      fetch: async () =>
        Response.json({
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'image', mime_type: 'image/jpeg', data: jpeg.toString('base64') }],
            },
          ],
        }),
    });
    const ctx = context('image', 'text-to-image', { outputFormat: 'jpeg' });
    const result = await adapter.poll({ ...ctx, upstreamId: 'interaction-image' });
    expect(result).toMatchObject({ status: 'succeeded', outputs: [{ mediaType: 'image/jpeg' }] });
    await expect(
      adapter.poll({
        ...context('image', 'text-to-image', { outputFormat: 'png' }),
        upstreamId: 'interaction-image',
      }),
    ).rejects.toThrow('requested single image format');
  });
  it('binds first/last frames and ordered subject references to explicit Omni roles', async () => {
    let posted!: GoogleBody;
    const read: string[] = [];
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture-key' },
      storeOutput,
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return Response.json({ id: 'interaction-video' });
      },
      readAsset: async (url) => {
        read.push(url);
        return { bytes: png, mediaType: 'image/png' };
      },
    });
    const ctx = context('video', 'image-to-video', {
      firstFrame: { url: 'https://media.example.com/first.png' },
      lastFrame: { url: 'https://media.example.com/last.png' },
      references: Array.from({ length: 6 }, (_, index) => ({
        type: 'image' as const,
        asset: { url: `https://media.example.com/ref-${index}.png` },
      })),
      audio: true,
      outputFormat: 'mp4',
      count: 1,
    });
    expect(await adapter.submit(ctx)).toEqual({ upstreamId: 'interaction-video' });
    expect(read.slice(0, 3)).toEqual([
      'https://media.example.com/first.png',
      'https://media.example.com/last.png',
      'https://media.example.com/ref-0.png',
    ]);
    expect(posted.input.at(-1)?.text).toBe(
      '[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] [# References <IMAGE_REF_0>@Image3 <IMAGE_REF_1>@Image4 <IMAGE_REF_2>@Image5 <IMAGE_REF_3>@Image6 <IMAGE_REF_4>@Image7 <IMAGE_REF_5>@Image8] A slow cinematic push in.',
    );
    expect(posted.response_format).toMatchObject({
      aspect_ratio: '16:9',
      duration: '5s',
      resolution: '720p',
    });
  });
  it('maps a named source video and omits only the qualified inherited extension ratio', async () => {
    let posted!: GoogleBody;
    const adapter = createGoogleVideoAdapter({
      env: { GEMINI_API_KEY: 'fixture-key' },
      storeOutput,
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return Response.json({ id: 'interaction-video' });
      },
      readAsset: async () => ({ bytes: mp4, mediaType: 'video/mp4' }),
    });
    const ctx = context('video', 'video-extend', {
      sourceVideo: { url: 'https://media.example.com/source.mp4' },
      aspectRatio: 'source',
    });
    await adapter.submit(ctx);
    expect(posted.input.map((part: { type: string }) => part.type)).toEqual(['video', 'text']);
    expect(posted.input.at(-1)?.text).toContain('[# Sources <VIDEO_0>@Video1]');
    expect(posted.response_format).not.toHaveProperty('aspect_ratio');
    expect(
      adapter.preflight!({
        ...ctx,
        input: { ...ctx.input, input: { ...ctx.input.input, aspectRatio: '16:9' } },
      }),
    ).toContain('preserves its source ratio');
  });
  it('rejects unsupported options, unresolved assets, and unqualified source inheritance before network work', async () => {
    let requests = 0;
    const shared = {
      env: { GEMINI_API_KEY: 'fixture-key' },
      storeOutput,
      fetch: async () => {
        requests++;
        return Response.json({ id: 'unreachable' });
      },
    };
    const image = createGoogleImageAdapter(shared);
    const video = createGoogleVideoAdapter(shared);
    await expect(
      image.submit(context('image', 'text-to-image', { grounding: true })),
    ).rejects.toThrow('citation delivery');
    await expect(
      image.submit(
        context('image', 'image-edit', {
          references: [{ type: 'image', asset: { assetKey: 'inputs/private.png' } }],
        }),
      ),
    ).rejects.toBeInstanceOf(SubmissionRejected);
    await expect(
      video.submit(
        context('video', 'image-to-video', {
          firstFrame: { url: 'https://media.example.com/first.png' },
          aspectRatio: 'source',
        }),
      ),
    ).rejects.toThrow('qualified only for extension');
    await expect(video.submit(context('video', 'text-to-video', { seed: 1 }))).rejects.toThrow(
      'does not implement seed',
    );
    await expect(
      video.submit(
        context('video', 'reference-to-video', {
          references: [{ type: 'video', asset: { url: 'https://media.example.com/ref.mp4' } }],
        }),
      ),
    ).rejects.toThrow('image references only');
    expect(requests).toBe(0);
  });
});
