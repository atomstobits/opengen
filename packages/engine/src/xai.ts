import type { GenerationArguments, Operation } from '@media-router/contracts';
import {
  isPublicHttpsAssetUrl,
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  frameUrl,
  numericDuration,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
  type ProviderResult,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';

const imageModel = 'grok-imagine-image-2.0';
const videoModels = new Set(['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite']);
const videoRatios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']);
const imageRatios = new Set([
  ...videoRatios,
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
  'auto',
]);
const isImage = (operation: Operation) =>
  operation === 'text-to-image' || operation === 'image-edit';

/** Provider-reported charge: 10^10 ticks/USD, so 10^4 ticks/micro-USD. */
function observedCostMicros(body: Record<string, unknown>): number | null {
  const ticks = providerObject(body.usage).cost_in_usd_ticks;
  if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 0) return null;
  // Keep integer precision and conservatively round any sub-micro charge upward.
  return Number((BigInt(ticks) + 9_999n) / 10_000n);
}

/** Image and video jobs both use the provider's documented asynchronous request IDs. */
export function createXaiAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields = (context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] =>
    isImage(context.input.operation)
      ? ['prompt', 'resolution', 'aspectRatio', 'references', 'quality', 'count']
      : [
          'prompt',
          'resolution',
          'duration',
          'aspectRatio',
          'references',
          'firstFrame',
          'audio',
          'count',
          'outputFormat',
        ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { input, route, deployment } = context;
    if (deployment.providerId !== 'xai') return 'Unsupported xAI deployment.';
    const args = input.input;
    const issue = adapterInputIssue(context, fields(context)) ?? referenceTypeIssue(input);
    if (issue) return issue;
    if (args.count !== undefined && args.count !== 1)
      return 'This xAI adapter returns one output per job.';
    const references = referenceUrls(input);
    if (references.some((url) => !isPublicHttpsAssetUrl(url)))
      return 'xAI reference assets must use public HTTPS URLs without embedded credentials.';
    if (isImage(input.operation)) {
      if (route.upstreamModelId !== imageModel) return 'Unsupported xAI image model.';
      if (!['1K', '2K'].includes((input.input.resolution ?? '').toUpperCase()))
        return 'xAI images support 1K and 2K resolution. No 1.5K substitution is made.';
      if (args.quality !== undefined && !['auto', 'low', 'medium'].includes(args.quality))
        return 'Unsupported xAI image quality.';
      if (
        input.input.aspectRatio &&
        input.input.aspectRatio !== 'source' &&
        !imageRatios.has(input.input.aspectRatio)
      )
        return 'Unsupported xAI image aspect ratio.';
      if (
        input.operation === 'text-to-image' &&
        (references.length || args.aspectRatio === 'source')
      )
        return 'Text-to-image does not accept reference images.';
      if (input.operation === 'image-edit' && references.length !== 1)
        return 'This xAI image-edit adapter requires exactly one reference image.';
      return null;
    }
    if (!videoModels.has(route.upstreamModelId))
      return 'This adapter supports Grok Imagine Video 1.5 and 1.5 Lite generation only.';
    if (!['text-to-video', 'image-to-video', 'reference-to-video'].includes(input.operation))
      return 'Video editing/extension requires source-derived sizing and is not executed by this adapter.';
    if (!['480p', '720p', '1080p'].includes((input.input.resolution ?? '').toLowerCase()))
      return 'Unsupported xAI video resolution.';
    if (
      !Number.isInteger(numericDuration(input)) ||
      numericDuration(input) < 1 ||
      numericDuration(input) > 15
    )
      return 'xAI video duration must be an integer from 1 through 15 seconds.';
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
      return 'xAI video output is MP4.';
    if (
      input.input.aspectRatio &&
      input.input.aspectRatio !== 'source' &&
      !videoRatios.has(input.input.aspectRatio)
    )
      return 'Unsupported xAI video aspect ratio.';
    if (input.operation !== 'image-to-video' && args.firstFrame)
      return 'firstFrame belongs to image-to-video.';
    if (input.operation !== 'image-to-video' && args.aspectRatio === 'source')
      return 'Source ratio requires a first frame.';
    if (input.operation === 'text-to-video' && references.length)
      return 'Text-to-video does not accept reference images.';
    if (input.operation === 'image-to-video') {
      if (!args.firstFrame || references.length)
        return 'Image-to-video requires exactly one first-frame image.';
      if (input.input.aspectRatio && input.input.aspectRatio !== 'source')
        return 'xAI image-to-video inherits the reference aspect ratio; omit aspectRatio rather than silently ignoring it.';
    }
    if (input.operation === 'reference-to-video') {
      if (route.upstreamModelId !== 'grok-imagine-video-1.5')
        return 'Reference-to-video requires Grok Imagine Video 1.5.';
      if (references.length < 1 || references.length > 14)
        return 'Reference-to-video requires 1–14 reference images.';
      if ((input.input.resolution ?? '').toLowerCase() === '1080p')
        return 'xAI reference-to-video supports up to 720p; no resolution downgrade is made.';
    }
    return null;
  }
  function auth() {
    if (!env.XAI_API_KEY) throw new SubmissionRejected('Configure XAI_API_KEY for xAI.');
    return { Authorization: `Bearer ${env.XAI_API_KEY}` };
  }
  return {
    id: 'xai',
    supportedOperations: [
      'text-to-image',
      'image-edit',
      'text-to-video',
      'image-to-video',
      'reference-to-video',
    ],
    inputFields: fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'xai' &&
      deployment.providerId === 'xai' &&
      (route.upstreamModelId === imageModel || videoModels.has(route.upstreamModelId)) &&
      Boolean(env.XAI_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const references = referenceUrls(input);
      const args = input.input;
      const image = isImage(input.operation);
      const endpoint = image
        ? input.operation === 'image-edit'
          ? 'images/edits'
          : 'images/generations'
        : 'videos/generations';
      const body = await submitProviderJson(
        request,
        'xAI',
        `https://api.x.ai/v1/${endpoint}`,
        auth(),
        {
          model: route.upstreamModelId,
          prompt: input.input.prompt,
          resolution: (input.input.resolution ?? '').toLowerCase(),
          ...(args.aspectRatio && args.aspectRatio !== 'source'
            ? { aspect_ratio: args.aspectRatio }
            : input.operation === 'image-edit' && args.aspectRatio === 'source'
              ? { aspect_ratio: 'auto' }
              : {}),
          ...(image
            ? {
                n: 1,
                deferred: true,
                response_format: 'url',
                // Pin documented current defaults rather than change billing with provider auto changes.
                quality: args.quality ?? (input.operation === 'image-edit' ? 'medium' : 'low'),
              }
            : { duration: input.input.duration, generate_audio: args.audio ?? true }),
          ...(input.operation === 'image-edit'
            ? { image: { url: references[0], type: 'image_url' } }
            : input.operation === 'image-to-video'
              ? { image: { url: frameUrl(input, 'first') } }
              : input.operation === 'reference-to-video'
                ? { reference_images: references.map((url) => ({ url })) }
                : {}),
        },
      );
      if (typeof body.request_id !== 'string' || !body.request_id) throw new SubmissionUnknown();
      return { upstreamId: body.request_id };
    },
    async poll(context) {
      const image = isImage(context.input.operation);
      const body = await pollProviderJson(
        request,
        'xAI',
        `https://api.x.ai/v1/${image ? 'images' : 'videos'}/${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      if (body.status === 'pending') return { status: 'running' };
      if (body.status === 'expired')
        return {
          status: 'unknown',
          error: 'xAI request expired; billing requires reconciliation.',
        };
      if (body.status === 'failed')
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'xAI generation failed.',
          billedCostMicros: observedCostMicros(body),
        };
      if (body.status !== 'done') throw new Error('Unrecognized xAI generation status.');
      const asset = image
        ? Array.isArray(body.data) && body.data.length === 1
          ? providerObject(body.data[0])
          : {}
        : providerObject(body.video);
      if (asset.respect_moderation === false || body.respect_moderation === false)
        return {
          status: 'failed',
          failureCategory: 'policy',
          error: 'The provider withheld this output following moderation.',
          billedCostMicros: observedCostMicros(body),
        };
      if (typeof asset.url !== 'string' || !isPublicHttpsAssetUrl(asset.url))
        throw new Error('xAI has not returned a supported output asset.');
      const result: ProviderResult = {
        status: 'succeeded',
        billedCostMicros: observedCostMicros(body),
        outputs: [
          {
            url: asset.url,
            mediaType: image
              ? ['image/png', 'image/jpeg', 'image/webp'].includes(String(asset.mime_type))
                ? String(asset.mime_type)
                : 'image/jpeg'
              : 'video/mp4',
            fidelity: 'unverified',
          },
        ],
      };
      return result;
    },
  };
}
