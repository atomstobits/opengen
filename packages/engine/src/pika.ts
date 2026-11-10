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
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';

const endpoints = new Map([
  ['pika/pika-h3-flex/text-to-video', 'text-to-video'],
  ['pika/pika-h3-flex/reference-to-video', 'reference-to-video'],
  ['pika/pika-h3-flex/image-to-video', 'image-to-video'],
]);
const resolutions = new Set(['480p', '768p', '1080p', '2k', '4k']);
const ratios = new Set([
  'auto',
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
  '9:21',
]);

/** H3 Flex native/upscaled video, with prompt rewriting and additional audio-stem charges disabled. */
export function createPikaAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'duration',
    'resolution',
    'aspectRatio',
    'references',
    'firstFrame',
    'lastFrame',
    'seed',
    'audio',
    'count',
    'outputFormat',
    'promptExpansion',
  ];
  function preflight({ input, route, deployment }: Omit<AdapterContext, 'jobId'>): string | null {
    if (
      deployment.providerId !== 'pika' ||
      endpoints.get(route.upstreamModelId) !== input.operation
    )
      return 'Unsupported Pika H3 Flex route or operation.';
    if (!resolutions.has((input.input.resolution ?? '').toLowerCase()))
      return 'Unsupported H3 Flex resolution.';
    if (
      !Number.isInteger(input.input.duration) ||
      numericDuration(input) < 5 ||
      numericDuration(input) > 15
    )
      return 'Pika H3 Flex requires an integer duration from 5 through 15 seconds.';
    if (
      input.input.aspectRatio &&
      input.input.aspectRatio !== 'source' &&
      !ratios.has(input.input.aspectRatio)
    )
      return 'Unsupported H3 Flex aspect ratio.';
    if (
      input.routing?.fidelity === 'native' &&
      !['480p', '768p'].includes((input.input.resolution ?? '').toLowerCase())
    )
      return 'H3 Flex resolutions above 768p use an upscaler and do not satisfy native fidelity.';
    const args = input.input,
      issue = adapterInputIssue({ input, route, deployment }, fields);
    if (issue) return issue;
    if (args.audio === false) return 'Pika H3 Flex native audio cannot be disabled.';
    if (args.count !== undefined && args.count !== 1) return 'Pika returns one video per job.';
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4') return 'Pika returns MP4.';
    if (
      args.promptExpansion !== undefined &&
      args.promptExpansion !== false &&
      args.promptExpansion !== 'disabled' &&
      args.promptExpansion !== 'none'
    )
      return 'Additional Pika rewrite billing is not implemented; choose disabled.';
    const typeIssue = referenceTypeIssue(input);
    if (typeIssue) return typeIssue;
    const references = referenceUrls(input);
    if (
      input.operation === 'text-to-video' &&
      (references.length || args.firstFrame || args.lastFrame)
    )
      return 'Text-to-video does not accept media.';
    if (
      input.operation === 'image-to-video' &&
      (!(args.firstFrame || args.lastFrame) || references.length)
    )
      return 'Pika frame generation needs firstFrame or lastFrame without references.';
    if (
      input.operation === 'reference-to-video' &&
      (references.length < 1 || references.length > 9 || args.firstFrame || args.lastFrame)
    )
      return 'This Pika reference integration requires1–9 images without strict frames.';
    if (args.aspectRatio === 'source' && !(args.firstFrame || args.lastFrame))
      return 'Source ratio requires a frame image.';
    return null;
  }
  function auth() {
    if (!env.PIKA_API_KEY) throw new SubmissionRejected('Configure PIKA_API_KEY for Pika.');
    return { 'X-API-Key': env.PIKA_API_KEY };
  }
  return {
    id: 'pika',
    supportedOperations: ['text-to-video', 'image-to-video', 'reference-to-video'],
    preflight,
    inputFields: () => fields,
    isConfigured: (route, deployment) =>
      route.adapter === 'pika' &&
      deployment.providerId === 'pika' &&
      endpoints.has(route.upstreamModelId) &&
      Boolean(env.PIKA_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const body = await submitProviderJson(
        request,
        'Pika',
        `https://api.dev.pika.art/v1/media/${route.upstreamModelId}`,
        { ...auth(), 'Idempotency-Key': context.jobId },
        {
          prompt: input.input.prompt,
          ...(input.input.seed === undefined ? {} : { seed: input.input.seed }),
          ...(input.input.firstFrame ? { image: frameUrl(input, 'first') } : {}),
          ...(input.input.lastFrame ? { last_frame_image: frameUrl(input, 'last') } : {}),
          duration: input.input.duration,
          resolution: (input.input.resolution ?? '').toLowerCase(),
          aspect_ratio:
            input.input.aspectRatio === 'source' ? 'auto' : (input.input.aspectRatio ?? '16:9'),
          rewrite: false,
          output_mode: 'video',
          ...(input.operation === 'reference-to-video'
            ? { references: referenceUrls(input).map((url) => ({ type: 'image', url })) }
            : {}),
        },
      );
      if (typeof body.id !== 'string' || !body.id) throw new SubmissionUnknown();
      return { upstreamId: body.id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Pika',
        `https://api.dev.pika.art/v1/media/jobs/${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      if (body.status === 'queued' || body.status === 'running') return { status: 'running' };
      const billing = providerObject(body.billing);
      const charge =
        billing.state === 'settled' &&
        typeof billing.charge_micro_usd === 'number' &&
        Number.isSafeInteger(billing.charge_micro_usd) &&
        billing.charge_micro_usd >= 0
          ? billing.charge_micro_usd
          : null;
      const retry = charge === null ? { retryAfterMs: 30_000 } : {};
      if (body.status === 'failed')
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'Pika generation failed. The final provider charge is tracked separately.',
          billedCostMicros: charge,
          ...retry,
        };
      const output = providerObject(body.output);
      const video = providerObject(output.video);
      if (
        body.status !== 'completed' ||
        typeof video.url !== 'string' ||
        !isPublicHttpsAssetUrl(video.url)
      )
        throw new Error('Pika has not returned a supported video asset.');
      return {
        status: 'succeeded',
        billedCostMicros: charge,
        ...retry,
        outputs: [{ url: video.url, mediaType: 'video/mp4', fidelity: 'unverified' }],
      };
    },
  };
}
