import type { GenerationArguments } from '@media-router/contracts';
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
} from './adapters.js';
import type { StoreProviderOutput } from './openai.js';
import { readPublicAsset } from './output.js';
import { pollProviderJson, submitProviderJson } from './provider-http.js';
import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';

const videoModel = 'bytedance/seedance-2.5';
const imageModel = 'bytedance/seedream-5-pro';
const ratios = new Set(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);

/** Exact public model schemas, never an arbitrary Replicate model/input proxy. */
export function createReplicateAdapter(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    storeOutput?: StoreProviderOutput;
    captureOutputs?: CaptureProviderOutputs;
    readAsset?: typeof readPublicAsset;
  } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const readAsset = options.readAsset ?? readPublicAsset;
  const fields = (context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] =>
    context.route.upstreamModelId === videoModel
      ? [
          'prompt',
          'resolution',
          'duration',
          'aspectRatio',
          'firstFrame',
          'lastFrame',
          'references',
          'audio',
          'outputFormat',
          'watermark',
          'seed',
          'count',
        ]
      : ['prompt', 'resolution', 'aspectRatio', 'references', 'outputFormat', 'count'];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { route, deployment, input } = context;
    if (deployment.id !== 'replicate-undisclosed') return 'Unsupported Replicate deployment.';
    const args = input.input;
    const issue =
      adapterInputIssue(context, fields(context)) ??
      referenceTypeIssue(
        input,
        route.upstreamModelId === videoModel ? ['image', 'video', 'audio'] : ['image'],
      );
    if (issue) return issue;
    const references = referenceUrls(input);
    if (args.count !== undefined && args.count !== 1)
      return 'This Replicate adapter returns one output per job.';
    if (references.some((url) => !isPublicHttpsAssetUrl(url)))
      return 'References must use public HTTPS URLs without embedded credentials.';
    if (route.upstreamModelId === videoModel) {
      if (!['text-to-video', 'image-to-video', 'reference-to-video'].includes(input.operation))
        return 'This Replicate Seedance adapter supports generation only.';
      if (!['480p', '720p'].includes((input.input.resolution ?? '').toLowerCase()))
        return 'Replicate Seedance 2.5 supports 480p and720p only.';
      if (
        args.duration !== 'auto' &&
        (!Number.isInteger(numericDuration(input)) ||
          numericDuration(input) < 4 ||
          numericDuration(input) > 30)
      )
        return 'Seedance 2.5 duration must be4–30 seconds.';
      if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
        return 'Seedance returns MP4 video.';
      if (
        input.operation === 'text-to-video' &&
        (args.references?.length || args.firstFrame || args.lastFrame)
      )
        return 'Text-to-video does not accept references.';
      if (input.operation === 'image-to-video') {
        if (!args.firstFrame || args.references?.length)
          return 'Image-to-video requires a first frame and optional last frame.';
        if (input.input.aspectRatio && input.input.aspectRatio !== 'source')
          return 'This first-frame route inherits the image ratio; omit aspectRatio or choose adaptive.';
      }
      if (
        input.operation === 'reference-to-video' &&
        (!args.references?.length || args.firstFrame || args.lastFrame)
      )
        return 'Reference-to-video supports1–30 reference images.';
      if ((args.prompt ?? '').length > 2000)
        return 'Replicate Seedance prompt exceeds 2,000 characters; it will not be truncated.';
      for (const [type, max] of [
        ['image', 30],
        ['video', 10],
        ['audio', 10],
      ] as const)
        if (referenceUrls(input, type).length > max)
          return `Replicate supports at most ${max} ${type} references.`;
      if (
        referenceUrls(input, 'audio').length &&
        !referenceUrls(input, 'image').length &&
        !referenceUrls(input, 'video').length
      )
        return 'Replicate audio references require an image or video reference.';
      if (args.aspectRatio === 'source' && !args.firstFrame)
        return 'Source ratio requires firstFrame.';
      if (
        input.input.aspectRatio &&
        input.input.aspectRatio !== 'source' &&
        !ratios.has(input.input.aspectRatio)
      )
        return 'Unsupported Seedance aspect ratio.';
    } else if (route.upstreamModelId === imageModel) {
      if (!['text-to-image', 'image-edit'].includes(input.operation))
        return 'This Replicate Seedream adapter supports text images and image edits only.';
      if (!['1K', '2K'].includes((input.input.resolution ?? '').toUpperCase()))
        return 'Standard Seedream supports1K/2K. 1.5K is reserved for layer decomposition.';
      if (args.outputFormat !== undefined && args.outputFormat !== 'png')
        return 'This Seedream adapter requests PNG output.';
      if ((input.input.prompt ?? '').length > 4000)
        return 'Replicate Seedream prompts must not exceed4,000 characters.';
      if (input.operation === 'text-to-image' && references.length)
        return 'Text-to-image does not accept reference images.';
      if (input.operation === 'image-edit' && (references.length < 1 || references.length > 10))
        return 'Seedream edits require1–10 reference images.';
      if (
        input.input.aspectRatio &&
        ![...ratios, '3:2', '2:3', 'source'].includes(input.input.aspectRatio)
      )
        return 'Unsupported Seedream aspect ratio.';
      if (input.operation === 'text-to-image' && input.input.aspectRatio === 'source')
        return 'No input image is available for aspect-ratio matching.';
    } else return 'Unsupported Replicate model.';
    return null;
  }
  function auth() {
    if (!env.REPLICATE_API_TOKEN || !(options.captureOutputs || options.storeOutput))
      throw new SubmissionRejected('Configure REPLICATE_API_TOKEN and private output storage.');
    return { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` };
  }
  return {
    id: 'replicate',
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
      route.adapter === 'replicate' &&
      deployment.id === 'replicate-undisclosed' &&
      [videoModel, imageModel].includes(route.upstreamModelId) &&
      Boolean(env.REPLICATE_API_TOKEN && (options.captureOutputs || options.storeOutput)),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const references = referenceUrls(input);
      const args = input.input;
      const video = route.upstreamModelId === videoModel;
      const body = await submitProviderJson(
        request,
        'Replicate',
        `https://api.replicate.com/v1/models/${route.upstreamModelId}/predictions`,
        auth(),
        {
          input: video
            ? {
                prompt: input.input.prompt,
                resolution: (input.input.resolution ?? '').toLowerCase(),
                duration: input.input.duration === 'auto' ? -1 : input.input.duration,
                aspect_ratio:
                  args.aspectRatio === 'source' ? 'adaptive' : (args.aspectRatio ?? '16:9'),
                generate_audio: args.audio ?? true,
                output_format: 'mp4',
                watermark: args.watermark ?? true,
                ...(args.seed === undefined ? {} : { seed: args.seed }),
                ...(input.operation === 'image-to-video'
                  ? {
                      image: frameUrl(input, 'first'),
                      ...(args.lastFrame ? { last_frame_image: frameUrl(input, 'last') } : {}),
                    }
                  : input.operation === 'reference-to-video'
                    ? {
                        reference_images: references,
                        reference_videos: referenceUrls(input, 'video'),
                        reference_audios: referenceUrls(input, 'audio'),
                      }
                    : {}),
              }
            : {
                prompt: input.input.prompt,
                size: (input.input.resolution ?? '').toUpperCase(),
                aspect_ratio:
                  args.aspectRatio === 'source' ? 'match_input_image' : (args.aspectRatio ?? '1:1'),
                output_format: 'png',
                layer_decomposition: false,
                ...(input.operation === 'image-edit' ? { image_input: references } : {}),
              },
        },
      );
      if (typeof body.id !== 'string' || !body.id) throw new SubmissionUnknown();
      return { upstreamId: body.id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Replicate',
        `https://api.replicate.com/v1/predictions/${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      if (body.status === 'starting' || body.status === 'processing') return { status: 'running' };
      if (body.status === 'failed' || body.status === 'canceled')
        return {
          status: body.status === 'canceled' ? 'cancelled' : 'failed',
          failureCategory: 'unknown',
          error:
            'Replicate ended the prediction without delivered media. Billing requires reconciliation.',
          billedCostMicros: null,
        };
      const video = context.route.upstreamModelId === videoModel;
      const url = video
        ? body.output
        : Array.isArray(body.output) && body.output.length === 1
          ? body.output[0]
          : undefined;
      if (body.status !== 'succeeded' || typeof url !== 'string' || !isPublicHttpsAssetUrl(url))
        throw new Error('Replicate has not returned the expected single media output.');
      const target = new URL(url);
      if (
        !(
          target.hostname === 'replicate.delivery' ||
          target.hostname.endsWith('.replicate.delivery')
        ) ||
        (target.port && target.port !== '443')
      )
        throw new Error('Unrecognized Replicate output host. Credentials were not sent.');
      const mediaType = video ? 'video/mp4' : 'image/png';
      // Persist this private host-checked descriptor before authenticated download. Recovery
      // uses the same prediction ID and attempt credential identity, never another submission.
      if (options.captureOutputs)
        return captureProviderResult(options.captureOutputs, context, [
          { kind: 'url', url, mediaType, refreshable: true },
        ]);
      const asset = await readAsset(url, {
        headers: auth(),
        credentialHosts: ['.replicate.delivery'],
        maxBytes: 100 * 1024 * 1024,
      });
      if (asset.mediaType !== mediaType)
        throw new Error('Replicate output did not match the requested media type.');
      const stored = await options.storeOutput!({
        jobId: context.jobId,
        bytes: asset.bytes,
        mediaType,
      });
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [{ ...stored, mediaType, fidelity: 'unverified' }],
      };
    },
  };
}
