import {
  resolveRouteUpstreamModelId,
  type GenerationArguments,
  type Operation,
} from '@media-router/contracts';
import {
  alibabaCredentials,
  adapterInputIssue,
  frameUrl,
  isPublicHttpsAssetUrl,
  numericDuration,
  referenceTypeIssue,
  referenceUrls,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';
import { createPublicPinnedFetch, type PublicResolver } from './public-network.js';

const happyHorseRegions = new Set([
  'cn-beijing',
  'ap-southeast-1',
  'ap-northeast-1',
  'eu-central-1',
  'us-east-1',
]);
const modelByOperation: Partial<Record<Operation, string>> = {
  'text-to-video': 'happyhorse-1.1-t2v',
  'image-to-video': 'happyhorse-1.1-i2v',
  'reference-to-video': 'happyhorse-1.1-r2v',
};
const happyHorseModels = new Set([
  'happyhorse-1.1',
  'happyhorse-1.1-t2v',
  'happyhorse-1.1-i2v',
  'happyhorse-1.1-r2v',
]);
const ratios = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9']);

export const isHappyHorseModel = (model: string): boolean => happyHorseModels.has(model);

/** Alibaba Cloud Model Studio HappyHorse 1.1 video adapter across the five documented regions (cn-hongkong excluded). */
export function createHappyHorseAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; resolve?: PublicResolver } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? createPublicPinnedFetch({ resolve: options.resolve });
  const supportedOperations: Operation[] = [
    'text-to-video',
    'image-to-video',
    'reference-to-video',
  ];
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'resolution',
    'duration',
    'aspectRatio',
    'firstFrame',
    'references',
    'audio',
    'seed',
    'watermark',
    'count',
  ];

  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { deployment, route, input } = context;
    if (
      deployment.providerId !== 'alibaba' ||
      !happyHorseRegions.has(deployment.endpointRegion) ||
      deployment.id !== `alibaba-model-studio-${deployment.endpointRegion}`
    ) {
      return 'HappyHorse 1.1 is documented only on Beijing, Singapore, Tokyo, Frankfurt, and Virginia Model Studio deployments.';
    }
    const expectedModel = modelByOperation[input.operation];
    const upstream = resolveRouteUpstreamModelId(route, input.operation);
    if (!expectedModel || upstream !== expectedModel)
      return 'Unsupported HappyHorse 1.1 route or operation.';
    const args = input.input;
    const issue = adapterInputIssue(context, fields) ?? referenceTypeIssue(input, ['image']);
    if (issue) return issue;
    const prompt = args.prompt ?? '';
    const hasChinese = /\p{Script=Han}/u.test(prompt);
    const promptLimit = hasChinese ? 2500 : 5000;
    if ([...prompt].length > promptLimit)
      return hasChinese
        ? 'HappyHorse 1.1 Chinese prompts cannot exceed 2,500 characters; it will not be truncated.'
        : 'HappyHorse 1.1 prompt exceeds 5,000 characters; it will not be truncated.';
    if (input.operation !== 'image-to-video' && !(args.prompt ?? '').trim())
      return 'HappyHorse 1.1 text-to-video and reference-to-video require a prompt.';
    if (!['480p', '720p', '1080p'].includes((args.resolution ?? '').toLowerCase()))
      return 'HappyHorse 1.1 supports 480p, 720p, and 1080p resolution.';
    const duration = numericDuration(input);
    if (!Number.isInteger(duration) || duration < 3 || duration > 15)
      return 'HappyHorse 1.1 duration must be an integer from 3 through 15 seconds.';
    if (
      args.seed !== undefined &&
      (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 2147483647)
    )
      return 'HappyHorse 1.1 seed must be an integer from 0 through 2147483647.';
    if (args.count !== undefined && args.count !== 1)
      return 'HappyHorse 1.1 produces one video per job.';
    if (args.audio === false)
      return 'HappyHorse 1.1 generates native audio and does not expose an audio-off toggle.';
    const references = referenceUrls(input, 'image');
    if (input.operation === 'text-to-video') {
      if (args.firstFrame || references.length)
        return 'Text-to-video does not accept image inputs.';
      if (args.aspectRatio && !ratios.has(args.aspectRatio))
        return 'Unsupported HappyHorse 1.1 aspect ratio.';
    } else if (input.operation === 'image-to-video') {
      if (!args.firstFrame || references.length)
        return 'HappyHorse 1.1 image-to-video requires firstFrame without reference images.';
      if (args.aspectRatio && args.aspectRatio !== 'source')
        return 'HappyHorse 1.1 image-to-video does not support ratio overrides; omit aspectRatio or use source.';
    } else {
      if (args.firstFrame || references.length < 1 || references.length > 9)
        return 'HappyHorse 1.1 reference-to-video requires 1–9 image references without firstFrame.';
      if (args.aspectRatio && !ratios.has(args.aspectRatio))
        return 'Unsupported HappyHorse 1.1 aspect ratio.';
    }
    return null;
  }

  function auth(context: AdapterContext) {
    const credentials = alibabaCredentials(context.deployment, env);
    if (!credentials)
      throw new SubmissionRejected(
        `Configure credentials and workspace endpoint for Alibaba ${context.deployment.endpointRegion}.`,
      );
    return {
      base: credentials.endpoint,
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
    };
  }

  return {
    id: 'alibaba',
    supportedOperations,
    inputFields: () => fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'alibaba' &&
      deployment.providerId === 'alibaba' &&
      happyHorseRegions.has(deployment.endpointRegion) &&
      deployment.id === `alibaba-model-studio-${deployment.endpointRegion}` &&
      isHappyHorseModel(route.upstreamModelId) &&
      alibabaCredentials(deployment, env) !== null,
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const credentials = auth(context);
      const { input, route } = context;
      const args = input.input;
      const upstream = resolveRouteUpstreamModelId(route, input.operation);
      const media =
        input.operation === 'image-to-video'
          ? [{ type: 'first_frame', url: frameUrl(input, 'first') }]
          : input.operation === 'reference-to-video'
            ? referenceUrls(input, 'image').map((url) => ({ type: 'reference_image', url }))
            : [];
      const body = await submitProviderJson(
        request,
        'Alibaba HappyHorse',
        `${credentials.base}/services/aigc/video-generation/video-synthesis`,
        { ...credentials.headers, 'X-DashScope-Async': 'enable' },
        {
          model: upstream,
          input: {
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(media.length ? { media } : {}),
          },
          parameters: {
            resolution: args.resolution?.toUpperCase(),
            duration: args.duration,
            ...(input.operation !== 'image-to-video' &&
            args.aspectRatio &&
            args.aspectRatio !== 'source'
              ? { ratio: args.aspectRatio }
              : {}),
            ...(args.watermark === undefined ? {} : { watermark: args.watermark }),
            ...(args.seed === undefined ? {} : { seed: args.seed }),
          },
        },
      );
      const taskId = providerObject(body.output).task_id;
      if (typeof taskId !== 'string' || !taskId) throw new SubmissionUnknown();
      return { upstreamId: taskId };
    },
    async poll(context) {
      const credentials = auth(context);
      const body = await pollProviderJson(
        request,
        'Alibaba HappyHorse',
        `${credentials.base}/tasks/${encodeURIComponent(context.upstreamId)}`,
        credentials.headers,
      );
      const output = providerObject(body.output);
      const state = output.task_status;
      if (state === 'PENDING' || state === 'RUNNING') return { status: 'running' };
      if (state === 'UNKNOWN')
        return {
          status: 'unknown',
          error: 'The provider cannot resolve this task. Keep its ID for reconciliation.',
        };
      if (state === 'FAILED')
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'Provider generation failed; billing requires reconciliation.',
          billedCostMicros: null,
        };
      if (state === 'CANCELED')
        return {
          status: 'cancelled',
          error: 'Provider cancelled the task; billing requires reconciliation.',
        };
      if (
        state !== 'SUCCEEDED' ||
        typeof output.video_url !== 'string' ||
        !isPublicHttpsAssetUrl(output.video_url)
      ) {
        throw new Error('Alibaba HappyHorse returned an unrecognized task status.');
      }
      const usage = providerObject(body.usage);
      const duration = usage.duration;
      const rate = context.route.rates.find(
        (entry) =>
          entry.resolution.toLowerCase() === (context.input.input.resolution ?? '').toLowerCase() &&
          entry.unit === 'output-second' &&
          (!entry.operation || entry.operation === context.input.operation),
      );
      const billedCostMicros =
        typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && rate
          ? Math.ceil(duration * rate.usdMicros)
          : null;
      return {
        status: 'succeeded',
        billedCostMicros,
        outputs: [
          {
            url: output.video_url,
            mediaType: 'video/mp4',
            fidelity: 'unverified',
          },
        ],
      };
    },
  };
}
