import { describe, expect, it } from 'vitest';
import {
  catalog,
  getModel,
  getModelRoutes,
  getSeriesDetail,
  quote,
  searchCatalog,
  validateCatalog,
} from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';

const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A red kite in the wind', resolution: '720p', duration: 10 },
};

describe('source-backed catalog', () => {
  it('has valid unique references and every requested model group', () => {
    expect(validateCatalog()).toEqual([]);
    expect(catalog.models.length).toBeGreaterThanOrEqual(27);
    expect(
      catalog.models.filter((model) => model.id.startsWith('bytedance/seedance-2.0')),
    ).toHaveLength(3);
  });
  it('lists H3 Max once across provider labels and keeps Turbo/Flex distinct', () => {
    const max = getModel('minimax/h3-max');
    expect(max).toMatchObject({ id: 'minimax/h3-max', name: 'MiniMax H3 Max', creator: 'MiniMax' });
    expect(getModel('fal/h3-max')).toBe(max);
    expect(catalog.models.some((model) => model.id === 'fal/h3-max')).toBe(false);
    expect(searchCatalog('fal/h3-max').map((model) => model.id)).toEqual([
      'minimax/h3-max',
      'fal/h3-max-turbo',
    ]);
    expect(getModel('fal/h3-max-turbo')?.id).toBe('fal/h3-max-turbo');
    expect(getModel('pika/h3-flex')?.familyId).toBe('minimax-h3');
    const routes = catalog.routes.filter((route) => route.modelId === max?.id);
    expect(routes).toHaveLength(3);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-undisclosed/minimax-h3-max',
          deploymentId: 'minimax-undisclosed',
          upstreamModelId: 'MiniMax-H3-Max',
          providerModelName: 'MiniMax H3 Max',
        }),
        expect.objectContaining({
          id: 'fal-undisclosed/minimax-h3-max',
          deploymentId: 'fal-undisclosed',
          upstreamModelId: 'minimax/h3-max',
          upstreamEndpoints: {
            'text-to-video': 'minimax/h3-max/text-to-video',
            'image-to-video': 'minimax/h3-max/image-to-video',
            'reference-to-video': 'minimax/h3-max/reference-to-video',
          },
          providerModelName: 'H3 Max',
        }),
        expect.objectContaining({
          id: 'runway-undisclosed/minimax-h3-max',
          deploymentId: 'runway-undisclosed',
        }),
      ]),
    );
    expect(catalog.models).toHaveLength(50);
    expect(catalog.routes).toHaveLength(178);
  });
  it('resolves Omni Flash as a search alias without creating duplicate live releases', () => {
    expect(searchCatalog('Gemini Omni Flash').map((model) => model.id)).toEqual([
      'google/gemini-omni-1.1-flash',
    ]);
  });
  it('records exact author-operated providers across brands and H3 derivatives', () => {
    expect(getModel('bytedance/seedance-2.5')?.authorProviderIds).toEqual(['byteplus']);
    expect(getModel('qwen/image-2.1')?.authorProviderIds).toEqual(['alibaba']);
    expect(getModel('minimax/h3-max')?.authorProviderIds).toEqual(['minimax']);
    expect(getModel('fal/h3-max')?.authorProviderIds).toEqual(['minimax']);
    expect(getModel('fal/h3-max-turbo')?.authorProviderIds).toEqual(['fal']);
    expect(getModel('pika/h3-flex')?.authorProviderIds).toEqual(['pika']);
    expect(getModel('kling/kling-4.0')?.authorProviderIds).toEqual(['kling']);
    // Authorship does not invent an author-hosted offering.
    expect(catalog.routes.filter((route) => route.modelId === 'qwen/image-2.1')).toHaveLength(0);
    expect(validateCatalog()).toEqual([]);
  });
  it('rejects unknown or duplicate author-provider references', () => {
    const model = getModel('minimax/h3-max')!;
    const original = model.authorProviderIds;
    try {
      model.authorProviderIds = ['unknown-provider'];
      expect(validateCatalog()).toContain(
        'Unknown author provider unknown-provider for minimax/h3-max',
      );
      model.authorProviderIds = ['minimax', 'minimax'];
      expect(validateCatalog()).toContain('Duplicate author provider for minimax/h3-max');
    } finally {
      model.authorProviderIds = original;
    }
  });
  it('keeps raw route records canonical even when lookup accepts legacy aliases', () => {
    const route = catalog.routes.find((item) => item.id === 'fal-undisclosed/minimax-h3-max')!;
    const canonical = route.modelId;
    try {
      route.modelId = 'fal/h3-max';
      expect(validateCatalog()).toContain(`Noncanonical model reference for ${route.id}`);
    } finally {
      route.modelId = canonical;
    }
  });
  it('places official routes before third-party routes for every model and series detail', () => {
    const deployments = new Map(
      catalog.deployments.map((deployment) => [deployment.id, deployment]),
    );
    for (const model of catalog.models) {
      const rawRoutes = catalog.routes.filter((route) => route.modelId === model.id);
      const selectedRoutes = getModelRoutes(model.id);
      expect(selectedRoutes.map((route) => route.id)).toEqual(rawRoutes.map((route) => route.id));
      let seenThirdParty = false;
      for (const route of selectedRoutes) {
        const providerId = deployments.get(route.deploymentId)?.providerId ?? '';
        const isOfficial = model.authorProviderIds.includes(providerId);
        if (isOfficial) {
          expect(seenThirdParty).toBe(false);
        } else {
          seenThirdParty = true;
        }
      }
    }
    expect(getModelRoutes('bytedance/seedance-2.5')[0]?.id).toBe(
      'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5',
    );
    expect(getModelRoutes('bytedance/seedance-2.5-flash')[0]?.id).toBe(
      'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5-flash',
    );
    expect(getModelRoutes('bytedance/seedance-2.5-flash').map((route) => route.id)).toEqual([
      'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5-flash',
      'runway-undisclosed/bytedance-seedance-2.5-flash',
      'fal-undisclosed/bytedance-seedance-2.5-flash',
      'pika-undisclosed/bytedance-seedance-2.5-flash',
    ]);
    expect(getModelRoutes('minimax/h3-max')[0]?.id).toBe('minimax-undisclosed/minimax-h3-max');
    expect(getModelRoutes('fal/h3-max')[0]?.id).toBe('minimax-undisclosed/minimax-h3-max');
    expect(getModelRoutes('openai/gpt-image-2.5-flare')[0]?.id).toBe(
      'openai-undisclosed/openai-gpt-image-2.5-flare',
    );
    expect(getModelRoutes('google/nano-banana-2.1')[0]?.id).toBe(
      'google-undisclosed/google-nano-banana-2.1',
    );
    expect(getSeriesDetail('bytedance/seedance-2.5')?.providers[0]?.id).toBe('byteplus');
    expect(getSeriesDetail('openai/gpt-image-2.5')?.providers[0]?.id).toBe('openai');
    expect(getSeriesDetail('google/nano-banana-2.1')?.providers[0]?.id).toBe('google');
    expect(getSeriesDetail('kling/kling-4.0')?.providers[0]?.id).toBe('kling');
    expect(getSeriesDetail('alibaba/happy-horse-1.1')?.providers[0]?.id).toBe('alibaba');
    expect(getSeriesDetail('bfl/flux-3-video')?.providers[0]?.id).toBe('bfl');
    expect(getSeriesDetail('bfl/flux-3-image')?.providers[0]?.id).toBe('bfl');
  });
  it('provides an official author-operated route for every closed model and verified official hosts', () => {
    const deployments = new Map(
      catalog.deployments.map((deployment) => [deployment.id, deployment]),
    );
    const missingOfficial = catalog.models.filter((model) => {
      const routes = getModelRoutes(model.id);
      return !routes.some((route) =>
        model.authorProviderIds.includes(deployments.get(route.deploymentId)?.providerId ?? ''),
      );
    });
    // Every closed model must carry at least one official route; only weights-only qwen/image-2.1 lacks one.
    expect(missingOfficial.filter((model) => model.openness === 'closed')).toEqual([]);
    expect(missingOfficial.map((model) => model.id)).toEqual(['qwen/image-2.1']);

    expect(getModelRoutes('kling/kling-4.0')[0]).toMatchObject({
      id: 'kling-ap-southeast-1/kling-kling-4.0',
      resolutions: ['720p', '1080p', '4K'],
      adapter: 'kling',
    });
    expect(getModelRoutes('kling/kling-4.0-flash')[0]).toMatchObject({
      id: 'kling-ap-southeast-1/kling-kling-4.0-flash',
      resolutions: ['720p'],
      adapter: 'kling',
    });

    const happyHorseOfficial = getModelRoutes('alibaba/happy-horse-1.1').filter(
      (route) => deployments.get(route.deploymentId)?.providerId === 'alibaba',
    );
    expect(happyHorseOfficial).toHaveLength(5);
    expect(happyHorseOfficial.every((route) => route.adapter === 'alibaba')).toBe(true);
    expect(happyHorseOfficial.map((route) => route.deploymentId).sort()).toEqual([
      'alibaba-model-studio-ap-northeast-1',
      'alibaba-model-studio-ap-southeast-1',
      'alibaba-model-studio-cn-beijing',
      'alibaba-model-studio-eu-central-1',
      'alibaba-model-studio-us-east-1',
    ]);

    expect(getModelRoutes('bfl/flux-3-video')[0]).toMatchObject({
      id: 'bfl-undisclosed/bfl-flux-3-video',
      resolutions: ['720p', '1080p', '1440p', '2160p'],
      adapter: 'bfl',
    });
    expect(getModelRoutes('bfl/flux-3-image')[0]).toMatchObject({
      id: 'bfl-undisclosed/bfl-flux-3-image',
      resolutions: ['768sq', '1K', '1.5K', '2K', '4K'],
      adapter: 'bfl',
    });
    expect(getModelRoutes('bfl/flux-3-klein')[0]).toMatchObject({
      id: 'bfl-undisclosed/bfl-flux-3-klein',
      resolutions: ['768sq', '1K', '1.5K', '2K', '4K'],
      adapter: 'bfl',
    });
    expect(getModelRoutes('xai/grok-imagine-video')[0]).toMatchObject({
      id: 'xai-undisclosed/xai-grok-imagine-video',
      adapter: 'xai',
    });
  });
  it('rejects catalog ordering when a third-party route precedes an official route', () => {
    const original = [...catalog.routes];
    try {
      const officialIndex = catalog.routes.findIndex(
        (route) => route.id === 'byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5',
      );
      const runwayIndex = catalog.routes.findIndex(
        (route) => route.id === 'runway-undisclosed/bytedance-seedance-2.5',
      );
      const official = catalog.routes[officialIndex]!;
      catalog.routes[officialIndex] = catalog.routes[runwayIndex]!;
      catalog.routes[runwayIndex] = official;
      expect(validateCatalog()).toContain(
        'Official routes must precede third-party routes for bytedance/seedance-2.5',
      );
    } finally {
      catalog.routes.splice(0, catalog.routes.length, ...original);
    }
  });
  it('lists six separately sourced Alibaba deployments plus aggregator offerings for each Wan variant', () => {
    for (const modelId of ['alibaba/wan-3.0', 'alibaba/wan-3.0-prime']) {
      const routes = catalog.routes.filter((route) => route.modelId === modelId);
      const alibabaRoutes = routes.filter((route) => route.adapter === 'alibaba');
      expect(alibabaRoutes).toHaveLength(6);
      expect(new Set(alibabaRoutes.map((route) => route.deploymentId)).size).toBe(6);
      expect(routes).toHaveLength(10);
      expect(new Set(routes.map((route) => route.deploymentId))).toEqual(
        new Set([
          ...alibabaRoutes.map((route) => route.deploymentId),
          'fal-undisclosed',
          'pika-undisclosed',
          'replicate-undisclosed',
          'runway-undisclosed',
        ]),
      );
    }
  });
  it('keeps generic provider endpoints in catalog code and requires env vars for workspace-specific endpoints', () => {
    const alibabaRegional = catalog.deployments.filter(
      (deployment) =>
        deployment.providerId === 'alibaba' && deployment.endpointRegion !== 'undisclosed',
    );
    expect(alibabaRegional).toHaveLength(6);
    for (const deployment of alibabaRegional) {
      expect(deployment.endpointTemplate).toBeNull();
      expect(deployment.endpointEnv).toBe(
        `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}_ENDPOINT`,
      );
    }
    for (const id of [
      'byteplus-modelark-ap-southeast-1',
      'kling-ap-southeast-1',
      'fal-undisclosed',
      'openai-undisclosed',
      'xai-undisclosed',
      'minimax-undisclosed',
      'google-undisclosed',
      'replicate-undisclosed',
      'runway-undisclosed',
      'pika-undisclosed',
      'bfl-undisclosed',
    ]) {
      const deployment = catalog.deployments.find((item) => item.id === id);
      expect(deployment?.endpointTemplate).toMatch(/^https:\/\//);
      expect(deployment?.endpointEnv).toBeUndefined();
    }
  });
});

describe('regional quote selection', () => {
  it('discloses the tested Wan operations and configuration for broader quotes', () => {
    const route = catalog.routes.find((entry) => entry.id === 'alibaba/ap-southeast-1/wan-3.0')!;
    const result = quote({ ...input, routeId: route.id }, { executableRouteIds: [route.id] });
    expect(result.candidates[0]!.notices).toContain(
      'Live verification covered text-to-video, image-to-video at 480p for 2s.',
    );
    expect(route.liveVerification?.operation).toBe('image-to-video');
    expect(
      catalog.routes
        .filter((entry) => entry.modelId === 'alibaba/wan-3.0' && entry.id !== route.id)
        .every((entry) => entry.status === 'documented' && !entry.liveVerification),
    ).toBe(true);
  });

  it('still discloses legacy single-operation verification metadata', () => {
    const route = catalog.routes.find((entry) => entry.id === 'alibaba/ap-southeast-1/wan-3.0')!;
    const original = route.liveVerification;
    try {
      route.liveVerification = {
        checkedAt: '2026-11-06',
        operation: 'image-to-video',
        resolution: '480p',
        duration: 2,
      };
      const result = quote({ ...input, routeId: route.id }, { executableRouteIds: [route.id] });
      expect(result.candidates[0]!.notices).toContain(
        'Live verification covered image-to-video at 480p for 2s.',
      );
    } finally {
      route.liveVerification = original;
    }
  });

  it('quotes both H3 Max providers under one exact identity and accepts the legacy alias', () => {
    const canonical: GenerateInput = {
      modelId: 'minimax/h3-max',
      operation: 'text-to-video',
      input: { prompt: 'A red kite.', duration: 5, resolution: '768p' },
      billing: 'byok',
    };
    const options = {
      executableRouteIds: ['minimax-undisclosed/minimax-h3-max', 'fal-undisclosed/minimax-h3-max'],
    };
    const result = quote(canonical, options);
    expect(result.modelId).toBe('minimax/h3-max');
    expect(new Set(result.candidates.map((candidate) => candidate.providerId))).toEqual(
      new Set(['fal', 'minimax', 'runway']),
    );
    expect(
      result.candidates
        .filter((candidate) => candidate.executable)
        .map((candidate) => candidate.routeId)
        .sort(),
    ).toEqual(['fal-undisclosed/minimax-h3-max', 'minimax-undisclosed/minimax-h3-max']);
    expect(quote({ ...canonical, modelId: 'fal/h3-max' }, options)).toEqual(result);
    // Legacy RouteAlias resolves cleanly to the canonical unified route.
    const pinned = quote({ ...canonical, routeId: 'fal-undisclosed/fal-h3-max' }, options);
    expect(pinned.candidates).toHaveLength(1);
    expect(pinned.selectedRouteId).toBe('fal-undisclosed/minimax-h3-max');
    const fullHd = quote(
      { ...canonical, input: { ...canonical.input, resolution: '1080p' } },
      options,
    );
    expect(fullHd.candidates.find((candidate) => candidate.providerId === 'minimax')).toMatchObject(
      {
        executable: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'unsupported_resolution' }),
        ]),
      },
    );
    expect(
      fullHd.candidates.find((candidate) => candidate.routeId === 'fal-undisclosed/minimax-h3-max')
        ?.executable,
    ).toBe(true);
    expect(fullHd.selectedRouteId).toBe('fal-undisclosed/minimax-h3-max');
  });
  it('keeps regional prices separate and refuses to imply execution without configuration', () => {
    const result = quote(input);
    expect(
      result.candidates.find((candidate) => candidate.endpointRegion === 'ap-southeast-1')
        ?.estimatedCostMicros,
    ).toBe(1_000_000);
    expect(
      result.candidates.find((candidate) => candidate.endpointRegion === 'eu-central-1')
        ?.estimatedCostMicros,
    ).toBe(825_130);
    expect(result.selectedRouteId).toBeNull();
  });
  it('pins every eligible candidate to the allowed regional deployment', () => {
    const result = quote(
      { ...input, routing: { endpointRegions: ['ap-southeast-1'] } },
      { executableRouteIds: catalog.routes.map((route) => route.id) },
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.selectedRouteId).toBe('alibaba/ap-southeast-1/wan-3.0');
  });
  it('does not equate a Frankfurt endpoint with EU-only inference', () => {
    expect(() =>
      quote({
        ...input,
        routing: { endpointRegions: ['eu-central-1'], processingRegions: ['eu-central-1'] },
      }),
    ).toThrow('No route satisfies');
  });
  it('does not quote a partial output-only price for reference-video operations', () => {
    const result = quote({
      ...input,
      operation: 'reference-to-video',
      input: {
        ...input.input,
        references: [{ type: 'video', asset: { url: 'https://example.com/input.mp4' } }],
      },
    });
    expect(result.candidates.every((candidate) => candidate.estimatedCostMicros === null)).toBe(
      true,
    );
    expect(result.selectedRouteId).toBeNull();
  });
  it('never selects an unknown-priced route as free', () => {
    const result = quote(
      {
        modelId: 'bytedance/seedance-2.5',
        operation: 'text-to-video',
        input: { prompt: 'A red kite', resolution: '720p', duration: 5 },
        routing: { deploymentIds: ['fal-undisclosed', 'pika-undisclosed', 'runway-undisclosed'] },
      },
      { executableRouteIds: catalog.routes.map((route) => route.id) },
    );
    expect(result.candidates.every((candidate) => candidate.estimatedCostMicros === null)).toBe(
      true,
    );
    expect(result.candidates.every((candidate) => candidate.executable === false)).toBe(true);
    expect(result.selectedRouteId).toBeNull();
  });
  it('quotes the real Singapore image tariff without applying it to edit/input-image costs', () => {
    const image: GenerateInput = {
      modelId: 'bytedance/seedream-5.0-pro',
      operation: 'text-to-image',
      input: { prompt: 'A red kite', resolution: '1K' },
    };
    const route = catalog.routes.find(
      (item) =>
        item.modelId === image.modelId && item.deploymentId === 'byteplus-modelark-ap-southeast-1',
    )!;
    const options = { executableRouteIds: [route.id] };
    expect(quote(image, options).selectedRouteId).toBe(route.id);
    expect(
      quote(image, options).candidates.find((item) => item.routeId === route.id)
        ?.estimatedCostMicros,
    ).toBe(45_000);
    expect(
      quote({ ...image, input: { ...image.input, resolution: '2K' } }, options).candidates.find(
        (item) => item.routeId === route.id,
      )?.estimatedCostMicros,
    ).toBe(90_000);
    const references = [
      { type: 'image' as const, asset: { url: 'https://example.com/photo.png' } },
    ];
    expect(() => quote({ ...image, input: { ...image.input, references } }, options)).toThrow(
      'references is not a supported argument',
    );
    expect(
      quote({ ...image, operation: 'image-edit', input: { ...image.input, references } }, options)
        .selectedRouteId,
    ).toBeNull();
  });
  it('rejects unsupported duration, model substitution and regional broadening', () => {
    expect(() => quote({ ...input, input: { ...input.input, duration: 31 } })).toThrow(
      'Duration is outside this model capability',
    );
    expect(() => quote({ ...input, routeId: 'alibaba/ap-southeast-1/wan-3.0-prime' })).toThrow(
      'does not serve this exact model',
    );
    expect(() =>
      quote({
        ...input,
        routeId: 'alibaba/ap-southeast-1/wan-3.0',
        routing: { endpointRegions: ['eu-central-1'] },
      }),
    ).toThrow('No route satisfies');
  });
  it('excludes over-budget routes from execution', () => {
    const result = quote(
      { ...input, maxCostMicros: 100 },
      { executableRouteIds: catalog.routes.map((route) => route.id) },
    );
    expect(result.selectedRouteId).toBeNull();
    expect(result.candidates.every((candidate) => !candidate.executable)).toBe(true);
  });
  it('does not invent performance observations for speed/reliability preference', () => {
    const result = quote(
      { ...input, routing: { preference: 'speed' } },
      { executableRouteIds: catalog.routes.map((route) => route.id) },
    );
    expect(result.selectedRouteId).toBeNull();
    expect(result.candidates.filter((candidate) => candidate.executable)).toHaveLength(0);
    expect(result.notices.join(' ')).toContain('observations');
  });
});
