import { z } from 'zod';
import type { Operation, Route } from './index';
import type {
  GenerationArguments,
  GenerationRequest,
  GenerationDefinition,
  GenerationIssue,
} from './generation-types';
import { modelDefinitions, nativeH3MaxDefinition, type ModelDefinition } from './generation-models';
import { canonicalModelId } from './model-identity';
export * from './generation-assets';
export type * from './generation-types';

const ids = z.array(z.string().min(1).max(160)).min(1).max(100);
export const routingSchema = z
  .object({
    modelIds: ids.optional(),
    modelProviderExceptions: z
      .array(z.object({ modelId: z.string().min(1).max(160), providerIds: ids }).strict())
      .max(100)
      .optional(),
    authorOnly: z.boolean().optional(),
    providerIds: ids.optional(),
    deploymentIds: ids.optional(),
    endpointRegions: ids.optional(),
    processingRegions: ids.optional(),
    processingScopes: z
      .array(z.enum(['regional', 'mainland-china', 'international', 'global', 'undisclosed']))
      .max(5)
      .optional(),
    fidelity: z.enum(['any', 'native']).optional(),
    preference: z.enum(['cost', 'speed', 'reliability']).optional(),
    fallback: z.boolean().optional(),
  })
  .strict();
export const assetRefSchema = z.union([
  z.object({ assetKey: z.string().min(1).max(300) }).strict(),
  z
    .object({
      url: z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      }, 'Assets require HTTPS without embedded credentials'),
    })
    .strict(),
]);
const element = z.union([
  z
    .object({
      id: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      images: z.array(assetRefSchema).min(1).max(10),
      voice: assetRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      video: assetRefSchema,
      voice: assetRefSchema.optional(),
    })
    .strict(),
]);
export const generationArgumentSchema = z
  .object({
    prompt: z.string().max(100_000).optional(),
    negativePrompt: z.string().max(20_000).optional(),
    firstFrame: assetRefSchema.optional(),
    lastFrame: assetRefSchema.optional(),
    sourceVideo: assetRefSchema.optional(),
    mask: assetRefSchema.optional(),
    references: z
      .array(
        z
          .object({ type: z.enum(['image', 'video', 'audio', 'document']), asset: assetRefSchema })
          .strict(),
      )
      .max(50)
      .optional(),
    duration: z.union([z.number().positive().max(300), z.literal('auto')]).optional(),
    resolution: z.string().min(1).max(30).optional(),
    size: z
      .object({
        width: z.number().int().positive().max(16384),
        height: z.number().int().positive().max(16384),
      })
      .strict()
      .optional(),
    aspectRatio: z
      .string()
      .regex(/^(source|auto|\d+(\.\d+)?:\d+(\.\d+)?)$/)
      .optional(),
    count: z.number().int().min(1).max(15).optional(),
    quality: z.string().min(1).max(30).optional(),
    outputFormat: z.enum(['png', 'jpeg', 'webp', 'mp4']).optional(),
    outputCompression: z.number().int().min(0).max(100).optional(),
    background: z.enum(['auto', 'opaque', 'transparent']).optional(),
    seed: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
    audio: z.boolean().optional(),
    draft: z.boolean().optional(),
    draftJobId: z.uuid().optional(),
    codec: z.enum(['auto', 'H264', 'H265']).optional(),
    bitrateMode: z.enum(['standard', 'high']).optional(),
    promptExpansion: z
      .union([z.boolean(), z.enum(['disabled', 'none', 'balanced', 'quality'])])
      .optional(),
    thinkingLevel: z.enum(['minimal', 'medium', 'high']).optional(),
    systemPrompt: z.string().max(50_000).optional(),
    grounding: z.boolean().optional(),
    targetAudio: assetRefSchema.optional(),
    layers: z.number().int().min(1).max(100).optional(),
    strength: z.number().min(0).max(1).optional(),
    keyframes: z
      .array(
        z
          .object({
            image: assetRefSchema,
            at: z.union([z.number().nonnegative(), z.enum(['start', 'end'])]).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    shots: z
      .array(
        z
          .object({
            prompt: z.string().min(1).max(20_000),
            duration: z.number().positive().max(300),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional(),
    elements: z.array(element).max(15).optional(),
    watermark: z.boolean().optional(),
    promptExtend: z.boolean().optional(),
    thinking: z.boolean().optional(),
  })
  .strict();
const envelopeSchema = z
  .object({
    modelId: z.string().min(1).max(160),
    operation: z.enum([
      'text-to-image',
      'image-edit',
      'text-to-video',
      'image-to-video',
      'reference-to-video',
      'video-edit',
      'video-extend',
    ]),
    metadata: z
      .object({
        project: z.string().min(1).max(80).optional(),
        tags: z
          .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), z.string().min(1).max(160))
          .refine((tags) => Object.keys(tags).length <= 16)
          .optional(),
      })
      .strict()
      .optional(),
    input: generationArgumentSchema,
    billing: z.enum(['managed', 'byok']).optional(),
    feeAcceptance: z
      .object({
        policyId: z.string().min(1).max(200),
        policyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
    routing: routingSchema.optional(),
    routeId: z.string().min(1).max(200).optional(),
    maxCostMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    previousJobId: z.uuid().optional(),
    queueStartDeadlineAt: z.iso.datetime().optional(),
  })
  .strict();

export const generationOperations = envelopeSchema.shape.operation.options;

export function getGenerationDefinition(
  modelId: string,
  operation: Operation,
): GenerationDefinition | undefined {
  modelId = canonicalModelId(modelId);
  return operationDefinition(modelId, operation, modelDefinitions[modelId]);
}
function operationDefinition(
  modelId: string,
  operation: Operation,
  model: ModelDefinition | undefined,
): GenerationDefinition | undefined {
  if (!model || !model.operations.includes(operation)) return undefined;
  const video = model.modality === 'video';
  const sourceRatioQualified =
    ['image-to-video', 'video-edit', 'video-extend'].includes(operation) &&
    (modelId !== 'google/gemini-omni-1.1-flash' || operation === 'video-extend');
  const capabilities = structuredClone(model.capabilities);
  if (modelId === 'minimax/h3-max' && operation !== 'reference-to-video') {
    capabilities.frameReferenceMix = false;
    capabilities.frames.keyframesMaximum = 0;
    capabilities.frames.timed = false;
  }
  if (modelId === 'google/gemini-omni-1.1-flash' && !sourceRatioQualified)
    capabilities.aspectRatios = capabilities.aspectRatios.filter((ratio) => ratio !== 'source');
  const forbidden = new Set<string>(
    operation === 'text-to-image' || operation === 'text-to-video'
      ? ['firstFrame', 'lastFrame', 'references', 'sourceVideo', 'mask']
      : operation === 'image-to-video'
        ? ['sourceVideo', 'mask', ...(capabilities.frameReferenceMix ? [] : ['references'])]
        : operation === 'reference-to-video'
          ? [
              'sourceVideo',
              'mask',
              ...(capabilities.frameReferenceMix ? [] : ['firstFrame', 'lastFrame']),
            ]
          : operation === 'image-edit'
            ? ['firstFrame', 'lastFrame', 'sourceVideo']
            : ['firstFrame', 'lastFrame', 'mask'],
  );
  const commonArguments = model.commonArguments.filter((field) => !forbidden.has(field));
  const modelSpecificArguments = model.modelSpecificArguments.filter((field) =>
    field === 'keyframes'
      ? modelId === 'minimax/h3-max'
        ? operation === 'reference-to-video' && capabilities.frames.keyframesMaximum > 0
        : operation === 'image-to-video'
      : field === 'elements'
        ? operation === 'image-to-video' || operation === 'reference-to-video'
        : true,
  );
  return {
    ...structuredClone(model),
    modelId,
    operation,
    capabilities,
    commonArguments,
    modelSpecificArguments,
    promptRequired: ['text-to-image', 'text-to-video', 'image-edit'].includes(operation),
    defaults: {
      resolution: model.defaults.resolution,
      ...(video ? { duration: 5 } : {}),
      ...(operation === 'image-edit'
        ? {}
        : {
            aspectRatio: sourceRatioQualified ? 'source' : video ? '16:9' : '1:1',
          }),
      ...(modelId.startsWith('openai/gpt-image-') ? { quality: 'medium' } : {}),
    },
  };
}
export const generationModelIds = Object.keys(modelDefinitions);

function inputIssues(
  request: GenerationRequest,
  definition: GenerationDefinition,
): GenerationIssue[] {
  const args = request.input,
    caps = definition.capabilities,
    issues: GenerationIssue[] = [];
  const issue = (
    code: GenerationIssue['code'],
    field: string,
    message: string,
    limit?: number | string,
    received?: number | string,
  ) =>
    issues.push({
      code,
      field: `input.${field}`,
      message,
      ...(limit === undefined ? {} : { limit }),
      ...(received === undefined ? {} : { received }),
    });
  const allowed = new Set([...definition.commonArguments, ...definition.modelSpecificArguments]);
  for (const key of Object.keys(args))
    if (
      args[key as keyof GenerationArguments] !== undefined &&
      !allowed.has(key as keyof GenerationArguments)
    )
      issue(
        'unsupported_argument',
        key,
        `${key} is not a supported argument for this exact model.`,
      );
  const refs = args.references ?? [];
  if (definition.promptRequired && !args.prompt?.trim())
    issue('required_argument', 'prompt', 'This model/operation requires a nonempty prompt.');
  if (
    args.prompt &&
    definition.promptMaximum !== null &&
    args.prompt.length > definition.promptMaximum
  )
    issue(
      'invalid_value',
      'prompt',
      'Prompt exceeds the documented model ceiling.',
      definition.promptMaximum,
      args.prompt.length,
    );
  if (args.resolution && !caps.resolutions.includes(args.resolution))
    issue(
      'unsupported_resolution',
      'resolution',
      'Unsupported output resolution for this exact model.',
      caps.resolutions.join(','),
      args.resolution,
    );
  if (args.duration !== undefined && caps.duration) {
    if (
      args.duration === 'auto'
        ? !caps.duration.auto
        : args.duration < caps.duration.minimum ||
          args.duration > caps.duration.maximum ||
          (caps.duration.integer && !Number.isInteger(args.duration))
    )
      issue(
        'unsupported_duration',
        'duration',
        'Duration is outside this model capability.',
        `${caps.duration.minimum}–${caps.duration.maximum}${caps.duration.auto ? ' or auto' : ''}`,
        args.duration,
      );
  }
  if (args.aspectRatio && !caps.aspectRatios.includes(args.aspectRatio))
    issue(
      'unsupported_aspect_ratio',
      'aspectRatio',
      'Unsupported aspect ratio for this model.',
      caps.aspectRatios.join(','),
      args.aspectRatio,
    );
  if (
    args.aspectRatio === 'source' &&
    !args.firstFrame &&
    !args.lastFrame &&
    !args.sourceVideo &&
    !args.keyframes?.length &&
    !request.previousJobId &&
    !refs.length
  )
    issue(
      'incompatible_combination',
      'aspectRatio',
      'Source aspect ratio requires source media or an owned continuation.',
    );
  if (request.modelId === 'kling/kling-4.0') {
    const images =
      (args.firstFrame ? 1 : 0) +
      (args.lastFrame ? 1 : 0) +
      (args.keyframes?.length ?? 0) +
      refs.filter((ref) => ref.type === 'image').length;
    if (images > 10)
      issue(
        'too_many_references',
        'references',
        'Kling keyframes and image references share a combined ten-image budget.',
        10,
        images,
      );
  }
  if (
    request.modelId === 'xai/grok-imagine-video-1.5' &&
    refs.some((ref) => ref.type === 'image') &&
    args.resolution === '1080p'
  )
    issue(
      'unsupported_resolution',
      'resolution',
      'xAI reference generation is qualified only up to 720p.',
    );
  if (
    request.modelId === 'xai/grok-imagine-video-1.5' &&
    args.keyframes?.some((frame) => typeof frame.at !== 'number')
  )
    issue(
      'required_argument',
      'keyframes.at',
      'xAI keyframes require an explicit numeric timestamp.',
    );
  if (
    request.modelId === 'xai/grok-imagine-video-1.5' &&
    args.keyframes?.some(
      (frame) =>
        typeof frame.at === 'number' && Math.abs(frame.at * 3 - Math.round(frame.at * 3)) > 1e-6,
    )
  )
    issue(
      'invalid_value',
      'keyframes.at',
      'xAI timed keyframes must follow its one-third-second grid.',
    );
  if (
    request.modelId.startsWith('bytedance/seedance-2.0') &&
    refs.length &&
    refs.every((ref) => ref.type === 'audio')
  )
    issue(
      'incompatible_combination',
      'references',
      'Seedance 2.0 audio references require visual media.',
    );
  if (args.count !== undefined && args.count > caps.countMaximum)
    issue(
      'invalid_value',
      'count',
      'Output count exceeds the model limit.',
      caps.countMaximum,
      args.count,
    );
  if (args.quality && caps.quality && !caps.quality.includes(args.quality))
    issue(
      'invalid_value',
      'quality',
      'Unsupported quality tier for this exact model.',
      caps.quality.join(','),
      args.quality,
    );
  if (args.firstFrame && !caps.frames.first)
    issue(
      'unsupported_argument',
      'firstFrame',
      'This model does not expose a first-frame control.',
    );
  if (args.lastFrame && !caps.frames.last)
    issue('unsupported_argument', 'lastFrame', 'This model does not expose a last-frame control.');
  if (args.lastFrame && !args.firstFrame && !caps.frames.lastOnly)
    issue(
      'incompatible_combination',
      'lastFrame',
      'Last-frame-only generation is not qualified for this model.',
    );
  if (args.keyframes?.length) {
    if (args.keyframes.length > caps.frames.keyframesMaximum)
      issue(
        'too_many_references',
        'keyframes',
        'Too many keyframes.',
        caps.frames.keyframesMaximum,
        args.keyframes.length,
      );
    if (!caps.frames.timed && args.keyframes.some((frame) => typeof frame.at === 'number'))
      issue(
        'unsupported_argument',
        'keyframes.at',
        'This model has no qualified timed-keyframe control.',
      );
    if (
      typeof args.duration === 'number' &&
      args.keyframes.some(
        (frame) => typeof frame.at === 'number' && frame.at > (args.duration as number),
      )
    )
      issue(
        'invalid_value',
        'keyframes.at',
        'A keyframe cannot be placed after the requested duration.',
      );
  }
  if (
    !caps.frameReferenceMix &&
    refs.length &&
    (args.firstFrame || args.lastFrame || args.keyframes?.length)
  )
    issue(
      'incompatible_combination',
      'references',
      'Frame mode and reference mode cannot be combined for this model.',
    );
  for (const type of ['image', 'video', 'audio', 'document'] as const) {
    const count = refs.filter((ref) => ref.type === type).length;
    if (!count) continue;
    if (!caps.references.types.includes(type))
      issue(
        'unsupported_reference_type',
        'references',
        `This model does not qualify ${type} references.`,
        undefined,
        type,
      );
    const max = caps.references.maximum[type];
    if (max !== undefined && count > max)
      issue('too_many_references', 'references', `Too many ${type} references.`, max, count);
  }
  if (caps.references.totalMaximum !== undefined && refs.length > caps.references.totalMaximum)
    issue(
      'too_many_references',
      'references',
      'Combined reference count exceeds the model limit.',
      caps.references.totalMaximum,
      refs.length,
    );
  if (args.audio !== undefined && (caps.audio === 'unsupported' || caps.audio === 'unverified'))
    issue('unsupported_argument', 'audio', 'Native audio control is not qualified for this model.');
  if (caps.audio === 'always-on' && args.audio === false)
    issue('invalid_value', 'audio', 'This model requires native audio enabled.');
  const hasFrames = Boolean(args.firstFrame || args.lastFrame || args.keyframes?.length);
  if (request.operation === 'text-to-image' || request.operation === 'text-to-video') {
    if (refs.length || hasFrames || args.sourceVideo || args.mask)
      issue(
        'incompatible_combination',
        'references',
        'Text-only generation does not accept source media; select the corresponding media operation.',
      );
  } else if (request.operation === 'image-to-video') {
    if (!hasFrames)
      issue(
        'required_argument',
        'firstFrame',
        'Image-to-video requires a qualified frame or keyframe input.',
      );
    if (args.sourceVideo || args.mask)
      issue(
        'incompatible_combination',
        'sourceVideo',
        'Image-to-video cannot use source video or masks.',
      );
  } else if (request.operation === 'reference-to-video') {
    if (!refs.length && !args.elements?.length)
      issue(
        'required_argument',
        'references',
        'Reference-to-video requires at least one reference or qualified element.',
      );
    if (args.sourceVideo || args.mask)
      issue(
        'incompatible_combination',
        'sourceVideo',
        'A source video is different from a reference video.',
      );
  } else if (request.operation === 'image-edit') {
    if (!refs.length)
      issue('required_argument', 'references', 'Image editing requires a source reference.');
    if (args.sourceVideo || hasFrames)
      issue(
        'incompatible_combination',
        'firstFrame',
        'Image editing uses references, not video-frame roles.',
      );
  } else if (!args.sourceVideo && !request.previousJobId)
    issue(
      'required_argument',
      'sourceVideo',
      'Video editing/extension requires source video or an owned continuation.',
    );
  if (args.mask && !refs.some((ref) => ref.type === 'image'))
    issue('incompatible_combination', 'mask', 'A mask requires a source image.');
  if (
    request.modelId === 'bytedance/seedance-2.5' &&
    args.draft &&
    (args.resolution !== '480p' || args.audio === true)
  )
    issue(
      'incompatible_combination',
      'draft',
      'Qualified draft generation requires 480p and cannot promise native audio.',
    );
  if (request.modelId.startsWith('openai/gpt-image-') && args.size) {
    const { width, height } = args.size,
      area = width * height;
    if (
      width % 16 ||
      height % 16 ||
      width > 3840 ||
      height > 3840 ||
      area < 655360 ||
      area > 8294400 ||
      width / height < 1 / 3 ||
      width / height > 3
    )
      issue(
        'invalid_value',
        'size',
        'GPT Image dimensions require multiples of 16, edge <=3840, area 655360–8294400 and aspect between 1:3 and 3:1.',
      );
  }
  if (
    request.modelId === 'bytedance/seedream-5.0-pro' &&
    args.background === 'transparent' &&
    (request.operation !== 'image-edit' || refs.length !== 1 || args.outputFormat !== 'png')
  )
    issue(
      'incompatible_combination',
      'background',
      'Qualified Seedream transparency requires one image edit reference and explicit PNG output.',
    );
  if (args.size && args.aspectRatio)
    issue(
      'incompatible_combination',
      'size',
      'Choose exact dimensions or an aspect ratio, not both.',
    );
  if (args.size && args.resolution)
    issue(
      'incompatible_combination',
      'size',
      'Choose exact dimensions or a resolution tier, not both.',
    );
  if (
    args.background === 'transparent' &&
    args.outputFormat &&
    !['png', 'webp'].includes(args.outputFormat)
  )
    issue(
      'incompatible_combination',
      'outputFormat',
      'Transparent output requires an alpha-capable format.',
    );
  return issues;
}
export function validateGenerationInput(request: GenerationRequest): GenerationIssue[] {
  request = { ...request, modelId: canonicalModelId(request.modelId) };
  const definition = getGenerationDefinition(request.modelId, request.operation);
  return definition
    ? inputIssues(request, definition)
    : [
        {
          code: 'unsupported_operation',
          field: 'operation',
          message: 'The exact model/operation has no registered generation schema.',
        },
      ];
}
export const generationSchema = envelopeSchema.superRefine((request, context) => {
  for (const issue of validateGenerationInput(request as GenerationRequest))
    context.addIssue({
      code: 'custom',
      path: issue.field.split('.'),
      message: issue.message,
      params: { generationIssue: issue },
    });
});
export function parseGenerationRequest(value: unknown): GenerationRequest {
  const result = envelopeSchema.safeParse(value);
  if (!result.success)
    throw new GenerationValidationError(
      result.error.issues.flatMap<GenerationIssue>((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => ({
              code: 'unsupported_argument' as const,
              field: [...issue.path, key].join('.'),
              message: 'Unknown argument is not part of the canonical schema.',
            }))
          : [
              {
                code: 'invalid_value' as const,
                field: issue.path.join('.'),
                message: issue.message,
              },
            ],
      ),
    );
  const parsed = {
    ...result.data,
    modelId: canonicalModelId(result.data.modelId),
  } as GenerationRequest;
  const definition = getGenerationDefinition(parsed.modelId, parsed.operation);
  if (!definition)
    throw new GenerationValidationError([
      {
        code: 'unsupported_operation',
        field: 'operation',
        message: 'The exact model/operation has no registered generation schema.',
      },
    ]);
  const normalized: GenerationRequest = {
    ...parsed,
    input: { ...definition.defaults, ...parsed.input },
  };
  if (parsed.input.size) {
    if (!parsed.input.resolution) delete normalized.input.resolution;
    if (!parsed.input.aspectRatio) delete normalized.input.aspectRatio;
  }
  const issues = inputIssues(normalized, definition);
  if (issues.length) throw new GenerationValidationError(issues);
  return normalized;
}
export class GenerationValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_generation';
  constructor(readonly issues: GenerationIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    this.name = 'GenerationValidationError';
  }
}
export function getGenerationSchema(
  modelId: string,
  operation: Operation,
): Record<string, unknown> | undefined {
  modelId = canonicalModelId(modelId);
  const definition = getGenerationDefinition(modelId, operation);
  if (!definition) return undefined;
  const caps = definition.capabilities;
  const keys = new Set([...definition.commonArguments, ...definition.modelSpecificArguments]);
  if (!caps.frames.first) keys.delete('firstFrame');
  if (!caps.frames.last) keys.delete('lastFrame');
  const json = z.toJSONSchema(generationArgumentSchema) as Record<string, unknown>;
  const all = json.properties as Record<string, Record<string, unknown>>;
  const properties: Record<string, Record<string, unknown>> = Object.fromEntries(
    [...keys].map((key) => [
      key,
      { ...all[key], ...(key in definition.defaults ? { default: definition.defaults[key] } : {}) },
    ]),
  );
  const required = definition.promptRequired ? ['prompt'] : [];
  const nonempty = (field: 'references' | 'elements' | 'keyframes') => ({
    required: [field],
    properties: { [field]: { minItems: 1 } },
  });
  const frames = [
    ...(keys.has('firstFrame') ? [{ required: ['firstFrame'] }] : []),
    ...(caps.frames.lastOnly && keys.has('lastFrame') ? [{ required: ['lastFrame'] }] : []),
    ...(keys.has('keyframes') ? [nonempty('keyframes')] : []),
  ];
  const allOf: Record<string, unknown>[] = [
    { not: { required: ['size', 'resolution'] } },
    { not: { required: ['size', 'aspectRatio'] } },
  ];
  if (definition.promptRequired)
    properties.prompt = { ...properties.prompt, minLength: 1, pattern: /\S/.source };
  if (properties.references) {
    const reference = properties.references.items as Record<string, unknown>;
    const fields = reference.properties as Record<string, unknown>;
    const maximum = caps.references.totalMaximum;
    const limits = Object.entries(caps.references.maximum)
      .filter(([, maximum]) => maximum !== undefined)
      .map(([type, maxContains]) => ({
        contains: { required: ['type'], properties: { type: { const: type } } },
        minContains: 0,
        maxContains,
      }));
    properties.references = {
      ...properties.references,
      ...(maximum === undefined
        ? {}
        : { maxItems: Math.min(properties.references.maxItems as number, maximum) }),
      items: { ...reference, properties: { ...fields, type: { enum: caps.references.types } } },
      // A missing per-type maximum stays unknown; the generic broker array bound is unchanged.
      ...(limits.length ? { allOf: limits } : {}),
    };
  }
  if (properties.keyframes) {
    const frame = properties.keyframes.items as Record<string, unknown>;
    properties.keyframes = {
      ...properties.keyframes,
      maxItems: Math.min(properties.keyframes.maxItems as number, caps.frames.keyframesMaximum),
      ...(caps.frames.timed
        ? {}
        : {
            items: {
              ...frame,
              properties: { ...(frame.properties as object), at: { enum: ['start', 'end'] } },
            },
          }),
    };
  }
  if (operation === 'image-to-video') {
    if (keys.has('firstFrame') && !caps.frames.lastOnly && !keys.has('keyframes'))
      required.push('firstFrame');
    else allOf.push({ anyOf: frames });
  }
  if (keys.has('lastFrame') && !caps.frames.lastOnly && !required.includes('firstFrame'))
    allOf.push({ if: { required: ['lastFrame'] }, then: { required: ['firstFrame'] } });
  if (operation === 'image-edit') {
    required.push('references');
    properties.references = { ...properties.references, minItems: 1 };
  }
  if (operation === 'reference-to-video')
    allOf.push({
      anyOf: [
        ...(keys.has('references') ? [nonempty('references')] : []),
        ...(keys.has('elements') ? [nonempty('elements')] : []),
      ],
    });
  if (keys.has('mask'))
    allOf.push({
      if: { required: ['mask'] },
      then: {
        required: ['references'],
        properties: {
          references: {
            contains: { required: ['type'], properties: { type: { const: 'image' } } },
            minContains: 1,
          },
        },
      },
    });
  return {
    ...json,
    allOf,
    properties,
    required,
    'x-opengen': {
      modelId,
      operation,
      capabilities: caps,
      notices: [
        ...definition.notices,
        ...(['video-edit', 'video-extend'].includes(operation)
          ? [
              'This schema describes input arguments only. The full request requires input.sourceVideo or an owned top-level previousJobId; continuation ownership, model and original deployment are checked by the executor.',
            ]
          : []),
        ...(caps.aspectRatios.includes('source')
          ? [
              'aspectRatio source requires source media or an owned top-level previousJobId. An arguments-only schema cannot validate that outer request context.',
            ]
          : []),
        'Runtime validation also checks model-specific combinations, media contents and regional route restrictions.',
      ],
      sources: definition.sources,
    },
  };
}

export function validateRouteInput(request: GenerationRequest, route: Route): GenerationIssue[] {
  request = { ...request, modelId: canonicalModelId(request.modelId) };
  const nativeMax =
    request.modelId === 'minimax/h3-max' && route.adapter === 'minimax'
      ? operationDefinition(request.modelId, request.operation, nativeH3MaxDefinition)
      : undefined;
  const issues = nativeMax ? inputIssues(request, nativeMax) : validateGenerationInput(request);
  if (canonicalModelId(route.modelId) !== request.modelId)
    issues.push({
      code: 'route_model_mismatch',
      field: 'modelId',
      message: 'The route serves a different exact variant.',
    });
  if (!route.operations.includes(request.operation))
    issues.push({
      code: 'unsupported_operation',
      field: 'operation',
      message: 'This regional route does not advertise the operation.',
    });
  const args = request.input;
  if (args.resolution && !route.resolutions.includes(args.resolution))
    issues.push({
      code: 'unsupported_resolution',
      field: 'input.resolution',
      message: 'The route does not support the requested resolution.',
      received: args.resolution,
      limit: route.resolutions.join(','),
    });
  const falMax = request.modelId === 'minimax/h3-max' && route.adapter === 'fal';
  if (typeof args.duration === 'number' && !falMax && !route.durations.includes(args.duration))
    issues.push({
      code: 'unsupported_duration',
      field: 'input.duration',
      message: 'The route does not support the requested duration.',
      received: args.duration,
    });
  if (falMax && (args.references?.length ?? 0) > 12)
    issues.push({
      code: 'too_many_references',
      field: 'input.references',
      message: 'This fal endpoint supports at most 12 combined references.',
      limit: 12,
      received: args.references!.length,
    });
  // These documented native APIs expose strict frame or omni modes, never a silent merge.
  if (
    (route.adapter === 'byteplus' || route.adapter === 'alibaba') &&
    request.input.references?.length &&
    (args.firstFrame || args.lastFrame || args.keyframes?.length)
  )
    issues.push({
      code: 'incompatible_combination',
      field: 'input.references',
      message: 'This provider prohibits combining strict frames with references.',
    });
  return issues;
}
