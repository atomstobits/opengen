import type { AdapterContext } from './adapters.js';
import type { GenerationArguments } from '@media-router/contracts';
import {
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  assetReferenceUrl,
} from './adapters.js';
import { openAIArgumentSize } from './openai.js';
import { seedreamImageSize } from './byteplus.js';

const endpoints = new Map<
  string,
  {
    kind: 'seedream' | 'gpt' | 'nano-banana';
    operation: 'text-to-image' | 'image-edit';
    maxReferences: number;
  }
>([
  [
    'bytedance/seedream/v5/pro/text-to-image',
    { kind: 'seedream', operation: 'text-to-image', maxReferences: 0 },
  ],
  [
    'bytedance/seedream/v5/pro/edit',
    { kind: 'seedream', operation: 'image-edit', maxReferences: 10 },
  ],
  [
    'openai/gpt-image-2.5/flare/text-to-image',
    { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 },
  ],
  ['openai/gpt-image-2.5/flare/edit', { kind: 'gpt', operation: 'image-edit', maxReferences: 16 }],
  [
    'openai/gpt-image-2.5/sunburst/text-to-image',
    { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 },
  ],
  [
    'openai/gpt-image-2.5/sunburst/edit',
    { kind: 'gpt', operation: 'image-edit', maxReferences: 16 },
  ],
  ['google/nano-banana-2.1', { kind: 'nano-banana', operation: 'text-to-image', maxReferences: 0 }],
  [
    'google/nano-banana-2.1/edit',
    { kind: 'nano-banana', operation: 'image-edit', maxReferences: 14 },
  ],
  ['fal-ai/gpt-image-2', { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 }],
  ['fal-ai/gpt-image-2/edit', { kind: 'gpt', operation: 'image-edit', maxReferences: 16 }],
] as const);
const nanoRatios = new Set([
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '5:4',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  '4:1',
  '1:4',
  '8:1',
  '1:8',
  'auto',
]);

export function isFalImageEndpoint(id: string): boolean {
  return endpoints.has(id);
}

export function falImageFields(id: string): readonly (keyof GenerationArguments)[] {
  const endpoint = endpoints.get(id);
  if (!endpoint) return [];
  const base = [
    'prompt',
    'resolution',
    'aspectRatio',
    'references',
    'count',
    'outputFormat',
  ] as const;
  return endpoint.kind === 'gpt'
    ? [...base, 'size', 'quality', 'mask', 'background', 'outputCompression']
    : endpoint.kind === 'nano-banana'
      ? [...base, 'thinkingLevel', 'grounding', 'systemPrompt', 'seed']
      : [
          ...base,
          'size',
          'watermark',
          ...(endpoint.operation === 'image-edit' ? ['background' as const] : []),
        ];
}
/** Each supported model has an explicit schema translation; arbitrary fal endpoints are not accepted. */
export function falImageInput(
  context: Omit<AdapterContext, 'jobId'>,
): { body: Record<string, unknown> } | { error: string } | null {
  const endpoint = endpoints.get(context.route.upstreamModelId);
  if (!endpoint) return null;
  const { input } = context;
  if (input.operation !== endpoint.operation)
    return { error: 'The selected fal image endpoint does not implement this operation.' };
  const args = input.input;
  const fields = falImageFields(context.route.upstreamModelId);
  const issue = adapterInputIssue(context, fields);
  if (issue) return { error: issue };
  const typeIssue = referenceTypeIssue(input);
  if (typeIssue) return { error: typeIssue };
  const references = referenceUrls(input);
  if (
    references.length > endpoint.maxReferences ||
    (input.operation === 'image-edit' && references.length < 1)
  )
    return {
      error: `This endpoint requires ${input.operation === 'image-edit' ? '1–' : ''}${endpoint.maxReferences} image references; none are dropped.`,
    };
  if (
    args.count !== undefined &&
    (!Number.isInteger(args.count) ||
      args.count < 1 ||
      args.count > (endpoint.kind === 'gpt' ? 10 : endpoint.kind === 'seedream' ? 6 : 4))
  )
    return { error: 'Requested count exceeds this endpoint output limit.' };
  if (args.outputFormat && !['png', 'jpeg', 'webp'].includes(args.outputFormat))
    return { error: 'Unsupported image format.' };
  if (
    args.outputCompression !== undefined &&
    (args.outputFormat === undefined || args.outputFormat === 'png')
  )
    return { error: 'Compression requires JPEG or WebP.' };
  if (args.background === 'transparent' && args.outputFormat === 'jpeg')
    return { error: 'Transparent images require PNG or WebP.' };
  const body: Record<string, unknown> = {
    prompt: input.input.prompt,
    num_images: args.count ?? 1,
    output_format: args.outputFormat ?? 'png',
    sync_mode: false,
    ...(input.operation === 'image-edit' ? { image_urls: references } : {}),
  };
  if (endpoint.kind === 'nano-banana') {
    if (
      !['0.5K', '1K', '2K', '4K'].includes((input.input.resolution ?? '').toUpperCase()) ||
      (input.input.aspectRatio && !nanoRatios.has(input.input.aspectRatio))
    )
      return { error: 'Unsupported Nano Banana image size or aspect ratio.' };
    return {
      body: {
        ...body,
        resolution: (input.input.resolution ?? '').toUpperCase(),
        aspect_ratio: input.input.aspectRatio ?? '1:1',
        thinking_level: args.thinkingLevel ?? 'medium',
        enable_web_search: args.grounding ?? false,
        ...(args.seed === undefined ? {} : { seed: args.seed }),
        ...(args.systemPrompt === undefined ? {} : { system_prompt: args.systemPrompt }),
        limit_generations: true,
      },
    };
  }
  if (endpoint.kind === 'gpt') {
    const qualities = context.route.upstreamModelId.includes('2.5')
      ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['auto', 'low', 'medium', 'high'];
    if (args.quality && !qualities.includes(args.quality))
      return { error: 'Unsupported exact GPT Image quality.' };
    if (args.mask && input.operation !== 'image-edit')
      return { error: 'A mask requires image-edit.' };
    const dimensions = openAIArgumentSize(args);
    if (!dimensions)
      return {
        error: 'Unsupported exact GPT Image dimensions; no automatic size substitution is made.',
      };
    const [width, height] = dimensions.split('x').map(Number);
    return {
      body: {
        ...body,
        image_size: { width, height },
        quality: args.quality ?? 'medium',
        ...(args.background === undefined ? {} : { background: args.background }),
        ...(args.outputCompression === undefined
          ? {}
          : { output_compression: args.outputCompression }),
        ...(args.mask ? { mask_url: assetReferenceUrl(args.mask) } : {}),
        enable_safety_checker: true,
      },
    };
  }
  if (args.outputFormat === 'webp') return { error: 'Seedream supports PNG or JPEG output.' };
  if (args.background === 'auto')
    return { error: 'Seedream background must be opaque or transparent.' };
  if (args.quality) return { error: 'Seedream does not expose this quality control.' };
  if (
    args.background === 'transparent' &&
    (input.operation !== 'image-edit' || references.length !== 1 || args.outputFormat !== 'png')
  )
    return { error: 'Seedream transparent edit requires one input and explicitPNG output.' };
  const dimensions = seedreamImageSize(args);
  if (!dimensions) return { error: 'Unsupported exact Seedream dimensions.' };
  const pair = /^(\d+)x(\d+)$/.exec(dimensions);
  return {
    body: {
      ...body,
      image_size: pair ? { width: Number(pair[1]), height: Number(pair[2]) } : `auto_${dimensions}`,
      watermark: args.watermark ?? true,
      enable_safety_checker: true,
      ...(args.background ? { background: args.background } : {}),
    },
  };
}
