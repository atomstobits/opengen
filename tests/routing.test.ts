import { describe, expect, it } from 'vitest';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput, RouteMetrics } from '@media-router/contracts';

const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A synthetic test scene.', resolution: '720p', duration: 5 },
};
const singapore = 'alibaba/ap-southeast-1/wan-3.0';
const frankfurt = 'alibaba/eu-central-1/wan-3.0';
function metric(routeId: string, overrides: Partial<RouteMetrics> = {}): RouteMetrics {
  return {
    routeId,
    sampleCount: 20,
    succeeded: 18,
    failed: 2,
    unresolved: 0,
    unclassifiedFailures: 0,
    technicalOutcomeCount: 20,
    technicalSuccessRate: 0.9,
    p50CompletionMs: 1000,
    p75CompletionMs: 1200,
    p90CompletionMs: 1400,
    p95CompletionMs: 1600,
    p99CompletionMs: 2000,
    window: '7 days',
    benchmarkOrigin: 'synthetic-fixture',
    configuration: { operation: input.operation, resolution: input.input.resolution, duration: 5 },
    ...overrides,
  };
}

describe('evidence-based routing and reservation bounds', () => {
  it('selects faster matching observations while excluding undersampled and different configurations', () => {
    const result = quote(
      { ...input, routing: { preference: 'speed' } },
      {
        executableRouteIds: [singapore, frankfurt],
        metrics: [metric(singapore), metric(frankfurt, { p50CompletionMs: 5000 })],
      },
    );
    expect(result.selectedRouteId).toBe(singapore);
    for (const incompatible of [
      metric(singapore, { succeeded: 4 }),
      metric(singapore, {
        configuration: { operation: input.operation, resolution: '1080p', duration: 5 },
      }),
    ]) {
      const rejected = quote(
        { ...input, routing: { preference: 'speed' } },
        { executableRouteIds: [singapore], metrics: [incompatible] },
      );
      expect(rejected.selectedRouteId).toBeNull();
      expect(
        rejected.candidates.find((candidate) => candidate.routeId === singapore)?.executable,
      ).toBe(false);
    }
  });

  it('requires classified technical outcomes before reliability selection', () => {
    const request = { ...input, routing: { preference: 'reliability' as const } };
    const result = quote(request, {
      executableRouteIds: [singapore, frankfurt],
      metrics: [
        metric(singapore, { technicalSuccessRate: 0.95 }),
        metric(frankfurt, { technicalSuccessRate: 1, technicalOutcomeCount: 9 }),
      ],
    });
    expect(result.selectedRouteId).toBe(singapore);
    const unclassified = quote(request, {
      executableRouteIds: [singapore],
      metrics: [metric(singapore, { technicalSuccessRate: null, unclassifiedFailures: 1 })],
    });
    expect(unclassified.selectedRouteId).toBeNull();
  });

  it('reserves the largest qualified fallback estimate without broadening a regional pin', () => {
    const result = quote(
      { ...input, routing: { fallback: true } },
      { executableRouteIds: [singapore, frankfurt] },
    );
    expect(result.selectedRouteId).toBe(frankfurt);
    expect(result.reservationMicros).toBe(500_000);
    const pinned = quote(
      { ...input, routeId: frankfurt, routing: { fallback: true } },
      { executableRouteIds: [singapore, frankfurt] },
    );
    expect(pinned.candidates).toHaveLength(1);
    expect(pinned.reservationMicros).toBe(412_565);
  });

  it('allows unpriced BYOK only without a gateway spending-cap promise', () => {
    const route = catalog.routes.find(
      (route) => route.id === 'fal-undisclosed/openai/gpt-image-2.5/flare/text-to-image',
    )!;
    const request: GenerateInput = {
      modelId: route.modelId,
      routeId: route.id,
      operation: 'text-to-image',
      input: { prompt: 'A synthetic test scene.', resolution: '1K' },
      billing: 'byok',
    };
    const options = { executableRouteIds: [route.id] };
    expect(quote(request, options)).toMatchObject({
      selectedRouteId: route.id,
      reservationMicros: 0,
    });
    expect(quote({ ...request, maxCostMicros: 1_000_000 }, options).selectedRouteId).toBeNull();
  });
});
