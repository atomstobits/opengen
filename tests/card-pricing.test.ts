import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { catalog, getModel, getModelRoutes, getSeries } from '@media-router/catalog';
import type { Catalog, Model, ModelSeries, Route } from '@media-router/contracts';
import {
  summarizeSeriesCardPricing,
  summarizeVariantCardPricing,
  type CardPricingSummary,
} from '../apps/web/app/route-pricing-comparison';

const source = { url: 'https://example.com/pricing', checkedAt: '2026-11-26' };

let CardPricing: ComponentType<{
  summary: CardPricingSummary;
  variant?: 'series' | 'directory' | 'compact';
  multiVariant?: boolean;
}>;
let SeriesCards: ComponentType<{ series: ModelSeries[]; compact?: boolean }>;
let ModelsCatalog: ComponentType<{
  catalog: Catalog;
  initialQuery?: string;
  initialModality?: 'all' | 'image' | 'video';
  initialRegion?: string;
}>;

beforeAll(async () => {
  // Next's app tsconfig preserves JSX. Compile these SSR fixtures in memory without changing
  // the shared Vitest or Next configuration.
  const result = await build({
    stdin: {
      contents: `
        export { CardPricing } from './apps/web/app/card-pricing';
        export { SeriesCards } from './apps/web/app/company-cards';
        export { ModelsCatalog } from './apps/web/app/catalog-browser';
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['react', 'react-dom', 'react/jsx-runtime', 'next/*'],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'css-fixture',
        setup(builder) {
          builder.onLoad({ filter: /\.css$/ }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
    ],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', target: 'ES2022', module: 'ESNext' } },
  });
  const mod = {
    exports: {} as {
      CardPricing: typeof CardPricing;
      SeriesCards: typeof SeriesCards;
      ModelsCatalog: typeof ModelsCatalog;
    },
  };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  CardPricing = mod.exports.CardPricing;
  SeriesCards = mod.exports.SeriesCards;
  ModelsCatalog = mod.exports.ModelsCatalog;
});

function makeRoute(overrides: Partial<Route> & Pick<Route, 'id' | 'modelId'>): Route {
  return {
    deploymentId: 'fal-undisclosed',
    upstreamModelId: overrides.modelId,
    operations: ['text-to-video'],
    resolutions: ['480p', '720p'],
    durations: [5],
    fidelity: 'unknown',
    adapter: null,
    status: 'documented',
    rates: [],
    pricingSource: source,
    source,
    ...overrides,
  };
}

describe('model card pricing and % off summaries', () => {
  it('computes starting price and same-variant savings for featured homepage series', () => {
    const seedance = summarizeSeriesCardPricing([getModel('bytedance/seedance-2.5')!], catalog);
    expect(seedance.lowest).toMatchObject({
      modelId: 'bytedance/seedance-2.5',
      resolution: '480p',
      unit: 'output-second',
      usdMicros: 102_800,
      approximate: false,
    });
    expect(seedance.savings).toMatchObject({
      modelId: 'bytedance/seedance-2.5',
      maxPercentOff: 53,
      label: 'Up to 53% off',
    });

    const nanoBanana = summarizeSeriesCardPricing([getModel('google/nano-banana-2.1')!], catalog);
    expect(nanoBanana.lowest).toMatchObject({
      modelId: 'google/nano-banana-2.1',
      resolution: '1K',
      unit: 'image',
      usdMicros: 33_600,
      approximate: false,
    });
    expect(nanoBanana.savings).toMatchObject({
      modelId: 'google/nano-banana-2.1',
      maxPercentOff: 16,
      label: 'Up to 16% off',
    });

    const h3Models = getSeries('minimax/h3')!.modelIds.map((id) => getModel(id)!);
    const h3 = summarizeSeriesCardPricing(h3Models, catalog);
    expect(h3.lowest).toMatchObject({
      modelId: 'pika/h3-flex',
      resolution: '480p',
      unit: 'output-second',
      usdMicros: 10_000,
      approximate: false,
    });
    // Savings come from same-variant route comparison (50% on H3 Lite/Highspeed),
    // never cross-variant comparisons against Pika H3 Flex.
    expect(h3.savings).toMatchObject({
      maxPercentOff: 50,
      label: 'Up to 50% off',
    });
    expect(['minimax/h3-lite', 'minimax/h3-highspeed']).toContain(h3.savings?.modelId);
  });

  it('updates price and drops % off when filtered to a single regional route', () => {
    const wan = getModel('alibaba/wan-3.0')!;
    const allRoutes = getModelRoutes(wan.id, catalog);
    const full = summarizeVariantCardPricing(wan, allRoutes, catalog);
    expect(full.lowest).toMatchObject({
      usdMicros: 32_500,
      unit: 'output-second',
    });
    expect(full.savings).toMatchObject({
      maxPercentOff: 35,
      label: 'Up to 35% off',
    });

    const singaporeOnly = allRoutes.filter(
      (route) => route.deploymentId === 'alibaba-model-studio-ap-southeast-1',
    );
    const regional = summarizeVariantCardPricing(wan, singaporeOnly, catalog);
    expect(regional.lowest).toMatchObject({
      usdMicros: 50_000,
      unit: 'output-second',
    });
    expect(regional.savings).toBeNull();
  });

  it('omits unknown prices, retired routes, zero rates, cross-operation spreads, and mixed-unit series', () => {
    const testModel: Model = {
      ...getModel('alibaba/wan-3.0')!,
      id: 'test/video',
      name: 'Test Video',
    };

    expect(
      summarizeVariantCardPricing(
        testModel,
        [makeRoute({ id: 'r0', modelId: 'test/video' })],
        catalog,
      ),
    ).toEqual({ lowest: null, savings: null });

    const edgeSummary = summarizeVariantCardPricing(
      testModel,
      [
        makeRoute({
          id: 'r-retired',
          modelId: 'test/video',
          status: 'retired',
          rates: [
            {
              operation: 'text-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 1_000,
            },
          ],
        }),
        makeRoute({
          id: 'r-zero',
          modelId: 'test/video',
          rates: [
            {
              operation: 'text-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 0,
            },
          ],
        }),
        makeRoute({
          id: 'r-t2v-480p',
          modelId: 'test/video',
          operations: ['text-to-video'],
          resolutions: ['480p'],
          rates: [
            {
              operation: 'text-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 20_000,
            },
          ],
        }),
        makeRoute({
          id: 'r-i2v-480p',
          modelId: 'test/video',
          operations: ['image-to-video'],
          resolutions: ['480p'],
          rates: [
            {
              operation: 'image-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 90_000,
            },
          ],
        }),
        makeRoute({
          id: 'r-t2v-1080p',
          modelId: 'test/video',
          operations: ['text-to-video'],
          resolutions: ['1080p'],
          rates: [
            {
              operation: 'text-to-video',
              resolution: '1080p',
              unit: 'output-second',
              usdMicros: 120_000,
            },
          ],
        }),
      ],
      catalog,
    );
    expect(edgeSummary.lowest).toMatchObject({ routeId: 'r-t2v-480p', usdMicros: 20_000 });
    expect(edgeSummary.savings).toBeNull();

    // Never displays 100% off for positive paid routes even on extreme spreads.
    const extremeCatalog: Catalog = {
      ...catalog,
      routes: [
        makeRoute({
          id: 'r-low',
          modelId: 'test/video',
          resolutions: ['480p'],
          rates: [
            {
              operation: 'text-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 1,
            },
          ],
        }),
        makeRoute({
          id: 'r-high',
          modelId: 'test/video',
          deploymentId: 'replicate-undisclosed',
          resolutions: ['480p'],
          rates: [
            {
              operation: 'text-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 1_000,
            },
          ],
        }),
      ],
    };
    const extreme = summarizeVariantCardPricing(testModel, extremeCatalog.routes, extremeCatalog);
    expect(extreme.savings?.maxPercentOff).toBe(99);
    expect(extreme.savings?.label).toBe('Up to 99% off');

    // Mixed image + video series keeps starting price null rather than comparing incompatible units.
    const mixedCatalog: Catalog = {
      ...catalog,
      models: [
        { ...getModel('alibaba/wan-3.0')!, id: 'test/vid', modality: 'video' },
        { ...getModel('xai/grok-imagine-image-2.0')!, id: 'test/img', modality: 'image' },
      ],
      routes: [
        makeRoute({
          id: 'vid-1',
          modelId: 'test/vid',
          resolutions: ['480p'],
          rates: [
            {
              operation: 'text-to-video',
              resolution: '480p',
              unit: 'output-second',
              usdMicros: 50_000,
            },
          ],
        }),
        makeRoute({
          id: 'img-1',
          modelId: 'test/img',
          operations: ['text-to-image'],
          resolutions: ['1K'],
          rates: [
            { operation: 'text-to-image', resolution: '1K', unit: 'image', usdMicros: 40_000 },
          ],
        }),
      ],
    };
    expect(summarizeSeriesCardPricing(mixedCatalog.models, mixedCatalog)).toEqual({
      lowest: null,
      savings: null,
    });
  });

  it('supports rate-derived resolutions when declarations are empty and honors operation-specific overrides', () => {
    const testModel: Model = {
      ...getModel('alibaba/wan-3.0')!,
      id: 'test/overrides',
      name: 'Test Overrides',
    };

    // Empty route resolutions with a valid published output rate still resolve starting price.
    const emptyDeclRoute = makeRoute({
      id: 'r-empty-decl',
      modelId: 'test/overrides',
      resolutions: [],
      publishedPricing: {
        summary: '$0.03 / sec at 480p',
        source,
        conditions: ['Output-only rate.'],
        outputRates: [
          {
            operation: 'text-to-video',
            resolution: '480p',
            unit: 'output-second',
            usdMicros: 30_000,
          },
        ],
      },
    });
    const emptyDeclSummary = summarizeVariantCardPricing(testModel, [emptyDeclRoute], catalog);
    expect(emptyDeclSummary.lowest).toMatchObject({
      routeId: 'r-empty-decl',
      resolution: '480p',
      usdMicros: 30_000,
    });
    expect(emptyDeclSummary.savings).toBeNull();

    // An explicitly empty operation resolution override keeps unsupported resolutions excluded.
    const explicitEmptyOpRoute = makeRoute({
      id: 'r-explicit-empty-op',
      modelId: 'test/overrides',
      resolutions: ['480p'],
      operationCapabilities: {
        'text-to-video': { resolutions: [] },
      },
      rates: [
        {
          operation: 'text-to-video',
          resolution: '480p',
          unit: 'output-second',
          usdMicros: 30_000,
        },
      ],
    });
    expect(summarizeVariantCardPricing(testModel, [explicitEmptyOpRoute], catalog)).toEqual({
      lowest: null,
      savings: null,
    });

    // Operation-specific resolution overrides (global 720p, text-to-video 480p) participate in savings.
    const overrideRoutes = [
      makeRoute({
        id: 'r-op-cheap',
        modelId: 'test/overrides',
        deploymentId: 'fal-undisclosed',
        resolutions: ['720p'],
        operationCapabilities: {
          'text-to-video': { resolutions: ['480p'] },
        },
        rates: [
          {
            operation: 'text-to-video',
            resolution: '480p',
            unit: 'output-second',
            usdMicros: 20_000,
          },
        ],
      }),
      makeRoute({
        id: 'r-op-expensive',
        modelId: 'test/overrides',
        deploymentId: 'replicate-undisclosed',
        resolutions: ['720p'],
        operationCapabilities: {
          'text-to-video': { resolutions: ['480p'] },
        },
        rates: [
          {
            operation: 'text-to-video',
            resolution: '480p',
            unit: 'output-second',
            usdMicros: 40_000,
          },
        ],
      }),
    ];
    const overrideSummary = summarizeVariantCardPricing(testModel, overrideRoutes, catalog);
    expect(overrideSummary.lowest).toMatchObject({
      routeId: 'r-op-cheap',
      resolution: '480p',
      usdMicros: 20_000,
    });
    expect(overrideSummary.savings).toMatchObject({
      maxPercentOff: 50,
      label: 'Up to 50% off',
    });
  });

  it('renders crawlable price and % off markup on SeriesCards and ModelsCatalog', () => {
    const featured = ['bytedance/seedance-2.5', 'google/nano-banana-2.1', 'minimax/h3'].map((id) =>
      getSeries(id)!,
    );
    const homeHtml = renderToStaticMarkup(
      createElement(SeriesCards, { series: featured, compact: true }),
    );
    expect(homeHtml).toContain('$0.1028');
    expect(homeHtml).toContain('Up to 53% off');
    expect(homeHtml).toContain('$0.0336');
    expect(homeHtml).toContain('Up to 16% off');
    expect(homeHtml).toContain('$0.01');
    expect(homeHtml).toContain('Up to 50% off');
    expect(homeHtml.match(/data-testid="card-pricing"/g)).toHaveLength(3);
    expect(homeHtml.match(/data-testid="card-savings"/g)).toHaveLength(3);

    const klingHtml = renderToStaticMarkup(
      createElement(SeriesCards, { series: [getSeries('kling/kling-4.0')!], compact: true }),
    );
    expect(klingHtml).toContain('$0.094');
    expect(klingHtml).not.toContain('data-testid="card-savings"');

    const emptyHtml = renderToStaticMarkup(
      createElement(CardPricing, { summary: { lowest: null, savings: null } }),
    );
    expect(emptyHtml).toBe('');

    const wanAllHtml = renderToStaticMarkup(
      createElement(ModelsCatalog, { catalog, initialQuery: 'Wan 3.0' }),
    );
    expect(wanAllHtml).toContain('$0.0325');
    expect(wanAllHtml).toContain('Up to 35% off');
    expect(wanAllHtml).toContain('$0.051');
    expect(wanAllHtml).toContain('Up to 25% off');

    const wanSingaporeHtml = renderToStaticMarkup(
      createElement(ModelsCatalog, {
        catalog,
        initialQuery: 'Wan 3.0',
        initialRegion: 'ap-southeast-1',
      }),
    );
    expect(wanSingaporeHtml).toContain('$0.05');
    expect(wanSingaporeHtml).toContain('$0.068');
    expect(wanSingaporeHtml).not.toContain('data-testid="card-savings"');
  });
});
