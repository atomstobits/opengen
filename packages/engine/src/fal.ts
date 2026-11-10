import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';
import { createHash } from 'node:crypto';
import type { GenerationArguments } from '@media-router/contracts';
import {
  isPublicHttpsAssetUrl,
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  frameUrl,
  assetReferenceUrl,
  numericDuration,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';
import { falImageInput, falImageFields, isFalImageEndpoint } from './fal-images.js';

const h3Endpoints = new Map<string, 'text-to-video' | 'image-to-video' | 'reference-to-video'>(
  ['minimax/h3-max', 'minimax/h3-max-turbo'].flatMap((prefix) =>
    (['text-to-video', 'image-to-video', 'reference-to-video'] as const).map(
      (operation) => [`${prefix}/${operation}`, operation] as const,
    ),
  ),
);
const ratios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const seedanceEndpoints = new Map<
  string,
  {
    operation: 'text-to-video' | 'image-to-video' | 'reference-to-video';
    maximumDuration: number;
    referenceLimit: number;
    resolutions: string[];
  }
>(
  [
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
);

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
    if (isFalImageEndpoint(context.route.upstreamModelId))
      return [...falImageFields(context.route.upstreamModelId)];
    const seedance = seedanceEndpoints.get(context.route.upstreamModelId);
    if (seedance)
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
        ...(!context.route.upstreamModelId.includes('/mini/') ? ['bitrateMode' as const] : []),
        ...(context.route.upstreamModelId.includes('2.5') ? ['draft' as const] : []),
        ...(context.route.upstreamModelId.includes('2.5/reference') ? ['seed' as const] : []),
      ];
    const operation = h3Endpoints.get(context.route.upstreamModelId);
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
            ...(!context.route.upstreamModelId.includes('turbo')
              ? ['firstFrame' as const, 'lastFrame' as const, 'keyframes' as const]
              : []),
          ]
        : ['targetAudio' as const]),
    ];
  }
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (context.deployment.id !== 'fal-undisclosed')
      return 'This adapter does not establish account-specific fal region access.';
    const issue = isFalImageEndpoint(context.route.upstreamModelId)
      ? null
      : adapterInputIssue(context, fields(context));
    if (issue) return issue;
    const args = context.input.input,
      operation = context.input.operation;
    if (
      !isFalImageEndpoint(context.route.upstreamModelId) &&
      args.count !== undefined &&
      args.count !== 1
    )
      return 'This fal video adapter produces one output per job.';
    const image = falImageInput(context);
    if (image) return 'error' in image ? image.error : null;
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
      return 'Video output requires MP4.';
    const seedance = seedanceEndpoints.get(context.route.upstreamModelId);
    if (seedance) {
      if (operation !== seedance.operation)
        return 'The chosen fal endpoint does not implement this operation.';
      if (!seedance.resolutions.includes((args.resolution ?? '').toLowerCase()))
        return 'Unsupported fal Seedance resolution.';
      if (
        args.duration !== 'auto' &&
        (!Number.isInteger(numericDuration(context.input)) ||
          numericDuration(context.input) < 4 ||
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
      const latest = context.route.upstreamModelId.includes('2.5');
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
    if (h3Endpoints.get(context.route.upstreamModelId) !== operation)
      return 'Unsupported fal H3 endpoint/operation.';
    if (args.prompt && args.prompt.length > 50000)
      return 'The fal H3 prompt limit is 50000 characters.';
    if (args.audio === false) return 'H3 native audio cannot be disabled through this endpoint.';
    if (!['480P', '768P', '1080P'].includes((args.resolution ?? '').toUpperCase()))
      return 'Unsupported H3 output resolution.';
    if (
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
    if (args.aspectRatio === 'source' && !args.firstFrame)
      return 'Source ratio requires a first frame.';
    if (args.aspectRatio && args.aspectRatio !== 'source' && !ratios.has(args.aspectRatio))
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
  return {
    id: 'fal',
    supportedOperations: [
      'text-to-video',
      'image-to-video',
      'reference-to-video',
      'text-to-image',
      'image-edit',
    ],
    preflight,
    inputFields: fields,
    isConfigured: (route, deployment) =>
      route.adapter === 'fal' &&
      deployment.id === 'fal-undisclosed' &&
      (h3Endpoints.has(route.upstreamModelId) ||
        seedanceEndpoints.has(route.upstreamModelId) ||
        isFalImageEndpoint(route.upstreamModelId)) &&
      Boolean(env.FAL_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const seedance = seedanceEndpoints.has(context.route.upstreamModelId);
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
      const body = await submitProviderJson(
        request,
        'fal',
        `https://queue.fal.run/${context.route.upstreamModelId}`,
        {
          ...auth(),
          'X-Fal-No-Retry': '1',
          'x-app-fal-disable-fallback': 'true',
          'X-Fal-Store-IO': '0',
        },
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
                generate_audio: args.audio ?? true,
                ...(endUserId ? { end_user_id: endUserId } : {}),
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
                        ...(context.route.upstreamModelId.includes('2.5')
                          ? { task: 'reference' }
                          : {}),
                      }
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
                  ? { aspect_ratio: args.aspectRatio ?? '16:9' }
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
              },
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
      if (options.captureOutputs)
        return captureProviderResult(
          options.captureOutputs,
          context,
          assets.map((asset) => ({
            kind: 'url' as const,
            url: String(asset.url),
            mediaType: image ? `image/${context.input.input.outputFormat ?? 'png'}` : 'video/mp4',
            refreshable: true,
          })),
        );
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: assets.map((asset) => ({
          url: String(asset.url),
          mediaType: image ? `image/${context.input.input.outputFormat ?? 'png'}` : 'video/mp4',
          fidelity: 'unverified' as const,
        })),
      };
    },
  };
}
