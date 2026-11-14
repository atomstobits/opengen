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
import { pollProviderJson, submitProviderJson } from './provider-http.js';

const ratios: Record<string, Record<string, string>> = {
  '720p': {
    '16:9': '1280:720',
    '9:16': '720:1280',
    '1:1': '940:940',
    '21:9': '1460:624',
    auto: 'auto_720p',
  },
  '1080p': {
    '16:9': '1920:1080',
    '9:16': '1080:1920',
    '1:1': '1440:1440',
    '21:9': '2200:940',
    auto: 'auto_1080p',
  },
};

/** Explicit Kling 4.0 T2V and first-frame I2V protocol. Video edits have separate source-duration billing. */
export function createRunwayAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields = (operation: string): (keyof GenerationArguments)[] => [
    'prompt',
    'resolution',
    'duration',
    'aspectRatio',
    'references',
    'audio',
    'count',
    'outputFormat',
    ...(operation === 'image-to-video' ? ['firstFrame' as const] : []),
  ];
  function preflight({ input, route, deployment }: Omit<AdapterContext, 'jobId'>): string | null {
    const isFlash = route.upstreamModelId === 'kling_4_flash';
    if (deployment.providerId !== 'runway' || (route.upstreamModelId !== 'kling_4' && !isFlash))
      return 'This Runway adapter supports Kling 4.0 and Kling 4.0 Flash only.';
    if (!['text-to-video', 'image-to-video'].includes(input.operation))
      return 'Runway video editing requires source-derived duration and input billing; this adapter does not execute it.';
    const res = (input.input.resolution ?? '').toLowerCase();
    if (isFlash ? res !== '720p' : !ratios[res])
      return isFlash ? 'Kling 4.0 Flash supports 720p only.' : 'Kling 4.0 supports 720p and 1080p.';
    const maxDuration = isFlash ? 20 : 30;
    if (
      !Number.isInteger(input.input.duration) ||
      numericDuration(input) < 3 ||
      numericDuration(input) > maxDuration
    )
      return `Kling requires an integer duration from 3 through ${maxDuration} seconds.`;
    const args = input.input;
    const unsupported = adapterInputIssue({ input, route, deployment }, fields(input.operation));
    if (unsupported) return unsupported;
    if (args.count !== undefined && args.count !== 1) return 'Kling returns one video per job.';
    if (args.audio === false) return 'Kling4 native audio cannot be disabled.';
    if (args.outputFormat !== undefined && args.outputFormat !== 'mp4')
      return 'Kling4 returns MP4.';
    const typeIssue = referenceTypeIssue(input);
    if (typeIssue) return typeIssue;
    const references = referenceUrls(input);
    if (input.operation === 'text-to-video') {
      if (args.firstFrame || args.lastFrame)
        return 'Text-to-video does not accept first/last frames.';
      if (args.aspectRatio && !ratios[(args.resolution ?? '').toLowerCase()]![args.aspectRatio])
        return 'Unsupported Kling text ratio.';
      if (references.length > 10) return 'Kling allows at most10 reference images.';
    } else {
      if (!args.firstFrame) return 'This Kling integration requires a first frame.';
      if (args.aspectRatio && args.aspectRatio !== 'source')
        return 'Kling frame output preserves source ratio.';
      if (references.length + 1 > 10) return 'Frames and reference images share a10-image budget.';
    }
    return null;
  }
  function auth() {
    if (!env.RUNWAYML_API_SECRET)
      throw new SubmissionRejected('Configure RUNWAYML_API_SECRET for Runway.');
    return { Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`, 'X-Runway-Version': '2024-11-06' };
  }
  return {
    id: 'runway',
    supportedOperations: ['text-to-video', 'image-to-video'],
    preflight,
    inputFields: (context) => fields(context.input.operation),
    isConfigured: (route, deployment) =>
      route.adapter === 'runway' &&
      (route.upstreamModelId === 'kling_4' || route.upstreamModelId === 'kling_4_flash') &&
      deployment.providerId === 'runway' &&
      Boolean(env.RUNWAYML_API_SECRET),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const { input } = context;
      const image = input.operation === 'image-to-video';
      const body = await submitProviderJson(
        request,
        'Runway',
        `https://api.dev.runwayml.com/v1/${image ? 'image_to_video' : 'text_to_video'}`,
        auth(),
        {
          model: context.route.upstreamModelId,
          promptText: input.input.prompt,
          duration: input.input.duration,
          ratio: image
            ? `auto_${(input.input.resolution ?? '').toLowerCase()}`
            : ratios[(input.input.resolution ?? '').toLowerCase()]![
                input.input.aspectRatio ?? '16:9'
              ],
          ...(image ? { promptImage: frameUrl(input, 'first') } : {}),
          ...(input.input.references?.length
            ? { references: referenceUrls(input).map((uri) => ({ uri })) }
            : {}),
        },
      );
      if (typeof body.id !== 'string' || !body.id) throw new SubmissionUnknown();
      return { upstreamId: body.id };
    },
    async poll(context) {
      const body = await pollProviderJson(
        request,
        'Runway',
        `https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(context.upstreamId)}`,
        auth(),
      );
      if (['PENDING', 'THROTTLED', 'RUNNING'].includes(String(body.status)))
        return { status: 'running' };
      if (body.status === 'FAILED' || body.status === 'CANCELLED')
        return {
          status: body.status === 'FAILED' ? 'failed' : 'cancelled',
          failureCategory: 'unknown',
          error:
            'Runway ended this task without a delivered video. Billing requires reconciliation.',
          billedCostMicros: null,
        };
      if (
        body.status !== 'SUCCEEDED' ||
        !Array.isArray(body.output) ||
        body.output.length !== 1 ||
        typeof body.output[0] !== 'string' ||
        !isPublicHttpsAssetUrl(body.output[0])
      )
        throw new Error('Runway has not returned one supported video asset.');
      // Task estimatedCost is an estimate, not an authoritative charge or refund.
      return {
        status: 'succeeded',
        billedCostMicros: null,
        outputs: [{ url: body.output[0], mediaType: 'video/mp4', fidelity: 'unverified' }],
      };
    },
  };
}
