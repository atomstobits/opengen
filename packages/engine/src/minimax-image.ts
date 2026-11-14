import type { GenerationArguments, OutputAsset } from '@media-router/contracts';
import {
  adapterInputIssue,
  isPublicHttpsAssetUrl,
  referenceTypeIssue,
  referenceUrls,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';
import type { DeliverySource } from './delivery.js';
import { providerObject, submitProviderJson } from './provider-http.js';

const models = new Set(['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed']);
const NANO_PER_MICRO = 1_000n;

export function isMiniMaxImageModel(upstreamModelId: string): boolean {
  return models.has(upstreamModelId);
}

function safeNonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Exact standard MiniMax H3 Image token settlement ($2.30/1M text input,
 * $1.50/1M vs $3.00/1M image input, $3.80/1M vs $7.60/1M image output).
 * Requires complete conserved token counts across input/output details.
 */
export function observedMiniMaxImageCostMicros(
  body: Record<string, unknown>,
  upstreamModelId = 'MiniMax-H3-Image',
  expectedCount?: number,
): number | null {
  if (!isMiniMaxImageModel(upstreamModelId)) return null;
  if (!body.usage || typeof body.usage !== 'object' || Array.isArray(body.usage)) return null;
  const usage = providerObject(body.usage);
  const inputTokens = safeNonnegativeInt(usage.input_tokens);
  const outputTokens = safeNonnegativeInt(usage.output_tokens);
  const totalTokens = safeNonnegativeInt(usage.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  if (inputTokens + outputTokens !== totalTokens) return null;

  if (
    !usage.input_tokens_details ||
    typeof usage.input_tokens_details !== 'object' ||
    Array.isArray(usage.input_tokens_details)
  )
    return null;
  const inputDetails = providerObject(usage.input_tokens_details);
  const textTokens = safeNonnegativeInt(inputDetails.text_tokens);
  const imageTokens = safeNonnegativeInt(inputDetails.image_tokens);
  if (textTokens === null || imageTokens === null) return null;
  if (textTokens + imageTokens !== inputTokens) return null;

  if (usage.output_tokens_details !== undefined) {
    if (
      typeof usage.output_tokens_details !== 'object' ||
      Array.isArray(usage.output_tokens_details)
    )
      return null;
    const outDetails = providerObject(usage.output_tokens_details);
    const outText =
      outDetails.text_tokens === undefined ? 0 : safeNonnegativeInt(outDetails.text_tokens);
    const outImage =
      outDetails.image_tokens === undefined
        ? outputTokens
        : safeNonnegativeInt(outDetails.image_tokens);
    if (outText === null || outImage === null || outText !== 0 || outImage !== outputTokens)
      return null;
  }

  if (usage.generated_images !== undefined) {
    const generated = safeNonnegativeInt(usage.generated_images);
    if (generated === null) return null;
    if (expectedCount !== undefined && generated !== expectedCount) return null;
  }

  const isHighspeed = upstreamModelId === 'MiniMax-H3-Image-Highspeed';
  const imageInNano = isHighspeed ? 3_000n : 1_500n;
  const imageOutNano = isHighspeed ? 7_600n : 3_800n;
  const nanoUsd =
    BigInt(textTokens) * 2_300n +
    BigInt(imageTokens) * imageInNano +
    BigInt(outputTokens) * imageOutNano;
  const micros = (nanoUsd + NANO_PER_MICRO - 1n) / NANO_PER_MICRO;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

function minimaxCustomSize(size: NonNullable<GenerationArguments['size']>): string | null {
  const { width, height } = size;
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height >= 655_360 &&
    width * height <= 20_000_000 &&
    width / height >= 1 / 3 &&
    width / height <= 3
    ? `${width}x${height}`
    : null;
}

function minimaxAspectRatio(
  aspectRatio: string | undefined,
  operation: 'text-to-image' | 'image-edit',
): string | null {
  if (aspectRatio === undefined || aspectRatio === 'auto') return 'auto';
  if (aspectRatio === 'source') return operation === 'image-edit' ? 'auto' : null;
  const match = /^(\d+):(\d+)$/.exec(aspectRatio);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || w > 300 || h < 1 || h > 300)
    return null;
  if (w / h < 1 / 3 || w / h > 3) return null;
  return `${w}:${h}`;
}

export function createMiniMaxImageAdapter(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    captureOutputs?: CaptureProviderOutputs;
  } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields = (context: Omit<AdapterContext, 'jobId'>): (keyof GenerationArguments)[] => [
    'prompt',
    'resolution',
    'size',
    'aspectRatio',
    'references',
    'count',
    'outputFormat',
    'outputCompression',
    ...(context.input.operation === 'text-to-image' ? ['promptExpansion' as const] : []),
  ];

  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (
      context.deployment.providerId !== 'minimax' ||
      !isMiniMaxImageModel(context.route.upstreamModelId)
    )
      return 'Unsupported MiniMax image deployment/model.';
    if (!['text-to-image', 'image-edit'].includes(context.input.operation))
      return 'Unsupported MiniMax image operation.';
    const issue = adapterInputIssue(context, fields(context));
    if (issue) return issue;
    const typeIssue = referenceTypeIssue(context.input);
    if (typeIssue) return typeIssue;

    const args = context.input.input;
    if ((args.prompt ?? '').length > 50_000)
      return 'MiniMax image prompt exceeds 50,000 characters.';
    const refs = referenceUrls(context.input);
    if (context.input.operation === 'text-to-image' && refs.length)
      return 'Text-to-image does not accept reference images.';
    if (context.input.operation === 'image-edit' && (refs.length < 1 || refs.length > 16))
      return 'MiniMax image edits require 1–16 reference images.';

    if (args.size) {
      if (!minimaxCustomSize(args.size))
        return 'MiniMax custom image dimensions require 655,360–20,000,000 pixels and an aspect ratio within 1:3–3:1.';
    } else {
      const tier = (args.resolution ?? '2K').toUpperCase();
      if (!['1K', '2K', '4K'].includes(tier))
        return 'MiniMax H3 Image supports 1K, 2K or 4K area tiers.';
      const ratio = minimaxAspectRatio(
        args.aspectRatio,
        context.input.operation as 'text-to-image' | 'image-edit',
      );
      if (!ratio)
        return 'MiniMax H3 Image requires an integer X:Y aspect ratio within 1:3–3:1 (1–300 per side) or auto.';
      const disablePromptEnhanced =
        context.input.operation === 'text-to-image' &&
        (args.promptExpansion === false ||
          args.promptExpansion === 'none' ||
          args.promptExpansion === 'disabled');
      if (disablePromptEnhanced && ratio === 'auto')
        return 'MiniMax H3 Image requires an explicit X:Y aspect ratio when prompt enhancement is disabled without custom pixel dimensions.';
    }

    if (
      args.promptExpansion !== undefined &&
      ![false, true, 'disabled', 'none', 'balanced', 'quality'].includes(args.promptExpansion)
    )
      return 'Unsupported MiniMax prompt expansion setting.';
    if (
      args.count !== undefined &&
      (!Number.isInteger(args.count) || args.count < 1 || args.count > 10)
    )
      return 'MiniMax image count must be 1–10.';
    if (args.outputFormat && !['png', 'jpeg', 'webp'].includes(args.outputFormat))
      return 'Unsupported MiniMax image output format.';
    if (
      args.outputCompression !== undefined &&
      (args.outputFormat === undefined || args.outputFormat === 'png')
    )
      return 'MiniMax output compression requires JPEG or WebP.';
    return null;
  }

  return {
    id: 'minimax',
    supportedOperations: ['text-to-image', 'image-edit'],
    inputFields: fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'minimax' &&
      deployment.providerId === 'minimax' &&
      isMiniMaxImageModel(route.upstreamModelId) &&
      Boolean(env.MINIMAX_API_KEY),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      if (!env.MINIMAX_API_KEY)
        throw new SubmissionRejected('Configure MINIMAX_API_KEY for MiniMax.');
      const args = context.input.input;
      const expectedCount = args.count ?? 1;
      const format = (args.outputFormat ?? 'png') as 'png' | 'jpeg' | 'webp';
      const expectedMediaType = `image/${format}` as 'image/png' | 'image/jpeg' | 'image/webp';
      const customSize = args.size ? minimaxCustomSize(args.size) : null;
      const disablePromptEnhanced =
        args.promptExpansion === false ||
        args.promptExpansion === 'none' ||
        args.promptExpansion === 'disabled';

      const body = await submitProviderJson(
        request,
        'MiniMax',
        `https://api.minimax.io/v1/images/${context.input.operation === 'image-edit' ? 'edits' : 'generations'}`,
        { Authorization: `Bearer ${env.MINIMAX_API_KEY}` },
        {
          model: context.route.upstreamModelId,
          prompt: args.prompt,
          n: expectedCount,
          output_format: format,
          response_format: 'url',
          ...(customSize
            ? { size: customSize }
            : {
                size: 'auto',
                area: (args.resolution ?? '2K').toUpperCase(),
                aspect_ratio: minimaxAspectRatio(
                  args.aspectRatio,
                  context.input.operation as 'text-to-image' | 'image-edit',
                ),
              }),
          ...(args.outputCompression === undefined
            ? {}
            : { output_compression: args.outputCompression }),
          ...(context.input.operation === 'text-to-image'
            ? { disable_prompt_enhanced: disablePromptEnhanced }
            : { images: referenceUrls(context.input).map((image_url) => ({ image_url })) }),
        },
        { timeoutMs: 600_000 },
      );

      const topError = providerObject(body.error);
      if (typeof topError.code === 'string' || typeof topError.message === 'string') {
        return {
          immediateResult: {
            status: 'failed',
            failureCategory: 'unknown',
            error: 'MiniMax image generation failed. Billing requires provider reconciliation.',
            billedCostMicros: null,
          },
        };
      }

      if (!Array.isArray(body.data) || body.data.length !== expectedCount)
        throw new SubmissionUnknown(
          'MiniMax did not return the requested image items. Billing requires reconciliation.',
        );

      const items = body.data.map(providerObject);
      const itemErrors = items.filter((item) => item.error !== undefined && item.error !== null);
      if (itemErrors.length === expectedCount) {
        return {
          immediateResult: {
            status: 'failed',
            failureCategory: 'policy',
            error: 'MiniMax withheld all requested images.',
            billedCostMicros: observedMiniMaxImageCostMicros(
              body,
              context.route.upstreamModelId,
              0,
            ),
          },
        };
      }
      if (itemErrors.length > 0) {
        throw new SubmissionUnknown(
          'MiniMax withheld part of a multi-image generation. Billing requires reconciliation.',
        );
      }

      const sources: DeliverySource[] = [];
      const outputs: OutputAsset[] = [];
      for (const item of items) {
        if (typeof item.url !== 'string' || !isPublicHttpsAssetUrl(item.url)) {
          throw new SubmissionUnknown(
            'MiniMax image response has no usable HTTPS asset URL. Billing requires reconciliation.',
          );
        }
        sources.push({
          kind: 'url',
          url: item.url,
          mediaType: expectedMediaType,
          refreshable: false,
        });
        outputs.push({
          url: item.url,
          mediaType: expectedMediaType,
          fidelity: 'unverified',
        });
      }

      const billedCostMicros = observedMiniMaxImageCostMicros(
        body,
        context.route.upstreamModelId,
        expectedCount,
      );
      if (options.captureOutputs) {
        return {
          immediateResult: await captureProviderResult(
            options.captureOutputs,
            context,
            sources,
            billedCostMicros,
          ),
        };
      }
      return {
        immediateResult: {
          status: 'succeeded',
          billedCostMicros,
          outputs,
        },
      };
    },
    async poll() {
      throw new Error(
        'The MiniMax Images endpoint returns a synchronous result, not a pollable task.',
      );
    },
  };
}
