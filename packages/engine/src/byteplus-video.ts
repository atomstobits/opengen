import { createHash } from 'node:crypto';
import type { GenerationArguments } from '@media-router/contracts';
import {
  isPublicHttpsAssetUrl,
  adapterInputIssue,
  assetReferenceUrl,
  frameUrl,
  referenceUrls,
  numericDuration,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';

const models = new Set([
  'dreamina-seedance-2-5-260628',
  'dreamina-seedance-2-0-260128',
  'dreamina-seedance-2-0-fast-260128',
  'dreamina-seedance-2-0-mini-260615',
  'seedance-1-0-pro-250528',
  'seedance-1-0-pro-fast-251015',
]);
const ratios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']);
export const isBytePlusVideoModel = (model: string) => models.has(model);

function settledVideoCost(context: AdapterContext, body: Record<string, unknown>): number | null {
  if (context.deployment.id !== 'byteplus-modelark-ap-southeast-1' || context.input.input.draft)
    return null;
  const usage = providerObject(body.usage);
  const tokens = usage.completion_tokens;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0) return null;
  const resolution = (
    typeof body.resolution === 'string' ? body.resolution : (context.input.input.resolution ?? '')
  ).toLowerCase();
  const hasVideoInput = Boolean(
    context.input.input.sourceVideo ||
    (context.input.input.references ?? []).some((ref) => ref.type === 'video'),
  );
  const model = context.route.upstreamModelId;
  let rateMicros: number | null = null;
  if (model === 'dreamina-seedance-2-5-260628') {
    rateMicros =
      resolution === '480p' || resolution === '720p'
        ? hasVideoInput
          ? 6_400_000
          : 10_700_000
        : resolution === '1080p'
          ? hasVideoInput
            ? 7_000_000
            : 11_700_000
          : null;
  } else if (model === 'dreamina-seedance-2-0-260128') {
    rateMicros =
      resolution === '480p' || resolution === '720p'
        ? hasVideoInput
          ? 4_300_000
          : 7_000_000
        : resolution === '1080p'
          ? hasVideoInput
            ? 4_700_000
            : 7_700_000
          : resolution === '4k'
            ? hasVideoInput
              ? 2_400_000
              : 4_000_000
            : null;
  } else if (model === 'dreamina-seedance-2-0-fast-260128') {
    rateMicros =
      resolution === '480p' || resolution === '720p'
        ? hasVideoInput
          ? 3_300_000
          : 5_600_000
        : null;
  } else if (model === 'dreamina-seedance-2-0-mini-260615') {
    rateMicros =
      resolution === '480p' || resolution === '720p'
        ? hasVideoInput
          ? 2_100_000
          : 3_500_000
        : null;
  } else if (model === 'seedance-1-0-pro-250528') {
    rateMicros =
      !hasVideoInput && ['480p', '720p', '1080p'].includes(resolution) ? 2_500_000 : null;
  } else if (model === 'seedance-1-0-pro-fast-251015') {
    rateMicros =
      !hasVideoInput && ['480p', '720p', '1080p'].includes(resolution) ? 1_000_000 : null;
  }
  if (rateMicros === null) return null;
  const settled = (BigInt(tokens) * BigInt(rateMicros) + 999_999n) / 1_000_000n;
  return settled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(settled) : null;
}

/** Internal video branch of the BytePlus adapter; the image branch remains synchronous. */
export function createBytePlusVideoAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'resolution',
    'duration',
    'aspectRatio',
    'firstFrame',
    'lastFrame',
    'references',
    'audio',
    'draft',
    'watermark',
    'count',
  ];
  const endpoint = 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks';
  function modelFields(modelId: string): (keyof GenerationArguments)[] {
    if (modelId.startsWith('seedance-1-0-')) {
      return [
        ...fields.filter(
          (field) =>
            field !== 'audio' &&
            field !== 'draft' &&
            (modelId !== 'seedance-1-0-pro-fast-251015' ||
              (field !== 'lastFrame' && field !== 'references')),
        ),
        'seed',
      ];
    }
    return modelId.includes('2-5-') ? fields : fields.filter((field) => field !== 'draft');
  }
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { route, deployment, input } = context;
    if (deployment.id !== 'byteplus-modelark-ap-southeast-1' || !models.has(route.upstreamModelId))
      return 'This adapter executes explicitly qualified Singapore Seedance routes only.';
    const isV1 = route.upstreamModelId.startsWith('seedance-1-0-');
    const isV1Fast = route.upstreamModelId === 'seedance-1-0-pro-fast-251015';
    const supportedOps = isV1Fast
      ? ['text-to-video', 'image-to-video']
      : ['text-to-video', 'image-to-video', 'reference-to-video'];
    if (!supportedOps.includes(input.operation))
      return 'This Seedance adapter supports generation, without implicit edit/extension parameter changes.';
    const latest = route.upstreamModelId.includes('2-5-');
    const standard = route.upstreamModelId === 'dreamina-seedance-2-0-260128';
    if (
      !(
        latest || isV1
          ? ['480p', '720p', '1080p']
          : standard
            ? ['480p', '720p', '1080p', '4k']
            : ['480p', '720p']
      ).includes((input.input.resolution ?? '').toLowerCase())
    )
      return 'The selected Seedance variant does not support this resolution.';
    const args = input.input;
    const issue = adapterInputIssue(context, modelFields(route.upstreamModelId));
    if (issue) return issue;
    if (args.count !== undefined && args.count !== 1) return 'Seedance returns one video per job.';
    if (isV1) {
      if (
        !Number.isInteger(numericDuration(input)) ||
        numericDuration(input) < 2 ||
        numericDuration(input) > 12
      )
        return 'Seedance 1.0 requires 2–12 seconds.';
    } else {
      const maximum = latest ? 30 : 15;
      if (
        args.duration !== 'auto' &&
        (!Number.isInteger(numericDuration(input)) ||
          numericDuration(input) < 4 ||
          numericDuration(input) > maximum)
      )
        return `Seedance requires 4–${maximum} seconds or auto.`;
    }
    if (
      input.operation === 'text-to-video' &&
      (args.firstFrame || args.lastFrame || args.references?.length)
    )
      return 'Text-to-video does not accept media.';
    if (input.operation === 'image-to-video' && (!args.firstFrame || args.references?.length))
      return 'Seedance strict frames require firstFrame and cannot mix omni references.';
    if (
      input.operation === 'reference-to-video' &&
      (args.firstFrame || args.lastFrame || !args.references?.length)
    )
      return 'Seedance omni references cannot mix first/last frames.';
    if (args.references?.some((ref) => ref.type === 'document'))
      return 'This Seedance adapter does not support document inputs.';
    if (isV1) {
      if (args.references?.some((ref) => ref.type !== 'image'))
        return 'Seedance 1.0 Pro supports image references only.';
      if ((args.references?.length ?? 0) > 4)
        return 'Seedance 1.0 Pro supports at most 4 image references.';
    } else {
      for (const [type, limit] of [
        ['image', latest ? 30 : 9],
        ['video', latest ? 10 : 3],
        ['audio', latest ? 10 : 3],
      ] as const)
        if ((args.references ?? []).filter((ref) => ref.type === type).length > limit)
          return `Seedance supports at most ${limit} ${type} references.`;
      if ((args.references?.length ?? 0) > (latest ? 50 : 12))
        return 'Seedance combined reference limit exceeded.';
      if (
        !latest &&
        args.references?.length &&
        !args.references.some((ref) => ref.type === 'image' || ref.type === 'video')
      )
        return 'Seedance 2.0 audio requires visual reference media.';
    }
    if (args.aspectRatio === 'source' && !args.firstFrame)
      return 'Source ratio requires firstFrame.';
    if (args.firstFrame && args.aspectRatio && args.aspectRatio !== 'source')
      return 'Seedance frame generation preserves source shape; choose source ratio.';
    if (
      args.aspectRatio &&
      args.aspectRatio !== 'source' &&
      args.aspectRatio !== 'auto' &&
      !ratios.has(args.aspectRatio)
    )
      return 'Unsupported Seedance aspect ratio.';
    if (args.draft && (!latest || args.resolution?.toLowerCase() !== '480p'))
      return 'This draft implementation requires Seedance 2.5 at480p.';
    return null;
  }
  function auth() {
    if (!env.BYTEPLUS_API_KEY)
      throw new SubmissionRejected('Configure BYTEPLUS_API_KEY for Singapore ModelArk.');
    return { Authorization: `Bearer ${env.BYTEPLUS_API_KEY}` };
  }
  return {
    id: 'byteplus',
    supportedOperations: ['text-to-video', 'image-to-video', 'reference-to-video'],
    preflight,
    inputFields: (context) => modelFields(context.route.upstreamModelId),
    isConfigured: (route, deployment) =>
      route.adapter === 'byteplus' &&
      deployment.id === 'byteplus-modelark-ap-southeast-1' &&
      models.has(route.upstreamModelId) &&
      Boolean(env.BYTEPLUS_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { route, input } = context;
      const latest = route.upstreamModelId.includes('2-5-');
      const isV1 = route.upstreamModelId.startsWith('seedance-1-0-');
      const body = await submitProviderJson(request, 'BytePlus', endpoint, auth(), {
        model: route.upstreamModelId,
        content: [
          ...(input.input.prompt === undefined ? [] : [{ type: 'text', text: input.input.prompt }]),
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
        resolution: input.input.resolution?.toLowerCase(),
        duration: input.input.duration === 'auto' ? -1 : input.input.duration,
        ratio:
          input.input.aspectRatio === 'source' || input.input.aspectRatio === 'auto'
            ? 'adaptive'
            : input.input.aspectRatio,
        ...(isV1 ? {} : { generate_audio: input.input.audio ?? true }),
        watermark: input.input.watermark ?? true,
        ...(input.input.seed === undefined ? {} : { seed: input.input.seed }),
        ...(input.input.draft === undefined ? {} : { draft: input.input.draft }),
        ...(latest && input.operation === 'reference-to-video'
          ? { omni_reference_task_type: 'reference' }
          : {}),
        ...(context.workspaceId
          ? {
              safety_identifier: createHash('sha256')
                .update(`opengen:${context.workspaceId}`)
                .digest('hex'),
            }
          : {}),
      });
      if (typeof body.id !== 'string' || !body.id) throw new SubmissionUnknown();
      return { upstreamId: body.id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'BytePlus',
        `${endpoint}/${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      if (body.status === 'queued' || body.status === 'running') return { status: 'running' };
      if (body.status === 'expired')
        return {
          status: 'unknown',
          error: 'BytePlus task expired; billing requires reconciliation.',
        };
      if (body.status === 'failed' || body.status === 'cancelled')
        return {
          status: body.status,
          failureCategory: 'unknown',
          error:
            'BytePlus ended this task without a delivered video. Billing requires reconciliation.',
          billedCostMicros: null,
        };
      const content = providerObject(body.content);
      if (
        body.status !== 'succeeded' ||
        typeof content.video_url !== 'string' ||
        !isPublicHttpsAssetUrl(content.video_url)
      )
        throw new Error('BytePlus has not returned a supported video asset.');
      return {
        status: 'succeeded',
        billedCostMicros: settledVideoCost(context, body),
        outputs: [{ url: content.video_url, mediaType: 'video/mp4', fidelity: 'unverified' }],
      };
    },
  };
}
