import { describe, expect, it } from 'vitest';
import { catalog, getModel, quote, searchCatalog, validateCatalog } from '@media-router/catalog';
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
    expect(routes).toHaveLength(4);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-undisclosed/minimax-h3-max',
          deploymentId: 'minimax-undisclosed',
          upstreamModelId: 'MiniMax-H3-Max',
          providerModelName: 'MiniMax H3 Max',
        }),
        expect.objectContaining({
          id: 'fal-undisclosed/fal-h3-max',
          deploymentId: 'fal-undisclosed',
          upstreamModelId: 'minimax/h3-max/text-to-video',
          providerModelName: 'H3 Max',
        }),
      ]),
    );
    expect(catalog.models).toHaveLength(35);
    expect(catalog.routes).toHaveLength(132);
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
    const route = catalog.routes.find((item) => item.id === 'fal-undisclosed/fal-h3-max')!;
    const canonical = route.modelId;
    try {
      route.modelId = 'fal/h3-max';
      expect(validateCatalog()).toContain(`Noncanonical model reference for ${route.id}`);
    } finally {
      route.modelId = canonical;
    }
  });
  it('lists six separately sourced Alibaba deployments plus fal routes for each Wan variant', () => {
    for (const modelId of ['alibaba/wan-3.0', 'alibaba/wan-3.0-prime']) {
      const routes = catalog.routes.filter((route) => route.modelId === modelId);
      const alibabaRoutes = routes.filter((route) => route.adapter === 'alibaba');
      expect(alibabaRoutes).toHaveLength(6);
      expect(new Set(alibabaRoutes.map((route) => route.deploymentId)).size).toBe(6);
      expect(routes).toHaveLength(9);
      expect(new Set(routes.map((route) => route.deploymentId)).size).toBe(7);
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
      executableRouteIds: ['minimax-undisclosed/minimax-h3-max', 'fal-undisclosed/fal-h3-max'],
    };
    const result = quote(canonical, options);
    expect(result.modelId).toBe('minimax/h3-max');
    expect(new Set(result.candidates.map((candidate) => candidate.providerId))).toEqual(
      new Set(['fal', 'minimax']),
    );
    expect(
      result.candidates
        .filter((candidate) => candidate.executable)
        .map((candidate) => candidate.routeId)
        .sort(),
    ).toEqual(['fal-undisclosed/fal-h3-max', 'minimax-undisclosed/minimax-h3-max']);
    expect(quote({ ...canonical, modelId: 'fal/h3-max' }, options)).toEqual(result);
    const pinned = quote({ ...canonical, routeId: 'fal-undisclosed/fal-h3-max' }, options);
    expect(pinned.candidates).toHaveLength(1);
    expect(pinned.selectedRouteId).toBe('fal-undisclosed/fal-h3-max');
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
      fullHd.candidates.find((candidate) => candidate.routeId === 'fal-undisclosed/fal-h3-max')
        ?.executable,
    ).toBe(true);
    expect(fullHd.selectedRouteId).toBe('fal-undisclosed/fal-h3-max');
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
        routing: { deploymentIds: ['byteplus-undisclosed', 'fal-undisclosed'] },
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
