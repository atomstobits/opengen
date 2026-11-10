import { afterEach, describe, expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { buildApp } from '../apps/server/src/app.js';
import {
  createEngine,
  executionScopeAllows,
  readExecutionScopeConfiguration,
  type ExecutionScope,
} from '../packages/engine/src/index.js';

const profile: ExecutionScope = {
  profile: 'qualification-sg-v1',
  firstFrameSha256: 'a'.repeat(64),
};
const video: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  operation: 'text-to-video',
  billing: 'managed',
  routing: { fallback: false },
  input: {
    prompt: 'Synthetic qualification scope test.',
    resolution: '480p',
    duration: 2,
    count: 1,
    aspectRatio: '16:9',
  },
};
const image: GenerateInput = {
  modelId: 'qwen/image-2.1-turbo',
  routeId: 'alibaba-model-studio-ap-southeast-1/qwen-image-2.1-turbo',
  operation: 'text-to-image',
  billing: 'managed',
  routing: { fallback: false },
  input: {
    prompt: 'Synthetic scope test.',
    resolution: '1K',
    count: 1,
    aspectRatio: '1:1',
    watermark: true,
    promptExtend: false,
    thinking: false,
  },
};
const route = (request: GenerateInput) =>
  catalog.routes.find((route) => route.id === request.routeId)!;
const allows = (request: GenerateInput) =>
  executionScopeAllows(profile, route(request), parseGenerationRequest(request));
const engines: ReturnType<typeof createEngine>[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
});
function engine() {
  const value = createEngine({
    databaseUrl: 'postgresql://127.0.0.1:1/no_connection_used',
    executionScope: profile,
    adapters: [
      {
        id: 'alibaba',
        isConfigured: () => true,
        submit: async () => {
          throw new Error('No provider calls allowed.');
        },
        poll: async () => {
          throw new Error('No provider calls allowed.');
        },
      },
    ],
  });
  engines.push(value);
  return value;
}

describe('operator qualification execution scope', () => {
  it('keeps unrestricted self hosting explicit and rejects malformed operator controls', () => {
    expect(readExecutionScopeConfiguration({})).toEqual({ profile: 'unrestricted' });
    expect(
      readExecutionScopeConfiguration({ OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1' }),
    ).toEqual({ profile: 'qualification-sg-v1' });
    for (const env of [
      { OPENGEN_EXECUTION_SCOPE: '' },
      { OPENGEN_EXECUTION_SCOPE: 'all' },
      {
        OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1',
        OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: '',
      },
      {
        OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1',
        OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: 'not-a-digest',
      },
      { OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: 'a'.repeat(64) },
    ])
      expect(() => readExecutionScopeConfiguration(env)).toThrow();
  });

  it('allows precisely the five request shapes, with existing Qwen adapter defaults', () => {
    for (const modelId of ['alibaba/wan-3.0', 'alibaba/wan-3.0-prime']) {
      const request = {
        ...video,
        modelId,
        routeId: `alibaba/ap-southeast-1/${modelId.split('/')[1]}`,
      };
      expect(allows(request)).toBe(true);
      expect(
        allows({
          ...request,
          operation: 'image-to-video',
          input: {
            ...request.input,
            aspectRatio: 'source',
            firstFrame: { assetKey: 'owned-fixture' },
          },
        }),
      ).toBe(true);
    }
    expect(allows(image)).toBe(true);
    expect(allows({ ...image, input: { prompt: image.input.prompt } })).toBe(true);
    expect(
      executionScopeAllows({ profile: 'qualification-sg-v1' }, route(video), {
        ...video,
        operation: 'image-to-video',
        input: { ...video.input, aspectRatio: 'source', firstFrame: { assetKey: 'owned-fixture' } },
      }),
    ).toBe(false);
  });

  it.each([
    ['same-price 2K', { ...image, input: { ...image.input, resolution: '2K' } }],
    ['count', { ...image, input: { ...image.input, count: 2 } }],
    ['duration', { ...video, input: { ...video.input, duration: 3 } }],
    ['resolution', { ...video, input: { ...video.input, resolution: '720p' } }],
    ['aspect ratio', { ...video, input: { ...video.input, aspectRatio: '1:1' } }],
    ['watermark', { ...image, input: { ...image.input, watermark: false } }],
    ['prompt expansion', { ...image, input: { ...image.input, promptExtend: true } }],
    ['seed', { ...image, input: { ...image.input, seed: 1 } }],
    ['audio', { ...video, input: { ...video.input, audio: false } }],
    ['BYOK', { ...image, billing: 'byok' }],
    ['fallback', { ...image, routing: { fallback: true } }],
    [
      'extra reference',
      {
        ...image,
        operation: 'image-edit',
        input: {
          ...image.input,
          references: [{ type: 'image', asset: { url: 'https://example.invalid/input.png' } }],
        },
      },
    ],
    [
      'external frame',
      {
        ...video,
        operation: 'image-to-video',
        input: {
          ...video.input,
          aspectRatio: 'source',
          firstFrame: { url: 'https://assets.opengen.dev/owned/not-proof.png' },
        },
      },
    ],
  ] as [string, GenerateInput][])('rejects %s without broadening a fixed row', (_name, request) => {
    expect(executionScopeAllows(profile, route(request), request)).toBe(false);
  });

  it('does not allow another regional route, Pro identity, or operation', () => {
    for (const candidate of catalog.routes.filter(
      (candidate) => candidate.modelId === 'alibaba/wan-3.0' && candidate.id !== video.routeId,
    ))
      expect(executionScopeAllows(profile, candidate, { ...video, routeId: candidate.id })).toBe(
        false,
      );
    const pro = catalog.routes.find(
      (candidate) => candidate.modelId === 'alibaba/qwen-image-2.1-pro',
    )!;
    expect(
      executionScopeAllows(profile, pro, { ...image, modelId: pro.modelId, routeId: pro.id }),
    ).toBe(false);
    expect(
      executionScopeAllows(profile, route(image), { ...image, operation: 'image-to-video' }),
    ).toBe(false);
  });

  it('retains equal published prices while refusing the unqualified request, even with supplied IDs', () => {
    const value = engine();
    const ids = value.getExecutableRouteIds();
    expect(ids).toEqual(expect.arrayContaining([video.routeId, image.routeId]));
    expect(ids).toHaveLength(3);
    const one = value.quoteGeneration(image, { executableRouteIds: ids });
    const two = value.quoteGeneration(
      { ...image, input: { ...image.input, resolution: '2K' } },
      { executableRouteIds: ids },
    );
    expect(one.selectedRouteId).toBe(image.routeId);
    expect(one.candidates[0]?.estimatedCostMicros).toBe(16_000);
    expect(two.candidates[0]?.estimatedCostMicros).toBe(16_000);
    expect(two.candidates[0]).toMatchObject({
      executable: false,
      reason: expect.stringContaining('qualification scope'),
    });
    expect(two.selectedRouteId).toBeNull();
    expect(two.reservationMicros).toBeNull();
  });

  it('shares scope eligibility with ordinary anonymous HTTP and batch quotes without changing discovery', async () => {
    const value = engine();
    const app = await buildApp({ engine: value });
    apps.push(app);
    const accepted = await app.inject({ method: 'POST', url: '/v1/quotes', payload: image });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().selectedRouteId).toBe(image.routeId);
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: { ...image, input: { ...image.input, resolution: '2K' } },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().selectedRouteId).toBeNull();
    expect(rejected.json().candidates[0].estimatedCostMicros).toBe(16_000);
    expect((await app.inject({ url: '/v1/catalog' })).json().routes).toHaveLength(
      catalog.routes.length,
    );
    expect(JSON.stringify(rejected.json())).not.toContain(profile.firstFrameSha256);
  });
});
