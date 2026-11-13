import { describe, expect, it } from 'vitest';
import { catalog, getModel, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { catalogSmokeCases } from '../scripts/live-smoke.js';

const routeId = 'fal-undisclosed/fal-h3-max-turbo';
const options = { executableRouteIds: [routeId] };
const input: GenerateInput = {
  modelId: 'fal/h3-max-turbo',
  routeId,
  operation: 'text-to-video',
  input: { prompt: 'A paper boat on still water.', duration: 5, resolution: '480p' },
  routing: { fallback: false },
};

describe('fal H3 Max Turbo scoped standard tariff', () => {
  it.each([
    ['480p', 125_000],
    ['768p', 200_000],
    ['1080p', 400_000],
  ])(
    'estimates five text-only seconds at %s without the temporary discount',
    (resolution, cost) => {
      const result = quote({ ...input, input: { ...input.input, resolution } }, options);
      expect(result.selectedRouteId).toBe(routeId);
      expect(result.reservationMicros).toBe(cost);
      expect(result.candidates[0]).toMatchObject({
        estimatedCostMicros: cost,
        source: { checkedAt: '2026-11-03' },
      });
      expect(result.candidates[0]!.notices.join(' ')).toContain('November 1–15, 2026');
      expect(result.candidates[0]!.notices.join(' ')).toContain('0.7 seconds longer');
    },
  );
  it.each([undefined, false, 'none', 'disabled'] as const)(
    'allows the reviewed disabled expansion setting %s',
    (promptExpansion) => {
      expect(
        quote({ ...input, input: { ...input.input, promptExpansion } }, options).selectedRouteId,
      ).toBe(routeId);
    },
  );
  it.each([true, 'balanced', 'quality'] as const)(
    'keeps unqualified expansion %s unpriced',
    (promptExpansion) => {
      const result = quote({ ...input, input: { ...input.input, promptExpansion } }, options);
      expect(result.selectedRouteId).toBeNull();
      expect(result.candidates[0]!.estimatedCostMicros).toBeNull();
    },
  );
  it('does not extend the output tariff to target audio, frames or reference operations', () => {
    const asset = { url: 'https://media.example.com/input' };
    const requests: GenerateInput[] = [
      { ...input, input: { ...input.input, targetAudio: asset } },
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
    ];
    for (const request of requests) {
      const result = quote(request, options);
      expect(result.selectedRouteId).toBeNull();
      expect(result.candidates[0]!.estimatedCostMicros).toBeNull();
    }
    const route = catalog.routes.find((value) => value.id === routeId)!;
    expect(route.operations).toEqual(['text-to-video']);
    expect(route.rates.every((rate) => rate.operation === 'text-to-video')).toBe(true);
  });
  it('preserves the separate Max variant and keeps Turbo rates distinct from fal Max', () => {
    expect(getModel('fal/h3-max-turbo')!.id).toBe('fal/h3-max-turbo');
    expect(getModel('fal/h3-max')!.id).toBe('minimax/h3-max');
    const maxRoutes = catalog.routes.filter((route) => route.modelId === 'minimax/h3-max');
    expect(maxRoutes).toHaveLength(2);
    const falMax = maxRoutes.find((route) => route.adapter === 'fal')!;
    expect(falMax.rates.map((rate) => rate.usdMicros)).toEqual([50_000, 80_000, 160_000]);
    expect(falMax.pricingSource.url).toBe('https://fal.ai/models/minimax/h3-max/text-to-video');
    expect(
      maxRoutes
        .find((route) => route.adapter === 'minimax')!
        .rates.every((rate) => rate.operation === 'text-to-video'),
    ).toBe(true);
  });
  it('plans one five-second standard estimate with a conservative budget hold', () => {
    expect(catalogSmokeCases(catalog).find((entry) => entry.routeId === routeId)).toMatchObject({
      state: 'ready',
      estimateMicros: 125_000,
      reserveMicros: 250_000,
      input: { modelId: 'fal/h3-max-turbo', operation: 'text-to-video', routeId },
    });
  });
});
