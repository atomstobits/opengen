import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalRouteId,
  catalog,
  getModel,
  getRoute,
  getRouteAlias,
  quote,
  resolveRoute,
  validateCatalog,
} from '@media-router/catalog';
import {
  describeRouteFeatures,
  resolveRouteUpstreamModelId,
  routeDurationsForOperation,
  routeFeatureDiscriminator,
  routeFeatureSignature,
  routePublishedPricingForOperation,
  routeResolutionsForOperation,
  variantHasFeatureDistinctions,
  type GenerateInput,
  type Route,
} from '@media-router/contracts';
import { validateRouteInput } from '@media-router/contracts/generation';
import {
  publishedPricingFor,
  scopePublishedPricing,
} from '../packages/catalog/src/published-pricing';
import { buildApp } from '../apps/server/src/app';
import { openApiDocument } from '../apps/server/src/openapi';
import { localCatalog } from '../apps/web/app/native-gateway';
import { buildProviderRouteRows } from '../apps/web/app/provider-order';
import {
  formatDeploymentLabel,
  formatDisclosedRegion,
  formatRouteLabel,
  routeIdentity,
} from '../apps/web/app/route-identity';
import {
  computeCheapestRouteHighlights,
  isDisplayedRateCheapest,
  resolveDisplayedRouteRate,
} from '../apps/web/app/route-pricing-comparison';
import {
  clearConflictingRoutingFilters,
  resolveOperationRouteSwitch,
  siblingRouteRoutingConflict,
  validatePlaygroundRequest,
} from '../apps/web/app/playground-request';
import { createFalAdapter } from '../packages/engine/src/fal.js';
import { runCommand } from '../apps/cli/src/index';
import { OpenGen } from '@media-router/sdk';
import { playgroundHref } from '../apps/web/app/links';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('unified official-standard routes, RouteAlias, and catalog invariants', () => {
  it('unifies every (modelId, deploymentId) into one canonical route while keeping operation distinctions clear', () => {
    const qwenTurboRoutes = catalog.routes.filter(
      (route) => route.modelId === 'qwen/image-2.1-turbo',
    );
    expect(variantHasFeatureDistinctions(qwenTurboRoutes)).toBe(false);
    expect(routeFeatureDiscriminator(qwenTurboRoutes[0]!, qwenTurboRoutes)).toBeNull();
    expect(
      routeFeatureDiscriminator(qwenTurboRoutes[0]!, qwenTurboRoutes, 'image-edit'),
    ).toBeNull();

    const seedanceRoutes = catalog.routes.filter(
      (route) => route.modelId === 'bytedance/seedance-2.5',
    );
    expect(seedanceRoutes).toHaveLength(5);
    expect(new Set(seedanceRoutes.map((route) => route.deploymentId)).size).toBe(5);
    expect(variantHasFeatureDistinctions(seedanceRoutes)).toBe(true);

    const falSeedance = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    const byteplus = getRoute('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5')!;
    expect(falSeedance.operations).toEqual([
      'text-to-video',
      'image-to-video',
      'reference-to-video',
    ]);
    expect(falSeedance.upstreamEndpoints).toEqual({
      'text-to-video': 'bytedance/seedance-2.5/text-to-video',
      'image-to-video': 'bytedance/seedance-2.5/image-to-video',
      'reference-to-video': 'bytedance/seedance-2.5/reference-to-video',
    });
    expect(resolveRouteUpstreamModelId(falSeedance, 'image-to-video')).toBe(
      'bytedance/seedance-2.5/image-to-video',
    );
    expect(routeFeatureDiscriminator(falSeedance, seedanceRoutes, 'image-to-video')).toBeNull();
    expect(routeFeatureDiscriminator(byteplus, seedanceRoutes, 'image-to-video')).toBeNull();
    expect(routeFeatureDiscriminator(byteplus, seedanceRoutes, 'video-edit')).toBe(
      'Text to video, Image to video, Reference to video',
    );

    const pikaRoutes = catalog.routes.filter((route) => route.modelId === 'pika/h3-flex');
    expect(pikaRoutes).toHaveLength(1);
    expect(pikaRoutes[0]?.id).toBe('pika-undisclosed/pika-h3-flex');
    expect(pikaRoutes[0]?.operations).toEqual([
      'text-to-video',
      'image-to-video',
      'reference-to-video',
    ]);
    expect(routeIdentity(catalog, pikaRoutes[0]!).label).toBe('Pika');
  });

  it('registers dedicated RouteAlias entries and resolves legacy split route IDs safely', () => {
    expect(catalog.routeAliases?.length).toBeGreaterThan(100);
    expect(getRouteAlias('fal-undisclosed/bytedance/seedance-2.5/image-to-video')).toEqual({
      id: 'fal-undisclosed/bytedance/seedance-2.5/image-to-video',
      routeId: 'fal-undisclosed/bytedance-seedance-2.5',
      operation: 'image-to-video',
    });
    expect(canonicalRouteId('fal-undisclosed/bytedance/seedance-2.5/image-to-video')).toBe(
      'fal-undisclosed/bytedance-seedance-2.5',
    );
    expect(resolveRoute('fal-undisclosed/fal-h3-max')).toMatchObject({
      route: { id: 'fal-undisclosed/minimax-h3-max', modelId: 'minimax/h3-max' },
      alias: {
        id: 'fal-undisclosed/fal-h3-max',
        routeId: 'fal-undisclosed/minimax-h3-max',
        operation: 'text-to-video',
      },
    });
    expect(resolveRoute('pika-undisclosed/pika-h3-flex-reference-to-video')).toMatchObject({
      route: { id: 'pika-undisclosed/pika-h3-flex' },
      alias: {
        id: 'pika-undisclosed/pika-h3-flex-reference-to-video',
        routeId: 'pika-undisclosed/pika-h3-flex',
        operation: 'reference-to-video',
      },
    });
    expect(resolveRoute('replicate-undisclosed/xai-grok-imagine-video-extension')).toMatchObject({
      route: { id: 'replicate-undisclosed/xai-grok-imagine-video' },
      alias: {
        id: 'replicate-undisclosed/xai-grok-imagine-video-extension',
        routeId: 'replicate-undisclosed/xai-grok-imagine-video',
        operation: 'video-extend',
      },
    });
  });

  it('enforces one active canonical route per (modelId, deploymentId) and validates RouteAlias invariants', () => {
    const base = getRoute('replicate-undisclosed/bytedance-seedream-5.0-pro')!;
    const baseIndex = catalog.routes.indexOf(base);
    const layerRoute: Route = {
      ...base,
      id: 'replicate-undisclosed/bytedance-seedream-5.0-pro/layers',
      upstreamModelId: 'bytedance/seedream-5-pro:layers',
      operations: ['image-edit'],
      feature: {
        id: 'layer-decomposition',
        label: 'Layer decomposition',
        summary: 'Separates an edited scene into transparent layers.',
      },
    };

    expect(describeRouteFeatures(layerRoute)).toMatchObject({
      featureLabel: 'Layer decomposition',
      scopeLabel: 'Image editing · Layer decomposition',
      badges: ['Image editing', 'Layer decomposition'],
    });
    expect(routeFeatureSignature(layerRoute)).toBe('image-edit|layer-decomposition');

    const variantRoutes = [
      ...catalog.routes.filter((route) => route.modelId === 'bytedance/seedream-5.0-pro'),
      layerRoute,
    ];
    expect(routeFeatureDiscriminator(layerRoute, variantRoutes, 'image-edit')).toBe(
      'Layer decomposition',
    );

    catalog.routes.splice(baseIndex + 1, 0, layerRoute);
    try {
      expect(validateCatalog()).toContain(
        `Duplicate active routes for ${base.modelId} on ${base.deploymentId}: ${base.id} and ${layerRoute.id} must be unified into one canonical route`,
      );
    } finally {
      const layerIndex = catalog.routes.indexOf(layerRoute);
      if (layerIndex !== -1) catalog.routes.splice(layerIndex, 1);
    }

    const badAlias = {
      id: base.id,
      routeId: base.id,
    };
    catalog.routeAliases!.push(badAlias);
    try {
      expect(validateCatalog()).toContain(
        `Route alias collides with canonical route ID ${base.id}`,
      );
    } finally {
      catalog.routeAliases!.pop();
    }
  });

  it('validates route feature fields and rejects unsupported operations in rates, published pricing, and operationCapabilities', () => {
    const falSeedance = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    const originalFeature = falSeedance.feature;
    const originalPublished = falSeedance.publishedPricing;
    const originalRates = falSeedance.rates;
    try {
      falSeedance.feature = { id: 'Bad Slug!', label: '  ' };
      expect(validateCatalog()).toContain(`Invalid route feature metadata for ${falSeedance.id}`);
      falSeedance.feature = originalFeature;

      falSeedance.rates = [
        { operation: 'video-edit', resolution: '720p', unit: 'output-second', usdMicros: 1000 },
      ];
      expect(validateCatalog()).toContain(`Rate lists unsupported operation for ${falSeedance.id}`);
      falSeedance.rates = originalRates;

      falSeedance.publishedPricing = {
        ...originalPublished!,
        outputRates: [
          {
            operation: 'video-edit',
            resolution: '720p',
            unit: 'output-second',
            usdMicros: 473_000,
            approximate: true,
          },
        ],
      };
      expect(validateCatalog()).toContain(
        `Published tariff output rate lists unsupported operation for ${falSeedance.id}`,
      );
    } finally {
      falSeedance.feature = originalFeature;
      falSeedance.publishedPricing = originalPublished;
      falSeedance.rates = originalRates;
    }
  });

  it('preserves truthful per-operation capabilities, tariffs, and rates on unified routes', () => {
    const falGrok = getRoute('fal-undisclosed/xai-grok-imagine-video-1.5')!;
    expect(routeResolutionsForOperation(falGrok, 'text-to-video')).toEqual([
      '480p',
      '720p',
      '1080p',
    ]);
    expect(routeResolutionsForOperation(falGrok, 'reference-to-video')).toEqual(['480p', '720p']);
    expect(routeDurationsForOperation(falGrok, 'reference-to-video')).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const grokIssues = validateRouteInput(
      {
        modelId: 'xai/grok-imagine-video-1.5',
        operation: 'reference-to-video',
        input: {
          prompt: 'Ref clip',
          references: [{ type: 'image', asset: { url: 'https://example.com/a.png' } }],
          resolution: '1080p',
          duration: 12,
        },
      },
      falGrok,
    );
    expect(grokIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unsupported_resolution', 'unsupported_duration']),
    );

    const pikaFlex = getRoute('pika-undisclosed/pika-h3-flex')!;
    expect(routePublishedPricingForOperation(pikaFlex, 'text-to-video')?.summary).toContain(
      '$0.01',
    );
    expect(routePublishedPricingForOperation(pikaFlex, 'reference-to-video')?.summary).toContain(
      '$0.03',
    );

    const falFlux = getRoute('fal-undisclosed/bfl-flux-3-video')!;
    expect(routeResolutionsForOperation(falFlux, 'video-edit')).toEqual([]);
    expect(routeDurationsForOperation(falFlux, 'video-edit')).toEqual([]);
    expect(routePublishedPricingForOperation(falFlux, 'video-edit')?.summary).toContain('$0.03');

    // Operation-scoped outputRates are stripped when applied to an incompatible operation list.
    const falSeedance = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    expect(falSeedance.publishedPricing?.outputRates?.length).toBeGreaterThan(0);
    expect(
      publishedPricingFor({
        id: falSeedance.id,
        deploymentId: falSeedance.deploymentId,
        modelId: falSeedance.modelId,
        upstreamModelId: falSeedance.upstreamModelId,
        operations: falSeedance.operations,
      }),
    ).toStrictEqual(falSeedance.publishedPricing);
    const t2vOnlyTariff: NonNullable<Route['publishedPricing']> = {
      ...falSeedance.publishedPricing!,
      outputRates: [
        {
          operation: 'text-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 473_000,
          approximate: true,
        },
      ],
    };
    expect(scopePublishedPricing(t2vOnlyTariff, ['text-to-video'])).toBe(t2vOnlyTariff);
    expect(scopePublishedPricing(t2vOnlyTariff, ['image-to-video'])?.outputRates).toBeUndefined();
    expect(scopePublishedPricing(t2vOnlyTariff, ['image-to-video'])?.summary).toBe(
      t2vOnlyTariff.summary,
    );
  });
});

describe('feature-aware quoting and REST/local discovery', () => {
  it('quotes unified routes cleanly and rejects mismatched legacy RouteAlias operations', () => {
    const i2vRequest: GenerateInput = {
      modelId: 'bytedance/seedance-2.5',
      operation: 'image-to-video',
      input: {
        prompt: 'A quiet harbor at dusk.',
        firstFrame: { url: 'https://example.com/harbor.png' },
        resolution: '720p',
        duration: 5,
      },
    };
    const autoQuote = quote(i2vRequest);
    const falCandidates = autoQuote.candidates.filter(
      (candidate) => candidate.providerId === 'fal',
    );
    expect(falCandidates).toHaveLength(1);
    expect(falCandidates[0]).toMatchObject({
      routeId: 'fal-undisclosed/bytedance-seedance-2.5',
      operations: ['text-to-video', 'image-to-video', 'reference-to-video'],
    });
    const pikaCandidates = autoQuote.candidates.filter(
      (candidate) => candidate.providerId === 'pika',
    );
    expect(pikaCandidates).toHaveLength(1);
    expect(pikaCandidates[0]).toMatchObject({
      routeId: 'pika-undisclosed/bytedance-seedance-2.5',
      operations: ['text-to-video', 'image-to-video', 'reference-to-video'],
    });

    // Legacy matching RouteAlias resolves to canonical route.
    const pinnedAliasMatch = quote({
      ...i2vRequest,
      routeId: 'fal-undisclosed/bytedance/seedance-2.5/image-to-video',
    });
    expect(pinnedAliasMatch.candidates).toHaveLength(1);
    expect(pinnedAliasMatch.candidates[0]).toMatchObject({
      routeId: 'fal-undisclosed/bytedance-seedance-2.5',
      issues: [],
    });

    // Legacy mismatched RouteAlias is rejected safely with unsupported_operation.
    const pinnedMismatch = quote({
      ...i2vRequest,
      routeId: 'fal-undisclosed/bytedance/seedance-2.5/text-to-video',
    });
    expect(pinnedMismatch.candidates).toHaveLength(1);
    expect(pinnedMismatch.candidates[0]).toMatchObject({
      routeId: 'fal-undisclosed/bytedance-seedance-2.5',
      executable: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unsupported_operation' })]),
    });

    const h3R2vQuote = quote({
      modelId: 'minimax/h3-max',
      operation: 'reference-to-video',
      input: {
        prompt: 'Keep the sailboat framing.',
        references: [{ type: 'image', asset: { url: 'https://example.com/boat.png' } }],
        resolution: '768p',
        duration: 5,
      },
    });
    expect(
      h3R2vQuote.candidates
        .filter((candidate) => candidate.providerId === 'fal')
        .map((c) => c.routeId),
    ).toEqual(['fal-undisclosed/minimax-h3-max']);
    // Runway has no reference-to-video support on minimax/h3-max, so its exclusion remains transparent.
    expect(
      h3R2vQuote.candidates.find((candidate) => candidate.providerId === 'runway'),
    ).toMatchObject({
      executable: false,
      operations: ['text-to-video', 'image-to-video'],
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unsupported_operation' })]),
    });

    const pikaR2v = quote({
      modelId: 'pika/h3-flex',
      operation: 'reference-to-video',
      input: {
        prompt: 'Ocean waves in moonlight.',
        references: [{ type: 'image', asset: { url: 'https://example.com/ocean.png' } }],
        resolution: '768p',
        duration: 5,
      },
    });
    expect(pikaR2v.candidates.map((candidate) => candidate.routeId)).toEqual([
      'pika-undisclosed/pika-h3-flex',
    ]);
  });

  it('filters /v1/routes by operation identically over REST and local fallback', async () => {
    const app = await buildApp({ env: { NODE_ENV: 'test' } });
    apps.push(app);
    const path = '/v1/routes?modelId=bytedance%2Fseedance-2.5&operation=image-to-video';
    const rest = await app.inject({ url: path });
    expect(rest.statusCode).toBe(200);
    const restRoutes = rest.json().data as Route[];
    expect(restRoutes.every((route) => route.operations.includes('image-to-video'))).toBe(true);
    expect(restRoutes.filter((route) => route.deploymentId === 'fal-undisclosed')).toHaveLength(1);
    expect(restRoutes.filter((route) => route.deploymentId === 'pika-undisclosed')).toHaveLength(1);
    expect(restRoutes[0]?.id).toBe('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5');
    const fallback = localCatalog(new Request(`https://opengen.example${path}`))!;
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toEqual(rest.json());

    const fullCatalog = (await app.inject({ url: '/v1/catalog' })).json();
    expect(Array.isArray(fullCatalog.routeAliases)).toBe(true);
    expect(fullCatalog.routeAliases.length).toBeGreaterThan(100);

    const invalidPath = '/v1/routes?operation=not-an-operation';
    expect((await app.inject({ url: invalidPath })).statusCode).toBe(400);
    expect(localCatalog(new Request(`https://opengen.example${invalidPath}`))!.status).toBe(400);
  });
});

describe('UI grouping, SSR table markup, and Playground operation switching', () => {
  it('groups synthetic same-deployment routes contiguously with Official first', () => {
    const deployments = new Map(catalog.deployments.map((item) => [item.id, item]));
    const byteplus = getRoute('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5')!;
    const falBase = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    const t2v: Route = { ...falBase, id: 'fal-t2v', operations: ['text-to-video'] };
    const i2v: Route = { ...falBase, id: 'fal-i2v', operations: ['image-to-video'] };
    const r2v: Route = { ...falBase, id: 'fal-r2v', operations: ['reference-to-video'] };

    const rows = buildProviderRouteRows([r2v, byteplus, t2v, i2v], deployments, ['byteplus']);
    expect(
      rows.map((row) => [row.route.id, row.deploymentGroupSize, row.deploymentGroupIndex]),
    ).toEqual([
      [byteplus.id, 1, 0],
      [t2v.id, 3, 0],
      [i2v.id, 3, 1],
      [r2v.id, 3, 2],
    ]);
    expect(rows[1]).toMatchObject({
      isGroupStart: true,
      isGroupContinuation: false,
      isGroupEnd: false,
    });
    expect(rows[2]).toMatchObject({
      isGroupStart: false,
      isGroupContinuation: true,
      isGroupEnd: false,
    });
    expect(rows[3]).toMatchObject({
      isGroupStart: false,
      isGroupContinuation: true,
      isGroupEnd: true,
    });
  });

  it('builds clean provider identities and Playground deep links for unified routes', () => {
    const qwen = getRoute('alibaba-model-studio-ap-southeast-1/qwen-image-2.1-turbo')!;
    const qwenIdentity = routeIdentity(catalog, qwen, 'image-edit');
    expect(qwenIdentity).toMatchObject({
      label: 'Alibaba Cloud · Model Studio',
      feature: null,
      region: 'SG',
    });
    expect(formatRouteLabel(qwenIdentity)).toBe('Alibaba Cloud · Model Studio · SG');

    const falSeedance = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    const falIdentity = routeIdentity(catalog, falSeedance, 'image-to-video');
    expect(falIdentity).toMatchObject({
      label: 'fal',
      feature: null,
      region: null,
    });
    expect(formatRouteLabel(falIdentity)).toBe('fal');
    expect(formatDisclosedRegion('undisclosed')).toBeNull();
    expect(formatDisclosedRegion('unknown')).toBeNull();
    expect(formatDisclosedRegion('eu-central-1')).toBe('DE');
    expect(formatDisclosedRegion('cn-hongkong')).toBe('HK');
    expect(
      formatDeploymentLabel(
        catalog.deployments.find((entry) => entry.id === 'openai-undisclosed')!,
        catalog.providers.find((entry) => entry.id === 'openai'),
      ),
    ).toBe('OpenAI');
    expect(
      formatDeploymentLabel(
        catalog.deployments.find((entry) => entry.id === 'alibaba-model-studio-eu-central-1')!,
        catalog.providers.find((entry) => entry.id === 'alibaba'),
      ),
    ).toBe('Alibaba Cloud · Model Studio · DE');
    expect(playgroundHref(falSeedance.modelId, falSeedance.id, 'image-to-video')).toBe(
      '/playground?model=bytedance%2Fseedance-2.5&operation=image-to-video&route=fal-undisclosed%2Fbytedance-seedance-2.5',
    );
  });

  it('keeps unified routes pinned across supported operations and clears on unsupported operations', () => {
    const seedanceRoutes = catalog.routes.filter(
      (route) => route.modelId === 'bytedance/seedance-2.5',
    );
    // Unified BytePlus and fal routes keep their pin across T2V/I2V/R2V.
    expect(
      resolveOperationRouteSwitch(
        seedanceRoutes,
        'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5',
        'image-to-video',
      ),
    ).toEqual({
      routeId: 'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5',
      outcome: 'kept',
    });
    expect(
      resolveOperationRouteSwitch(
        seedanceRoutes,
        'fal-undisclosed/bytedance-seedance-2.5',
        'image-to-video',
      ),
    ).toEqual({
      routeId: 'fal-undisclosed/bytedance-seedance-2.5',
      outcome: 'kept',
    });
    // Deployment without target operation clears pin explicitly
    expect(
      resolveOperationRouteSwitch(
        seedanceRoutes,
        'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5',
        'video-edit',
      ),
    ).toEqual({ outcome: 'cleared-unsupported' });

    // Synthetic sibling routes still resolve unique/ambiguous cases safely.
    const falBase = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    const falT2v: Route = { ...falBase, id: 'fal-t2v', operations: ['text-to-video'] };
    const falI2v: Route = { ...falBase, id: 'fal-i2v', operations: ['image-to-video'] };
    const extraI2v: Route = {
      ...falI2v,
      id: 'fal-i2v-draft',
      feature: { id: 'draft', label: 'Draft preview' },
    };
    expect(
      resolveOperationRouteSwitch([falT2v, falI2v], falT2v.id, 'image-to-video'),
    ).toMatchObject({ routeId: falI2v.id, outcome: 'switched-sibling' });
    expect(
      resolveOperationRouteSwitch([falT2v, falI2v, extraI2v], falT2v.id, 'image-to-video'),
    ).toEqual({ outcome: 'ambiguous-sibling' });

    // Detects saved routing conflicts before applying a pin and clears only conflicting filters.
    const seedanceModel = getModel('bytedance/seedance-2.5')!;
    const compatibleDraft: GenerateInput = {
      modelId: seedanceModel.id,
      operation: 'image-to-video',
      input: { prompt: 'Harbor' },
      routing: { providerIds: ['fal'], preference: 'cost', fallback: false },
    };
    expect(
      siblingRouteRoutingConflict(seedanceModel, falBase, catalog.deployments, compatibleDraft),
    ).toBe(false);

    const conflictingDraft: GenerateInput = {
      modelId: seedanceModel.id,
      operation: 'image-to-video',
      input: { prompt: 'Harbor' },
      routing: {
        deploymentIds: ['byteplus-modelark-ap-southeast-1'],
        providerIds: ['byteplus'],
        endpointRegions: ['ap-southeast-1'],
        authorOnly: true,
        preference: 'cost',
      },
    };
    expect(
      siblingRouteRoutingConflict(seedanceModel, falBase, catalog.deployments, conflictingDraft),
    ).toBe(true);
    expect(
      clearConflictingRoutingFilters(
        seedanceModel,
        falBase,
        catalog.deployments,
        conflictingDraft.routing,
      ),
    ).toEqual({ preference: 'cost' });

    // Retains global providerIds when a matching modelProviderExceptions entry permits the chosen provider.
    const exceptionRouting = {
      providerIds: ['byteplus'],
      modelProviderExceptions: [{ modelId: seedanceModel.id, providerIds: ['fal'] }],
      deploymentIds: ['byteplus-modelark-ap-southeast-1'],
    };
    expect(
      clearConflictingRoutingFilters(seedanceModel, falBase, catalog.deployments, exceptionRouting),
    ).toEqual({
      providerIds: ['byteplus'],
      modelProviderExceptions: [{ modelId: seedanceModel.id, providerIds: ['fal'] }],
    });
  });

  it('closes RouteFeature and RouteAlias OpenAPI schemas against unspecified properties', () => {
    const doc = openApiDocument() as {
      components: {
        schemas: {
          RouteAlias: { additionalProperties?: boolean };
          RouteFeature: { additionalProperties?: boolean };
        };
      };
    };
    expect(doc.components.schemas.RouteFeature.additionalProperties).toBe(false);
    expect(doc.components.schemas.RouteAlias.additionalProperties).toBe(false);
  });
});

describe('cheapest route highlight per model variant', () => {
  it('computes apples-to-apples savings vs the most expensive route on Seedance 2.5 and respects feature filters', () => {
    const model = getModel('bytedance/seedance-2.5')!;
    const routes = catalog.routes.filter((route) => route.modelId === model.id);

    const allView = computeCheapestRouteHighlights(routes, model, catalog);
    expect([...allView.keys()].sort()).toEqual([
      'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5',
      'replicate-undisclosed/bytedance-seedance-2.5',
    ]);
    const replicate = allView.get('replicate-undisclosed/bytedance-seedance-2.5')!;
    expect(replicate).toMatchObject({
      maxPercentOff: 53,
      minPercentOff: 53,
      savingsLabel: '53% off',
      winningResolutions: ['480p'],
      isTied: false,
      usesPublishedEstimates: true,
    });
    expect(replicate.comparisons[0]).toMatchObject({
      resolution: '480p',
      operations: ['text-to-video', 'image-to-video', 'reference-to-video'],
      cheapestMicros: 102_800,
      mostExpensiveMicros: 220_500,
      mostExpensiveLabels: ['fal'],
      percentOff: 53,
    });

    const byteplus = allView.get('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5')!;
    expect(byteplus).toMatchObject({
      maxPercentOff: 51,
      minPercentOff: 51,
      savingsLabel: '51% off',
      winningResolutions: ['720p', '1080p'],
      isTied: false,
      usesPublishedEstimates: true,
    });
    expect(byteplus.comparisons[0]).toMatchObject({
      resolution: '720p',
      operations: ['text-to-video', 'image-to-video', 'reference-to-video'],
      cheapestMicros: 231_000,
      mostExpensiveMicros: 473_000,
      mostExpensiveLabels: ['fal'],
      percentOff: 51,
    });

    // Under image-to-video, comparisons scope strictly to image-to-video routes.
    const i2vView = computeCheapestRouteHighlights(routes, model, catalog, 'image-to-video');
    expect(
      i2vView.get('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5')?.comparisons,
    ).toHaveLength(2);
    expect(
      i2vView.get('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5')?.comparisons[0],
    ).toMatchObject({
      resolution: '720p',
      operations: ['image-to-video'],
      mostExpensiveLabels: ['fal'],
      percentOff: 51,
    });

    // Under video-edit, only Runway supports it -> zero cheapest badges.
    expect(computeCheapestRouteHighlights(routes, model, catalog, 'video-edit').size).toBe(0);
  });

  it('handles regional ties, variable per-resolution savings, and quality-tier partitioning truthfully', () => {
    const wan = getModel('alibaba/wan-3.0')!;
    const wanRoutes = catalog.routes.filter((route) => route.modelId === wan.id);
    const wanEditHighlights = computeCheapestRouteHighlights(wanRoutes, wan, catalog, 'video-edit');
    expect(wanEditHighlights.size).toBe(5);
    expect(wanEditHighlights.has('alibaba/ap-southeast-1/wan-3.0')).toBe(false);
    const frankfurt = wanEditHighlights.get('alibaba/eu-central-1/wan-3.0')!;
    expect(frankfurt).toMatchObject({
      savingsLabel: '17% off',
      maxPercentOff: 17,
      minPercentOff: 17,
      isTied: true,
      winningResolutions: ['480p', '720p', '1080p'],
    });
    expect(frankfurt.comparisons).toHaveLength(3);
    expect(frankfurt.comparisons[0]).toMatchObject({
      resolution: '480p',
      operations: ['video-edit'],
      mostExpensiveLabels: ['Alibaba Cloud · Model Studio · SG'],
      tiedCheapestCount: 5,
    });

    const wanT2vHighlights = computeCheapestRouteHighlights(
      wanRoutes,
      wan,
      catalog,
      'text-to-video',
    );
    expect([...wanT2vHighlights.keys()]).toEqual(['pika-undisclosed/alibaba-wan-3.0']);
    expect(wanT2vHighlights.get('pika-undisclosed/alibaba-wan-3.0')).toMatchObject({
      savingsLabel: '35% off',
      maxPercentOff: 35,
      minPercentOff: 35,
    });

    const prime = getModel('alibaba/wan-3.0-prime')!;
    const primeRoutes = catalog.routes.filter((route) => route.modelId === prime.id);
    const primeFrankfurt = computeCheapestRouteHighlights(
      primeRoutes,
      prime,
      catalog,
      'video-edit',
    ).get('alibaba/eu-central-1/wan-3.0-prime')!;
    expect(primeFrankfurt).toMatchObject({
      minPercentOff: 6,
      maxPercentOff: 9,
      savingsLabel: 'Up to 9% off',
      isTied: true,
    });

    // Quality-tiered models compare strictly within matching quality tiers (never medium vs Runway high).
    const flare = getModel('openai/gpt-image-2.5-flare')!;
    const flareRoutes = catalog.routes.filter((route) => route.modelId === flare.id);
    const flareT2i = computeCheapestRouteHighlights(flareRoutes, flare, catalog, 'text-to-image');
    const pikaFlare = flareT2i.get('pika-undisclosed/openai-gpt-image-2.5-flare')!;
    expect(pikaFlare).toMatchObject({
      savingsLabel: 'Up to 73% off',
      maxPercentOff: 73,
      minPercentOff: 46,
    });
    expect(pikaFlare.comparisons.every((entry) => entry.quality === 'medium')).toBe(true);
    expect(
      pikaFlare.comparisons.every(
        (entry) => !entry.mostExpensiveLabels.some((label) => label.includes('Runway')),
      ),
    ).toBe(true);
  });

  it('never compares across different resolutions or different operations, omits 0% ties, and scopes displayed cheapest markers by operation', () => {
    for (const modelId of ['minimax/h3-max', 'pika/h3-flex']) {
      const model = getModel(modelId)!;
      const routes = catalog.routes.filter((route) => route.modelId === model.id);
      expect(computeCheapestRouteHighlights(routes, model, catalog).size).toBe(0);
    }

    // Route A ($0.10 T2V / $0.30 I2V) vs Route B ($0.05 T2V / $0.60 I2V) at 720p:
    // Under All, A displays $0.10 (T2V), while winning only I2V ($0.30) -> displayed $0.10 must NOT be marked cheapest.
    const model = getModel('bytedance/seedance-2.5')!;
    const baseA = getRoute('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5')!;
    const baseB = getRoute('runway-undisclosed/bytedance-seedance-2.5')!;
    const routeA: Route = {
      ...baseA,
      operations: ['text-to-video', 'image-to-video'],
      resolutions: ['720p'],
      rates: [
        {
          operation: 'text-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 100_000,
        },
        {
          operation: 'image-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 300_000,
        },
      ],
      publishedPricing: undefined,
    };
    const routeB: Route = {
      ...baseB,
      operations: ['text-to-video', 'image-to-video'],
      resolutions: ['720p'],
      rates: [
        {
          operation: 'text-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 50_000,
        },
        {
          operation: 'image-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 600_000,
        },
      ],
      publishedPricing: undefined,
    };
    const allHighlights = computeCheapestRouteHighlights([routeA, routeB], model, catalog);
    const displayedAAll = resolveDisplayedRouteRate(routeA, '720p', 'video');
    const displayedAI2v = resolveDisplayedRouteRate(routeA, '720p', 'video', 'image-to-video');
    const displayedBAll = resolveDisplayedRouteRate(routeB, '720p', 'video');
    expect(isDisplayedRateCheapest(allHighlights.get(routeA.id), displayedAAll)).toBe(false);
    expect(
      isDisplayedRateCheapest(allHighlights.get(routeA.id), displayedAI2v, 'image-to-video'),
    ).toBe(true);
    expect(isDisplayedRateCheapest(allHighlights.get(routeB.id), displayedBAll)).toBe(true);

    // Real catalog check on Wan 3.0: Frankfurt wins video-edit/extend, not its displayed All (text-to-video) rate.
    const wan = getModel('alibaba/wan-3.0')!;
    const wanRoutes = catalog.routes.filter((route) => route.modelId === wan.id);
    const frankfurt = getRoute('alibaba/eu-central-1/wan-3.0')!;
    const wanAll = computeCheapestRouteHighlights(wanRoutes, wan, catalog);
    expect(
      isDisplayedRateCheapest(
        wanAll.get(frankfurt.id),
        resolveDisplayedRouteRate(frankfurt, '480p', 'video'),
      ),
    ).toBe(false);
    const wanEdit = computeCheapestRouteHighlights(wanRoutes, wan, catalog, 'video-edit');
    expect(
      isDisplayedRateCheapest(
        wanEdit.get(frankfurt.id),
        resolveDisplayedRouteRate(frankfurt, '480p', 'video', 'video-edit'),
        'video-edit',
      ),
    ).toBe(true);

    // Same prices with mixed qualification (qualified T2V vs non-approximate published I2V) stay separated so usesPublishedEstimates remains true.
    const mixedA: Route = {
      ...baseA,
      operations: ['text-to-video', 'image-to-video'],
      resolutions: ['720p'],
      rates: [
        {
          operation: 'text-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 100_000,
        },
      ],
      publishedPricing: {
        summary: 'Published $0.10/sec',
        source: baseA.pricingSource,
        conditions: ['Published list rate.'],
        outputRates: [
          {
            operation: 'image-to-video',
            resolution: '720p',
            unit: 'output-second',
            usdMicros: 100_000,
          },
        ],
      },
    };
    const mixedB: Route = {
      ...baseB,
      operations: ['text-to-video', 'image-to-video'],
      resolutions: ['720p'],
      rates: [
        {
          operation: 'text-to-video',
          resolution: '720p',
          unit: 'output-second',
          usdMicros: 200_000,
        },
      ],
      publishedPricing: {
        summary: 'Published $0.20/sec',
        source: baseB.pricingSource,
        conditions: ['Published list rate.'],
        outputRates: [
          {
            operation: 'image-to-video',
            resolution: '720p',
            unit: 'output-second',
            usdMicros: 200_000,
          },
        ],
      },
    };
    const mixedHighlights = computeCheapestRouteHighlights([mixedA, mixedB], model, catalog);
    const mixedWinner = mixedHighlights.get(mixedA.id)!;
    expect(mixedWinner.comparisons).toHaveLength(2);
    expect(mixedWinner.usesPublishedEstimates).toBe(true);
  });

  it('dispatches multiple operations on one unified fal Route to distinct provider endpoints', async () => {
    const route = getRoute('fal-undisclosed/bytedance-seedance-2.5')!;
    const deployment = catalog.deployments.find((item) => item.id === route.deploymentId)!;
    const urls: string[] = [];
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'fixture-key' },
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({ request_id: 'task-1' });
      },
    });
    const baseContext = {
      jobId: '00000000-0000-4000-8000-000000000099',
      workspaceId: 'workspace-fixture',
      route,
      deployment,
    };
    await adapter.submit({
      ...baseContext,
      input: {
        modelId: 'bytedance/seedance-2.5',
        operation: 'text-to-video',
        input: { prompt: 'Ocean waves.', resolution: '720p', duration: 5, aspectRatio: '16:9' },
      },
    });
    await adapter.submit({
      ...baseContext,
      input: {
        modelId: 'bytedance/seedance-2.5',
        operation: 'image-to-video',
        input: {
          prompt: 'Ocean waves.',
          firstFrame: { url: 'https://assets.example.com/first.png' },
          resolution: '720p',
          duration: 5,
          aspectRatio: 'source',
        },
      },
    });
    await adapter.submit({
      ...baseContext,
      input: {
        modelId: 'bytedance/seedance-2.5',
        operation: 'reference-to-video',
        input: {
          prompt: 'Ocean waves.',
          references: [{ type: 'image', asset: { url: 'https://assets.example.com/ref.png' } }],
          resolution: '720p',
          duration: 5,
          aspectRatio: '16:9',
        },
      },
    });
    expect(urls).toEqual([
      'https://queue.fal.run/bytedance/seedance-2.5/text-to-video',
      'https://queue.fal.run/bytedance/seedance-2.5/image-to-video',
      'https://queue.fal.run/bytedance/seedance-2.5/reference-to-video',
    ]);
  });

  it('normalizes legacy RouteAlias IDs in Playground validation and CLI catalog lookup', async () => {
    const normalized = validatePlaygroundRequest(
      {
        modelId: 'bytedance/seedance-2.5',
        operation: 'image-to-video',
        routeId: 'fal-undisclosed/bytedance/seedance-2.5/image-to-video',
        billing: 'byok',
        input: {
          prompt: 'A quiet harbor.',
          firstFrame: { url: 'https://assets.example.com/first.png' },
          resolution: '720p',
          duration: 5,
        },
      },
      catalog,
      'bytedance/seedance-2.5',
    );
    expect(normalized.routeId).toBe('fal-undisclosed/bytedance-seedance-2.5');
    expect(() =>
      validatePlaygroundRequest(
        {
          modelId: 'bytedance/seedance-2.5',
          operation: 'text-to-video',
          routeId: 'fal-undisclosed/bytedance/seedance-2.5/image-to-video',
          billing: 'byok',
          input: {
            prompt: 'A quiet harbor.',
            resolution: '720p',
            duration: 5,
          },
        },
        catalog,
        'bytedance/seedance-2.5',
      ),
    ).toThrow(/is bound to image-to-video and cannot execute text-to-video/);

    const client = new OpenGen({
      baseUrl: 'https://gateway.example',
      fetch: async (url) => localCatalog(new Request(String(url)))!,
    });
    const cliEntry = await runCommand(
      ['catalog', 'get', 'fal-undisclosed/bytedance/seedance-2.5/image-to-video'],
      { client, env: { NODE_ENV: 'test' } },
    );
    expect(cliEntry).toMatchObject({
      id: 'fal-undisclosed/bytedance-seedance-2.5',
      modelId: 'bytedance/seedance-2.5',
    });
  });
});
