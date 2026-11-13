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

const model = 'gemini-omni-1.1-flash';
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
    if (deployment.id !== 'google-undisclosed' || route.upstreamModelId !== model)
      return 'Unsupported Google Omni model or deployment.';
    if (!tasks[input.operation]) return 'Unsupported Omni operation.';
    const issue = adapterInputIssue(context, fields) ?? referenceTypeIssue(input);
    if (issue) return issue;
    const args = input.input;
    if (!['360p', '720p', '1080p', '4k'].includes((args.resolution ?? '').toLowerCase()))
      return 'Unsupported Omni output resolution.';
    const duration = numericDuration(input);
    if (!Number.isInteger(duration) || duration < 3 || duration > 10)
      return 'Omni duration must be 3–10 seconds.';
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
    const references = referenceUrls(input);
    const first = frameUrl(input, 'first');
    const last = frameUrl(input, 'last');
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
    if (input.operation === 'text-to-video' && references.length)
      return 'Text-to-video does not accept reference assets.';
    if (input.operation === 'image-to-video' && !first)
      return 'Omni image-to-video requires firstFrame and accepts optional lastFrame.';
    if (input.operation === 'reference-to-video' && !references.length)
      return 'Omni reference generation requires at least one image reference.';
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
      route.upstreamModelId === model &&
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
        return type === 'image' ? ++imageIndex : 1;
      }
      const first = frameUrl(input, 'first');
      const last = frameUrl(input, 'last');
      if (first) sources.push(`<FIRST_FRAME>@Image${await addMedia(first, 'image')}`);
      if (last) sources.push(`<LAST_FRAME>@Image${await addMedia(last, 'image')}`);
      const images = referenceUrls(input);
      for (let index = 0; index < images.length; index++)
        references.push(`<IMAGE_REF_${index}>@Image${await addMedia(images[index]!, 'image')}`);
      const source = sourceVideoUrl(input);
      if (source) {
        await addMedia(source, 'video');
        sources.push('<VIDEO_0>@Video1');
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
          model,
          input: content,
          background: true,
          store: true,
          generation_config: { video_config: { task: tasks[input.operation] } },
          response_format: {
            type: 'video',
            delivery: 'inline',
            duration: `${input.input.duration}s`,
            resolution: (input.input.resolution ?? '').toLowerCase(),
            ...(input.operation !== 'video-extend'
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
      const billedCostMicros = observedGoogleVideoCostMicros(body);
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
