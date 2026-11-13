import { describe, expect, it } from 'vitest';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { createXaiAdapter } from '../packages/engine/src/xai.js';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { catalogSmokeCases } from '../scripts/live-smoke.js';

const route = catalog.routes.find(
  (entry) => entry.modelId === 'xai/grok-imagine-image-2.0' && entry.adapter === 'xai',
)!;
const options = { executableRouteIds: [route.id] };
const input: GenerateInput = {
  modelId: route.modelId,
  routeId: route.id,
  operation: 'text-to-image',
  input: { prompt: 'A paper boat on still water.', resolution: '1K' },
  routing: { fallback: false },
};

describe('xAI Image 2.0 single-output low-quality tariff', () => {
  it.each([
    ['1K', 40_000],
    ['2K', 60_000],
  ] as const)('quotes one low-quality %s image', (resolution, cost) => {
    for (const quality of [undefined, 'low'] as const) {
      const result = quote({ ...input, input: { ...input.input, resolution, quality } }, options);
      expect(result.selectedRouteId).toBe(route.id);
      expect(result.reservationMicros).toBe(cost);
      expect(result.candidates[0]!.source).toMatchObject({
        url: 'https://docs.x.ai/developers/pricing#imagine-api',
        checkedAt: '2026-11-03',
      });
    }
  });

  it('does not price auto/medium quality, edits, extra outputs, 1.5K or video as low-quality images', () => {
    const requests: GenerateInput[] = [
      ...(['auto', 'medium'] as const).map((quality) => ({
        ...input,
        input: { ...input.input, quality },
      })),
      { ...input, input: { ...input.input, count: 2 } },
      { ...input, input: { ...input.input, resolution: '1.5K' } },
      {
        ...input,
        operation: 'image-edit',
        input: {
          ...input.input,
          references: [
            { type: 'image', asset: { url: 'https://media.example.com/reference.png' } },
          ],
        },
      },
    ];
    for (const request of requests) {
      const result = quote(request, options);
      expect(result.selectedRouteId).toBeNull();
      expect(result.candidates[0]!.estimatedCostMicros).toBeNull();
    }
    expect(
      catalog.routes.find((entry) => entry.modelId === 'xai/grok-imagine-video')!.rates,
    ).toEqual([]);
    expect(
      catalog.routes
        .filter(
          (entry) =>
            entry.adapter === 'xai' && entry.modelId.startsWith('xai/grok-imagine-video-1.5'),
        )
        .every((entry) =>
          entry.rates.every(
            (rate) => rate.operation === 'text-to-video' && rate.unit === 'output-second',
          ),
        ),
    ).toBe(true);
    expect(route.rates.every((rate) => rate.operation === 'text-to-image')).toBe(true);
  });

  it('proposes one low-default 1K smoke and respects credentials and request budget', () => {
    expect(catalogSmokeCases(catalog).find((entry) => entry.routeId === route.id)).toMatchObject({
      state: 'ready',
      estimateMicros: 40_000,
      reserveMicros: 80_000,
      input: {
        modelId: 'xai/grok-imagine-image-2.0',
        routeId: route.id,
        operation: 'text-to-image',
        input: { resolution: '1K' },
        routing: { fallback: false },
      },
    });
    expect(quote(input).selectedRouteId).toBeNull();
    expect(quote({ ...input, maxCostMicros: 39_999 }, options).selectedRouteId).toBeNull();
  });

  it('pins the omitted quality to low in the paid request and keeps unknown charge separate', async () => {
    const normalized = parseGenerationRequest(input);
    const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
    const adapter = createXaiAdapter({
      env: { XAI_API_KEY: 'fixture' },
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toMatchObject({
            model: 'grok-imagine-image-2.0',
            resolution: '1k',
            n: 1,
            deferred: true,
            quality: 'low',
          });
          return Response.json({ request_id: 'fixture-task' });
        }
        return Response.json({
          status: 'done',
          data: [{ url: 'https://media.example.com/output.jpg', mime_type: 'image/jpeg' }],
        });
      },
    });
    const context = { jobId: 'fixture-job', input: normalized, route, deployment };
    expect(adapter.preflight?.(context)).toBeNull();
    expect(await adapter.submit(context)).toEqual({ upstreamId: 'fixture-task' });
    expect(await adapter.poll({ ...context, upstreamId: 'fixture-task' })).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
    });
  });
});
