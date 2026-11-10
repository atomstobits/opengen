import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { catalog } from '@media-router/catalog';
import {
  parseGenerationRequest,
  getGenerationDefinition,
  getGenerationSchema,
  generationModelIds,
  validateRouteInput,
  validateGenerationInput,
  mapGenerationAssets,
  collectGenerationAssets,
  assertHandledArguments,
  GenerationValidationError,
} from '@media-router/contracts/generation';
import type {
  AssetRef,
  GenerateInput,
  GenerationArguments,
  Operation,
} from '@media-router/contracts';
const first: AssetRef = { assetKey: 'inputs/workspace/first.png' };
const last: AssetRef = { url: 'https://media.example/last.png' };
const video = {
  operation: 'image-to-video' as const,
  input: {
    prompt: 'A slow push in.',
    firstFrame: first,
    duration: 5,
    resolution: '720p',
    aspectRatio: 'source',
  },
};

describe('canonical generation registry', () => {
  it('resolves the confirmed fal H3 Max name to one canonical model profile', () => {
    const canonical = parseGenerationRequest({
      modelId: 'minimax/h3-max',
      operation: 'text-to-video',
      input: { prompt: 'A quiet lake.' },
    });
    expect(parseGenerationRequest({ ...canonical, modelId: 'fal/h3-max' })).toEqual(canonical);
    expect(getGenerationDefinition('fal/h3-max', 'text-to-video')).toEqual(
      getGenerationDefinition('minimax/h3-max', 'text-to-video'),
    );
    expect(getGenerationSchema('fal/h3-max', 'text-to-video')).toMatchObject({
      'x-opengen': { modelId: 'minimax/h3-max' },
    });
    expect(generationModelIds).toContain('minimax/h3-max');
    expect(generationModelIds).not.toContain('fal/h3-max');
    expect(generationModelIds).toContain('fal/h3-max-turbo');
    expect(canonical.input).toMatchObject({ resolution: '768p', duration: 5 });
  });
  it('keeps shared H3 Max inputs portable while excluding narrower native routes explicitly', () => {
    const native = catalog.routes.find(
      (route) => route.modelId === 'minimax/h3-max' && route.adapter === 'minimax',
    )!;
    const fal = catalog.routes.find(
      (route) => route.modelId === 'minimax/h3-max' && route.adapter === 'fal',
    )!;
    const shared = parseGenerationRequest({
      modelId: 'minimax/h3-max',
      operation: 'text-to-video',
      input: { prompt: 'A quiet lake.', resolution: '768p', duration: 5 },
    });
    expect(validateRouteInput(shared, native)).toEqual([]);
    expect(validateRouteInput(shared, fal)).toEqual([]);
    for (const [input, code, field] of [
      [{ duration: 5.5 }, 'unsupported_duration', 'input.duration'],
      [{ resolution: '1080p' }, 'unsupported_resolution', 'input.resolution'],
      [{ seed: 7 }, 'unsupported_argument', 'input.seed'],
      [
        { targetAudio: { url: 'https://media.example/audio.mp3' } },
        'unsupported_argument',
        'input.targetAudio',
      ],
      [{ prompt: 'a'.repeat(7001) }, 'invalid_value', 'input.prompt'],
    ] as const) {
      const request = parseGenerationRequest({ ...shared, input: { ...shared.input, ...input } });
      expect(validateRouteInput(request, native)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code, field })]),
      );
      expect(validateRouteInput(request, fal)).toEqual([]);
    }
  });
  it('retains native H3 Max reference capacity without expanding fal endpoint limits', () => {
    const native = catalog.routes.find(
      (route) => route.modelId === 'minimax/h3-max' && route.adapter === 'minimax',
    )!;
    const fal = catalog.routes.find(
      (route) => route.modelId === 'minimax/h3-max' && route.adapter === 'fal',
    )!;
    const references = [
      ...Array.from({ length: 9 }, () => ({
        type: 'image' as const,
        asset: { url: 'https://media.example/ref.png' },
      })),
      ...Array.from({ length: 3 }, () => ({
        type: 'video' as const,
        asset: { url: 'https://media.example/ref.mp4' },
      })),
      { type: 'audio' as const, asset: { url: 'https://media.example/ref.mp3' } },
    ];
    const request = parseGenerationRequest({
      modelId: 'minimax/h3-max',
      operation: 'reference-to-video',
      input: { prompt: 'A quiet lake.', resolution: '768p', duration: 5, references },
    });
    expect(validateRouteInput(request, native)).toEqual([]);
    expect(validateRouteInput(request, { ...fal, operations: ['reference-to-video'] })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'too_many_references',
          field: 'input.references',
          limit: 12,
          received: 13,
        }),
      ]),
    );
  });
  it('covers every exact catalog variant with separately owned definitions', () => {
    expect([...generationModelIds].sort()).toEqual(catalog.models.map((model) => model.id).sort());
    for (const model of catalog.models) {
      const operation = model.modality === 'image' ? 'text-to-image' : 'text-to-video';
      const definition = getGenerationDefinition(model.id, operation);
      expect(definition?.modelId).toBe(model.id);
      expect(definition?.sources.length).toBeGreaterThan(0);
      expect(getGenerationSchema(model.id, operation)).toMatchObject({
        type: 'object',
        'x-opengen': { modelId: model.id, operation },
      });
    }
  });
  it('changes only model identity for compatible Seedance and Kling image-to-video', () => {
    const seedance = parseGenerationRequest({ ...video, modelId: 'bytedance/seedance-2.5' });
    const kling = parseGenerationRequest({ ...video, modelId: 'kling/kling-4.0' });
    expect(seedance.input).toEqual(kling.input);
    expect(seedance.input.firstFrame).toEqual(first);
  });
  it('keeps one input object and rejects positional arrays, provider fields and untyped extras', () => {
    expect(() =>
      parseGenerationRequest({
        ...video,
        modelId: 'bytedance/seedance-2.5',
        referenceUrls: ['https://media.example/first.png'],
      }),
    ).toThrow(GenerationValidationError);
    expect(() =>
      parseGenerationRequest({
        ...video,
        modelId: 'bytedance/seedance-2.5',
        input: { ...video.input, extra: { anything: true } },
      }),
    ).toThrow('Unknown argument');
    expect(() =>
      parseGenerationRequest({
        ...video,
        modelId: 'bytedance/seedance-2.5',
        input: { ...video.input, image_url: 'https://media.example/first.png' },
      }),
    ).toThrow('Unknown argument');
  });
  it('strictly rejects two competing asset locations and insecure reference URLs', () => {
    for (const asset of [
      { url: 'https://media.example/a.png', assetKey: 'inputs/a.png' },
      { url: 'http://media.example/a.png' },
      { url: 'https://user:secret@media.example/a.png' },
    ]) {
      expect(() =>
        parseGenerationRequest({
          ...video,
          modelId: 'bytedance/seedance-2.5',
          input: { ...video.input, firstFrame: asset },
        }),
      ).toThrow(GenerationValidationError);
    }
  });
  it('preserves mixed owned/external first/last frame roles while resolving every typed location', async () => {
    const input: GenerationArguments = {
      firstFrame: first,
      lastFrame: last,
      references: [
        { type: 'image', asset: { url: 'https://media.example/reference-a.png' } },
        { type: 'image', asset: { assetKey: 'inputs/workspace/reference-b.png' } },
      ],
      keyframes: [{ image: { assetKey: 'inputs/workspace/middle.png' } }],
      elements: [
        { id: 'actor', images: [first], voice: { assetKey: 'inputs/workspace/voice.wav' } },
      ],
    };
    const paths = collectGenerationAssets(input).map((entry) => entry.path);
    expect(paths).toEqual([
      'firstFrame',
      'lastFrame',
      'references[0].asset',
      'references[1].asset',
      'keyframes[0].image',
      'elements[0].voice',
      'elements[0].images[0]',
    ]);
    const resolved = await mapGenerationAssets(input, async (asset) =>
      'assetKey' in asset ? { url: `https://signed.example/${asset.assetKey}` } : asset,
    );
    expect(resolved.firstFrame).toEqual({
      url: 'https://signed.example/inputs/workspace/first.png',
    });
    expect(resolved.lastFrame).toEqual(last);
    expect(resolved.references?.map((ref) => ref.asset)).toEqual([
      { url: 'https://media.example/reference-a.png' },
      { url: 'https://signed.example/inputs/workspace/reference-b.png' },
    ]);
    expect(input.firstFrame).toEqual(first);
  });
  it('publishes supported model-specific fields without treating them as universal', () => {
    const seedance = getGenerationSchema('bytedance/seedance-2.5', 'image-to-video')!;
    const kling = getGenerationSchema('kling/kling-4.0', 'image-to-video')!;
    expect(seedance.properties).toHaveProperty('draft');
    expect(kling.properties).not.toHaveProperty('draft');
    expect(() =>
      parseGenerationRequest({
        ...video,
        modelId: 'kling/kling-4.0',
        input: { ...video.input, draft: true },
      }),
    ).toThrow('not a supported argument');
  });
  it('uses explicit shared defaults so the provider cannot pick a different request shape', () => {
    const seedance = parseGenerationRequest({
      modelId: 'bytedance/seedance-2.5',
      operation: 'text-to-video',
      input: { prompt: 'A calm sea.' },
    });
    expect(seedance.input).toMatchObject({ duration: 5, resolution: '720p', aspectRatio: '16:9' });
    const image = parseGenerationRequest({
      modelId: 'openai/gpt-image-2.5-flare',
      operation: 'text-to-image',
      input: { prompt: 'A calm sea.' },
    });
    expect(image.input).toMatchObject({ resolution: '1K', aspectRatio: '1:1', quality: 'medium' });
    expect(image.input.outputFormat).toBeUndefined();
    const omni = getGenerationDefinition('google/gemini-omni-1.1-flash', 'image-to-video')!;
    expect(omni.defaults.aspectRatio).toBe('16:9');
    expect(omni.capabilities.aspectRatios).not.toContain('source');
    expect(
      getGenerationDefinition('google/gemini-omni-1.1-flash', 'video-extend')!.defaults.aspectRatio,
    ).toBe('source');
    const sized = parseGenerationRequest({
      modelId: 'openai/gpt-image-2.5-flare',
      operation: 'text-to-image',
      input: { prompt: 'A sea.', size: { width: 1024, height: 1536 } },
    });
    expect(sized.input.resolution).toBeUndefined();
    expect(sized.input.aspectRatio).toBeUndefined();
    expect(() =>
      parseGenerationRequest({ ...sized, input: { ...sized.input, aspectRatio: '1:1' } }),
    ).toThrow('exact dimensions or an aspect ratio');
    expect(() =>
      parseGenerationRequest({ ...sized, input: { ...sized.input, resolution: '1K' } }),
    ).toThrow('exact dimensions or a resolution tier');
    expect(
      parseGenerationRequest({
        modelId: 'openai/gpt-image-2.5-flare',
        operation: 'image-edit',
        input: { prompt: 'A sea.', references: [{ type: 'image', asset: last }] },
      }).input.aspectRatio,
    ).toBeUndefined();
  });
  it('rejects incompatible frame/reference modes but retains the compatible Kling combination', () => {
    const input = { ...video.input, references: [{ type: 'image' as const, asset: last }] };
    expect(() =>
      parseGenerationRequest({ ...video, modelId: 'bytedance/seedance-2.5', input }),
    ).toThrow('cannot be combined');
    expect(
      parseGenerationRequest({ ...video, modelId: 'kling/kling-4.0', input }).input.references,
    ).toHaveLength(1);
  });
  it('enforces aggregate image budgets rather than individual maxima independently', () => {
    const request: GenerateInput = {
      ...video,
      modelId: 'kling/kling-4.0',
      input: {
        ...video.input,
        lastFrame: last,
        references: Array.from({ length: 9 }, () => ({ type: 'image', asset: last })),
      },
    };
    expect(validateGenerationInput(request)).toContainEqual(
      expect.objectContaining({ code: 'too_many_references', limit: 10, received: 11 }),
    );
  });
  it('qualifies only documented native-audio controls', () => {
    expect(() =>
      parseGenerationRequest({
        ...video,
        modelId: 'kling/kling-4.0',
        input: { ...video.input, audio: false },
      }),
    ).toThrow('requires native audio');
    expect(() =>
      parseGenerationRequest({
        modelId: 'openai/gpt-image-2',
        operation: 'text-to-image',
        input: { prompt: 'A sea.', audio: true },
      }),
    ).toThrow('not a supported argument');
  });
  it('enforces transparency representation and exact GPT pixel limits', () => {
    const base = {
      modelId: 'openai/gpt-image-2.5-flare',
      operation: 'text-to-image',
      input: { prompt: 'A sea.', background: 'transparent', outputFormat: 'jpeg' },
    };
    expect(() => parseGenerationRequest(base)).toThrow('alpha-capable');
    expect(() =>
      parseGenerationRequest({
        ...base,
        input: { prompt: 'A sea.', size: { width: 4096, height: 4096 } },
      }),
    ).toThrow('GPT Image dimensions');
    expect(
      parseGenerationRequest({
        ...base,
        input: { prompt: 'A sea.', size: { width: 1024, height: 1024 } },
      }).input.resolution,
    ).toBeUndefined();
  });
  it('returns structured route exclusions and never changes the exact model', () => {
    const request = parseGenerationRequest({ ...video, modelId: 'bytedance/seedance-2.5' });
    const route = catalog.routes.find((route) => route.modelId === 'kling/kling-4.0')!;
    expect(validateRouteInput(request, route)).toContainEqual(
      expect.objectContaining({ code: 'route_model_mismatch', field: 'modelId' }),
    );
    const own = catalog.routes.find(
      (route) => route.modelId === request.modelId && route.adapter === 'byteplus',
    )!;
    expect(
      validateRouteInput({ ...request, input: { ...request.input, duration: 31 } }, own),
    ).toContainEqual(
      expect.objectContaining({ code: 'unsupported_duration', field: 'input.duration' }),
    );
  });
  it('rejects supported model fields when the specific adapter has not implemented them', () => {
    expect(assertHandledArguments({ prompt: 'A sea.', draft: false }, ['prompt'])).toEqual([
      {
        code: 'unsupported_argument',
        field: 'input.draft',
        message: 'This provider route does not implement draft.',
      },
    ]);
  });
  it('does not infer a provider maximum from Omni examples or copy the old four-image adapter cap', () => {
    const definition = getGenerationDefinition(
      'google/gemini-omni-1.1-flash',
      'reference-to-video',
    )!;
    expect(definition.capabilities.references.maximum.image).toBeUndefined();
    expect(definition.verification).toBe('model-guided-partial');
    definition.capabilities.references.maximum.image = 4;
    expect(
      getGenerationDefinition(definition.modelId, definition.operation)?.capabilities.references
        .maximum.image,
    ).toBeUndefined();
  });
  it('validates timed-keyframe grids without rounding user input', () => {
    const input = {
      duration: 5,
      resolution: '720p',
      aspectRatio: 'source',
      keyframes: [{ image: last, at: 0.2 }],
    };
    expect(() =>
      parseGenerationRequest({
        modelId: 'xai/grok-imagine-video-1.5',
        operation: 'image-to-video',
        input,
      }),
    ).toThrow('one-third-second');
    expect(
      parseGenerationRequest({
        modelId: 'xai/grok-imagine-video-1.5',
        operation: 'image-to-video',
        input: { ...input, keyframes: [{ image: last, at: 1 / 3 }] },
      }).input.keyframes?.[0]?.at,
    ).toBe(1 / 3);
  });
});

describe('published generation JSON Schema media roles', () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  function parity(modelId: string, operation: Operation, cases: [GenerationArguments, boolean][]) {
    const validate = ajv.compile(getGenerationSchema(modelId, operation)!);
    for (const [input, expected] of cases) {
      expect(validate(input), JSON.stringify(validate.errors)).toBe(expected);
      if (expected)
        expect(() => parseGenerationRequest({ modelId, operation, input })).not.toThrow();
      else
        expect(() => parseGenerationRequest({ modelId, operation, input })).toThrow(
          GenerationValidationError,
        );
    }
  }
  const image = { type: 'image' as const, asset: last };
  it('publishes valid Draft 2020-12 schemas for every registered model operation', () => {
    for (const modelId of generationModelIds)
      for (const operation of [
        'text-to-image',
        'image-edit',
        'text-to-video',
        'image-to-video',
        'reference-to-video',
        'video-edit',
        'video-extend',
      ] as const) {
        const schema = getGenerationSchema(modelId, operation);
        if (schema)
          expect(
            ajv.validateSchema(schema),
            `${modelId}/${operation}: ${JSON.stringify(ajv.errors)}`,
          ).toBe(true);
      }
  });
  it('requires qualified first/keyframe roles without substituting a last frame', () => {
    expect(getGenerationSchema('bytedance/seedance-2.5', 'image-to-video')!.required).toContain(
      'firstFrame',
    );
    parity('bytedance/seedance-2.5', 'image-to-video', [
      [{}, false],
      [{ lastFrame: last }, false],
      [{ firstFrame: last }, true],
      [{ firstFrame: last, lastFrame: last }, true],
    ]);
    parity('kling/kling-4.0', 'image-to-video', [
      [{ keyframes: [] }, false],
      [{ keyframes: [{ image: last }] }, true],
      [{ firstFrame: last, keyframes: [] }, true],
      [{ lastFrame: last, keyframes: [{ image: last }] }, false],
      [{ keyframes: Array.from({ length: 11 }, () => ({ image: last })) }, false],
      [{ keyframes: [{ image: last, at: 1 }] }, false],
    ]);
    parity('pika/h3-flex', 'image-to-video', [[{ lastFrame: last }, true]]);
    parity('xai/grok-imagine-video-1.5-lite', 'image-to-video', [[{ lastFrame: last }, false]]);
  });
  it('requires edit source references and rejects empty or wrongly typed references', () => {
    parity('openai/gpt-image-2', 'image-edit', [
      [{ prompt: 'Edit the image.' }, false],
      [{ prompt: 'Edit the image.', references: [] }, false],
      [{ prompt: 'Edit the image.', mask: last }, false],
      [{ prompt: 'Edit the image.', references: [image], mask: last }, true],
      [{ prompt: 'Edit the image.', references: [{ type: 'video', asset: last }] }, false],
    ]);
  });
  it('accepts reference arrays or qualified elements while rejecting empty reference generation', () => {
    const element = { id: 'subject', images: [last] };
    parity('kling/kling-4.0', 'reference-to-video', [
      [{}, false],
      [{ references: [], elements: [] }, false],
      [{ references: [image] }, true],
      [{ elements: [element] }, true],
      [{ references: [], elements: [element] }, true],
      [{ firstFrame: last }, false],
    ]);
  });
  it('honors strict operation fields and preserves qualified frame/reference mixing', () => {
    parity('bytedance/seedance-2.5', 'image-to-video', [
      [{ firstFrame: last, references: [image] }, false],
      [{ firstFrame: last, references: [] }, false],
    ]);
    parity('kling/kling-4.0', 'image-to-video', [
      [{ firstFrame: last, references: [image] }, true],
    ]);
  });
  it('enforces typed and total reference limits while preserving unknown provider maxima', () => {
    const images = (count: number) => Array.from({ length: count }, () => image);
    parity('bytedance/seedance-2.0', 'reference-to-video', [
      [{ references: images(9) }, true],
      [{ references: images(10) }, false],
      [
        {
          references: [
            ...images(9),
            ...Array.from({ length: 3 }, () => ({ type: 'video' as const, asset: last })),
            { type: 'audio', asset: last },
          ],
        },
        false,
      ],
      [{ references: [{ type: 'document', asset: last }] }, false],
    ]);
    parity('google/gemini-omni-1.1-flash', 'reference-to-video', [
      [{ references: images(6) }, true],
      [
        { references: Array.from({ length: 4 }, () => ({ type: 'video' as const, asset: last })) },
        false,
      ],
    ]);
    const schema = getGenerationSchema('google/gemini-omni-1.1-flash', 'reference-to-video')!;
    const references = (
      schema.properties as Record<
        string,
        { allOf: { contains: { properties: { type: { const: string } } }; maxContains: number }[] }
      >
    ).references!;
    expect(
      references.allOf.some((constraint) => constraint.contains.properties.type.const === 'image'),
    ).toBe(false);
  });
  it('documents envelope-only continuation requirements instead of falsely requiring uploaded source media', () => {
    const modelId = 'google/gemini-omni-1.1-flash',
      operation = 'video-extend';
    const schema = getGenerationSchema(modelId, operation)!;
    const validate = ajv.compile(schema);
    expect(validate({ prompt: 'Continue the scene.' })).toBe(true);
    expect((schema['x-opengen'] as { notices: string[] }).notices.join(' ')).toContain(
      'input.sourceVideo or an owned top-level previousJobId',
    );
    expect(() =>
      parseGenerationRequest({ modelId, operation, input: { prompt: 'Continue the scene.' } }),
    ).toThrow('requires source video or an owned continuation');
    expect(() =>
      parseGenerationRequest({
        modelId,
        operation,
        previousJobId: '23fbebec-a73d-4647-a13d-1b963f0c43c5',
        input: { prompt: 'Continue the scene.' },
      }),
    ).not.toThrow();
    parity(modelId, operation, [
      [{ sourceVideo: { url: 'https://media.example/source.mp4' } }, true],
    ]);
  });
});
