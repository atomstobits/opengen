import type { GenerationArguments, Operation } from '@media-router/contracts';
import {
  adapterInputIssue,
  frameUrl,
  sourceVideoUrl,
  referenceTypeIssue,
  referenceUrls,
  numericDuration,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import type { StoreProviderOutput } from './openai.js';
import { detectedMediaType, readPublicAsset, outputLimitBytes } from './output.js';
import { pollProviderJson, providerObject, submitProviderJson } from './provider-http.js';
import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';
import { observedGoogleVideoCostMicros } from './google-usage.js';

const models = new Set(['gemini-omni-1.1-flash', 'gemini-omni-1.2-flash']);
const tasks: Partial<Record<Operation, string>> = {
  'text-to-video': 'text_to_video',
  'image-to-video': 'image_to_video',
  'reference-to-video': 'reference_to_video',
  'video-edit': 'edit',
  'video-extend': 'extend',
};

export function createGoogleVideoAdapter(
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
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'duration',
    'resolution',
    'aspectRatio',
    'firstFrame',
    'lastFrame',
    'sourceVideo',
    'references',
    'count',
    'outputFormat',
    'audio',
  ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    const { route, deployment, input } = context;
    if (deployment.id !== 'google-undisclosed' || !models.has(route.upstreamModelId))
      return 'Unsupported Google Omni model or deployment.';
    if (!tasks[input.operation]) return 'Unsupported Omni operation.';
    const is12 = route.upstreamModelId === 'gemini-omni-1.2-flash';
    const issue =
      adapterInputIssue(context, fields) ??
      referenceTypeIssue(input, is12 ? ['image', 'video'] : ['image']);
    if (issue) return issue;
    const args = input.input;
    if (!['360p', '720p', '1080p', '4k'].includes((args.resolution ?? '').toLowerCase()))
      return 'Unsupported Omni output resolution.';
    const first = frameUrl(input, 'first');
    const last = frameUrl(input, 'last');
    const maxDuration =
      is12 && input.operation !== 'video-extend' && !(input.operation === 'image-to-video' && last)
        ? 15
        : 10;
    const durationOptionalEdit =
      is12 && input.operation === 'video-edit' && args.duration === undefined;
    if (!durationOptionalEdit) {
      const duration = numericDuration(input);
      if (!Number.isInteger(duration) || duration < 3 || duration > maxDuration)
        return `Omni duration must be 3–${maxDuration} seconds.`;
    }
    if (input.operation === 'video-extend') {
      if (args.aspectRatio && args.aspectRatio !== 'source')
        return 'Omni extension preserves its source ratio; use source or omit aspectRatio.';
    } else if (args.aspectRatio && !['16:9', '9:16'].includes(args.aspectRatio))
      return 'This Omni adapter supports 16:9 and 9:16; source-ratio inheritance is qualified only for extension.';
    if (args.count !== undefined && args.count !== 1)
      return 'This Omni adapter produces one video per job.';
    if (args.outputFormat && args.outputFormat !== 'mp4')
      return 'This Omni adapter produces MP4 output only.';
    if (args.audio === false)
      return 'Omni generates native audio and has no qualified audio-off switch.';
    const imageRefs = referenceUrls(input, 'image');
    const videoRefs = referenceUrls(input, 'video');
    const allRefs = [...imageRefs, ...videoRefs];
    if (is12 && (imageRefs.length > 10 || videoRefs.length > 3))
      return 'Omni 1.2 supports at most 10 image references and 3 video references.';
    const source = sourceVideoUrl(input);
    const continuing = Boolean(context.previousUpstreamId || input.previousJobId);
    if (continuing && !['video-edit', 'video-extend'].includes(input.operation))
      return 'A previous Omni generation may be continued through video edit or extension.';
    if (continuing && source)
      return 'Choose an owned previous job or an uploaded source video, not both.';
    if (input.operation !== 'image-to-video' && (first || last))
      return 'First/last frames belong to the image-to-video operation.';
    if (!['video-edit', 'video-extend'].includes(input.operation) && source)
      return 'A source video belongs to video edit or extension.';
    if (input.operation === 'text-to-video' && allRefs.length)
      return 'Text-to-video does not accept reference assets.';
    if (input.operation === 'image-to-video' && !first)
      return 'Omni image-to-video requires firstFrame and accepts optional lastFrame.';
    if (input.operation === 'reference-to-video' && !allRefs.length)
      return 'Omni reference generation requires at least one reference.';
    if (['video-edit', 'video-extend'].includes(input.operation) && !source && !continuing)
      return 'Omni video edit/extend requires sourceVideo or a verified previous job.';
    return null;
  }
  function auth() {
    const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!key || !(options.captureOutputs || options.storeOutput))
      throw new SubmissionRejected('Configure GEMINI_API_KEY and private output storage.');
    return { 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' };
  }
  return {
    id: 'google',
    supportedOperations: [
      'text-to-video',
      'image-to-video',
      'reference-to-video',
      'video-edit',
      'video-extend',
    ],
    preflight,
    inputFields: () => fields,
    isConfigured: (route, deployment) =>
      route.adapter === 'google' &&
      deployment.id === 'google-undisclosed' &&
      models.has(route.upstreamModelId) &&
      Boolean(
        (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) &&
        (options.captureOutputs || options.storeOutput),
      ),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input } = context;
      if (input.previousJobId && !context.previousUpstreamId)
        throw new SubmissionRejected(
          'The engine must verify and pin the previous Omni job before continuation.',
        );
      const content: Record<string, unknown>[] = [];
      const sources: string[] = [];
      const references: string[] = [];
      let inputBytes = 0;
      let imageIndex = 0;
      let videoIndex = 0;
      async function addMedia(url: string, type: 'image' | 'video'): Promise<number> {
        let asset: Awaited<ReturnType<typeof readPublicAsset>>;
        try {
          asset = await readAsset(url, { maxBytes: 20 * 1024 * 1024 });
        } catch {
          throw new SubmissionRejected(
            'An Omni reference could not be read safely. No provider generation was submitted.',
          );
        }
        inputBytes += asset.bytes.length;
        if (inputBytes > 20 * 1024 * 1024)
          throw new SubmissionRejected(
            'Omni reference inputs exceed this adapter’s 20 MiB total limit.',
          );
        if (
          type === 'video'
            ? asset.mediaType !== 'video/mp4'
            : !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType)
        )
          throw new SubmissionRejected(
            'The reference asset type does not match its explicit Omni media role.',
          );
        content.push({ type, mime_type: asset.mediaType, data: asset.bytes.toString('base64') });
        return type === 'image' ? ++imageIndex : ++videoIndex;
      }
      const first = frameUrl(input, 'first');
      const last = frameUrl(input, 'last');
      if (first) sources.push(`<FIRST_FRAME>@Image${await addMedia(first, 'image')}`);
      if (last) sources.push(`<LAST_FRAME>@Image${await addMedia(last, 'image')}`);
      const images = referenceUrls(input, 'image');
      for (let index = 0; index < images.length; index++)
        references.push(`<IMAGE_REF_${index}>@Image${await addMedia(images[index]!, 'image')}`);
      const videos = referenceUrls(input, 'video');
      for (let index = 0; index < videos.length; index++)
        references.push(`<VIDEO_REF_${index}>@Video${await addMedia(videos[index]!, 'video')}`);
      const source = sourceVideoUrl(input);
      if (source) {
        sources.push(`<VIDEO_0>@Video${await addMedia(source, 'video')}`);
      }
      // Google’s documented declarations bind each named role to its physical media position.
      // Ordinary references cannot accidentally become the first or last frame.
      const prompt = [
        ...(sources.length ? [`[# Sources ${sources.join(' ')}]`] : []),
        ...(references.length ? [`[# References ${references.join(' ')}]`] : []),
        input.input.prompt ?? '',
      ]
        .join(' ')
        .trim();
      content.push({ type: 'text', text: prompt });
      const body = await submitProviderJson(
        request,
        'Google Omni',
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        auth(),
        {
          model: context.route.upstreamModelId,
          input: content,
          background: true,
          store: true,
          generation_config: { video_config: { task: tasks[input.operation] } },
          response_format: {
            type: 'video',
            delivery: 'inline',
            ...(input.input.duration !== undefined ? { duration: `${input.input.duration}s` } : {}),
            resolution: (input.input.resolution ?? '').toLowerCase(),
            ...(input.operation !== 'video-extend' &&
            !(input.operation === 'video-edit' && input.input.aspectRatio === undefined)
              ? { aspect_ratio: input.input.aspectRatio ?? '16:9' }
              : {}),
          },
          ...(context.previousUpstreamId
            ? { previous_interaction_id: context.previousUpstreamId }
            : {}),
        },
        { maxBytes: 32_000_000 },
      );
      if (typeof body.id !== 'string' || !body.id) throw new SubmissionUnknown();
      return { upstreamId: body.id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Google Omni',
        `https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(context.upstreamId)}`,
        auth(),
        140_000_000,
      );
      if (body.status === 'in_progress') return { status: 'running' };
      const billedCostMicros = observedGoogleVideoCostMicros(body, context.route.upstreamModelId);
      if (body.status === 'failed' || body.status === 'cancelled')
        return {
          status: body.status,
          failureCategory: 'unknown',
          error:
            'Google ended the video interaction without delivered media. Billing requires reconciliation.',
          billedCostMicros,
        };
      if (body.status !== 'completed') throw new Error('Unrecognized Omni interaction status.');
      const videos = (Array.isArray(body.steps) ? body.steps : []).flatMap((value) => {
        const step = providerObject(value);
        return step.type === 'model_output' && Array.isArray(step.content)
          ? step.content.map(providerObject).filter((block) => block.type === 'video')
          : [];
      });
      const video = videos[0];
      if (
        videos.length !== 1 ||
        video?.mime_type !== 'video/mp4' ||
        typeof video.data !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(video.data) ||
        video.data.length % 4 !== 0
      )
        throw new Error('Omni has not returned the expected single inline video.');
      const bytes = Buffer.from(video.data, 'base64');
      if (bytes.length > outputLimitBytes || detectedMediaType(bytes) !== 'video/mp4')
        throw new Error('Omni output type or size is unsupported.');
      if (options.captureOutputs)
        return captureProviderResult(
          options.captureOutputs,
          context,
          [{ kind: 'inline', bytes, mediaType: 'video/mp4' }],
          billedCostMicros,
        );
      const asset = await options.storeOutput!({
        jobId: context.jobId,
        bytes,
        mediaType: 'video/mp4',
      });
      return {
        status: 'succeeded',
        billedCostMicros,
        outputs: [{ ...asset, mediaType: 'video/mp4', fidelity: 'unverified' }],
      };
    },
  };
}
