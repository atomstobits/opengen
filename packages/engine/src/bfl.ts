import {
  resolveRouteUpstreamModelId,
  type GenerationArguments,
  type Operation,
} from '@media-router/contracts';
import {
  adapterInputIssue,
  frameUrl,
  isPublicHttpsAssetUrl,
  numericDuration,
  referenceTypeIssue,
  referenceUrls,
  sourceVideoUrl,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';

const bflSubmitBase = 'https://api.bfl.ai/v1';
const bflPollHostPattern = /^api(?:\.[a-z0-9-]+)?\.bfl\.ai$/i;
const bflModels = new Set(['flux-3-image', 'flux-3-image-klein', 'flux-3-video']);
const imageResolutions = new Set(['768sq', '1k', '1.5k', '2k', '4k']);
const imageRatios = new Set([
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
  '9:21',
]);
const videoResolutionMap: Record<string, string> = {
  '720p': 'hd',
  '1080p': 'fhd',
  '1440p': 'qhd',
  '2160p': 'uhd',
};
const videoRatios = new Set(['auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16', '9:21']);
const videoModeByOperation: Partial<Record<Operation, 't2v' | 'i2v' | 'v2v'>> = {
  'text-to-video': 't2v',
  'image-to-video': 'i2v',
  'video-extend': 'v2v',
};

const isImageOperation = (operation: Operation) =>
  operation === 'text-to-image' || operation === 'image-edit';

/** Validate BFL's regional polling_url against a strict *.bfl.ai allowlist so polling never becomes an SSRF vector. */
function encodeBflUpstreamId(rawId: unknown, rawPollingUrl: unknown): string | null {
  if (typeof rawId !== 'string' || !rawId || rawId.includes('/') || /\s/.test(rawId)) return null;
  if (rawPollingUrl === undefined || rawPollingUrl === null) return `api.bfl.ai/${rawId}`;
  if (typeof rawPollingUrl !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(rawPollingUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    !bflPollHostPattern.test(host) ||
    parsed.pathname !== '/v1/get_result' ||
    parsed.searchParams.get('id') !== rawId
  )
    return null;
  return `${host}/${rawId}`;
}

function buildBflPollUrl(upstreamId: string): string {
  const slash = upstreamId.indexOf('/');
  const host = slash > 0 ? upstreamId.slice(0, slash).toLowerCase() : 'api.bfl.ai';
  const taskId = slash > 0 ? upstreamId.slice(slash + 1) : upstreamId;
  if (!bflPollHostPattern.test(host) || !taskId || taskId.includes('/'))
    throw new Error('Invalid BFL task reference.');
  return `https://${host}/v1/get_result?id=${encodeURIComponent(taskId)}`;
}

/** BFL settled credits -> micro-USD (1 credit = $0.01 = 10,000 micro-USD). */
function observedBflCostMicros(body: Record<string, unknown>): number | null {
  const credits = body.cost;
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) return null;
  const micros = Math.ceil(credits * 10_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

/** Official Black Forest Labs FLUX 3 adapter (flux-3-image, flux-3-image-klein, flux-3-video). */
export function createBflAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const supportedOperations: Operation[] = [
    'text-to-image',
    'image-edit',
    'text-to-video',
    'image-to-video',
    'video-extend',
  ];
  const fields = (context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] => {
    const upstream = resolveRouteUpstreamModelId(context.route, context.input.operation);
    if (upstream === 'flux-3-image')
      return ['prompt', 'resolution', 'size', 'aspectRatio', 'references', 'count', 'grounding'];
    if (upstream === 'flux-3-image-klein')
      return [
        'prompt',
        'resolution',
        'size',
        'aspectRatio',
        'references',
        'count',
        'seed',
        'outputFormat',
      ];
    return [
      'prompt',
      'resolution',
      'duration',
      'aspectRatio',
      'firstFrame',
      'sourceVideo',
      'audio',
      'draft',
      'count',
      'outputFormat',
    ];
  };

  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { deployment, route, input } = context;
    if (deployment.providerId !== 'bfl' || deployment.id !== 'bfl-undisclosed')
      return 'Unsupported Black Forest Labs deployment.';
    const upstream = resolveRouteUpstreamModelId(route, input.operation);
    if (input.operation === 'video-edit')
      return 'BFL video-edit is not implemented by this adapter.';
    if (!bflModels.has(upstream)) return 'Unsupported Black Forest Labs model.';
    const args = input.input;
    const issue =
      adapterInputIssue(context, fields(context)) ?? referenceTypeIssue(input, ['image']);
    if (issue) return issue;
    if (!(args.prompt ?? '').trim()) return 'Black Forest Labs requires a prompt.';
    if (args.count !== undefined && args.count !== 1)
      return 'This Black Forest Labs adapter produces one output per job.';

    if (isImageOperation(input.operation)) {
      if (upstream !== 'flux-3-image' && upstream !== 'flux-3-image-klein')
        return 'Selected Black Forest Labs model does not support image operations.';
      const refs = referenceUrls(input, 'image');
      if (input.operation === 'text-to-image' && refs.length)
        return 'Text-to-image does not accept reference images.';
      if (input.operation === 'image-edit' && (refs.length < 1 || refs.length > 10))
        return 'FLUX 3 image editing requires 1–10 reference images.';
      if (args.size) {
        const minEdge = upstream === 'flux-3-image-klein' ? 64 : 256;
        const maxPixels = upstream === 'flux-3-image' && refs.length > 0 ? 4_194_304 : 16_822_272;
        const { width, height } = args.size;
        if (
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < minEdge ||
          height < minEdge ||
          width > 6256 ||
          height > 6256 ||
          width * height > maxPixels
        )
          return 'Unsupported Black Forest Labs custom image dimensions.';
      } else {
        if (!imageResolutions.has((args.resolution ?? '').toLowerCase()))
          return 'Unsupported Black Forest Labs image resolution.';
        if (args.aspectRatio === 'source')
          return 'Black Forest Labs cannot guarantee source aspect-ratio preservation; specify an explicit aspectRatio or use auto.';
        if (args.aspectRatio && !imageRatios.has(args.aspectRatio))
          return 'Unsupported Black Forest Labs image aspect ratio.';
      }
      if (upstream === 'flux-3-image-klein') {
        if (
          args.seed !== undefined &&
          (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 4294967295)
        )
          return 'FLUX 3 Klein seed must be an integer from 0 through 4294967295.';
        if (args.outputFormat !== undefined && !['jpeg', 'png'].includes(args.outputFormat))
          return 'FLUX 3 Klein outputFormat must be jpeg or png.';
      }
      return null;
    }

    if (upstream !== 'flux-3-video')
      return 'Selected Black Forest Labs model does not support video operations.';
    const mode = videoModeByOperation[input.operation];
    if (!mode) return 'Unsupported FLUX 3 Video operation.';
    const mappedRes = videoResolutionMap[(args.resolution ?? '').toLowerCase()];
    if (!mappedRes) return 'FLUX 3 Video supports 720p, 1080p, 1440p, and 2160p resolution.';
    if (args.draft === true && mappedRes !== 'hd')
      return 'FLUX 3 Video draft mode supports 720p (hd) only.';
    const maxDuration = mode === 'v2v' ? 15 : 20;
    if (
      args.duration !== 'auto' &&
      (!Number.isInteger(numericDuration(input)) ||
        numericDuration(input) < 5 ||
        numericDuration(input) > maxDuration)
    )
      return `FLUX 3 Video duration must be 5–${maxDuration} seconds or auto.`;
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
      return 'FLUX 3 Video produces MP4 output only.';
    if (args.aspectRatio === 'source')
      return 'Black Forest Labs FLUX 3 Video cannot guarantee source aspect-ratio preservation; specify an explicit aspectRatio or use auto.';
    if (args.aspectRatio && !videoRatios.has(args.aspectRatio))
      return 'Unsupported FLUX 3 Video aspect ratio.';
    if (mode === 't2v' && (args.firstFrame || args.sourceVideo))
      return 'Text-to-video does not accept media inputs.';
    if (mode === 'i2v' && (!args.firstFrame || args.sourceVideo))
      return 'FLUX 3 image-to-video requires firstFrame without sourceVideo.';
    if (mode === 'v2v' && (!args.sourceVideo || args.firstFrame))
      return 'FLUX 3 video-extend requires sourceVideo without firstFrame.';
    return null;
  }

  function auth() {
    if (!env.BFL_API_KEY)
      throw new SubmissionRejected('Configure BFL_API_KEY for Black Forest Labs.');
    return { 'x-key': env.BFL_API_KEY };
  }

  return {
    id: 'bfl',
    supportedOperations,
    inputFields: fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'bfl' &&
      deployment.providerId === 'bfl' &&
      deployment.id === 'bfl-undisclosed' &&
      bflModels.has(route.upstreamModelId) &&
      Boolean(env.BFL_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const args = input.input;
      const upstream = resolveRouteUpstreamModelId(route, input.operation);

      let payload: Record<string, unknown>;
      if (upstream === 'flux-3-image') {
        const refs = referenceUrls(input, 'image');
        payload = {
          prompt: args.prompt,
          ...(args.size
            ? { width: args.size.width, height: args.size.height }
            : {
                resolution: (args.resolution ?? '1k').toLowerCase(),
                ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
              }),
          ...(refs.length ? { images: refs } : {}),
          ...(args.grounding === undefined ? {} : { grounding: args.grounding }),
          version: 'latest',
        };
      } else if (upstream === 'flux-3-image-klein') {
        const refs = referenceUrls(input, 'image');
        payload = {
          prompt: args.prompt,
          ...(args.size
            ? { width: args.size.width, height: args.size.height }
            : {
                resolution: (args.resolution ?? '1k').toLowerCase(),
                ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
              }),
          ...(refs.length ? { images: refs } : {}),
          ...(args.seed === undefined ? {} : { seed: args.seed }),
          ...(args.outputFormat === undefined ? {} : { output_format: args.outputFormat }),
        };
      } else {
        const mode = videoModeByOperation[input.operation]!;
        payload = {
          mode,
          prompt: args.prompt,
          resolution: videoResolutionMap[(args.resolution ?? '').toLowerCase()],
          duration: args.duration,
          ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
          generate_audio: args.audio ?? true,
          ...(args.draft === undefined ? {} : { draft: args.draft }),
          ...(mode === 'i2v' ? { keyframes: [frameUrl(input, 'first')] } : {}),
          ...(mode === 'v2v' ? { start_video: sourceVideoUrl(input) } : {}),
          version: 'latest',
        };
      }

      const body = await submitProviderJson(
        request,
        'Black Forest Labs',
        `${bflSubmitBase}/${upstream}`,
        auth(),
        payload,
      );
      const upstreamId = encodeBflUpstreamId(body.id, body.polling_url);
      if (!upstreamId) throw new SubmissionUnknown();
      return { upstreamId };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Black Forest Labs',
        buildBflPollUrl(context.upstreamId),
        auth(),
      );
      const status = body.status;
      if (status === 'Pending' || status === 'Reasoning' || status === 'Generating')
        return { status: 'running' };
      if (status === 'Task not found')
        return {
          status: 'unknown',
          error: 'Black Forest Labs cannot resolve this task; billing requires reconciliation.',
        };
      const billedCostMicros = observedBflCostMicros(body);
      if (status === 'Request Moderated' || status === 'Content Moderated')
        return {
          status: 'failed',
          failureCategory: 'policy',
          error: 'Black Forest Labs moderated this request.',
          billedCostMicros,
        };
      if (status === 'Error' || status === 'No Card Generated')
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'Black Forest Labs generation failed; billing requires reconciliation.',
          billedCostMicros,
        };
      if (status !== 'Ready')
        throw new Error('Black Forest Labs returned an unrecognized task status.');
      const sample = providerObject(body.result).sample;
      if (typeof sample !== 'string' || !isPublicHttpsAssetUrl(sample))
        throw new Error('Black Forest Labs has not returned a supported output asset.');
      const image = isImageOperation(context.input.operation);
      const pathname = new URL(sample).pathname.toLowerCase();
      const mediaType = image
        ? context.input.input.outputFormat === 'png' || pathname.endsWith('.png')
          ? 'image/png'
          : 'image/jpeg'
        : 'video/mp4';
      return {
        status: 'succeeded',
        billedCostMicros,
        outputs: [{ url: sample, mediaType, fidelity: 'unverified' }],
      };
    },
  };
}
