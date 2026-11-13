import { describe, expect, it } from 'vitest';
import { catalog, quote, validateCatalog } from '@media-router/catalog';
import { publishedPricingFor } from '../packages/catalog/src/published-pricing';

describe('informational provider tariffs', () => {
  it('retains each H3 Max provider tariff after canonical identity merging', () => {
    const routes = catalog.routes.filter((route) => route.modelId === 'minimax/h3-max');
    const native = routes.find((route) => route.deploymentId === 'minimax-undisclosed')!;
    const fal = routes.find((route) => route.deploymentId === 'fal-undisclosed')!;
    expect(native.publishedPricing?.source.url).toContain('platform.minimax.io');
    expect(fal.publishedPricing?.source.url).toBe(
      'https://fal.ai/models/minimax/h3-max/text-to-video',
    );
    expect(fal.publishedPricing?.summary).toContain('$0.05');
    expect(fal.publishedPricing?.conditions.join(' ')).toContain('Reference tokens');
    expect(publishedPricingFor({ deploymentId: fal.deploymentId, modelId: 'fal/h3-max' })).toBe(
      fal.publishedPricing,
    );
    expect(native.rates).toHaveLength(2);
    expect(native.rates.every((rate) => rate.operation === 'text-to-video')).toBe(true);
    expect(native.pricingSource.checkedAt).toBe('2026-11-03');
    expect(fal.rates.map((rate) => [rate.resolution, rate.usdMicros])).toEqual([
      ['480p', 50_000],
      ['768p', 80_000],
      ['1080p', 160_000],
    ]);
    expect(fal.rates.every((rate) => rate.operation === 'text-to-video')).toBe(true);
  });
  it('keeps published token tariffs separate from flat output rates while bounding text-only quotes', () => {
    const route = catalog.routes.find(
      (route) =>
        route.modelId === 'openai/gpt-image-2.5-flare' &&
        route.deploymentId === 'openai-undisclosed',
    )!;
    expect(route.rates).toEqual([]);
    expect(route.publishedPricing?.summary).toMatch(/per 1M tokens/i);
    expect(route.publishedPricing?.source.url).toBe(
      'https://developers.openai.com/api/docs/models/gpt-image-2.5-flare',
    );
    const bounded = quote(
      {
        modelId: route.modelId,
        routeId: route.id,
        operation: 'text-to-image',
        input: { prompt: 'A red paper sailboat.', resolution: '1K' },
      },
      { executableRouteIds: [route.id] },
    );
    expect(bounded.selectedRouteId).toBe(route.id);
    expect(bounded.candidates[0]?.estimatedCostMicros).toBeGreaterThan(100_000);
    expect(bounded.candidates[0]?.notices.join(' ')).toContain('Bounded max-token reservation');

    const edit = quote(
      {
        modelId: route.modelId,
        routeId: route.id,
        operation: 'image-edit',
        input: {
          prompt: 'Add a lighthouse.',
          resolution: '1K',
          references: [{ type: 'image', asset: { url: 'https://media.example.com/in.png' } }],
        },
      },
      { executableRouteIds: [route.id] },
    );
    expect(edit.candidates[0]).toMatchObject({ estimatedCostMicros: null, executable: false });
    expect(edit.selectedRouteId).toBeNull();
    expect(edit.candidates[0]?.reason).toContain('not qualified');
  });
  it('does not copy a global reseller tariff onto an account-enabled regional offering', () => {
    const global = catalog.routes.find(
      (route) =>
        route.modelId === 'bytedance/seedance-2.0' && route.deploymentId === 'fal-undisclosed',
    )!;
    const regional = catalog.routes.find(
      (route) => route.deploymentId === 'fal-seedance-us-account-enabled',
    )!;
    expect(global.publishedPricing?.summary).toContain('video tokens');
    expect(regional.publishedPricing).toBeUndefined();
    const turbo = catalog.routes.find((route) => route.modelId === 'fal/h3-max-turbo')!;
    expect(turbo.publishedPricing?.summary).toContain('Standard');
    expect(turbo.publishedPricing?.conditions.join(' ')).toContain('without promotional discounts');
  });
  it('requires dated HTTPS evidence for an informational tariff', () => {
    const route = catalog.routes.find(
      (route) =>
        route.modelId === 'bytedance/seedream-5.0-pro' && route.deploymentId === 'fal-undisclosed',
    )!;
    expect(validateCatalog()).toEqual([]);
    const original = route.publishedPricing!;
    try {
      route.publishedPricing = {
        ...original,
        source: { ...original.source, url: 'https://user:private@example.com/pricing' },
      };
      expect(validateCatalog()).toContain(`Invalid published tariff evidence for ${route.id}`);
    } finally {
      route.publishedPricing = original;
    }
  });
});
