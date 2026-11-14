import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';
import { createHash } from 'node:crypto';
import type { GenerationArguments, Operation } from '@media-router/contracts';
import {
  isPublicHttpsAssetUrl,
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  frameUrl,
  sourceVideoUrl,
  assetReferenceUrl,
  numericDuration,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';
import {
  falImageDefaultFormat,
  falImageFields,
  falImageInput,
  isFalImageEndpoint,
} from './fal-images.js';

const h3Endpoints = new Map<string, 'text-to-video' | 'image-to-video' | 'reference-to-video'>(
  ['minimax/h3-max', 'minimax/h3-max-turbo', 'minimax/h3'].flatMap((prefix) =>
    (['text-to-video', 'image-to-video', 'reference-to-video'] as const).map(
      (operation) => [`${prefix}/${operation}`, operation] as const,
    ),
  ),
);
const ratios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const wanRatios = new Set(['16:9', '4:3', '1:1', '3:4', '9:16']);
const xaiVideoRatios = new Set(['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16']);
const seedanceEndpoints = new Map<
  string,
  {
    operation: 'text-to-video' | 'image-to-video' | 'reference-to-video';
    minimumDuration: number;
    maximumDuration: number;
    referenceLimit: number;
    resolutions: readonly string[];
    v1?: boolean;
    v1Fast?: boolean;
  }
>([
  ...[
    'bytedance/seedance-2.5',
    'bytedance/seedance-2.0',
    'bytedance/seedance-2.0/fast',
    'bytedance/seedance-2.0/mini',
  ].flatMap((prefix) =>
    (['text-to-video', 'image-to-video', 'reference-to-video'] as const).map(
      (operation) =>
        [
          `${prefix}/${operation}`,
          {
            operation,
            minimumDuration: 4,
            maximumDuration: prefix.includes('2.5') ? 30 : 15,
            referenceLimit: prefix.includes('2.5') ? 30 : 9,
            resolutions:
              prefix.endsWith('/fast') || prefix.endsWith('/mini')
                ? ['480p', '720p']
                : prefix.includes('2.5')
                  ? ['480p', '720p', '1080p']
                  : ['480p', '720p', '1080p', '4k'],
          },
        ] as const,
    ),
  ),
  ...['fal-ai/bytedance/seedance/v1/pro', 'fal-ai/bytedance/seedance/v1/pro/fast'].flatMap(
    (prefix) =>
      (['text-to-video', 'image-to-video'] as const).map(
        (operation) =>
          [
            `${prefix}/${operation}`,
            {
              operation,
              minimumDuration: 2,
              maximumDuration: 12,
              referenceLimit: 0,
              resolutions: ['480p', '720p', '1080p'],
              v1: true,
              v1Fast: prefix.endsWith('/fast'),
            },
          ] as const,
      ),
  ),
]);
const wanEndpoints = new Map<string, 'text-to-video' | 'image-to-video' | 'reference-to-video'>(
  ['alibaba/wan-3.0', 'alibaba/wan-3.0-prime'].flatMap((prefix) =>
    (['text-to-video', 'image-to-video', 'reference-to-video'] as const).map(
      (operation) => [`${prefix}/${operation}`, operation] as const,
    ),
  ),
);
const geminiOmniEndpoints = new Map<
  string,
  'text-to-video' | 'image-to-video' | 'reference-to-video' | 'video-edit'
>([
  ['google/gemini-omni-flash/v1.1/text-to-video', 'text-to-video'],
  ['google/gemini-omni-flash/v1.1/image-to-video', 'image-to-video'],
  ['google/gemini-omni-flash/v1.1/reference-to-video', 'reference-to-video'],
  ['google/gemini-omni-flash/v1.1/edit', 'video-edit'],
]);
const xaiVideoEndpoints = new Map<
  string,
  {
    operation:
      'text-to-video' | 'image-to-video' | 'reference-to-video' | 'video-edit' | 'video-extend';
    resolutions?: string[];
    minDuration?: number;
    maxDuration?: number;
  }
>([
  [
    'xai/grok-imagine-video/v1.5/text-to-video',
    {
      operation: 'text-to-video',
      resolutions: ['480p', '720p', '1080p'],
      minDuration: 1,
      maxDuration: 15,
    },
  ],
  [
    'xai/grok-imagine-video/v1.5/image-to-video',
    {
      operation: 'image-to-video',
      resolutions: ['480p', '720p', '1080p'],
      minDuration: 1,
      maxDuration: 15,
    },
  ],
  [
    'xai/grok-imagine-video/v1.5/reference-to-video',
    {
      operation: 'reference-to-video',
      resolutions: ['480p', '720p'],
      minDuration: 1,
      maxDuration: 10,
    },
  ],
  [
    'xai/grok-imagine-video/v1.5/lite/text-to-video',
    {
      operation: 'text-to-video',
      resolutions: ['480p', '720p', '1080p'],
      minDuration: 1,
      maxDuration: 15,
    },
  ],
  [
    'xai/grok-imagine-video/v1.5/lite/image-to-video',
    {
      operation: 'image-to-video',
      resolutions: ['480p', '720p', '1080p'],
      minDuration: 1,
      maxDuration: 15,
    },
  ],
  ['xai/grok-imagine-video/edit-video', { operation: 'video-edit', resolutions: ['480p', '720p'] }],
  [
    'xai/grok-imagine-video/extend-video',
    { operation: 'video-extend', minDuration: 2, maxDuration: 10 },
  ],
]);

/** fal's persisted queue request ID resumes safely across worker restarts. */
export function createFalAdapter(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    captureOutputs?: CaptureProviderOutputs;
  } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  function fields(context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] {
    const model = context.route.upstreamModelId;
    if (isFalImageEndpoint(model)) return [...falImageFields(model)];
    const seedance = seedanceEndpoints.get(model);
    if (seedance) {
      if (seedance.v1)
        return [
          'prompt',
          'resolution',
          'duration',
          'aspectRatio',
          'firstFrame',
          ...(seedance.v1Fast ? [] : ['lastFrame' as const]),
          'seed',
          'count',
          'outputFormat',
        ];
      return [
        'prompt',
        'resolution',
        'duration',
        'aspectRatio',
        'firstFrame',
        'lastFrame',
        'references',
        'audio',
        'codec',
        'count',
        'outputFormat',
        ...(!model.includes('/mini/') ? ['bitrateMode' as const] : []),
        ...(model.includes('2.5') ? ['draft' as const] : []),
        ...(model.includes('2.5/reference') ? ['seed' as const] : []),
      ];
    }
    if (wanEndpoints.has(model))
      return [
        'prompt',
        'resolution',
        'duration',
        'aspectRatio',
        'firstFrame',
        'lastFrame',
        'references',
        'audio',
        'seed',
        'promptExtend',
        'count',
        'outputFormat',
      ];
    const omni = geminiOmniEndpoints.get(model);
    if (omni)
      return [
        'prompt',
        'resolution',
        'aspectRatio',
        'audio',
        'count',
        'outputFormat',
        ...(omni === 'video-edit' ? ['sourceVideo' as const] : ['duration' as const]),
        ...(omni === 'image-to-video' ? ['firstFrame' as const, 'lastFrame' as const] : []),
        ...(omni === 'reference-to-video' ? ['references' as const] : []),
      ];
    const xai = xaiVideoEndpoints.get(model);
    if (xai)
      return [
        'prompt',
        'aspectRatio',
        'audio',
        'count',
        'outputFormat',
        ...(xai.resolutions ? ['resolution' as const] : []),
        ...(xai.minDuration !== undefined ? ['duration' as const] : []),
        ...(xai.operation === 'image-to-video' ? ['firstFrame' as const] : []),
        ...(xai.operation === 'reference-to-video' ? ['references' as const] : []),
        ...(xai.operation === 'video-edit' || xai.operation === 'video-extend'
          ? ['sourceVideo' as const]
          : []),
      ];
    const operation = h3Endpoints.get(model);
    const isBaseH3 = model.startsWith('minimax/h3/');
    return [
      'prompt',
      'duration',
      'resolution',
      'aspectRatio',
      'count',
      'outputFormat',
      'audio',
      'seed',
      'promptExpansion',
      ...(operation === 'image-to-video' ? ['firstFrame' as const, 'lastFrame' as const] : []),
      ...(operation === 'reference-to-video'
        ? [
            'references' as const,
            ...(isBaseH3
              ? ['targetAudio' as const]
              : !model.includes('turbo')
                ? ['firstFrame' as const, 'lastFrame' as const, 'keyframes' as const]
                : []),
          ]
        : ['targetAudio' as const]),
    ];
  }
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (context.deployment.id !== 'fal-undisclosed')
      return 'This adapter does not establish account-specific fal region access.';
    const model = context.route.upstreamModelId;
    const issue = isFalImageEndpoint(model) ? null : adapterInputIssue(context, fields(context));
    if (issue) return issue;
    const args = context.input.input,
      operation = context.input.operation;
    if (!isFalImageEndpoint(model) && args.count !== undefined && args.count !== 1)
      return 'This fal video adapter produces one output per job.';
    if (!isFalImageEndpoint(model) && context.input.previousJobId)
      return 'This fal video endpoint requires an explicit sourceVideo asset rather than previousJobId.';
    const image = falImageInput(context);
    if (image) return 'error' in image ? image.error : null;
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
      return 'Video output requires MP4.';
    const seedance = seedanceEndpoints.get(model);
    if (seedance) {
      if (operation !== seedance.operation)
        return 'The chosen fal endpoint does not implement this operation.';
      if (!seedance.resolutions.includes((args.resolution ?? '').toLowerCase()))
        return 'Unsupported fal Seedance resolution.';
      if (
        (seedance.v1 || args.duration !== 'auto') &&
        (!Number.isInteger(numericDuration(context.input)) ||
          numericDuration(context.input) < seedance.minimumDuration ||
          numericDuration(context.input) > seedance.maximumDuration)
      )
        return 'Unsupported fal Seedance duration.';
      if (
        operation === 'text-to-video' &&
        (args.firstFrame || args.lastFrame || args.references?.length)
      )
        return 'Text-to-video does not accept references.';
      if (operation === 'image-to-video' && (!args.firstFrame || args.references?.length))
        return 'Seedance frames require firstFrame and cannot mix omni references.';
      if (
        operation === 'reference-to-video' &&
        (args.firstFrame || args.lastFrame || !args.references?.length)
      )
        return 'Seedance references cannot mix first/last frames.';
      if (args.references?.some((reference) => reference.type === 'document'))
        return 'Seedance does not accept document references.';
      const latest = model.includes('2.5');
      for (const [type, limit] of [
        ['image', latest ? 30 : 9],
        ['video', latest ? 10 : 3],
        ['audio', latest ? 10 : 3],
      ] as const)
        if ((args.references ?? []).filter((ref) => ref.type === type).length > limit)
          return `Too many ${type} references.`;
      if ((args.references?.length ?? 0) > (latest ? 50 : 12))
        return 'Combined Seedance reference limit exceeded.';
      if (args.aspectRatio === 'source' && !args.firstFrame)
        return 'Source ratio requires firstFrame.';
      if (args.firstFrame && args.aspectRatio && args.aspectRatio !== 'source')
        return 'First-frame output preserves source ratio; choose source.';
      if (args.aspectRatio && !['source', 'auto', ...ratios].includes(args.aspectRatio))
        return 'Unsupported Seedance aspect ratio.';
      if (args.draft && (!latest || args.resolution?.toLowerCase() !== '480p'))
        return 'Draft generation requires Seedance 2.5 at480p.';
      return null;
    }
    const wanOp = wanEndpoints.get(model);
    if (wanOp) {
      if (operation !== wanOp)
        return 'The chosen fal Wan endpoint does not implement this operation.';
      if (!['480p', '720p', '1080p'].includes((args.resolution ?? '').toLowerCase()))
        return 'Unsupported fal Wan output resolution.';
      if (
        args.duration !== 'auto' &&
        (!Number.isInteger(numericDuration(context.input)) ||
          numericDuration(context.input) < 2 ||
          numericDuration(context.input) > 30)
      )
        return 'Fal Wan duration must be 2–30 seconds or auto.';
      if ((args.prompt ?? '').length > 20000)
        return 'Wan prompt exceeds 20,000 characters; it will not be truncated.';
      if (
        operation === 'text-to-video' &&
        (args.firstFrame || args.lastFrame || args.references?.length)
      )
        return 'Text-to-video does not accept media.';
      if (operation === 'image-to-video' && (!args.firstFrame || args.references?.length))
        return 'Wan frame generation requires firstFrame and cannot mix omni references.';
      if (
        operation === 'reference-to-video' &&
        (args.firstFrame || args.lastFrame || !args.references?.length)
      )
        return 'Wan omni generation requires references without first/last frames.';
      if (args.references?.some((ref) => ref.type === 'document'))
        return 'This fal Wan adapter does not execute document mode.';
      for (const [type, max] of [
        ['image', 10],
        ['video', 5],
        ['audio', 5],
      ] as const)
        if ((args.references ?? []).filter((ref) => ref.type === type).length > max)
          return `Wan supports at most ${max} ${type} references.`;
      if (args.aspectRatio === 'source' && !args.firstFrame)
        return 'Source ratio requires a first frame.';
      if (
        args.aspectRatio &&
        args.aspectRatio !== 'source' &&
        args.aspectRatio !== 'auto' &&
        !wanRatios.has(args.aspectRatio)
      )
        return 'Unsupported fal Wan aspect ratio.';
      return null;
    }
    const omniOp = geminiOmniEndpoints.get(model);
    if (omniOp) {
      if (operation !== omniOp)
        return 'The chosen fal Gemini Omni endpoint does not implement this operation.';
      if (args.audio === false) return 'Fal Gemini Omni Flash v1.1 audio cannot be disabled.';
      if (!['360p', '720p', '1080p', '4k'].includes((args.resolution ?? '').toLowerCase()))
        return 'Unsupported fal Gemini Omni resolution.';
      if (omniOp === 'video-edit') {
        if (!args.sourceVideo) return 'Video edit requires sourceVideo.';
        if (args.aspectRatio && args.aspectRatio !== 'source')
          return 'Fal Gemini Omni video edit preserves source aspect ratio.';
        return null;
      }
      if (
        !Number.isInteger(numericDuration(context.input)) ||
        numericDuration(context.input) < 3 ||
        numericDuration(context.input) > 10
      )
        return 'Fal Gemini Omni requires 3–10 seconds.';
      if (omniOp === 'image-to-video') {
        if (!args.firstFrame) return 'Image-to-video requires firstFrame.';
        if (args.aspectRatio && !['16:9', '9:16'].includes(args.aspectRatio))
          return 'Fal Gemini Omni supports 16:9 or 9:16 aspect ratio.';
        return null;
      }
      if (args.aspectRatio && !['16:9', '9:16'].includes(args.aspectRatio))
        return 'Fal Gemini Omni supports 16:9 or 9:16 aspect ratio.';
      if (omniOp === 'reference-to-video') {
        if (!args.references?.length) return 'Reference-to-video requires reference assets.';
        if (referenceTypeIssue(context.input, ['image', 'video']))
          return 'Fal Gemini Omni supports image and video references only.';
        if (referenceUrls(context.input, 'video').length > 3)
          return 'Fal Gemini Omni supports at most 3 reference videos.';
      }
      return null;
    }
    const xaiSpec = xaiVideoEndpoints.get(model);
    if (xaiSpec) {
      if (operation !== xaiSpec.operation)
        return 'The chosen fal Grok Imagine Video endpoint does not implement this operation.';
      if (args.audio === false)
        return 'Grok Imagine Video audio cannot be disabled through this endpoint.';
      if (
        xaiSpec.resolutions &&
        !xaiSpec.resolutions.includes((args.resolution ?? '').toLowerCase())
      )
        return 'Unsupported fal Grok Imagine Video resolution.';
      if (
        xaiSpec.minDuration !== undefined &&
        (!Number.isInteger(numericDuration(context.input)) ||
          numericDuration(context.input) < xaiSpec.minDuration ||
          numericDuration(context.input) > xaiSpec.maxDuration!)
      )
        return `Fal Grok Imagine Video requires ${xaiSpec.minDuration}–${xaiSpec.maxDuration} seconds.`;
      if (operation === 'video-edit' || operation === 'video-extend') {
        if (!args.sourceVideo) return `${operation} requires sourceVideo.`;
        if (args.aspectRatio && args.aspectRatio !== 'source')
          return 'Fal Grok Imagine Video edit/extend preserves source aspect ratio.';
        return null;
      }
      if (operation === 'image-to-video') {
        if (!args.firstFrame) return 'Image-to-video requires firstFrame.';
        if (args.aspectRatio && args.aspectRatio !== 'source')
          return 'Fal Grok Imagine Video image-to-video preserves source aspect ratio.';
        return null;
      }
      if (args.aspectRatio && !xaiVideoRatios.has(args.aspectRatio))
        return 'Unsupported fal Grok Imagine Video aspect ratio.';
      if (operation === 'reference-to-video') {
        const refs = referenceUrls(context.input, 'image');
        if (referenceTypeIssue(context.input, ['image']) || refs.length < 1 || refs.length > 7)
          return 'Fal Grok Imagine Video reference-to-video requires 1–7 image references.';
      }
      return null;
    }
    if (h3Endpoints.get(model) !== operation) return 'Unsupported fal H3 endpoint/operation.';
    const isBaseH3 = model.startsWith('minimax/h3/');
    if (args.prompt && args.prompt.length > 50000)
      return 'The fal H3 prompt limit is 50000 characters.';
    if (args.audio === false) return 'H3 native audio cannot be disabled through this endpoint.';
    const h3Resolutions = isBaseH3 ? ['480P', '768P', '2K', '4K'] : ['480P', '768P', '1080P'];
    if (!h3Resolutions.includes((args.resolution ?? '').toUpperCase()))
      return 'Unsupported H3 output resolution.';
    if (isBaseH3) {
      if (
        !Number.isInteger(numericDuration(context.input)) ||
        numericDuration(context.input) < 4 ||
        numericDuration(context.input) > 15
      )
        return 'Fal MiniMax H3 requires 4–15 integer seconds.';
    } else if (
      !Number.isFinite(numericDuration(context.input)) ||
      numericDuration(context.input) < 0.92 ||
      numericDuration(context.input) > 15
    )
      return 'Fal H3 requires0.92–15 seconds.';
    if (
      args.promptExpansion !== undefined &&
      ![false, true, 'disabled', 'none', 'balanced', 'quality'].includes(args.promptExpansion)
    )
      return 'Unsupported H3 prompt expansion mode.';
    if (operation === 'image-to-video' && (!args.firstFrame || args.references?.length))
      return 'H3 frame generation requires firstFrame without references.';
    if (operation === 'reference-to-video') {
      if (!args.references?.length) return 'H3 reference generation requires references.';
      if (referenceTypeIssue(context.input, ['image', 'video', 'audio']))
        return 'Unsupported H3 reference type.';
      if (
        referenceUrls(context.input, 'image').length > 9 ||
        referenceUrls(context.input, 'video').length > 3 ||
        referenceUrls(context.input, 'audio').length > 3
      )
        return 'H3 per-type reference limit exceeded.';
      if ((args.references?.length ?? 0) > 12)
        return 'H3 supports at most 12 combined references on fal.';
    }
    if (args.firstFrame && args.aspectRatio && args.aspectRatio !== 'source')
      return 'First-frame generation preserves source ratio.';
    if (
      args.aspectRatio === 'source' &&
      !args.firstFrame &&
      !(isBaseH3 && operation === 'reference-to-video')
    )
      return 'Source ratio requires a first frame.';
    if (
      args.aspectRatio &&
      args.aspectRatio !== 'source' &&
      !(isBaseH3 && operation === 'reference-to-video' && args.aspectRatio === 'auto') &&
      !ratios.has(args.aspectRatio)
    )
      return 'Unsupported H3 aspect ratio.';
    if (
      args.keyframes &&
      (args.keyframes.length !== 1 ||
        typeof args.keyframes[0]?.at !== 'number' ||
        args.keyframes[0].at <= 0 ||
        args.keyframes[0].at >= 15)
    )
      return 'This fal H3 endpoint supports one explicitly timed middle frame.';
    return null;
  }
  function auth() {
    if (!env.FAL_KEY) throw new SubmissionRejected('Configure FAL_KEY for the fal deployment.');
    return { Authorization: `Key ${env.FAL_KEY}` };
  }
  function base(context: AdapterContext) {
    // Queue management uses owner/app, excluding endpoint paths such as text-to-video.
    return `https://queue.fal.run/${context.route.upstreamModelId.split('/').slice(0, 2).join('/')}`;
  }
  const supportedOperations: Operation[] = [
    'text-to-video',
    'image-to-video',
    'reference-to-video',
    'video-edit',
    'video-extend',
    'text-to-image',
    'image-edit',
  ];
  return {
    id: 'fal',
    supportedOperations,
    preflight,
    inputFields: fields,
    isConfigured: (route, deployment) =>
      route.adapter === 'fal' &&
      deployment.id === 'fal-undisclosed' &&
      (h3Endpoints.has(route.upstreamModelId) ||
        seedanceEndpoints.has(route.upstreamModelId) ||
        wanEndpoints.has(route.upstreamModelId) ||
        geminiOmniEndpoints.has(route.upstreamModelId) ||
        xaiVideoEndpoints.has(route.upstreamModelId) ||
        isFalImageEndpoint(route.upstreamModelId)) &&
      Boolean(env.FAL_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const model = context.route.upstreamModelId;
      const seedance = seedanceEndpoints.get(model);
      const wanOp = wanEndpoints.get(model);
      const omniOp = geminiOmniEndpoints.get(model);
      const xaiSpec = xaiVideoEndpoints.get(model);
      const image = falImageInput(context),
        args = context.input.input,
        operation = context.input.operation;
      const endUserId = context.workspaceId
        ? createHash('sha256').update(`opengen:${context.workspaceId}`).digest('hex')
        : env.FAL_END_USER_ID;
      const expansion =
        args.promptExpansion === false || args.promptExpansion === 'none'
          ? 'disabled'
          : args.promptExpansion === true
            ? 'balanced'
            : (args.promptExpansion ?? 'disabled');
      const payload: Record<string, unknown> =
        image && 'body' in image
          ? image.body
          : seedance
            ? {
                ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
                duration: String(args.duration ?? 'auto'),
                resolution: args.resolution?.toLowerCase(),
                aspect_ratio:
                  args.aspectRatio === 'source'
                    ? 'auto'
                    : (args.aspectRatio ?? (operation === 'image-to-video' ? 'auto' : '16:9')),
                ...(seedance.v1
                  ? { enable_safety_checker: true }
                  : {
                      generate_audio: args.audio ?? true,
                      ...(endUserId ? { end_user_id: endUserId } : {}),
                    }),
                ...(args.codec === undefined ? {} : { codec: args.codec }),
                ...(args.bitrateMode === undefined ? {} : { bitrate_mode: args.bitrateMode }),
                ...(args.draft === undefined ? {} : { draft: args.draft }),
                ...(args.seed === undefined ? {} : { seed: args.seed }),
                ...(operation === 'image-to-video'
                  ? {
                      image_url: frameUrl(context.input, 'first'),
                      ...(args.lastFrame ? { end_image_url: frameUrl(context.input, 'last') } : {}),
                    }
                  : operation === 'reference-to-video'
                    ? {
                        image_urls: referenceUrls(context.input),
                        video_urls: referenceUrls(context.input, 'video'),
                        audio_urls: referenceUrls(context.input, 'audio'),
                        ...(model.includes('2.5') ? { task: 'reference' } : {}),
                      }
                    : {}),
              }
            : wanOp
              ? {
                  ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
                  resolution: args.resolution?.toLowerCase(),
                  ...(args.duration === 'auto' ? {} : { duration: args.duration }),
                  aspect_ratio:
                    args.aspectRatio === 'source' || args.aspectRatio === 'auto'
                      ? 'adaptive'
                      : (args.aspectRatio ??
                        (operation === 'image-to-video' || operation === 'reference-to-video'
                          ? 'adaptive'
                          : '16:9')),
                  audio: args.audio ?? true,
                  enable_prompt_expansion: args.promptExtend ?? false,
                  enable_thinking: false,
                  enable_safety_checker: true,
                  ...(args.seed === undefined ? {} : { seed: args.seed }),
                  ...(operation === 'image-to-video'
                    ? {
                        start_image_url: frameUrl(context.input, 'first'),
                        ...(args.lastFrame
                          ? { end_image_url: frameUrl(context.input, 'last') }
                          : {}),
                      }
                    : operation === 'reference-to-video'
                      ? {
                          reference_image_urls: referenceUrls(context.input, 'image'),
                          reference_video_urls: referenceUrls(context.input, 'video'),
                          reference_audio_urls: referenceUrls(context.input, 'audio'),
                        }
                      : {}),
                }
              : omniOp
                ? omniOp === 'video-edit'
                  ? {
                      prompt: args.prompt,
                      video_url: sourceVideoUrl(context.input),
                      resolution: args.resolution?.toLowerCase(),
                    }
                  : omniOp === 'image-to-video'
                    ? {
                        prompt: args.prompt,
                        image_url: frameUrl(context.input, 'first'),
                        ...(args.lastFrame
                          ? { end_image_url: frameUrl(context.input, 'last') }
                          : {}),
                        duration: args.duration,
                        resolution: args.resolution?.toLowerCase(),
                        ...(args.aspectRatio && args.aspectRatio !== 'source'
                          ? { aspect_ratio: args.aspectRatio }
                          : {}),
                      }
                    : omniOp === 'reference-to-video'
                      ? {
                          prompt: args.prompt,
                          image_urls: referenceUrls(context.input, 'image'),
                          reference_video_urls: referenceUrls(context.input, 'video'),
                          duration: args.duration,
                          resolution: args.resolution?.toLowerCase(),
                          aspect_ratio: args.aspectRatio ?? '16:9',
                        }
                      : {
                          prompt: args.prompt,
                          duration: args.duration,
                          resolution: args.resolution?.toLowerCase(),
                          aspect_ratio: args.aspectRatio ?? '16:9',
                        }
                : xaiSpec
                  ? operation === 'video-edit'
                    ? {
                        prompt: args.prompt,
                        video_url: sourceVideoUrl(context.input),
                        resolution: args.resolution?.toLowerCase() ?? 'auto',
                        enable_safety_checker: true,
                      }
                    : operation === 'video-extend'
                      ? {
                          prompt: args.prompt,
                          video_url: sourceVideoUrl(context.input),
                          duration: args.duration,
                          enable_safety_checker: true,
                        }
                      : {
                          prompt: args.prompt,
                          duration: args.duration,
                          resolution: args.resolution?.toLowerCase(),
                          enable_safety_checker: true,
                          ...(operation === 'image-to-video'
                            ? { image_url: frameUrl(context.input, 'first') }
                            : { aspect_ratio: args.aspectRatio ?? '16:9' }),
                          ...(operation === 'reference-to-video'
                            ? { reference_image_urls: referenceUrls(context.input, 'image') }
                            : {}),
                        }
                  : {
                      prompt: args.prompt,
                      duration: args.duration,
                      resolution: args.resolution?.toUpperCase(),
                      prompt_expansion_mode: expansion,
                      enable_safety_checker: true,
                      sync_mode: false,
                      ...(args.seed === undefined ? {} : { seed: args.seed }),
                      ...(operation !== 'image-to-video' && !args.firstFrame
                        ? {
                            aspect_ratio:
                              args.aspectRatio === 'auto' || args.aspectRatio === 'source'
                                ? 'adaptive'
                                : (args.aspectRatio ?? '16:9'),
                          }
                        : {}),
                      ...(args.firstFrame ? { image_url: frameUrl(context.input, 'first') } : {}),
                      ...(args.lastFrame ? { end_image_url: frameUrl(context.input, 'last') } : {}),
                      ...(args.targetAudio
                        ? { target_audio_url: assetReferenceUrl(args.targetAudio) }
                        : {}),
                      ...(operation === 'reference-to-video'
                        ? {
                            reference_image_urls: referenceUrls(context.input),
                            reference_video_urls: referenceUrls(context.input, 'video'),
                            reference_audio_urls: referenceUrls(context.input, 'audio'),
                          }
                        : {}),
                      ...(args.keyframes?.[0]
                        ? {
                            middle_image_url: assetReferenceUrl(args.keyframes[0].image),
                            middle_frame_time: args.keyframes[0].at,
                          }
                        : {}),
                    };
      const body = await submitProviderJson(
        request,
        'fal',
        `https://queue.fal.run/${model}`,
        {
          ...auth(),
          'X-Fal-No-Retry': '1',
          'x-app-fal-disable-fallback': 'true',
          'X-Fal-Store-IO': '0',
        },
        payload,
      );
      if (typeof body.request_id !== 'string' || !body.request_id) throw new SubmissionUnknown();
      return { upstreamId: body.request_id };
    },
    async poll(context) {
      const path = `${base(context)}/requests/${encodeURIComponent(context.upstreamId)}`;
      const status = await pollProviderJson(request, 'fal', `${path}/status`, auth());
      if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS')
        return { status: 'running' };
      if (status.status !== 'COMPLETED') throw new Error('Unrecognized fal queue status.');
      if (status.error || status.error_type)
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'fal generation failed. Billing requires provider reconciliation.',
          billedCostMicros: null,
        };
      const output = await pollProviderJson(request, 'fal', path, auth());
      const image = isFalImageEndpoint(context.route.upstreamModelId);
      if (Array.isArray(output.has_nsfw_concepts) && output.has_nsfw_concepts.some(Boolean))
        return {
          status: 'failed',
          failureCategory: 'policy',
          error: 'The provider filtered this output.',
          billedCostMicros: null,
        };
      const assets = image
        ? Array.isArray(output.images)
          ? output.images.map(providerObject)
          : []
        : [providerObject(output.video)];
      if (
        assets.length !== (image ? (context.input.input.count ?? 1) : 1) ||
        assets.some((asset) => typeof asset.url !== 'string' || !isPublicHttpsAssetUrl(asset.url))
      )
        throw new Error('Fal has not returned the requested output assets.');
      const mediaType = image
        ? `image/${falImageDefaultFormat(context.route.upstreamModelId, context.input.input.outputFormat)}`
        : 'video/mp4';
      if (options.captureOutputs)
        return captureProviderResult(
          options.captureOutputs,
          context,
          assets.map((asset) => ({
            kind: 'url' as const,
            url: String(asset.url),
            mediaType,
            refreshable: true,
          })),
        );
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: assets.map((asset) => ({
          url: String(asset.url),
          mediaType,
          fidelity: 'unverified' as const,
        })),
      };
    },
  };
}
