import { describe, expect, it } from 'vitest';
import { catalog, getModel, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import {
  getGenerationDefinition,
  parseGenerationRequest,
} from '@media-router/contracts/generation';
import { createMiniMaxAdapter } from '../packages/engine/src/minimax.js';
import { catalogSmokeCases } from '../scripts/live-smoke.js';

const nativeRoute = (modelId: string) =>
  catalog.routes.find((route) => route.modelId === modelId && route.adapter === 'minimax')!;
const request = (
  modelId = 'minimax/h3-lite',
  resolution = '480p',
  duration = 4,
): GenerateInput => ({
  modelId,
  routeId: nativeRoute(modelId).id,
  operation: 'text-to-video',
  input: { prompt: 'A paper boat on still water.', resolution, duration },
  routing: { fallback: false },
});
const quoted = (input: GenerateInput) => quote(input, { executableRouteIds: [input.routeId!] });

describe('native MiniMax H3 text-only tariffs', () => {
  it.each([
    ['minimax/h3', '768p', 4, 320_000],
    ['minimax/h3', '2K', 4, 520_000],
    ['minimax/h3-highspeed', '480p', 4, 160_000],
    ['minimax/h3-highspeed', '768p', 4, 240_000],
    ['minimax/h3-lite', '480p', 4, 100_000],
    ['minimax/h3-lite', '768p', 4, 160_000],
    ['minimax/h3-max', '480p', 5, 250_000],
    ['minimax/h3-max', '768p', 5, 400_000],
  ] as const)('quotes %s %s %ss through the common path', (modelId, resolution, duration, cost) => {
    const input = request(modelId, resolution, duration);
    const result = quoted(input);
    expect(result.selectedRouteId).toBe(input.routeId);
    expect(result.reservationMicros).toBe(cost);
    expect(result.candidates[0]).toMatchObject({
      estimatedCostMicros: cost,
      source: {
        checkedAt: '2026-11-03',
        url: 'https://platform.minimax.io/docs/pricing/overview#video',
      },
    });
    expect(result.candidates[0]!.notices.join(' ')).toContain('not settled billing');
    expect(Math.min(...nativeRoute(modelId).durations)).toBe(duration);
    if (modelId !== 'minimax/h3-max')
      expect(
        getGenerationDefinition(modelId, 'text-to-video')!.capabilities.duration!.minimum,
      ).toBe(4);
  });

  it('plans the smallest native Lite case without changing the shared five-second default', () => {
    const input = request();
    const route = nativeRoute(input.modelId);
    expect(catalogSmokeCases(catalog).find((entry) => entry.routeId === route.id)).toMatchObject({
      state: 'ready',
      estimateMicros: 100_000,
      reserveMicros: 200_000,
      input: {
        modelId: 'minimax/h3-lite',
        routeId: route.id,
        operation: 'text-to-video',
        input: { resolution: '480p', duration: 4 },
        routing: { fallback: false },
      },
    });
    expect(
      parseGenerationRequest({
        modelId: input.modelId,
        operation: input.operation,
        input: { prompt: 'A paper boat.' },
      }).input.duration,
    ).toBe(5);
    expect(quoted({ ...input, maxCostMicros: 99_999 }).selectedRouteId).toBeNull();
    expect(quote(input).selectedRouteId).toBeNull();
  });

  it.each(['minimax/h3', 'minimax/h3-highspeed', 'minimax/h3-lite', 'minimax/h3-max'])(
    'does not extend %s output-only pricing to frames, references or extra modes',
    (modelId) => {
      const input = request(modelId, '768p', 5);
      const asset = { url: 'https://media.example.com/input.png' };
      const candidates: GenerateInput[] = [
        {
          ...input,
          operation: 'image-to-video',
          input: { ...input.input, firstFrame: asset, aspectRatio: 'source' },
        },
        {
          ...input,
          operation: 'reference-to-video',
          input: { ...input.input, references: [{ type: 'image', asset }] },
        },
        { ...input, input: { ...input.input, promptExpansion: 'quality' } },
      ];
      for (const candidate of candidates) {
        const result = quoted(candidate);
        expect(result.selectedRouteId).toBeNull();
        expect(result.candidates[0]!.estimatedCostMicros).toBeNull();
      }
      expect(nativeRoute(modelId).rates.every((rate) => rate.operation === 'text-to-video')).toBe(
        true,
      );
    },
  );

  it('rejects multiple outputs and an unsupported audio-off request before pricing', () => {
    const input = request();
    for (const invalid of [{ count: 2 }, { audio: false }])
      expect(() => quoted({ ...input, input: { ...input.input, ...invalid } })).toThrow();
  });

  it('keeps native Max at five seconds and preserves the separate reseller variants', () => {
    const input = request('minimax/h3-max', '480p', 4);
    expect(quoted(input).selectedRouteId).toBeNull();
    expect(quoted(input).candidates[0]!.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unsupported_duration' })]),
    );
    const falMax = catalog.routes.find((route) => route.id === 'fal-undisclosed/fal-h3-max')!;
    expect(falMax.pricingSource.url).toBe('https://fal.ai/models/minimax/h3-max/text-to-video');
    expect(falMax.rates.map((rate) => [rate.resolution, rate.usdMicros])).toEqual([
      ['480p', 50_000],
      ['768p', 80_000],
      ['1080p', 160_000],
    ]);
    expect(getModel('fal/h3-max')!.id).toBe('minimax/h3-max');
    expect(getModel('fal/h3-max-turbo')!.id).toBe('fal/h3-max-turbo');
    expect(getModel('pika/h3-flex')!.id).toBe('pika/h3-flex');
  });

  it('maps four-second Lite text inputs and leaves provider billing unresolved without a charge', async () => {
    const input = parseGenerationRequest(request());
    const route = nativeRoute(input.modelId);
    const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
    const adapter = createMiniMaxAdapter({
      env: { MINIMAX_API_KEY: 'fixture' },
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toEqual({
            model: 'MiniMax-H3-Lite',
            content: [{ type: 'text', text: input.input.prompt }],
            duration: 4,
            resolution: '480P',
            ratio: '16:9',
          });
          return Response.json({ task_id: 'fixture-task' });
        }
        return Response.json({
          task: {
            model: 'MiniMax-H3-Lite',
            status: 'succeeded',
            content: { url: 'https://media.example.com/output.mp4' },
            usage: { output_seconds: 4, input_seconds: 0, input_image_count: 0 },
          },
        });
      },
    });
    const context = { jobId: 'fixture-job', input, route, deployment };
    expect(adapter.preflight?.(context)).toBeNull();
    expect(await adapter.submit(context)).toEqual({ upstreamId: 'fixture-task' });
    expect(await adapter.poll({ ...context, upstreamId: 'fixture-task' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
    });
  });
});
