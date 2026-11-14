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

interface FalImageEndpointSpec {
  kind: 'seedream' | 'gpt' | 'nano-banana' | 'xai' | 'qwen';
  operation: 'text-to-image' | 'image-edit';
  maxReferences: number;
  tiers?: readonly string[];
  minPixels?: number;
  maxPixels?: number;
  backgroundModes?: readonly string[];
  legacyV4?: boolean;
}

const stdSeedream = { tiers: ['1K', '1.5K', '2K'], minPixels: 921_600, maxPixels: 4_624_220 };
const liteSeedream = { tiers: ['2K', '3K', '4K'], minPixels: 3_686_400, maxPixels: 16_777_216 };
const v45Seedream = {
  tiers: ['2K', '4K'],
  minPixels: 3_686_400,
  maxPixels: 16_777_216,
  legacyV4: true,
};
const v4Seedream = {
  tiers: ['1K', '2K', '4K'],
  minPixels: 921_600,
  maxPixels: 16_777_216,
  legacyV4: true,
};

const endpoints = new Map<string, FalImageEndpointSpec>([
  [
    'bytedance/seedream/v5.5/text-to-image',
    {
      kind: 'seedream',
      operation: 'text-to-image',
      maxReferences: 0,
      ...stdSeedream,
      backgroundModes: ['auto', 'opaque', 'transparent'],
    },
  ],
  [
    'bytedance/seedream/v5.5/edit',
    {
      kind: 'seedream',
      operation: 'image-edit',
      maxReferences: 10,
      ...stdSeedream,
      backgroundModes: ['auto', 'opaque', 'transparent'],
    },
  ],
  [
    'bytedance/seedream/v5/pro/text-to-image',
    { kind: 'seedream', operation: 'text-to-image', maxReferences: 0, ...stdSeedream },
  ],
  [
    'bytedance/seedream/v5/pro/edit',
    {
      kind: 'seedream',
      operation: 'image-edit',
      maxReferences: 10,
      ...stdSeedream,
      backgroundModes: ['opaque', 'transparent'],
    },
  ],
  [
    'bytedance/seedream/v5/flash/text-to-image',
    { kind: 'seedream', operation: 'text-to-image', maxReferences: 0, ...stdSeedream },
  ],
  [
    'bytedance/seedream/v5/flash/edit',
    {
      kind: 'seedream',
      operation: 'image-edit',
      maxReferences: 10,
      ...stdSeedream,
      backgroundModes: ['opaque', 'transparent'],
    },
  ],
  [
    'bytedance/seedream/v5/lite/text-to-image',
    { kind: 'seedream', operation: 'text-to-image', maxReferences: 0, ...liteSeedream },
  ],
  [
    'bytedance/seedream/v5/lite/edit',
    { kind: 'seedream', operation: 'image-edit', maxReferences: 14, ...liteSeedream },
  ],
  [
    'fal-ai/bytedance/seedream/v4.5/text-to-image',
    { kind: 'seedream', operation: 'text-to-image', maxReferences: 0, ...v45Seedream },
  ],
  [
    'fal-ai/bytedance/seedream/v4.5/edit',
    { kind: 'seedream', operation: 'image-edit', maxReferences: 10, ...v45Seedream },
  ],
  [
    'fal-ai/bytedance/seedream/v4/text-to-image',
    { kind: 'seedream', operation: 'text-to-image', maxReferences: 0, ...v4Seedream },
  ],
  [
    'fal-ai/bytedance/seedream/v4/edit',
    { kind: 'seedream', operation: 'image-edit', maxReferences: 10, ...v4Seedream },
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
  ['openai/gpt-image-2', { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 }],
  ['openai/gpt-image-2/edit', { kind: 'gpt', operation: 'image-edit', maxReferences: 16 }],
  ['fal-ai/gpt-image-2', { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 }],
  ['fal-ai/gpt-image-2/edit', { kind: 'gpt', operation: 'image-edit', maxReferences: 16 }],
  ['google/nano-banana-2.1', { kind: 'nano-banana', operation: 'text-to-image', maxReferences: 0 }],
  [
    'google/nano-banana-2.1/edit',
    { kind: 'nano-banana', operation: 'image-edit', maxReferences: 14 },
  ],
  [
    'xai/grok-imagine-image/v2.0/text-to-image',
    { kind: 'xai', operation: 'text-to-image', maxReferences: 0 },
  ],
  ['xai/grok-imagine-image/v2.0/edit', { kind: 'xai', operation: 'image-edit', maxReferences: 5 }],
  [
    'alibaba/qwen-image-3/text-to-image',
    { kind: 'qwen', operation: 'text-to-image', maxReferences: 0 },
  ],
  ['alibaba/qwen-image-3/edit', { kind: 'qwen', operation: 'image-edit', maxReferences: 3 }],
]);
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
const xaiRatios = new Set([
  '2:1',
  '20:9',
  '19.5:9',
  '16:9',
  '4:3',
  '3:2',
  '1:1',
  '2:3',
  '3:4',
  '9:16',
  '9:19.5',
  '9:20',
  '1:2',
  'auto',
  '21:9',
  '5:2',
]);

function qwenImageSize(
  args: GenerationArguments,
): { width: number; height: number } | 'omit' | null {
  if (args.size) {
    const { width, height } = args.size;
    return Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 512 &&
      height >= 512 &&
      width <= 4096 &&
      height <= 4096 &&
      width * height >= 262_144 &&
      width * height <= 4_194_304
      ? { width, height }
      : null;
  }
  const tier = (args.resolution ?? '').toUpperCase();
  if (!['1K', '2K'].includes(tier)) return null;
  if (args.aspectRatio === 'source' || args.aspectRatio === 'auto')
    return tier === '1K' ? 'omit' : { width: 2048, height: 2048 };
  const edge = tier === '2K' ? 2048 : 1024;
  const map: Record<string, [number, number]> = {
    '1:1': [edge, edge],
    '4:3': [edge, (edge * 3) / 4],
    '3:4': [(edge * 3) / 4, edge],
    '16:9': tier === '1K' ? [1280, 720] : [2048, 1152],
    '9:16': tier === '1K' ? [720, 1280] : [1152, 2048],
  };
  const pair = map[args.aspectRatio ?? '1:1'];
  return pair ? { width: pair[0], height: pair[1] } : null;
}

export function isFalImageEndpoint(id: string): boolean {
  return endpoints.has(id);
}

export function falImageDefaultFormat(id: string, requested?: string): string {
  if (requested) return requested;
  const endpoint = endpoints.get(id);
  return endpoint?.legacyV4 ? 'jpeg' : 'png';
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
    ...(endpoint.legacyV4 ? [] : ['outputFormat' as const]),
  ] as const;
  if (endpoint.kind === 'gpt')
    return [...base, 'size', 'quality', 'mask', 'background', 'outputCompression'];
  if (endpoint.kind === 'nano-banana')
    return [...base, 'thinkingLevel', 'grounding', 'systemPrompt', 'seed'];
  if (endpoint.kind === 'xai') return [...base, 'quality'];
  if (endpoint.kind === 'qwen') return [...base, 'negativePrompt', 'size', 'seed', 'promptExtend'];
  return [
    ...base,
    'size',
    ...(endpoint.legacyV4 ? ['seed' as const] : ['watermark' as const]),
    ...(endpoint.backgroundModes?.length ? ['background' as const] : []),
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
    ...(endpoint.legacyV4 ? {} : { output_format: args.outputFormat ?? 'png' }),
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
  if (endpoint.kind === 'xai') {
    const res = (args.resolution ?? '').toLowerCase();
    if (!['1k', '1.5k', '2k'].includes(res))
      return { error: 'Unsupported fal Grok Imagine Image resolution.' };
    if (args.quality && !['low', 'medium', 'auto'].includes(args.quality))
      return { error: 'Unsupported Grok Imagine Image quality.' };
    const ratio =
      args.aspectRatio === 'source'
        ? 'auto'
        : (args.aspectRatio ?? (input.operation === 'image-edit' ? 'auto' : '1:1'));
    if (!xaiRatios.has(ratio)) return { error: 'Unsupported Grok Imagine Image aspect ratio.' };
    return {
      body: {
        ...body,
        resolution: res,
        quality: args.quality ?? (input.operation === 'image-edit' ? 'medium' : 'low'),
        aspect_ratio: ratio,
        enable_safety_checker: true,
      },
    };
  }
  if (endpoint.kind === 'qwen') {
    const qwenSize = qwenImageSize(args);
    if (!qwenSize) return { error: 'Unsupported Qwen Image 3 dimensions.' };
    return {
      body: {
        ...body,
        ...(qwenSize === 'omit' ? {} : { image_size: qwenSize }),
        enable_prompt_expansion: args.promptExtend ?? false,
        ...(args.negativePrompt === undefined ? {} : { negative_prompt: args.negativePrompt }),
        ...(args.seed === undefined ? {} : { seed: args.seed }),
        enable_safety_checker: true,
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
  if (args.background !== undefined && !endpoint.backgroundModes?.includes(args.background))
    return { error: 'Seedream background must be opaque or transparent.' };
  if (args.quality) return { error: 'Seedream does not expose this quality control.' };
  if (
    args.background === 'transparent' &&
    context.route.upstreamModelId === 'bytedance/seedream/v5/pro/edit' &&
    (references.length !== 1 || args.outputFormat !== 'png')
  )
    return { error: 'Seedream transparent edit requires one input and explicitPNG output.' };
  if (
    args.background === 'transparent' &&
    args.outputFormat !== undefined &&
    args.outputFormat !== 'png'
  )
    return { error: 'Seedream transparent output requires PNG.' };
  const dimensions = seedreamImageSize(args, {
    tiers: endpoint.tiers ?? stdSeedream.tiers,
    minPixels: endpoint.minPixels ?? stdSeedream.minPixels,
    maxPixels: endpoint.maxPixels ?? stdSeedream.maxPixels,
  });
  if (!dimensions) return { error: 'Unsupported exact Seedream dimensions.' };
  const pair = /^(\d+)x(\d+)$/.exec(dimensions);
  const imageSize = pair
    ? { width: Number(pair[1]), height: Number(pair[2]) }
    : endpoint.legacyV4 && dimensions === '1K'
      ? { width: 1024, height: 1024 }
      : `auto_${dimensions}`;
  return {
    body: {
      ...body,
      image_size: imageSize,
      ...(endpoint.legacyV4
        ? args.seed === undefined
          ? {}
          : { seed: args.seed }
        : { watermark: args.watermark ?? true }),
      enable_safety_checker: true,
      ...(args.background ? { background: args.background } : {}),
    },
  };
}
