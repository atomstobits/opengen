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

const baseUrl = 'https://api-singapore.klingai.com';
const klingModels = new Set(['kling-4.0', 'kling-4.0-flash']);
const t2vRatios = new Set(['21:9', '16:9', '9:16', '1:1', '4:3', '3:4']);
const omniRatios = new Set([...t2vRatios, 'auto']);

function expectedEndpointPath(upstreamModelId: string, operation: Operation): string | null {
  if (!klingModels.has(upstreamModelId)) return null;
  if (operation === 'text-to-video') return `/text-to-video/${upstreamModelId}`;
  if (operation === 'image-to-video') return `/image-to-video/${upstreamModelId}`;
  if (operation === 'reference-to-video' || operation === 'video-edit')
    return `/omni-video/${upstreamModelId}`;
  return null;
}

/** Exact decimal USD string -> ceiling micro-USD without floating-point drift. */
function parseUsdMicros(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const [wholePart, fracPart = ''] = value.trim().split('.');
  const padded = fracPart.padEnd(6, '0');
  const micros = BigInt(wholePart!) * 1_000_000n + BigInt(padded.slice(0, 6));
  const hasRemainder = /[1-9]/.test(padded.slice(6));
  const rounded = hasRemainder ? micros + 1n : micros;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

function observedKlingCostMicros(task: Record<string, unknown>): number | null {
  const billing = Array.isArray(task.billing) ? task.billing.map(providerObject) : [];
  if (!billing.length) return null;
  let total = 0;
  for (const entry of billing) {
    if (entry.charge_type !== 'cash' || entry.currency !== 'USD') return null;
    const amount = parseUsdMicros(entry.amount);
    if (amount === null) return null;
    total += amount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Official Kling AI Singapore API adapter for Kling 4.0 and Kling 4.0 Flash. */
export function createKlingAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const supportedOperations: Operation[] = [
    'text-to-video',
    'image-to-video',
    'reference-to-video',
    'video-edit',
  ];
  const fields = (context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] => [
    'prompt',
    'resolution',
    'duration',
    'aspectRatio',
    'firstFrame',
    ...(context.route.upstreamModelId === 'kling-4.0' ? (['lastFrame'] as const) : []),
    'references',
    'sourceVideo',
    'audio',
    'watermark',
    'count',
    'outputFormat',
  ];

  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { deployment, route, input } = context;
    if (deployment.providerId !== 'kling' || deployment.id !== 'kling-ap-southeast-1')
      return 'Unsupported Kling AI deployment.';
    const expectedPath = expectedEndpointPath(route.upstreamModelId, input.operation);
    const upstreamPath = resolveRouteUpstreamModelId(route, input.operation);
    if (!expectedPath || upstreamPath !== expectedPath)
      return 'Unsupported Kling AI route or operation.';
    const args = input.input;
    const issue =
      adapterInputIssue(context, fields(context)) ?? referenceTypeIssue(input, ['image', 'video']);
    if (issue) return issue;
    const isFlash = route.upstreamModelId === 'kling-4.0-flash';
    const res = (args.resolution ?? '').toLowerCase();
    if (!(isFlash ? ['720p'] : ['720p', '1080p', '4k']).includes(res))
      return isFlash
        ? 'Kling 4.0 Flash supports 720p resolution only.'
        : 'Kling 4.0 supports 720p, 1080p, and 4K resolution.';
    const maxDuration = isFlash ? 20 : 30;
    const duration = numericDuration(input);
    if (!Number.isInteger(duration) || duration < 3 || duration > maxDuration)
      return `Kling duration must be an integer from 3 through ${maxDuration} seconds.`;
    if ((args.prompt ?? '').length > 26000)
      return 'Kling prompt exceeds 26,000 characters; it will not be truncated.';
    if (args.count !== undefined && args.count !== 1) return 'Kling AI produces one video per job.';
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
      return 'Kling AI produces MP4 output only.';
    if (args.audio === false)
      return 'Kling 4.0 generates native audio and does not expose an audio-off switch.';

    const imageRefs = referenceUrls(input, 'image');
    const videoRefs = referenceUrls(input, 'video');
    const frameCount = (args.firstFrame ? 1 : 0) + (args.lastFrame ? 1 : 0);
    const sourceCount = args.sourceVideo ? 1 : 0;
    if (imageRefs.length + frameCount > 10)
      return 'Kling supports at most 10 combined images across frames and references.';
    if (videoRefs.length + sourceCount > 5)
      return 'Kling supports at most 5 video inputs per request.';
    if (imageRefs.length + frameCount + videoRefs.length + sourceCount > 15)
      return 'Kling supports at most 15 combined media assets per request.';

    if (input.operation === 'text-to-video') {
      if (!(args.prompt ?? '').trim()) return 'Kling text-to-video requires a prompt.';
      if (args.firstFrame || args.lastFrame || args.references?.length || args.sourceVideo)
        return 'Text-to-video does not accept media inputs.';
      if (args.aspectRatio && !t2vRatios.has(args.aspectRatio))
        return 'Unsupported Kling text-to-video aspect ratio.';
    } else if (input.operation === 'image-to-video') {
      if (!args.firstFrame || args.references?.length || args.sourceVideo)
        return 'Kling image-to-video requires firstFrame without references or sourceVideo.';
      if (args.aspectRatio && args.aspectRatio !== 'source')
        return 'Kling image-to-video inherits frame ratio; omit aspectRatio or use source.';
    } else if (input.operation === 'reference-to-video') {
      if (!(args.prompt ?? '').trim()) return 'Kling reference-to-video requires a prompt.';
      if (!imageRefs.length && !videoRefs.length)
        return 'Kling reference-to-video requires at least one image or video reference.';
      if (args.sourceVideo) return 'Reference-to-video does not accept sourceVideo.';
      if (args.aspectRatio === 'source')
        return 'Kling omni-video cannot guarantee source aspect-ratio preservation; specify an explicit aspectRatio or use auto.';
      if (args.aspectRatio && !omniRatios.has(args.aspectRatio))
        return 'Unsupported Kling omni-video aspect ratio.';
    } else if (input.operation === 'video-edit') {
      if (!args.sourceVideo) return 'Kling video-edit requires sourceVideo.';
      if (!(args.prompt ?? '').trim()) return 'Kling video-edit requires an edit prompt.';
      if (args.aspectRatio === 'source')
        return 'Kling omni-video cannot guarantee source aspect-ratio preservation; specify an explicit aspectRatio or use auto.';
      if (args.aspectRatio && !omniRatios.has(args.aspectRatio))
        return 'Unsupported Kling omni-video aspect ratio.';
    }
    return null;
  }

  function auth() {
    if (!env.KLING_API_KEY) throw new SubmissionRejected('Configure KLING_API_KEY for Kling AI.');
    return { Authorization: `Bearer ${env.KLING_API_KEY}` };
  }

  return {
    id: 'kling',
    supportedOperations,
    inputFields: fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'kling' &&
      deployment.providerId === 'kling' &&
      deployment.id === 'kling-ap-southeast-1' &&
      klingModels.has(route.upstreamModelId) &&
      Boolean(env.KLING_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const args = input.input;
      const endpointPath = resolveRouteUpstreamModelId(route, input.operation);
      const is40 = route.upstreamModelId === 'kling-4.0';
      const resolution = (args.resolution ?? '').toLowerCase();
      const optionsPayload = {
        external_task_id: context.jobId,
        ...(args.watermark === undefined ? {} : { watermark_info: { enabled: args.watermark } }),
      };

      let payload: Record<string, unknown>;
      if (input.operation === 'text-to-video') {
        payload = {
          prompt: args.prompt,
          settings: {
            resolution,
            duration: args.duration,
            ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
            ...(is40 ? { dynamic_range: 'sdr' } : {}),
          },
          options: optionsPayload,
        };
      } else if (input.operation === 'image-to-video') {
        const first = frameUrl(input, 'first');
        const last = frameUrl(input, 'last');
        const contents: Record<string, unknown>[] = [
          ...(args.prompt ? [{ type: 'prompt', text: args.prompt }] : []),
          { type: 'first_frame', url: first, id: 'Image1' },
          ...(last ? [{ type: 'last_frame', url: last, id: 'Image2' }] : []),
        ];
        payload = {
          contents,
          settings: {
            resolution,
            duration: args.duration,
            ...(is40 ? { dynamic_range: 'sdr' } : {}),
          },
          options: optionsPayload,
        };
      } else {
        const first = frameUrl(input, 'first');
        const last = frameUrl(input, 'last');
        const baseVideo = sourceVideoUrl(input);
        const imageRefs = referenceUrls(input, 'image');
        const videoRefs = referenceUrls(input, 'video');
        let imageIndex = 0;
        let videoIndex = 0;
        const contents: Record<string, unknown>[] = [
          ...(args.prompt ? [{ type: 'prompt', text: args.prompt }] : []),
          ...(first ? [{ type: 'first_frame', url: first, id: `Image${++imageIndex}` }] : []),
          ...imageRefs.map((url) => ({
            type: 'refer_image',
            url,
            id: `Image${++imageIndex}`,
          })),
          ...(last ? [{ type: 'last_frame', url: last, id: `Image${++imageIndex}` }] : []),
          ...(baseVideo
            ? [{ type: 'base_video', url: baseVideo, id: `Video${++videoIndex}` }]
            : []),
          ...videoRefs.map((url) => ({
            type: 'feature_video',
            url,
            id: `Video${++videoIndex}`,
          })),
        ];
        const ratio = args.aspectRatio === 'auto' ? 'adaptive' : args.aspectRatio;
        payload = {
          contents,
          settings: {
            resolution,
            duration: args.duration,
            ...(ratio ? { aspect_ratio: ratio } : {}),
            ...(is40 ? { dynamic_range: 'sdr' } : {}),
          },
          options: optionsPayload,
        };
      }

      const body = await submitProviderJson(
        request,
        'Kling AI',
        `${baseUrl}${endpointPath}`,
        auth(),
        payload,
      );
      if (body.code !== 0)
        throw new SubmissionUnknown('Kling AI submission acceptance could not be confirmed.');
      const taskId = providerObject(body.data).id;
      if (typeof taskId !== 'string' || !taskId) throw new SubmissionUnknown();
      return { upstreamId: taskId };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Kling AI',
        `${baseUrl}/tasks?task_ids=${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      if (body.code !== 0 || !Array.isArray(body.data))
        throw new Error('Kling AI returned an unrecognized task query response.');
      const tasks = body.data.map(providerObject);
      const task = tasks.find((item) => item.id === context.upstreamId);
      if (!task || typeof task.status !== 'string')
        return {
          status: 'unknown',
          error: 'Kling AI cannot resolve this task; billing requires reconciliation.',
        };
      if (task.status === 'submitted' || task.status === 'processing') return { status: 'running' };
      const billedCostMicros = observedKlingCostMicros(task);
      if (task.status === 'failed')
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'Kling AI generation failed; billing requires reconciliation.',
          billedCostMicros,
        };
      if (task.status !== 'succeeded')
        throw new Error('Kling AI returned an unrecognized task status.');
      const outputs = Array.isArray(task.outputs) ? task.outputs.map(providerObject) : [];
      const video = outputs.find((item) => item.type === 'video' && typeof item.url === 'string');
      if (!video || typeof video.url !== 'string' || !isPublicHttpsAssetUrl(video.url))
        throw new Error('Kling AI has not returned a supported video output.');
      return {
        status: 'succeeded',
        billedCostMicros,
        outputs: [{ url: video.url, mediaType: 'video/mp4', fidelity: 'unverified' }],
      };
    },
  };
}
