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

export interface SeedreamSizeConfig {
  tiers: readonly string[];
  minPixels: number;
  maxPixels: number;
  maxReferences: number;
  jpegOnly?: boolean;
  supportsBackground?: boolean;
}

export const seedreamModelConfigs = new Map<string, SeedreamSizeConfig>([
  [
    'dola-seedream-5-5-261028',
    {
      tiers: ['1K', '1.5K', '2K'],
      minPixels: 921_600,
      maxPixels: 4_624_220,
      maxReferences: 10,
      supportsBackground: true,
    },
  ],
  [
    'dola-seedream-5-0-pro-260628',
    {
      tiers: ['1K', '1.5K', '2K'],
      minPixels: 921_600,
      maxPixels: 4_624_220,
      maxReferences: 14,
      supportsBackground: true,
    },
  ],
  [
    'dola-seedream-5-0-flash-260915',
    {
      tiers: ['1K', '1.5K', '2K'],
      minPixels: 921_600,
      maxPixels: 4_624_220,
      maxReferences: 10,
      supportsBackground: true,
    },
  ],
  [
    'seedream-5-0-lite-260128',
    {
      tiers: ['2K', '3K', '4K'],
      minPixels: 3_686_400,
      maxPixels: 16_777_216,
      maxReferences: 14,
    },
  ],
  [
    'seedream-4-5-251128',
    {
      tiers: ['2K', '4K'],
      minPixels: 3_686_400,
      maxPixels: 16_777_216,
      maxReferences: 14,
      jpegOnly: true,
    },
  ],
  [
    'seedream-4-0-250828',
    {
      tiers: ['1K', '2K', '4K'],
      minPixels: 921_600,
      maxPixels: 16_777_216,
      maxReferences: 14,
      jpegOnly: true,
    },
  ],
]);

function observedImageCost(
  route: Route,
  image: JsonObject,
  generatedImages: unknown,
  maxPixels = 4_624_220,
): number | null {
  // A usage count alone cannot establish the price tier; billing follows the actual output's pixel count.
  if (generatedImages !== undefined && generatedImages !== 1) return null;
  if (typeof image.size !== 'string') return null;
  const match = /^(\d+)x(\d+)$/.exec(image.size);
  if (!match) return null;
  const pixels = Number(match[1]) * Number(match[2]);
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > maxPixels) return null;
  const tiers =
    pixels <= 2_610_000
      ? ['1K', '1.5K']
      : pixels <= 4_624_220
        ? ['2K']
        : pixels <= 9_437_184
          ? ['3K', '4K']
          : ['4K'];
  const rate =
    route.rates.find(
      (value) =>
        value.unit === 'image' &&
        tiers.includes(value.resolution.toUpperCase()) &&
        (!value.operation || value.operation === 'text-to-image'),
    ) ??
    (new Set(
      route.rates
        .filter(
          (value) =>
            value.unit === 'image' && (!value.operation || value.operation === 'text-to-image'),
        )
        .map((value) => value.usdMicros),
    ).size === 1
      ? route.rates.find(
          (value) =>
            value.unit === 'image' && (!value.operation || value.operation === 'text-to-image'),
        )
      : undefined);
  return rate?.usdMicros ?? null;
}

/** Stable exact dimensions shared by native and reseller Seedream routes. */
export function seedreamImageSize(
  args: GenerationArguments,
  options: Pick<SeedreamSizeConfig, 'tiers' | 'minPixels' | 'maxPixels'> = {
    tiers: ['1K', '1.5K', '2K'],
    minPixels: 921_600,
    maxPixels: 4_624_220,
  },
): string | null {
  const tier = args.resolution?.toUpperCase() ?? '';
  let dimensions = args.size;
  if (!dimensions) {
    if (!options.tiers.includes(tier)) return null;
    if (!args.aspectRatio || args.aspectRatio === 'auto') return tier;
    const highMin = options.minPixels >= 3_686_400;
    const sizes: Record<string, [number, number]> =
      tier === '4K'
        ? {
            '1:1': [4096, 4096],
            '4:3': [4096, 3072],
            '3:4': [3072, 4096],
            '16:9': [4096, 2304],
            '9:16': [2304, 4096],
          }
        : tier === '3K'
          ? {
              '1:1': [3072, 3072],
              '4:3': [3456, 2592],
              '3:4': [2592, 3456],
              '16:9': [3840, 2160],
              '9:16': [2160, 3840],
            }
          : tier === '2K' && highMin
            ? {
                '1:1': [2048, 2048],
                '4:3': [2304, 1728],
                '3:4': [1728, 2304],
                '16:9': [2560, 1440],
                '9:16': [1440, 2560],
              }
            : (() => {
                const long = tier === '2K' ? 2048 : tier === '1.5K' ? 1536 : 1152;
                const square = tier === '2K' ? 2048 : tier === '1.5K' ? 1536 : 1024;
                return {
                  '1:1': [square, square],
                  '4:3': [long, (long * 3) / 4],
                  '3:4': [(long * 3) / 4, long],
                  '16:9': tier === '1K' ? [1280, 720] : [long, (long * 9) / 16],
                  '9:16': tier === '1K' ? [720, 1280] : [(long * 9) / 16, long],
                };
              })();
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
    area >= options.minPixels &&
    area <= options.maxPixels &&
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
  const baseFields: (keyof GenerationArguments)[] = [
    'prompt',
    'resolution',
    'size',
    'aspectRatio',
    'references',
    'count',
    'outputFormat',
    'watermark',
  ];
  function imageFields(modelId: string): (keyof GenerationArguments)[] {
    const config = seedreamModelConfigs.get(modelId);
    return config?.supportsBackground ? [...baseFields, 'background'] : baseFields;
  }
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (isBytePlusVideoModel(context.route.upstreamModelId)) return video.preflight!(context);
    const config = seedreamModelConfigs.get(context.route.upstreamModelId);
    if (context.deployment.endpointRegion !== 'ap-southeast-1' || !config) {
      return 'This adapter executes documented Singapore Seedream routes only.';
    }
    const args = context.input.input;
    const fields = imageFields(context.route.upstreamModelId);
    const issue = adapterInputIssue(context, fields) ?? referenceTypeIssue(context.input);
    if (issue) return issue;
    if (!['text-to-image', 'image-edit'].includes(context.input.operation))
      return 'This Seedream adapter executes generation and edits only.';
    const refs = referenceUrls(context.input);
    if (context.input.operation === 'text-to-image' && refs.length)
      return 'Text-to-image does not accept references.';
    if (
      context.input.operation === 'image-edit' &&
      (refs.length < 1 || refs.length > config.maxReferences)
    )
      return `Seedream edit requires 1–${config.maxReferences} ordered reference images.`;
    if (args.count !== undefined && args.count !== 1)
      return 'This synchronous Seedream adapter produces one image per job.';
    if (config.jpegOnly) {
      if (args.outputFormat !== undefined && args.outputFormat !== 'jpeg')
        return 'This Seedream variant outputs JPEG only.';
    } else if (args.outputFormat !== undefined && !['png', 'jpeg'].includes(args.outputFormat)) {
      return 'Seedream supports PNG or JPEG output.';
    }
    if (args.background !== undefined) {
      if (!['auto', 'opaque', 'transparent'].includes(args.background))
        return 'Unsupported Seedream background mode.';
      if (args.background === 'transparent' && args.outputFormat === 'jpeg')
        return 'Transparent output requires PNG.';
    }
    if (!seedreamImageSize(args, config)) return 'Unsupported exact Seedream dimensions.';
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
      isBytePlusVideoModel(context.route.upstreamModelId)
        ? video.inputFields!(context)
        : imageFields(context.route.upstreamModelId),
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'byteplus' &&
      deployment.endpointRegion === 'ap-southeast-1' &&
      (isBytePlusVideoModel(route.upstreamModelId) ||
        seedreamModelConfigs.has(route.upstreamModelId)) &&
      Boolean(env.BYTEPLUS_API_KEY),
    async submit(context) {
      if (isBytePlusVideoModel(context.route.upstreamModelId)) return video.submit(context);
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      if (!env.BYTEPLUS_API_KEY)
        throw new SubmissionRejected('Configure BYTEPLUS_API_KEY for the Singapore deployment.');
      const config = seedreamModelConfigs.get(context.route.upstreamModelId)!;
      const size = seedreamImageSize(context.input.input, config);
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
              ...(config.jpegOnly
                ? {}
                : { output_format: context.input.input.outputFormat ?? 'png' }),
              watermark: context.input.input.watermark ?? true,
              ...(context.input.input.background === undefined
                ? {}
                : { background: context.input.input.background }),
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
      const format = config.jpegOnly ? 'jpeg' : (context.input.input.outputFormat ?? 'png');
      return {
        immediateResult: {
          status: 'succeeded',
          // The qualified fixed-image tariff covers text generation only. Edit inputs
          // have additional, unqualified billing and must remain pending reconciliation.
          billedCostMicros:
            context.input.operation === 'text-to-image'
              ? observedImageCost(
                  context.route,
                  image,
                  object(body.usage).generated_images,
                  config.maxPixels,
                )
              : null,
          outputs: [
            {
              url: image.url,
              mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
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
