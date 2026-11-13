import { createHash } from 'node:crypto';
import type { GenerationArguments, OutputAsset } from '@media-router/contracts';
import {
  adapterInputIssue,
  referenceUrls,
  referenceTypeIssue,
  assetReferenceUrl,
  SubmissionRejected,
  SubmissionUnknown,
  type AdapterContext,
  type ProviderAdapter,
} from './adapters.js';
import { providerObject, submitProviderJson } from './provider-http.js';
import { detectedMediaType } from './output.js';
import { captureProviderResult, type CaptureProviderOutputs } from './adapter-output.js';
import type { DeliverySource } from './delivery.js';

const models = new Set(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
const NANO_PER_MICRO = 1_000n;

function safeNonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Exact standard OpenAI Images token settlement ($5/1M text input, $1.25/1M cached text,
 * $8/1M image input, $30/1M image output). Requires complete conserved token counts.
 */
export function observedOpenAICostMicros(body: Record<string, unknown>): number | null {
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

  const cachedTokens =
    inputDetails.cached_tokens === undefined ? 0 : safeNonnegativeInt(inputDetails.cached_tokens);
  if (cachedTokens === null || cachedTokens > inputTokens) return null;
  // Without a modality-specific cached breakdown, cached tokens are only unambiguous when one input modality is zero.
  if (cachedTokens > 0 && textTokens > 0 && imageTokens > 0) return null;

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

  const cachedTextTokens = imageTokens === 0 ? cachedTokens : 0;
  const cachedImageTokens = textTokens === 0 ? cachedTokens : 0;
  const uncachedTextTokens = textTokens - cachedTextTokens;
  const uncachedImageTokens = imageTokens - cachedImageTokens;

  const nanoUsd =
    BigInt(uncachedTextTokens) * 5_000n +
    BigInt(cachedTextTokens) * 1_250n +
    BigInt(uncachedImageTokens) * 8_000n +
    BigInt(cachedImageTokens) * 2_000n +
    BigInt(outputTokens) * 30_000n;
  const micros = (nanoUsd + NANO_PER_MICRO - 1n) / NANO_PER_MICRO;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}
export interface StoredProviderOutput {
  jobId: string;
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
}
export type StoreProviderOutput = (asset: StoredProviderOutput) => Promise<OutputAsset>;
export type StoreProviderImage = StoreProviderOutput;

/** Exact documented pixel dimensions; unsupported requests are never silently resized. */
export function openAIImageSize(resolution: string, aspectRatio = '1:1'): string | null {
  const tier = resolution.toUpperCase();
  if (tier === '4K') {
    return aspectRatio === '16:9' ? '3840x2160' : aspectRatio === '9:16' ? '2160x3840' : null;
  }
  if (tier !== '1K' && tier !== '2K') return null;
  const sizes: Record<string, [number, number]> =
    tier === '2K'
      ? {
          '1:1': [2048, 2048],
          '16:9': [2048, 1152],
          '9:16': [1152, 2048],
          '4:3': [2048, 1536],
          '3:4': [1536, 2048],
        }
      : {
          '1:1': [1024, 1024],
          '16:9': [1280, 720],
          '9:16': [720, 1280],
          '4:3': [1024, 768],
          '3:4': [768, 1024],
        };
  const size = sizes[aspectRatio];
  return size ? `${size[0]}x${size[1]}` : null;
}

export function openAIArgumentSize(args: GenerationArguments): string | null {
  if (!args.size) return openAIImageSize(args.resolution ?? '', args.aspectRatio);
  const { width, height } = args.size;
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    Math.max(width, height) <= 3840 &&
    width * height >= 655360 &&
    width * height <= 8294400 &&
    width / height >= 1 / 3 &&
    width / height <= 3
    ? `${width}x${height}`
    : null;
}

/** GPT Image returns bytes. An operator-configured output store is required before admission. */
export function createOpenAIAdapter(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    storeOutput?: StoreProviderImage;
    captureOutputs?: CaptureProviderOutputs;
  } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'resolution',
    'size',
    'aspectRatio',
    'references',
    'mask',
    'quality',
    'count',
    'outputFormat',
    'outputCompression',
    'background',
  ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (context.deployment.providerId !== 'openai' || !models.has(context.route.upstreamModelId))
      return 'Unsupported OpenAI image deployment/model.';
    if (!['text-to-image', 'image-edit'].includes(context.input.operation))
      return 'Unsupported OpenAI image operation.';
    const issue = adapterInputIssue(context, fields);
    if (issue) return issue;
    const args = context.input.input,
      typeIssue = referenceTypeIssue(context.input);
    if (typeIssue) return typeIssue;
    const refs = referenceUrls(context.input);
    if (context.input.operation === 'text-to-image' && (refs.length || args.mask))
      return 'Text-to-image does not accept reference images or a mask.';
    if (context.input.operation === 'image-edit' && (refs.length < 1 || refs.length > 16))
      return 'OpenAI edits require1–16 reference images.';
    if (!openAIArgumentSize(args)) return 'Unsupported exact OpenAI dimensions.';
    const qualities =
      context.route.upstreamModelId === 'gpt-image-2'
        ? ['auto', 'low', 'medium', 'high']
        : ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (args.quality && !qualities.includes(args.quality)) return 'Unsupported model quality.';
    if (
      args.count !== undefined &&
      (!Number.isInteger(args.count) || args.count < 1 || args.count > 10)
    )
      return 'OpenAI image count must be1–10.';
    if (args.outputFormat && !['png', 'jpeg', 'webp'].includes(args.outputFormat))
      return 'Unsupported image output format.';
    if (
      args.outputCompression !== undefined &&
      (args.outputFormat === undefined || args.outputFormat === 'png')
    )
      return 'Output compression requires JPEG or WebP.';
    if (args.background === 'transparent' && args.outputFormat === 'jpeg')
      return 'Transparent output requires PNG or WebP.';
    return null;
  }
  return {
    id: 'openai',
    supportedOperations: ['text-to-image', 'image-edit'],
    inputFields: () => fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'openai' &&
      deployment.providerId === 'openai' &&
      models.has(route.upstreamModelId) &&
      Boolean(env.OPENAI_API_KEY && (options.captureOutputs || options.storeOutput)),
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      if (!env.OPENAI_API_KEY || !(options.captureOutputs || options.storeOutput))
        throw new SubmissionRejected('Configure OPENAI_API_KEY and a private output store.');
      const body = await submitProviderJson(
        request,
        'OpenAI',
        `https://api.openai.com/v1/images/${context.input.operation === 'image-edit' ? 'edits' : 'generations'}`,
        { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        {
          model: context.route.upstreamModelId,
          prompt: context.input.input.prompt,
          n: context.input.input.count ?? 1,
          size: openAIArgumentSize(context.input.input),
          quality: context.input.input.quality ?? 'medium',
          output_format: context.input.input.outputFormat ?? 'png',
          ...(context.input.input.background === undefined
            ? {}
            : { background: context.input.input.background }),
          ...(context.input.input.outputCompression === undefined
            ? {}
            : { output_compression: context.input.input.outputCompression }),
          ...(context.input.operation === 'image-edit'
            ? {
                images: referenceUrls(context.input).map((image_url) => ({ image_url })),
                ...(context.input.input.mask
                  ? { mask: { image_url: assetReferenceUrl(context.input.input.mask) } }
                  : {}),
              }
            : {}),
          safety_identifier: createHash('sha256')
            .update(`opengen:${context.workspaceId ?? context.jobId}`)
            .digest('hex'),
        },
        { timeoutMs: 90_000, maxBytes: 32_000_000 },
      );
      if (!Array.isArray(body.data) || body.data.length !== (context.input.input.count ?? 1))
        throw new SubmissionUnknown();
      const expected = `image/${context.input.input.outputFormat ?? 'png'}` as
        'image/png' | 'image/jpeg' | 'image/webp';
      const outputs: OutputAsset[] = [];
      const sources: DeliverySource[] = [];
      for (const item of body.data) {
        const image = providerObject(item);
        if (
          typeof image.b64_json !== 'string' ||
          !image.b64_json ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json) ||
          image.b64_json.length % 4 !== 0
        )
          throw new SubmissionUnknown();
        const bytes = Buffer.from(image.b64_json, 'base64');
        if (detectedMediaType(bytes) !== expected)
          throw new SubmissionUnknown('Generated image did not match the requested file format.');
        sources.push({ kind: 'inline', bytes, mediaType: expected });
      }
      const billedCostMicros = observedOpenAICostMicros(body);
      // Checkpoint all slots together before the first output PUT. Losing an inline-only
      // synchronous response before this callback persists it cannot be repaired by polling.
      if (options.captureOutputs)
        return {
          immediateResult: await captureProviderResult(
            options.captureOutputs,
            context,
            sources,
            billedCostMicros,
          ),
        };
      for (const source of sources) {
        if (source.kind !== 'inline') throw new Error('Expected inline OpenAI image.');
        try {
          const stored = await options.storeOutput!({
            jobId: context.jobId,
            bytes: source.bytes,
            mediaType: expected,
          });
          const parsed = new URL(stored.url);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid stored URL');
          outputs.push({ ...stored, mediaType: expected, fidelity: 'unverified' });
        } catch {
          throw new SubmissionUnknown(
            'The provider generated image data but storage failed. No render was retried.',
          );
        }
      }
      return { immediateResult: { status: 'succeeded', billedCostMicros, outputs } };
    },
    async poll() {
      throw new Error(
        'The OpenAI Images endpoint returns a synchronous result, not a pollable task.',
      );
    },
  };
}
