import type { GenerationArguments, Route } from '@media-router/contracts';
import {
  isPublicHttpsAssetUrl,
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { createBytePlusVideoAdapter, isBytePlusVideoModel } from './byteplus-video.js';
import { providerJson } from './provider-http.js';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' ? (value as JsonObject) : {};
}

function observedImageCost(
  route: Route,
  image: JsonObject,
  generatedImages: unknown,
): number | null {
  // A usage count alone cannot establish the price tier; billing follows the actual output's pixel count.
  if (generatedImages !== undefined && generatedImages !== 1) return null;
  if (typeof image.size !== 'string') return null;
  const match = /^(\d+)x(\d+)$/.exec(image.size);
  if (!match) return null;
  const pixels = Number(match[1]) * Number(match[2]);
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 4_624_220) return null;
  const tier = pixels <= 2_610_000 ? ['1K', '1.5K'] : ['2K'];
  const rate = route.rates.find(
    (value) =>
      value.unit === 'image' &&
      tier.includes(value.resolution.toUpperCase()) &&
      (!value.operation || value.operation === 'text-to-image'),
  );
  return rate?.usdMicros ?? null;
}

/** Stable exact dimensions shared by native and reseller Seedream routes. */
export function seedreamImageSize(args: GenerationArguments): string | null {
  const tier = args.resolution?.toUpperCase() ?? '';
  let dimensions = args.size;
  if (!dimensions) {
    if (!['1K', '1.5K', '2K'].includes(tier)) return null;
    if (!args.aspectRatio || args.aspectRatio === 'auto') return tier;
    const long = tier === '2K' ? 2048 : tier === '1.5K' ? 1536 : 1152;
    const square = tier === '2K' ? 2048 : tier === '1.5K' ? 1536 : 1024;
    const sizes: Record<string, [number, number]> = {
      '1:1': [square, square],
      '4:3': [long, (long * 3) / 4],
      '3:4': [(long * 3) / 4, long],
      '16:9': tier === '1K' ? [1280, 720] : [long, (long * 9) / 16],
      '9:16': tier === '1K' ? [720, 1280] : [(long * 9) / 16, long],
    };
    const pair = sizes[args.aspectRatio];
    if (!pair) return null;
    dimensions = { width: pair[0], height: pair[1] };
  }
  const { width, height } = dimensions,
    area = width * height,
    ratio = width / height;
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    area >= 921600 &&
    area <= 4624220 &&
    ratio >= 1 / 16 &&
    ratio <= 16
    ? `${width}x${height}`
    : null;
}

/** Seedream's synchronous response is normalized into the same durable generation state as video. */
export function createBytePlusAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const video = createBytePlusVideoAdapter(options);
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'resolution',
    'size',
    'aspectRatio',
    'references',
    'count',
    'outputFormat',
    'watermark',
  ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (isBytePlusVideoModel(context.route.upstreamModelId)) return video.preflight!(context);
    if (
      context.deployment.endpointRegion !== 'ap-southeast-1' ||
      context.route.upstreamModelId !== 'dola-seedream-5-0-pro-260628'
    ) {
      return 'This adapter executes the documented Singapore Seedream 5.0 Pro route only.';
    }
    const args = context.input.input;
    const issue = adapterInputIssue(context, fields) ?? referenceTypeIssue(context.input);
    if (issue) return issue;
    if (!['text-to-image', 'image-edit'].includes(context.input.operation))
      return 'This Seedream adapter executes generation and edits only.';
    const refs = referenceUrls(context.input);
    if (context.input.operation === 'text-to-image' && refs.length)
      return 'Text-to-image does not accept references.';
    if (context.input.operation === 'image-edit' && (refs.length < 1 || refs.length > 14))
      return 'Seedream edit requires 1–14 ordered reference images.';
    if (args.count !== undefined && args.count !== 1)
      return 'This synchronous Seedream adapter produces one image per job.';
    if (args.outputFormat !== undefined && !['png', 'jpeg'].includes(args.outputFormat))
      return 'Seedream supports PNG or JPEG output.';
    if (!seedreamImageSize(args)) return 'Unsupported exact Seedream dimensions.';
    return null;
  }
  return {
    id: 'byteplus',
    supportedOperations: [
      'text-to-image',
      'image-edit',
      'text-to-video',
      'image-to-video',
      'reference-to-video',
    ],
    inputFields: (context) =>
      isBytePlusVideoModel(context.route.upstreamModelId) ? video.inputFields!(context) : fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'byteplus' &&
      deployment.endpointRegion === 'ap-southeast-1' &&
      Boolean(env.BYTEPLUS_API_KEY),
    async submit(context) {
      if (isBytePlusVideoModel(context.route.upstreamModelId)) return video.submit(context);
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      if (!env.BYTEPLUS_API_KEY)
        throw new SubmissionRejected('Configure BYTEPLUS_API_KEY for the Singapore deployment.');
      const size = seedreamImageSize(context.input.input);
      let response: Response;
      try {
        response = await request(
          'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${env.BYTEPLUS_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: context.route.upstreamModelId,
              prompt: context.input.input.prompt,
              size,
              response_format: 'url',
              output_format: context.input.input.outputFormat ?? 'png',
              watermark: context.input.input.watermark ?? true,
              ...(context.input.operation === 'image-edit'
                ? { image: referenceUrls(context.input) }
                : {}),
            }),
            signal: AbortSignal.timeout(90_000),
          },
        );
      } catch {
        throw new SubmissionUnknown(
          'The synchronous image request may have been accepted. No automatic resubmission was sent.',
        );
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        throw new SubmissionRejected(`BytePlus rejected submission (HTTP ${response.status}).`);
      }
      if (!response.ok)
        throw new SubmissionUnknown(
          `BytePlus returned HTTP ${response.status}; generation acceptance is unknown.`,
        );
      let body: JsonObject;
      try {
        body = await providerJson(response);
      } catch {
        throw new SubmissionUnknown(
          'The image response could not be decoded; billing requires reconciliation.',
        );
      }
      const error = object(body.error);
      if (typeof error.code === 'string') {
        return {
          immediateResult: {
            status: 'failed',
            failureCategory: 'unknown',
            error: 'BytePlus generation failed. Billing requires provider reconciliation.',
            billedCostMicros: null,
          },
        };
      }
      if (!Array.isArray(body.data) || body.data.length !== 1) {
        throw new SubmissionUnknown(
          'The provider did not return the expected single-image response. Billing requires reconciliation.',
        );
      }
      const image = object(body.data[0]);
      if (typeof image.url !== 'string' || !isPublicHttpsAssetUrl(image.url)) {
        throw new SubmissionUnknown(
          'The image response has no usable HTTPS asset URL. Billing requires reconciliation.',
        );
      }
      return {
        immediateResult: {
          status: 'succeeded',
          // The qualified fixed-image tariff covers text generation only. Edit inputs
          // have additional, unqualified billing and must remain pending reconciliation.
          billedCostMicros:
            context.input.operation === 'text-to-image'
              ? observedImageCost(context.route, image, object(body.usage).generated_images)
              : null,
          outputs: [
            {
              url: image.url,
              mediaType: context.input.input.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
              fidelity: 'unverified',
            },
          ],
        },
      };
    },
    async poll(context) {
      if (isBytePlusVideoModel(context.route.upstreamModelId)) return video.poll(context);
      throw new Error('BytePlus synchronous image requests do not have a pollable task ID.');
    },
  };
}
