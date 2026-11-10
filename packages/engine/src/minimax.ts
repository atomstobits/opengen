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

const models = new Set(['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']);
const ratios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

export function createMiniMaxAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields = (context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] => [
    'prompt',
    'duration',
    'resolution',
    'aspectRatio',
    'firstFrame',
    'lastFrame',
    'references',
    'audio',
    'count',
    'outputFormat',
    ...(context.route.upstreamModelId === 'MiniMax-H3-Max' ? ['promptExpansion' as const] : []),
  ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { input, route, deployment } = context;
    if (deployment.providerId !== 'minimax' || !models.has(route.upstreamModelId))
      return 'Unsupported MiniMax H3 model or deployment.';
    if (!['text-to-video', 'image-to-video', 'reference-to-video'].includes(input.operation))
      return 'This adapter supports H3 generation; edit and extension operations are not implemented.';
    const base = route.upstreamModelId === 'MiniMax-H3';
    if (
      !(base ? ['768P', '2K'] : ['480P', '768P']).includes(
        (input.input.resolution ?? '').toUpperCase(),
      )
    )
      return 'The selected H3 variant does not support this resolution.';
    const minimum = route.upstreamModelId === 'MiniMax-H3-Max' ? 5 : 4;
    if (
      !Number.isInteger(input.input.duration) ||
      numericDuration(input) < minimum ||
      numericDuration(input) > 15
    )
      return `The selected H3 variant requires ${minimum}–15 seconds.`;
    const args = input.input;
    if (args.prompt && args.prompt.length > 7000)
      return 'The native MiniMax prompt limit is 7000 characters.';
    const issue = adapterInputIssue(context, fields(context));
    if (issue) return issue;
    if (args.count !== undefined && args.count !== 1) return 'H3 returns one video per job.';
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4') return 'H3 returns MP4.';
    if (args.audio === false) return 'This H3 endpoint has no native-audio off control.';
    if (
      input.operation === 'text-to-video' &&
      (args.firstFrame || args.lastFrame || args.references?.length)
    )
      return 'Text-to-video does not accept references.';
    if (input.operation === 'image-to-video' && (!args.firstFrame || args.references?.length))
      return 'H3 strict frames require firstFrame without mixed references.';
    if (
      input.operation === 'reference-to-video' &&
      (args.firstFrame || args.lastFrame || !args.references?.length)
    )
      return 'H3 omni references cannot mix first/last frames.';
    if (referenceTypeIssue(input, ['image', 'video', 'audio']))
      return 'Unsupported H3 reference type.';
    for (const [type, limit] of [
      ['image', 9],
      ['video', 3],
      ['audio', 3],
    ] as const)
      if (referenceUrls(input, type).length > limit)
        return `H3 supports at most${limit} ${type} references.`;
    if (args.firstFrame && args.aspectRatio && args.aspectRatio !== 'source')
      return 'H3 frames inherit source ratio.';
    if (args.aspectRatio === 'source' && !args.firstFrame)
      return 'Source ratio requires a first frame.';
    if (args.aspectRatio && args.aspectRatio !== 'source' && !ratios.has(args.aspectRatio))
      return 'Unsupported H3 aspect ratio.';
    return null;
  }
  function auth() {
    if (!env.MINIMAX_API_KEY)
      throw new SubmissionRejected('Configure MINIMAX_API_KEY for MiniMax.');
    return { Authorization: `Bearer ${env.MINIMAX_API_KEY}` };
  }
  return {
    id: 'minimax',
    supportedOperations: ['text-to-video', 'image-to-video', 'reference-to-video'],
    preflight,
    inputFields: fields,
    isConfigured: (route, deployment) =>
      route.adapter === 'minimax' &&
      deployment.providerId === 'minimax' &&
      models.has(route.upstreamModelId) &&
      Boolean(env.MINIMAX_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input, route } = context;
      const body = await submitProviderJson(
        request,
        'MiniMax',
        'https://api.minimax.io/v2/video_generation',
        auth(),
        {
          model: route.upstreamModelId,
          content: [
            ...(input.input.prompt === undefined
              ? []
              : [{ type: 'text', text: input.input.prompt }]),
            ...(input.input.firstFrame
              ? [
                  {
                    type: 'image_url',
                    image_url: { url: frameUrl(input, 'first') },
                    role: 'first_frame',
                  },
                ]
              : []),
            ...(input.input.lastFrame
              ? [
                  {
                    type: 'image_url',
                    image_url: { url: frameUrl(input, 'last') },
                    role: 'last_frame',
                  },
                ]
              : []),
            ...(input.input.references ?? []).map((reference) => ({
              type: `${reference.type}_url`,
              [`${reference.type}_url`]: { url: assetReferenceUrl(reference.asset) },
              role: `reference_${reference.type}`,
            })),
          ],
          duration: input.input.duration,
          resolution: input.input.resolution?.toUpperCase(),
          ratio:
            input.input.aspectRatio === 'source' ? 'adaptive' : (input.input.aspectRatio ?? '16:9'),
          ...(route.upstreamModelId === 'MiniMax-H3-Max'
            ? {
                extra: {
                  prompt_expansion_mode:
                    input.input.promptExpansion === true
                      ? 'balanced'
                      : input.input.promptExpansion === false ||
                          input.input.promptExpansion === 'none'
                        ? 'disabled'
                        : (input.input.promptExpansion ?? 'disabled'),
                },
              }
            : {}),
        },
      );
      if (typeof body.task_id !== 'string' || !body.task_id) throw new SubmissionUnknown();
      return { upstreamId: body.task_id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'MiniMax',
        `https://api.minimax.io/v2/query/video_generation/${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      const task = providerObject(body.task);
      if (task.status === 'queued' || task.status === 'running') return { status: 'running' };
      if (task.status === 'failed' || task.status === 'cancelled')
        return {
          status: task.status,
          failureCategory: 'unknown',
          error:
            'MiniMax ended this task without a delivered video. Billing requires reconciliation.',
          billedCostMicros: null,
        };
      const video = providerObject(task.content);
      if (
        task.status !== 'succeeded' ||
        typeof video.url !== 'string' ||
        !isPublicHttpsAssetUrl(video.url)
      )
        throw new Error('MiniMax has not returned a supported video asset.');
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [{ url: video.url, mediaType: 'video/mp4', fidelity: 'unverified' }],
      };
    },
  };
}
