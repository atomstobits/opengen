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
  kind:
    | 'seedream'
    | 'gpt'
    | 'nano-banana'
    | 'xai'
    | 'qwen'
    | 'minimax-image'
    | 'flux3-image'
    | 'flux3-klein';
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
    { kind: 'seedream', operation: 'image-edit', maxReferences: 10, ...liteSeedream },
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
    'openai/gpt-image-2.6/sunburst/text-to-image',
    { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 },
  ],
  [
    'openai/gpt-image-2.6/sunburst/edit',
    { kind: 'gpt', operation: 'image-edit', maxReferences: 16 },
  ],
  [
    'openai/gpt-image-2.6/flare/text-to-image',
    { kind: 'gpt', operation: 'text-to-image', maxReferences: 0 },
  ],
  ['openai/gpt-image-2.6/flare/edit', { kind: 'gpt', operation: 'image-edit', maxReferences: 16 }],
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
  ['fal-ai/nano-banana-pro', { kind: 'nano-banana', operation: 'text-to-image', maxReferences: 0 }],
  [
    'fal-ai/nano-banana-pro/edit',
    { kind: 'nano-banana', operation: 'image-edit', maxReferences: 14 },
  ],
  ['fal-ai/nano-banana-2', { kind: 'nano-banana', operation: 'text-to-image', maxReferences: 0 }],
  [
    'fal-ai/nano-banana-2/edit',
    { kind: 'nano-banana', operation: 'image-edit', maxReferences: 14 },
  ],
  [
    'google/nano-banana-2-lite',
    { kind: 'nano-banana', operation: 'text-to-image', maxReferences: 0 },
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
  [
    'minimax/h3-image/text-to-image',
    { kind: 'minimax-image', operation: 'text-to-image', maxReferences: 0 },
  ],
  ['minimax/h3-image/edit', { kind: 'minimax-image', operation: 'image-edit', maxReferences: 16 }],
  [
    'minimax/h3-image/highspeed/text-to-image',
    { kind: 'minimax-image', operation: 'text-to-image', maxReferences: 0 },
  ],
  [
    'minimax/h3-image/highspeed/edit',
    { kind: 'minimax-image', operation: 'image-edit', maxReferences: 16 },
  ],
  [
    'blackforestlabs/flux-3/text-to-image',
    { kind: 'flux3-image', operation: 'text-to-image', maxReferences: 0 },
  ],
  [
    'blackforestlabs/flux-3/edit-image',
    { kind: 'flux3-image', operation: 'image-edit', maxReferences: 10 },
  ],
  [
    'blackforestlabs/flux-3/klein/text-to-image',
    { kind: 'flux3-klein', operation: 'text-to-image', maxReferences: 0 },
  ],
  [
    'blackforestlabs/flux-3/klein/edit-image',
    { kind: 'flux3-klein', operation: 'image-edit', maxReferences: 10 },
  ],
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
const flux3Ratios = new Set([
  'auto',
  '21:9',
  '2:1',
  '16:9',
  '3:2',
  '7:5',
  '4:3',
  '5:4',
  '1:1',
  '4:5',
  '3:4',
  '5:7',
  '2:3',
  '9:16',
  '1:2',
]);
const fluxKleinRatios: Record<string, [number, number]> = {
  '21:9': [21, 9],
  '16:9': [16, 9],
  '4:3': [4, 3],
  '3:2': [3, 2],
  '1:1': [1, 1],
  '2:3': [2, 3],
  '3:4': [3, 4],
  '9:16': [9, 16],
};

function qwenImageSize(
  args: GenerationArguments,
  operation: 'text-to-image' | 'image-edit',
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
  if (args.aspectRatio === 'source' || (operation === 'image-edit' && !args.aspectRatio))
    return tier === '1K' ? 'omit' : null;
  if (args.aspectRatio === 'auto')
    return tier === '1K'
      ? 'omit'
      : operation === 'image-edit'
        ? null
        : { width: 2048, height: 2048 };
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

function minimaxFalImageSize(
  args: GenerationArguments,
  operation: 'text-to-image' | 'image-edit',
): { width: number; height: number } | 'auto' | null {
  if (args.size) {
    const { width, height } = args.size;
    return Number.isInteger(width) &&
      Number.isInteger(height) &&
      width > 0 &&
      height > 0 &&
      width * height >= 655_360 &&
      width * height <= 20_000_000 &&
      width / height >= 1 / 3 &&
      width / height <= 3
      ? { width, height }
      : null;
  }
  const tier = (args.resolution ?? '2K').toUpperCase();
  if (!['1K', '2K', '4K'].includes(tier)) return null;
  if (operation === 'text-to-image' && args.aspectRatio === 'source') return null;
  if (
    operation === 'image-edit' &&
    (args.aspectRatio === undefined ||
      args.aspectRatio === 'auto' ||
      args.aspectRatio === 'source') &&
    (args.resolution === undefined || tier === '2K')
  )
    return 'auto';
  const ratioStr =
    args.aspectRatio === undefined || args.aspectRatio === 'auto' || args.aspectRatio === 'source'
      ? '1:1'
      : args.aspectRatio;
  const match = /^(\d+):(\d+)$/.exec(ratioStr);
  if (!match) return null;
  const rw = Number(match[1]);
  const rh = Number(match[2]);
  if (!Number.isInteger(rw) || !Number.isInteger(rh) || rw < 1 || rw > 300 || rh < 1 || rh > 300)
    return null;
  if (rw / rh < 1 / 3 || rw / rh > 3) return null;
  const edge = tier === '4K' ? 4096 : tier === '1K' ? 1024 : 2048;
  const targetArea = edge * edge;
  let width = Math.round(Math.sqrt((targetArea * rw) / rh) / 16) * 16;
  let height = Math.round(Math.sqrt((targetArea * rh) / rw) / 16) * 16;
  if (width / height > 3) width -= 16;
  if (width / height < 1 / 3) height -= 16;
  return width * height >= 655_360 &&
    width * height <= 20_000_000 &&
    width / height >= 1 / 3 &&
    width / height <= 3
    ? { width, height }
    : null;
}

function fluxKleinImageSize(
  args: GenerationArguments,
  operation: 'text-to-image' | 'image-edit',
): { width: number; height: number } | 'omit' | null {
  if (args.size) {
    const { width, height } = args.size;
    return Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 256 &&
      width <= 4096 &&
      height >= 256 &&
      height <= 4096
      ? { width, height }
      : null;
  }
  const tier = (args.resolution ?? '1K').toUpperCase();
  if (!['1K', '2K', '4K'].includes(tier)) return null;
  if (operation === 'text-to-image' && args.aspectRatio === 'source') return null;
  if (
    operation === 'image-edit' &&
    (args.aspectRatio === undefined ||
      args.aspectRatio === 'auto' ||
      args.aspectRatio === 'source') &&
    (args.resolution === undefined || tier === '1K')
  )
    return 'omit';
  const ratioStr =
    args.aspectRatio === undefined || args.aspectRatio === 'auto' || args.aspectRatio === 'source'
      ? '1:1'
      : args.aspectRatio;
  const pair = fluxKleinRatios[ratioStr];
  if (!pair) return null;
  const [rw, rh] = pair;
  const edge = tier === '4K' ? 4096 : tier === '2K' ? 2048 : 1024;
  const width =
    rw >= rh ? edge : Math.max(256, Math.min(4096, Math.round((edge * rw) / rh / 16) * 16));
  const height =
    rh >= rw ? edge : Math.max(256, Math.min(4096, Math.round((edge * rh) / rw / 16) * 16));
  return { width, height };
}

export function isFalImageEndpoint(id: string): boolean {
  return endpoints.has(id);
}

export function falImageDefaultFormat(id: string, requested?: string): string {
  if (requested) return requested;
  const endpoint = endpoints.get(id);
  return endpoint?.legacyV4 || endpoint?.kind === 'flux3-image' ? 'jpeg' : 'png';
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
    return [
      ...base,
      'size',
      'quality',
      'mask',
      'background',
      'outputCompression',
      ...(id.includes('gpt-image-2.6') ? ['complexity' as const] : []),
    ];
  if (endpoint.kind === 'nano-banana')
    return [
      ...base,
      'thinkingLevel',
      ...(id === 'google/nano-banana-2-lite' ? [] : ['grounding' as const]),
      'systemPrompt',
      'seed',
    ];
  if (endpoint.kind === 'xai') return [...base, 'quality'];
  if (endpoint.kind === 'qwen') return [...base, 'negativePrompt', 'size', 'seed', 'promptExtend'];
  if (endpoint.kind === 'minimax-image')
    return [
      ...base,
      'size',
      ...(endpoint.operation === 'text-to-image' ? ['promptExpansion' as const] : []),
    ];
  if (endpoint.kind === 'flux3-image') return [...base, 'promptExpansion'];
  if (endpoint.kind === 'flux3-klein') return [...base, 'size', 'seed', 'promptExpansion'];
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
  const modelId = context.route.upstreamModelId;
  const endpoint = endpoints.get(modelId);
  if (!endpoint) return null;
  const { input } = context;
  if (input.operation !== endpoint.operation)
    return { error: 'The selected fal image endpoint does not implement this operation.' };
  const args = input.input;
  const fields = falImageFields(modelId);
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
  const maxCount =
    endpoint.kind === 'gpt' || endpoint.kind === 'minimax-image'
      ? 10
      : endpoint.kind === 'seedream'
        ? 6
        : endpoint.kind === 'flux3-image'
          ? 1
          : 4;
  if (
    args.count !== undefined &&
    (!Number.isInteger(args.count) || args.count < 1 || args.count > maxCount)
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

  if (endpoint.kind === 'flux3-image') {
    if (args.outputFormat === 'webp')
      return { error: 'FLUX 3 Image supports JPEG or PNG output only.' };
    const res = (args.resolution ?? '1k').toLowerCase();
    if (!['768sq', '1k', '1.5k', '2k', '4k'].includes(res))
      return { error: 'Unsupported FLUX 3 Image resolution tier.' };
    if (input.operation === 'text-to-image' && args.aspectRatio === 'source')
      return { error: 'Source aspect ratio requires an input image.' };
    const ratio =
      args.aspectRatio === 'source'
        ? 'auto'
        : (args.aspectRatio ?? (input.operation === 'image-edit' ? 'auto' : '1:1'));
    if (!flux3Ratios.has(ratio)) return { error: 'Unsupported FLUX 3 Image aspect ratio.' };
    if (
      args.promptExpansion !== undefined &&
      ![false, true, 'disabled', 'none', 'balanced', 'quality'].includes(args.promptExpansion)
    )
      return { error: 'Unsupported FLUX 3 Image prompt expansion setting.' };
    return {
      body: {
        prompt: args.prompt,
        resolution: res,
        aspect_ratio: ratio,
        output_format: args.outputFormat ?? 'jpeg',
        enable_prompt_expansion: Boolean(
          args.promptExpansion &&
          args.promptExpansion !== 'none' &&
          args.promptExpansion !== 'disabled',
        ),
        sync_mode: false,
        ...(input.operation === 'image-edit' ? { image_urls: references } : {}),
      },
    };
  }

  const body: Record<string, unknown> = {
    prompt: input.input.prompt,
    num_images: args.count ?? 1,
    ...(endpoint.legacyV4 ? {} : { output_format: args.outputFormat ?? 'png' }),
    sync_mode: false,
    ...(input.operation === 'image-edit' ? { image_urls: references } : {}),
  };

  if (endpoint.kind === 'nano-banana') {
    if (input.operation === 'text-to-image' && args.aspectRatio === 'source')
      return { error: 'Source aspect ratio requires an input image.' };
    const ratio =
      args.aspectRatio === 'source'
        ? 'auto'
        : (args.aspectRatio ?? (input.operation === 'image-edit' ? 'auto' : '1:1'));
    if (!nanoRatios.has(ratio))
      return { error: 'Unsupported Nano Banana image size or aspect ratio.' };

    const isLite = modelId === 'google/nano-banana-2-lite';
    const isPro = modelId.startsWith('fal-ai/nano-banana-pro');
    const isNb2 = modelId.startsWith('fal-ai/nano-banana-2');
    const res = (args.resolution ?? '1K').toUpperCase();
    const allowedRes = isLite ? ['1K'] : isPro ? ['1K', '2K', '4K'] : ['0.5K', '1K', '2K', '4K'];
    if (!allowedRes.includes(res))
      return { error: 'Unsupported Nano Banana image size or aspect ratio.' };

    const allowedThinking = isPro
      ? ['high']
      : isLite || isNb2
        ? ['minimal', 'high']
        : ['minimal', 'medium', 'high'];
    if (args.thinkingLevel !== undefined && !allowedThinking.includes(args.thinkingLevel))
      return { error: 'Unsupported Nano Banana thinking level.' };

    const thinkingLevel =
      isPro || isNb2 || isLite ? args.thinkingLevel : (args.thinkingLevel ?? 'medium');
    return {
      body: {
        ...body,
        ...(isLite ? {} : { resolution: res }),
        aspect_ratio: ratio,
        ...(thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
        ...(isLite ? {} : { enable_web_search: args.grounding ?? false }),
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
    const qwenSize = qwenImageSize(args, input.operation);
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

  if (endpoint.kind === 'minimax-image') {
    if ((args.prompt ?? '').length > 32_000)
      return { error: 'Fal MiniMax H3 Image prompt limit is 32,000 characters.' };
    if (
      args.promptExpansion !== undefined &&
      ![false, true, 'disabled', 'none', 'balanced', 'quality'].includes(args.promptExpansion)
    )
      return { error: 'Unsupported MiniMax H3 Image prompt expansion setting.' };
    const imageSize = minimaxFalImageSize(args, input.operation);
    if (!imageSize) return { error: 'Unsupported MiniMax H3 Image dimensions.' };
    return {
      body: {
        ...body,
        image_size: imageSize,
        ...(input.operation === 'text-to-image'
          ? {
              enable_prompt_expansion: !(
                args.promptExpansion === false ||
                args.promptExpansion === 'none' ||
                args.promptExpansion === 'disabled'
              ),
            }
          : {}),
      },
    };
  }

  if (endpoint.kind === 'flux3-klein') {
    if (
      args.promptExpansion !== undefined &&
      ![false, true, 'disabled', 'none', 'balanced', 'quality'].includes(args.promptExpansion)
    )
      return { error: 'Unsupported FLUX 3 Klein prompt expansion setting.' };
    const kleinSize = fluxKleinImageSize(args, input.operation);
    if (!kleinSize) return { error: 'Unsupported FLUX 3 Klein dimensions.' };
    return {
      body: {
        ...body,
        ...(kleinSize === 'omit' ? {} : { image_size: kleinSize }),
        enable_prompt_expansion:
          args.promptExpansion === undefined
            ? true
            : !(
                args.promptExpansion === false ||
                args.promptExpansion === 'none' ||
                args.promptExpansion === 'disabled'
              ),
        ...(args.seed === undefined ? {} : { seed: args.seed }),
        enable_safety_checker: true,
      },
    };
  }

  if (endpoint.kind === 'gpt') {
    const is26 = modelId.includes('gpt-image-2.6');
    const qualities =
      modelId.includes('2.5') || is26
        ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
        : ['auto', 'low', 'medium', 'high'];
    if (args.quality && !qualities.includes(args.quality))
      return { error: 'Unsupported exact GPT Image quality.' };
    if (args.complexity !== undefined && !['low', 'medium', 'high'].includes(args.complexity))
      return { error: 'Unsupported GPT Image 2.6 complexity.' };
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
        ...(args.complexity === undefined ? {} : { reasoning_effort: args.complexity }),
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
    (modelId === 'bytedance/seedream/v5/pro/edit' ||
      modelId === 'bytedance/seedream/v5/flash/edit') &&
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
