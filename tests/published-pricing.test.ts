import { afterAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { catalog, quote, validateCatalog } from '@media-router/catalog';
import { publishedPricingFor } from '../packages/catalog/src/published-pricing';
import { initialPlaygroundRequest } from '../apps/web/app/playground-request';

const temporary = await mkdtemp(join(process.cwd(), 'node_modules/.pricing-ui-'));
const entry = join(temporary, 'pricing-ui.cjs');
await build({
  stdin: {
    contents: `export { ProviderTable } from './apps/web/app/ui'; export { PlaygroundPricing } from './apps/web/app/playground-pricing';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next/navigation'],
  loader: { '.css': 'empty' },
});
const { ProviderTable, PlaygroundPricing } = createRequire(import.meta.url)(entry) as {
  ProviderTable: typeof import('../apps/web/app/ui').ProviderTable;
  PlaygroundPricing: typeof import('../apps/web/app/playground-pricing').PlaygroundPricing;
};
afterAll(() => rm(temporary, { recursive: true, force: true }));

describe('informational provider tariffs', () => {
  it('retains each H3 Max provider tariff after canonical identity merging', () => {
    const routes = catalog.routes.filter((route) => route.modelId === 'minimax/h3-max');
    const native = routes.find((route) => route.deploymentId === 'minimax-undisclosed')!;
    const fal = routes.find((route) => route.deploymentId === 'fal-undisclosed')!;
    const runway = routes.find((route) => route.deploymentId === 'runway-undisclosed')!;
    expect(native.publishedPricing?.source.url).toContain('platform.minimax.io');
    expect(fal.publishedPricing?.source.url).toBe(
      'https://fal.ai/models/minimax/h3-max/text-to-video',
    );
    expect(runway.publishedPricing?.source.url).toContain('runwayml.com');
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

  it('uses a dedicated primary-sourced US tariff rather than copying the global reseller tariff', () => {
    const global = catalog.routes.find(
      (route) =>
        route.modelId === 'bytedance/seedance-2.0' && route.deploymentId === 'fal-undisclosed',
    )!;
    const regional = catalog.routes.find(
      (route) => route.deploymentId === 'fal-seedance-us-account-enabled',
    )!;
    expect(global.publishedPricing?.summary).toContain('$0.014');
    expect(regional.publishedPricing?.summary).toContain('$0.0168');
    expect(regional.publishedPricing?.source.url).toBe(
      'https://fal.ai/models/bytedance/seedance-2.0/us/text-to-video',
    );
    expect(regional.rates).toEqual([]);
    const turbo = catalog.routes.find((route) => route.modelId === 'fal/h3-max-turbo')!;
    expect(turbo.publishedPricing?.summary).toContain('Standard');
    expect(turbo.publishedPricing?.conditions.join(' ')).toContain('without promotional discounts');
  });

  it('ensures every provider route has primary-sourced USD pricing across series tables and Playground', () => {
    expect(catalog.routes.length).toBeGreaterThanOrEqual(255);
    for (const route of catalog.routes) {
      const model = catalog.models.find((entry) => entry.id === route.modelId)!;
      const unit = model.modality === 'image' ? 'image' : 'output-second';
      const allRates = [...route.rates, ...(route.publishedPricing?.outputRates ?? [])].filter(
        (rate) => rate.unit === unit,
      );
      expect(route.publishedPricing, `Missing publishedPricing on route ${route.id}`).toBeDefined();
      expect(route.publishedPricing!.summary.length).toBeGreaterThan(0);
      expect(route.publishedPricing!.source.url).toMatch(/^https:\/\//);
      expect(allRates.length, `Missing numeric outputRates on route ${route.id}`).toBeGreaterThan(
        0,
      );
      for (const resolution of route.resolutions) {
        if (
          route.modelId === 'fal/flux-3-max-video' &&
          (resolution === '2K' || resolution === '4K')
        ) {
          // 2K and 4K list rates on fal FLUX 3 Max Video are genuinely unitemized by the provider.
          expect(
            allRates.find((rate) => rate.resolution.toLowerCase() === resolution.toLowerCase()),
          ).toBeUndefined();
          continue;
        }
        const matched = allRates.find(
          (rate) => rate.resolution.toLowerCase() === resolution.toLowerCase(),
        );
        expect(
          matched,
          `Missing USD rate for resolution ${resolution} on route ${route.id}`,
        ).toBeDefined();
        expect(matched!.usdMicros).toBeGreaterThan(0);
      }
    }
    for (const deploymentId of [
      'fal-undisclosed',
      'pika-undisclosed',
      'replicate-undisclosed',
      'runway-undisclosed',
    ]) {
      const aggregatorRoutes = catalog.routes.filter(
        (route) => route.deploymentId === deploymentId,
      );
      expect(aggregatorRoutes.length).toBeGreaterThanOrEqual(15);
      expect(aggregatorRoutes.every((route) => Boolean(route.publishedPricing?.summary))).toBe(
        true,
      );
    }
    for (const model of catalog.models) {
      const routes = catalog.routes.filter((route) => route.modelId === model.id);
      if (!routes.length) continue;
      const tableHtml = renderToStaticMarkup(
        createElement(ProviderTable, { model, routes, catalog }),
      );
      if (model.id !== 'fal/flux-3-max-video') {
        expect(tableHtml, `Unexpected unknown-price placeholder on ${model.id}`).not.toContain(
          'unknown-price',
        );
      }
      expect(tableHtml, `Unexpected tariff-only non-dollar badge on ${model.id}`).not.toContain(
        'tariff-only',
      );
      for (const route of routes) {
        const draft = initialPlaygroundRequest(model, routes, route.id, route.operations[0]);
        const playgroundHtml = renderToStaticMarkup(
          createElement(PlaygroundPricing, {
            catalog,
            model,
            routes,
            draft,
            quote: null,
            job: null,
            readiness: 'Ready',
            mobileStatus: 'Ready',
            busy: null,
            ready: false,
            canGenerate: false,
            onQuote: () => {},
            onGenerate: () => {},
            error: '',
          }),
        );
        expect(playgroundHtml, `Missing Playground price on ${route.id}`).not.toContain(
          'Price unavailable for these settings',
        );
        expect(playgroundHtml, `Missing Playground USD rate on ${route.id}`).toMatch(
          /\$\d+\.\d+\s+USD \/ output (image|second)/,
        );
      }
    }
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
