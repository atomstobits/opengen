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
    expect(
      publishedPricingFor({ deploymentId: fal.deploymentId, modelId: 'fal/h3-max' })?.summary,
    ).toBe(fal.publishedPricing?.summary);
    expect(fal.operationCapabilities?.['reference-to-video']?.publishedPricing?.summary).toContain(
      '$0.05',
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
    expect(catalog.routes.length).toBeGreaterThanOrEqual(164);
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
        const unitemizedInitialQuality =
          (route.deploymentId === 'runway-undisclosed' &&
            route.modelId.startsWith('openai/gpt-image-2.5-')) ||
          (route.deploymentId === 'pika-undisclosed' &&
            route.modelId === 'xai/grok-imagine-image-2.0');
        if (unitemizedInitialQuality) {
          expect(playgroundHtml, `Missing dollar tariff summary on ${route.id}`).toMatch(
            /\$\d+\.\d+/,
          );
          const itemizedDraft = {
            ...draft,
            input: {
              ...draft.input,
              quality: route.deploymentId === 'runway-undisclosed' ? 'high' : 'medium',
            },
          };
          const itemizedHtml = renderToStaticMarkup(
            createElement(PlaygroundPricing, {
              catalog,
              model,
              routes,
              draft: itemizedDraft,
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
          expect(itemizedHtml, `Missing itemized quality rate on ${route.id}`).toMatch(
            /\$\d+\.\d+\s+USD \/ output image/,
          );
        } else {
          expect(playgroundHtml, `Missing Playground USD rate on ${route.id}`).toMatch(
            /\$\d+\.\d+\s+USD \/ output (image|second)/,
          );
        }
      }
    }
  });

  it('matches draft quality in Playground pricing and excludes unmatched quality tiers from numeric ranges', () => {
    const flareModel = catalog.models.find((entry) => entry.id === 'openai/gpt-image-2.5-flare')!;
    const flareRoutes = catalog.routes.filter((route) => route.modelId === flareModel.id);
    const replicateFlare = flareRoutes.find(
      (route) => route.deploymentId === 'replicate-undisclosed',
    )!;
    const renderFlare = (draft = initialPlaygroundRequest(flareModel, flareRoutes)) =>
      renderToStaticMarkup(
        createElement(PlaygroundPricing, {
          catalog,
          model: flareModel,
          routes: flareRoutes,
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

    // Default draft quality is medium: Replicate resolves $0.047 (medium), Runway (high-only) stays out of the numeric range.
    const defaultAutoHtml = renderFlare();
    expect(defaultAutoHtml).toContain('Rates vary by provider and endpoint region');
    expect(defaultAutoHtml).toContain('$0.047 USD / output image · 1K');
    expect(defaultAutoHtml).not.toContain('$0.25 USD / output image · 1K');
    expect(defaultAutoHtml).toContain('<dt>Maximum spend</dt><dd>No cap set</dd>');

    const cappedAutoDraft = {
      ...initialPlaygroundRequest(flareModel, flareRoutes),
      maxCostMicros: 1_250_000,
    };
    expect(renderFlare(cappedAutoDraft)).toContain('<dt>Maximum spend</dt><dd>$1.25 USD</dd>');

    // At high quality (1:1), all five providers resolve high-tier rates and aggregate cleanly.
    const highDraft = initialPlaygroundRequest(flareModel, flareRoutes);
    highDraft.input.quality = 'high';
    const highAutoHtml = renderFlare(highDraft);
    expect(highAutoHtml).toContain('≈$0.05–$0.128 USD / output image · 1K');
    expect(highAutoHtml).toContain('≈$0.11 USD / output image · 1K');

    // Selecting Replicate updates dynamically across quality tiers and omits the automatic-routing spend cap row.
    for (const [quality, expected] of [
      ['low', '$0.012 USD / output image · 1K'],
      ['medium', '$0.047 USD / output image · 1K'],
      ['high', '$0.128 USD / output image · 1K'],
      ['xhigh', '$0.25 USD / output image · 1K'],
      ['max', '$0.50 USD / output image · 1K'],
    ] as const) {
      const pinned = initialPlaygroundRequest(flareModel, flareRoutes, replicateFlare.id);
      pinned.input.quality = quality;
      const pinnedHtml = renderFlare(pinned);
      expect(pinnedHtml).toContain(expected);
      expect(pinnedHtml).not.toContain('<dt>Maximum spend</dt>');
    }
    const jsonCappedPinned = {
      ...initialPlaygroundRequest(flareModel, flareRoutes, replicateFlare.id),
      maxCostMicros: 500_000,
    };
    expect(renderFlare(jsonCappedPinned)).toContain('<dt>Maximum spend</dt><dd>$0.50 USD</dd>');

    // Grok Imagine Image 2.0 does not retain the $0.04 low-quality rate when medium quality is selected.
    const grokModel = catalog.models.find((entry) => entry.id === 'xai/grok-imagine-image-2.0')!;
    const grokRoutes = catalog.routes.filter((route) => route.modelId === grokModel.id);
    const grokMedium = initialPlaygroundRequest(grokModel, grokRoutes);
    grokMedium.input.quality = 'medium';
    const grokMediumHtml = renderToStaticMarkup(
      createElement(PlaygroundPricing, {
        catalog,
        model: grokModel,
        routes: grokRoutes,
        draft: grokMedium,
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
    expect(grokMediumHtml).toContain('$0.06–$0.063 USD / output image · 1K');
    expect(grokMediumHtml).not.toContain('$0.04 USD / output image · 1K');

    // Media-reference inputs drop output-only fallback rates and show qualified tariff descriptions instead.
    const seedanceModel = catalog.models.find((entry) => entry.id === 'bytedance/seedance-2.0')!;
    const seedanceRoutes = catalog.routes.filter((route) => route.modelId === seedanceModel.id);
    const seedanceRefDraft = initialPlaygroundRequest(
      seedanceModel,
      seedanceRoutes,
      undefined,
      'reference-to-video',
    );
    seedanceRefDraft.input.resolution = '720p';
    seedanceRefDraft.input.references = [
      { type: 'video', asset: { url: 'https://media.example.com/ref.mp4' } },
    ];
    const seedanceRefHtml = renderToStaticMarkup(
      createElement(PlaygroundPricing, {
        catalog,
        model: seedanceModel,
        routes: seedanceRoutes,
        draft: seedanceRefDraft,
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
    expect(seedanceRefHtml).toContain('Rates vary by provider and endpoint region');
    expect(seedanceRefHtml).not.toContain('$0.18 USD / output second');
    expect(seedanceRefHtml).toContain('$0.22 at 720p');

    // Unsupported route resolutions are excluded from Playground fallback pricing.
    const grokVideoModel = catalog.models.find(
      (entry) => entry.id === 'xai/grok-imagine-video-1.5',
    )!;
    const grokVideoRoutes = catalog.routes.filter((route) => route.modelId === grokVideoModel.id);
    const falGrokRef = grokVideoRoutes.find(
      (route) => route.id === 'fal-undisclosed/xai-grok-imagine-video-1.5',
    )!;
    const grok1080Auto = initialPlaygroundRequest(
      grokVideoModel,
      grokVideoRoutes,
      undefined,
      'reference-to-video',
    );
    grok1080Auto.input.resolution = '1080p';
    const grok1080AutoHtml = renderToStaticMarkup(
      createElement(PlaygroundPricing, {
        catalog,
        model: grokVideoModel,
        routes: grokVideoRoutes,
        draft: grok1080Auto,
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
    expect(grok1080AutoHtml).toContain('xAI');
    expect(grok1080AutoHtml).not.toContain('fal.ai');

    const grok1080Pinned = { ...grok1080Auto, routeId: falGrokRef.id };
    const grok1080PinnedHtml = renderToStaticMarkup(
      createElement(PlaygroundPricing, {
        catalog,
        model: grokVideoModel,
        routes: grokVideoRoutes,
        draft: grok1080Pinned,
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
    expect(grok1080PinnedHtml).toContain('Price unavailable for these settings');
    expect(grok1080PinnedHtml).not.toContain('$0.25 USD / output second');

    // Frame-input surcharges (such as Runway and native MiniMax H3 image-to-video) withhold output-only fallback rates.
    const h3Model = catalog.models.find((entry) => entry.id === 'minimax/h3')!;
    const h3Routes = catalog.routes.filter((route) => route.modelId === h3Model.id);
    const runwayH3 = h3Routes.find((route) => route.deploymentId === 'runway-undisclosed')!;
    const h3FrameDraft = initialPlaygroundRequest(h3Model, h3Routes, runwayH3.id, 'image-to-video');
    h3FrameDraft.input.firstFrame = { url: 'https://media.example.com/start.png' };
    const h3FrameHtml = renderToStaticMarkup(
      createElement(PlaygroundPricing, {
        catalog,
        model: h3Model,
        routes: h3Routes,
        draft: h3FrameDraft,
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
    expect(h3FrameHtml).not.toContain('$0.10 USD / output second');
    expect(h3FrameHtml).toContain('+$0.02 / start or reference image');
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
