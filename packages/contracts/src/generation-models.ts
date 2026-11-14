import type { Operation } from './index';
import type {
  GenerationArguments,
  GenerationCapabilities,
  GenerationDefinition,
  ReferenceType,
} from './generation-types';

export type ModelDefinition = Omit<GenerationDefinition, 'modelId' | 'operation'> & {
  operations: readonly Operation[];
};
const videoOps: Operation[] = ['text-to-video', 'image-to-video', 'reference-to-video'];
const imageOps: Operation[] = ['text-to-image', 'image-edit'];
const imageCommon: (keyof GenerationArguments)[] = [
  'prompt',
  'negativePrompt',
  'references',
  'resolution',
  'size',
  'aspectRatio',
  'count',
  'quality',
  'outputFormat',
  'outputCompression',
  'seed',
];
const videoCommon: (keyof GenerationArguments)[] = [
  'prompt',
  'firstFrame',
  'lastFrame',
  'references',
  'sourceVideo',
  'duration',
  'resolution',
  'aspectRatio',
  'audio',
  'seed',
  'count',
];
const ratios = ['auto', 'source', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const wideRatios = [
  ...ratios,
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '2:1',
  '1:2',
  '5:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
  '4:1',
  '1:4',
  '8:1',
  '1:8',
];
const source = (url: string) => ({ url, checkedAt: '2026-11-03' });
const defs: Record<string, ModelDefinition> = {};
function video(
  id: string,
  options: {
    sources: string[];
    resolutions: string[];
    minimum?: number;
    maximum?: number;
    integer?: boolean;
    auto?: boolean;
    referenceMaximum?: Partial<Record<ReferenceType, number>>;
    totalMaximum?: number;
    lastOnly?: boolean;
    keyframes?: number;
    timed?: boolean;
    mix?: boolean;
    audio?: GenerationCapabilities['audio'];
    extra?: (keyof GenerationArguments)[];
    operations?: Operation[];
    promptMax?: number | null;
    notices?: string[];
    verification?: ModelDefinition['verification'];
    defaultResolution?: string;
    aspectRatios?: string[];
  },
) {
  const maximum = options.referenceMaximum ?? { image: 1 };
  defs[id] = {
    modality: 'video',
    operations: options.operations ?? videoOps,
    commonArguments: videoCommon,
    modelSpecificArguments: options.extra ?? [],
    defaults: { resolution: options.defaultResolution ?? '720p' },
    capabilities: {
      resolutions: options.resolutions,
      aspectRatios: options.aspectRatios ?? ratios,
      duration: {
        minimum: options.minimum ?? 4,
        maximum: options.maximum ?? 15,
        integer: options.integer ?? true,
        auto: options.auto ?? false,
      },
      references: {
        types: Object.keys(maximum) as ReferenceType[],
        maximum,
        ...(options.totalMaximum === undefined ? {} : { totalMaximum: options.totalMaximum }),
      },
      frames: {
        first: true,
        last: true,
        lastOnly: options.lastOnly ?? false,
        keyframesMaximum: options.keyframes ?? 0,
        timed: options.timed ?? false,
      },
      frameReferenceMix: options.mix ?? false,
      audio: options.audio ?? 'switchable',
      countMaximum: 1,
    },
    promptRequired: true,
    promptMaximum: options.promptMax ?? null,
    verification: options.verification ?? 'documented',
    sources: options.sources.map(source),
    notices: options.notices ?? [
      'Documented capabilities are not live account access. Route and adapter restrictions may narrow this schema.',
    ],
  };
}
function image(
  id: string,
  options: {
    sources: string[];
    resolutions?: string[];
    defaultResolution?: string;
    maxReferences?: number;
    types?: ReferenceType[];
    countMaximum?: number;
    quality?: string[];
    extra?: (keyof GenerationArguments)[];
    promptMax?: number | null;
    verification?: ModelDefinition['verification'];
    notices?: string[];
    operations?: Operation[];
    mask?: boolean;
  },
) {
  defs[id] = {
    modality: 'image',
    operations: options.operations ?? imageOps,
    commonArguments: options.mask ? [...imageCommon, 'mask'] : imageCommon,
    modelSpecificArguments: options.extra ?? [],
    defaults: { resolution: options.defaultResolution ?? '1K' },
    capabilities: {
      resolutions: options.resolutions ?? ['1K', '2K', '4K'],
      aspectRatios: wideRatios,
      references: {
        types: options.types ?? ['image'],
        maximum: options.maxReferences === undefined ? {} : { image: options.maxReferences },
      },
      frames: { first: false, last: false, lastOnly: false, keyframesMaximum: 0, timed: false },
      frameReferenceMix: false,
      audio: 'unsupported',
      countMaximum: options.countMaximum ?? 1,
      ...(options.quality ? { quality: options.quality } : {}),
    },
    promptRequired: true,
    promptMaximum: options.promptMax ?? null,
    verification: options.verification ?? 'documented',
    sources: options.sources.map(source),
    notices: options.notices ?? [
      'Model-specific controls and route support must both be qualified. Delivery representation is broker-owned, not a generation argument.',
    ],
  };
}
const byteplus = 'https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api';
video('bytedance/seedance-2.5', {
  sources: [byteplus, 'https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api'],
  resolutions: ['480p', '720p', '1080p'],
  minimum: 4,
  maximum: 30,
  auto: true,
  referenceMaximum: { image: 30, video: 10, audio: 10 },
  totalMaximum: 50,
  extra: ['draft', 'draftJobId', 'codec', 'bitrateMode', 'watermark'],
  operations: [...videoOps, 'video-edit', 'video-extend'],
  notices: [
    'Strict first/last-frame mode and omni references are mutually exclusive on native BytePlus. Supplier wrappers can expose different controls; seed/codec/bitrate are not universal native controls. Draft/finalization is deployment-bound.',
  ],
});
for (const [id, resolutions] of [
  ['bytedance/seedance-2.0', ['480p', '720p', '1080p', '4K']],
  ['bytedance/seedance-2.0-fast', ['480p', '720p']],
  ['bytedance/seedance-2.0-mini', ['480p', '720p']],
] as const)
  video(id, {
    sources: [byteplus],
    resolutions: [...resolutions],
    maximum: 15,
    auto: true,
    referenceMaximum: { image: 9, video: 3, audio: 3 },
    totalMaximum: 12,
    extra: ['watermark'],
    notices: [
      'Audio-only conditioning is not qualified for this model. Strict frame mode cannot be mixed with omni references. A resolution tier is not an exact pixel-dimension guarantee across wrappers.',
    ],
  });
video('bytedance/seedance-1.0-pro', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedance-1-0-pro',
    'https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video/api',
  ],
  resolutions: ['480p', '720p', '1080p'],
  minimum: 2,
  maximum: 12,
  referenceMaximum: { image: 4 },
  audio: 'unsupported',
  extra: ['watermark'],
  notices: [
    'Seedance 1.0 Pro generates silent video without native audio. Strict first/last-frame mode and 1–4 image references are mutually exclusive on native BytePlus; fal v1/pro routes expose text-to-video and image-to-video.',
  ],
});
video('bytedance/seedance-1.0-pro-fast', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedance-1-0-pro-fast',
    'https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/fast/image-to-video/api',
  ],
  resolutions: ['480p', '720p', '1080p'],
  minimum: 2,
  maximum: 12,
  referenceMaximum: {},
  operations: ['text-to-video', 'image-to-video'],
  audio: 'unsupported',
  extra: ['watermark'],
  notices: [
    'Seedance 1.0 Pro Fast supports text-to-video and first-frame image-to-video without last-frame or reference-image modes, and generates silent video.',
  ],
});
defs['bytedance/seedance-1.0-pro-fast']!.capabilities.frames.last = false;
video('kling/kling-4.0', {
  sources: [
    'https://dev.runwayml.com/learn/kling-4-0-api',
    'https://runware.ai/docs/models/klingai-video-4-0',
  ],
  resolutions: ['720p', '1080p'],
  minimum: 3,
  maximum: 30,
  referenceMaximum: { image: 10, video: 5, audio: 3 },
  totalMaximum: 15,
  keyframes: 10,
  mix: true,
  audio: 'always-on',
  extra: ['keyframes', 'elements', 'shots'],
  promptMax: 26000,
  notices: [
    'Native detailed payload remains unresolved; qualified wrappers are independent contracts. Keyframes and reference images can share one combined image budget. Timed placement is not inferred from ordered middle frames. Native 4K availability is not assumed from consumer marketing.',
  ],
});
for (const id of ['alibaba/wan-3.0', 'alibaba/wan-3.0-prime'])
  video(id, {
    sources: [
      'https://www.alibabacloud.com/help/en/model-studio/wan3-0-video',
      'https://www.alibabacloud.com/help/en/model-studio/wan3-0-video-prime',
    ],
    resolutions: ['480p', '720p', '1080p'],
    minimum: 2,
    maximum: 30,
    auto: true,
    referenceMaximum: { image: 10, video: 5, audio: 5, document: 1 },
    extra: ['watermark'],
    notices: [
      'Each regional deployment requires matching credentials. Endpoint region is distinct from inference/storage residency. Frame and omni-reference modes are mutually exclusive. Document/web-page mode is not silently translated into ordinary image references.',
    ],
  });
const minimax = 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create';
for (const [id, resolutions] of [
  ['minimax/h3', ['768p', '2K']],
  ['minimax/h3-highspeed', ['480p', '768p']],
  ['minimax/h3-lite', ['480p', '768p']],
  ['minimax/h3-max', ['480p', '768p']],
] as const)
  video(id, {
    sources: [minimax],
    resolutions: [...resolutions],
    defaultResolution: '768p',
    minimum: id === 'minimax/h3-max' ? 5 : 4,
    maximum: 15,
    referenceMaximum: { image: 9, video: 3, audio: 3 },
    extra: ['promptExpansion'],
    promptMax: 7000,
    notices: [
      'Native frames and omni references are separate modes. Native last-only support is conflicting in prose/child descriptions and remains unqualified. Video and audio each have a combined 15-second input budget; byte/duration inspection is required separately.',
    ],
  });
// Keep native MiniMax's narrower API profiles for route validation; the public profile is the union.
const nativeH3 = structuredClone(defs['minimax/h3']!);
export const nativeH3Definition: ModelDefinition = {
  ...nativeH3,
  commonArguments: nativeH3.commonArguments.filter((field) => field !== 'seed'),
  capabilities: { ...nativeH3.capabilities, audio: 'always-on' },
};
video('minimax/h3', {
  sources: [minimax, 'https://fal.ai/models/minimax/h3/reference-to-video/api'],
  resolutions: ['480p', '768p', '2K', '4K'],
  defaultResolution: '768p',
  minimum: 4,
  maximum: 15,
  referenceMaximum: { image: 9, video: 3, audio: 3 },
  extra: ['promptExpansion', 'targetAudio'],
  promptMax: 50000,
  notices: [
    'MiniMax H3 is served natively by MiniMax (768p/2K) and on fal (480p/768p/2K/4K). The model profile is a capability union; native MiniMax and fal route limits are validated separately.',
    ...nativeH3.notices,
  ],
});
// The owner confirmed that the native and fal Max names refer to one exact variant.
// Keep native's narrower API profile for route validation; the public profile is the union.
const nativeH3Max = structuredClone(defs['minimax/h3-max']!);
export const nativeH3MaxDefinition: ModelDefinition = {
  ...nativeH3Max,
  commonArguments: nativeH3Max.commonArguments.filter((field) => field !== 'seed'),
  capabilities: { ...nativeH3Max.capabilities, audio: 'always-on' },
};
for (const [id, endpoint] of [
  ['minimax/h3-max', 'minimax/h3-max'],
  ['fal/h3-max-turbo', 'minimax/h3-max-turbo'],
] as const)
  video(id, {
    sources: [
      ...(id === 'minimax/h3-max' ? [minimax] : []),
      `https://fal.ai/models/${endpoint}/reference-to-video/api`,
    ],
    resolutions: ['480p', '768p', '1080p'],
    defaultResolution: '768p',
    minimum: 0.92,
    maximum: 15,
    integer: false,
    referenceMaximum: { image: 9, video: 3, audio: 3 },
    totalMaximum: id === 'minimax/h3-max' ? 15 : 12,
    mix: id === 'minimax/h3-max',
    keyframes: id === 'minimax/h3-max' ? 1 : 0,
    timed: id === 'minimax/h3-max',
    extra: [
      'promptExpansion',
      'targetAudio',
      ...(id === 'minimax/h3-max' ? ['keyframes' as const] : []),
    ],
    promptMax: 50000,
    notices: [
      ...(id === 'minimax/h3-max'
        ? [
            'MiniMax H3 Max and fal H3 Max are provider labels for one exact variant. The model profile is a capability union; native MiniMax and fal route limits are validated separately.',
            ...nativeH3Max.notices,
          ]
        : ['Max Turbo remains a separate variant.']),
      'Fractional duration, 1080p, seed, a timed middle frame and target-audio controls depend on the selected provider/operation. Output duration can drift. No unsupported controls are silently discarded.',
    ],
  });
video('pika/h3-flex', {
  sources: ['https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video/api'],
  resolutions: ['480p', '768p', '1080p', '2K', '4K'],
  defaultResolution: '768p',
  minimum: 5,
  maximum: 15,
  referenceMaximum: { image: 9, video: 3, audio: 3 },
  totalMaximum: 12,
  lastOnly: true,
  mix: true,
  extra: ['promptExpansion', 'targetAudio'],
  promptMax: 8000,
  notices: [
    'Higher output tiers can be upscaled; do not label every tier native. Media completion and settled provider billing are distinct. Draft finishing/audio stems/prompt rewriting are separate operations, not implicit generation steps.',
  ],
});
video('google/gemini-omni-1.1-flash', {
  sources: [
    'https://aistudio.google.com/docs/models/gemini-omni-flash',
    'https://aistudio.google.com/api-reference/interactions-api',
  ],
  resolutions: ['360p', '720p', '1080p', '4K'],
  minimum: 3,
  maximum: 10,
  referenceMaximum: { video: 3 },
  mix: true,
  operations: [...videoOps, 'video-edit', 'video-extend'],
  audio: 'always-on',
  verification: 'model-guided-partial',
  aspectRatios: ['16:9', '9:16', 'source'],
  notices: [
    'Image-reference maximum is not documented; the generic broker bound is not a provider guarantee. Image references are supported despite no qualified maximum. Standalone audio references/negative prompts/seed are unqualified. URI delivery and stored interaction IDs are broker-owned. Uploaded-video edit/extend varies by region.',
  ],
});
// Unknown provider maximum remains absent, rather than copying the old adapter limit of four.
defs['google/gemini-omni-1.1-flash']!.capabilities.references.types = ['image', 'video'];
defs['google/gemini-omni-1.1-flash']!.commonArguments = videoCommon.filter(
  (field) => !['negativePrompt', 'seed'].includes(field),
);
video('xai/grok-imagine-video-1.5', {
  sources: [
    'https://docs.x.ai/developers/model-capabilities/video/generation',
    'https://docs.x.ai/developers/model-capabilities/video/reference-to-video',
  ],
  resolutions: ['480p', '720p', '1080p'],
  minimum: 1,
  maximum: 15,
  referenceMaximum: { image: 14, audio: 3 },
  lastOnly: true,
  keyframes: 4,
  timed: true,
  mix: true,
  extra: ['keyframes'],
  aspectRatios: wideRatios,
  notices: [
    'Reference output is qualified only up to 720p. Timed keyframes use a one-third-second grid. Preset voice references are a typed audio role, not arbitrary generic audio conditioning.',
  ],
});
video('xai/grok-imagine-video-1.5-lite', {
  sources: ['https://docs.x.ai/developers/model-capabilities/video/generation'],
  resolutions: ['480p', '720p', '1080p'],
  minimum: 1,
  maximum: 15,
  referenceMaximum: {},
  operations: ['text-to-video', 'image-to-video'],
  aspectRatios: wideRatios,
  notices: [
    'Lite does not qualify reference voices, reference images, last-frame or keyframe modes; 1080p is upscaled.',
  ],
});
defs['xai/grok-imagine-video-1.5-lite']!.capabilities.frames.last = false;
video('xai/grok-imagine-video', {
  sources: [
    'https://docs.x.ai/developers/model-capabilities/video/editing',
    'https://docs.x.ai/developers/model-capabilities/video/generation',
  ],
  resolutions: ['480p', '720p'],
  minimum: 1,
  maximum: 15,
  referenceMaximum: { image: 7 },
  mix: true,
  operations: [...videoOps, 'video-edit', 'video-extend'],
  notices: [
    'Legacy edit/extend uses source-derived duration/dimensions; a requested override cannot be silently discarded. The latest 1.5 family is a different exact model.',
  ],
});
const openai = 'https://developers.openai.com/api/reference/resources/images/methods/generate';
for (const id of ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare'])
  image(id, {
    sources: [openai, 'https://developers.openai.com/api/reference/resources/images/methods/edit'],
    maxReferences: 16,
    countMaximum: 10,
    mask: true,
    quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    extra: ['background'],
    promptMax: 32000,
    notices: [
      'Masks, exact dimensions and format/background combinations require validation. Conditional xhigh/max quality support must be qualified for the selected route. Raw URL/base64 delivery choice remains broker-owned.',
    ],
  });
image('openai/gpt-image-2', {
  sources: [openai, 'https://developers.openai.com/api/reference/resources/images/methods/edit'],
  maxReferences: 16,
  countMaximum: 10,
  mask: true,
  quality: ['auto', 'low', 'medium', 'high'],
  extra: ['background'],
  promptMax: 32000,
  notices: [
    'Input fidelity is not a portable client control on this exact model. The 2.0 name is a catalog alias, not a different execution checkpoint.',
  ],
});
image('google/nano-banana-2.1', {
  sources: [
    'https://aistudio.google.com/docs/image-generation',
    'https://fal.ai/models/google/nano-banana-2.1/edit/api',
  ],
  maxReferences: 14,
  types: ['image', 'video', 'document'],
  countMaximum: 4,
  extra: ['thinkingLevel', 'systemPrompt', 'grounding'],
  notices: [
    'Video/PDF context is model/route-specific. Native model thinking/grounding is not a generic provider URL option. A transparent prompt is not a native background-setting guarantee.',
  ],
});
image('xai/grok-imagine-image-2.0', {
  sources: [
    'https://docs.x.ai/developers/model-capabilities/images/generation',
    'https://docs.x.ai/developers/model-capabilities/images/editing',
  ],
  resolutions: ['1K', '1.5K', '2K'],
  maxReferences: 5,
  countMaximum: 10,
  quality: ['auto', 'low', 'medium'],
  notices: [
    '1.5K and maximum count differ across schema/guide channels. Quality-model retirement is not proof that the quality argument was retired. Delivery URL versus base64 is broker-owned.',
  ],
});
image('bytedance/seedream-5.5', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-5',
    'https://fal.ai/models/bytedance/seedream/v5.5/edit/api',
  ],
  resolutions: ['1K', '1.5K', '2K'],
  maxReferences: 14,
  countMaximum: 6,
  extra: ['background', 'watermark'],
  promptMax: 4000,
  notices: [
    'Native BytePlus synchronous generation returns one image and accepts up to 14 edit references; fal v5.5 accepts up to 10 edit references and 1–6 outputs.',
  ],
});
image('bytedance/seedream-5.0-pro', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro',
    'https://fal.ai/models/bytedance/seedream/v5/pro/edit/api',
  ],
  resolutions: ['1K', '1.5K', '2K'],
  maxReferences: 10,
  extra: ['background', 'layers', 'watermark'],
  promptMax: 4000,
  notices: [
    'Layer decomposition and constrained transparent image editing are distinct modes; source/PNG requirements cannot be inferred from a background flag. Some wrappers silently retain only the last ten references; OpenGen rejects overflow.',
  ],
});
image('bytedance/seedream-5.0-flash', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-flash',
    'https://fal.ai/models/bytedance/seedream/v5/flash/edit/api',
  ],
  resolutions: ['1K', '1.5K', '2K'],
  maxReferences: 14,
  countMaximum: 6,
  extra: ['background', 'watermark'],
  promptMax: 4000,
  notices: [
    'Fast Seedream 5.0 release; native BytePlus returns one image synchronously while fal v5/flash accepts up to 10 edit references.',
  ],
});
image('bytedance/seedream-5.0-lite', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedream-5-0-lite',
    'https://fal.ai/models/bytedance/seedream/v5/lite/edit/api',
  ],
  resolutions: ['2K', '3K', '4K'],
  defaultResolution: '2K',
  maxReferences: 14,
  countMaximum: 6,
  extra: ['watermark'],
  promptMax: 4000,
  notices: [
    'Seedream 5.0 Lite operates in the high-resolution 2K–4K pixel range (3,686,400–16,777,216 pixels); 1K is not supported.',
  ],
});
image('bytedance/seedream-4.5', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedream-4-5',
    'https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit/api',
  ],
  resolutions: ['2K', '4K'],
  defaultResolution: '2K',
  maxReferences: 14,
  countMaximum: 6,
  extra: ['watermark'],
  promptMax: 4000,
  notices: [
    'Seedream 4.5 supports 2K and 4K tiers; native BytePlus returns fixed JPEG output while fal v4.5 exposes seed without watermark or format controls.',
  ],
});
image('bytedance/seedream-4.0', {
  sources: [
    'https://docs.byteplus.com/en/docs/modelark/seedream-4-0',
    'https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit/api',
  ],
  resolutions: ['1K', '2K', '4K'],
  maxReferences: 14,
  countMaximum: 6,
  extra: ['watermark'],
  promptMax: 4000,
  notices: [
    'Seedream 4.0 supports 1K, 2K and 4K tiers; native BytePlus returns fixed JPEG output while fal v4 exposes seed without watermark or format controls.',
  ],
});
for (const [id, verification] of [
  ['qwen/image-2.1', 'weights-only'],
  ['qwen/image-2.1-turbo', 'documented'],
  ['alibaba/qwen-image-2.1-pro', 'documented'],
  ['alibaba/qwen-image-3.0-pro', 'documented'],
] as const)
  image(id, {
    sources: [
      'https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference',
      'https://github.com/QwenLM/Qwen-Image-2.1',
    ],
    resolutions: id.includes('3.0') ? ['1K', '2K'] : ['1K', '2K', '4K'],
    maxReferences: id.includes('3.0') ? 3 : 10,
    extra: verification === 'weights-only' ? [] : ['promptExtend', 'thinking', 'watermark'],
    verification,
    notices: [
      'Published weights do not establish a hosted offering. Base/Turbo/hosted Pro identities differ. Prompt-guided RGBA is not a native background-control guarantee. Regional model access must be independently qualified.',
    ],
  });
image('fal/qwen-image-3', {
  sources: [
    'https://fal.ai/models/alibaba/qwen-image-3/text-to-image/api',
    'https://fal.ai/models/alibaba/qwen-image-3/edit/api',
  ],
  resolutions: ['1K', '2K'],
  maxReferences: 3,
  countMaximum: 4,
  extra: ['promptExtend'],
  notices: [
    'fal hosts this endpoint as alibaba/qwen-image-3 without disclosing the exact upstream checkpoint suffix; it remains separate from alibaba/qwen-image-3.0-pro until equivalence is confirmed.',
  ],
});

for (const id of [
  'kling/kling-4.0',
  'minimax/h3-highspeed',
  'minimax/h3-lite',
  'google/gemini-omni-1.1-flash',
  'xai/grok-imagine-video-1.5',
  'xai/grok-imagine-video-1.5-lite',
  'xai/grok-imagine-video',
])
  defs[id]!.commonArguments = defs[id]!.commonArguments.filter((field) => field !== 'seed');
for (const id of [
  'minimax/h3',
  'minimax/h3-highspeed',
  'minimax/h3-lite',
  'minimax/h3-max',
  'fal/h3-max-turbo',
  'pika/h3-flex',
])
  defs[id]!.capabilities.audio = 'always-on';
for (const [id, model] of Object.entries(defs))
  if (model.modality === 'image') {
    const qwen = id.includes('qwen');
    const gpt = id.startsWith('openai/');
    const grok = id.startsWith('xai/');
    model.commonArguments = model.commonArguments.filter((field) =>
      field === 'negativePrompt'
        ? qwen
        : field === 'quality'
          ? gpt || grok
          : field === 'seed'
            ? qwen ||
              id === 'google/nano-banana-2.1' ||
              id === 'bytedance/seedream-4.5' ||
              id === 'bytedance/seedream-4.0'
            : field === 'outputCompression'
              ? gpt
              : true,
    );
  }

export const modelDefinitions: Readonly<Record<string, ModelDefinition>> = defs;
