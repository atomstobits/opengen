import type { GenerateInput, Route, Source } from '@media-router/contracts';

export interface BoundedTokenQuote {
  estimatedCostMicros: number;
  source: Source;
  notices: string[];
}

const NANO_PER_MICRO = 1_000n;
const PROTOCOL_FRAMING_TOKENS = 64;

const openAIModels = new Set(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
const openAI1K2KRatios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const openAI4KRatios = new Set(['16:9', '9:16']);

const gptImage2OutputCeiling: Record<string, Record<'1K' | '2K' | '4K', number>> = {
  low: { '1K': 1_000, '2K': 2_500, '4K': 6_000 },
  medium: { '1K': 2_500, '2K': 5_500, '4K': 12_000 },
  high: { '1K': 6_500, '2K': 14_000, '4K': 30_000 },
  auto: { '1K': 6_500, '2K': 14_000, '4K': 30_000 },
};

const gptImage25OutputCeiling: Record<string, Record<'1K' | '2K' | '4K', number>> = {
  low: { '1K': 1_500, '2K': 3_500, '4K': 8_000 },
  medium: { '1K': 3_500, '2K': 7_500, '4K': 16_000 },
  high: { '1K': 8_000, '2K': 16_000, '4K': 32_000 },
  xhigh: { '1K': 12_000, '2K': 24_000, '4K': 48_000 },
  max: { '1K': 16_000, '2K': 32_000, '4K': 64_000 },
  auto: { '1K': 16_000, '2K': 32_000, '4K': 64_000 },
};

const googleImageRatios = new Set([
  '1:1',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
]);

const nanoBananaImageTokens: Record<'1K' | '2K' | '4K', number> = {
  '1K': 1_120,
  '2K': 1_680,
  '4K': 3_840,
};

const nanoBananaThoughtCeiling: Record<'minimal' | 'medium' | 'high', number> = {
  minimal: 2_048,
  medium: 8_192,
  high: 24_576,
};

const omniVideoTokensPerSecond: Record<'360p' | '720p' | '1080p' | '4K', number> = {
  '360p': 3_200,
  '720p': 6_000,
  '1080p': 12_000,
  '4K': 24_000,
};
const OMNI_THOUGHT_TOKEN_CEILING = 8_192;

function nanoToMicrosCeil(nanoUsd: bigint): number | null {
  if (nanoUsd < 0n) return null;
  const micros = (nanoUsd + NANO_PER_MICRO - 1n) / NANO_PER_MICRO;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/** Conservative UTF-8 byte upper bound for byte-fallback BPE / SentencePiece text inputs. */
function maxTextTokens(...texts: (string | undefined)[]): number {
  let bytes = PROTOCOL_FRAMING_TOKENS;
  for (const text of texts) {
    if (text) bytes += Buffer.byteLength(text, 'utf8');
  }
  return bytes;
}

function openAIBoundedQuote(route: Route, input: GenerateInput): BoundedTokenQuote | null {
  if (
    route.adapter !== 'openai' ||
    route.deploymentId !== 'openai-undisclosed' ||
    !openAIModels.has(route.upstreamModelId) ||
    input.operation !== 'text-to-image'
  )
    return null;

  const args = input.input;
  if (args.size) return null;
  const tier = (args.resolution ?? '').toUpperCase();
  if (tier !== '1K' && tier !== '2K' && tier !== '4K') return null;
  const ratio = args.aspectRatio ?? '1:1';
  if (tier === '4K' ? !openAI4KRatios.has(ratio) : !openAI1K2KRatios.has(ratio)) return null;

  const count = args.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) return null;
  if (args.outputFormat && !['png', 'jpeg', 'webp'].includes(args.outputFormat)) return null;
  if (
    args.outputCompression !== undefined &&
    (args.outputFormat === undefined || args.outputFormat === 'png')
  )
    return null;
  if (args.background === 'transparent' && args.outputFormat === 'jpeg') return null;

  const quality = args.quality ?? 'medium';
  const ceilings =
    route.upstreamModelId === 'gpt-image-2' ? gptImage2OutputCeiling : gptImage25OutputCeiling;
  const perImageOutputTokens = ceilings[quality]?.[tier];
  if (!perImageOutputTokens) return null;

  const promptTokens = maxTextTokens(args.prompt);
  const outputTokens = count * perImageOutputTokens;
  // Standard rates per 1M tokens: $5 text input (5,000 nano-USD/tok), $30 image output (30,000 nano-USD/tok).
  const nanoUsd = BigInt(promptTokens) * 5_000n + BigInt(outputTokens) * 30_000n;
  const estimatedCostMicros = nanoToMicrosCeil(nanoUsd);
  if (estimatedCostMicros === null) return null;

  const url =
    route.upstreamModelId === 'gpt-image-2'
      ? 'https://developers.openai.com/api/docs/pricing#image-generation-models'
      : `https://developers.openai.com/api/docs/models/${route.upstreamModelId}`;

  return {
    estimatedCostMicros,
    source: {
      url,
      checkedAt: '2026-11-06',
      note: 'Conservative bounded max-token reservation for text-only standard generation ($5/1M text input, $30/1M image output). Image edits and custom pixel dimensions remain unpriced.',
    },
    notices: [
      `Bounded max-token reservation (${promptTokens} prompt-byte ceiling + ${outputTokens} ${tier} ${quality} image-output token ceiling at standard OpenAI token rates); settled against reported token usage on completion and unused reservation is released.`,
    ],
  };
}

function googleNanoBananaBoundedQuote(
  route: Route,
  input: GenerateInput,
): BoundedTokenQuote | null {
  if (
    route.adapter !== 'google' ||
    route.deploymentId !== 'google-undisclosed' ||
    route.upstreamModelId !== 'gemini-nano-banana-2.1' ||
    input.operation !== 'text-to-image'
  )
    return null;

  const args = input.input;
  if (args.size || args.grounding) return null;
  if ((args.count ?? 1) !== 1) return null;
  if (args.outputFormat && !['png', 'jpeg'].includes(args.outputFormat)) return null;
  if (args.aspectRatio && !googleImageRatios.has(args.aspectRatio)) return null;

  const tier = (args.resolution ?? '').toUpperCase();
  if (tier !== '1K' && tier !== '2K' && tier !== '4K') return null;
  const thinking = (args.thinkingLevel ?? 'medium') as 'minimal' | 'medium' | 'high';
  const thoughtTokens = nanoBananaThoughtCeiling[thinking];
  const imageTokens = nanoBananaImageTokens[tier];
  if (!thoughtTokens || !imageTokens) return null;

  const inputTokens = maxTextTokens(args.prompt, args.systemPrompt);
  // Standard rates per 1M tokens: $1.50 input (1,500 nano-USD/tok), $7.50 text/thinking (7,500 nano-USD/tok), $30 image output (30,000 nano-USD/tok).
  const nanoUsd =
    BigInt(inputTokens) * 1_500n + BigInt(thoughtTokens) * 7_500n + BigInt(imageTokens) * 30_000n;
  const estimatedCostMicros = nanoToMicrosCeil(nanoUsd);
  if (estimatedCostMicros === null) return null;

  return {
    estimatedCostMicros,
    source: {
      url: 'https://aistudio.google.com/docs/pricing#gemini-nano-banana-2.1',
      checkedAt: '2026-11-02',
      note: 'Conservative bounded max-token reservation for single-output text-to-image without grounding ($1.50/1M input, $7.50/1M thinking/text output, $30/1M image output). Reference/edit operations remain unpriced.',
    },
    notices: [
      `Bounded max-token reservation (${inputTokens} input-byte ceiling + ${thoughtTokens} ${thinking}-thinking ceiling + ${imageTokens} ${tier} image-output tokens at standard Gemini Developer API rates); settled against reported modality token usage when unambiguous.`,
    ],
  };
}

function googleOmniBoundedQuote(route: Route, input: GenerateInput): BoundedTokenQuote | null {
  if (
    route.adapter !== 'google' ||
    route.deploymentId !== 'google-undisclosed' ||
    route.upstreamModelId !== 'gemini-omni-1.1-flash' ||
    input.operation !== 'text-to-video'
  )
    return null;

  const args = input.input;
  if ((args.count ?? 1) !== 1) return null;
  if (args.audio === false) return null;
  if (args.outputFormat && args.outputFormat !== 'mp4') return null;
  if (args.aspectRatio && !['16:9', '9:16'].includes(args.aspectRatio)) return null;
  if (typeof args.duration !== 'number' || !Number.isInteger(args.duration)) return null;
  if (args.duration < 3 || args.duration > 10) return null;

  const normalizedRes =
    (args.resolution ?? '').toUpperCase() === '4K'
      ? '4K'
      : ((args.resolution ?? '').toLowerCase() as '360p' | '720p' | '1080p');
  const perSecondTokens = omniVideoTokensPerSecond[normalizedRes];
  if (!perSecondTokens) return null;

  const inputTokens = maxTextTokens(args.prompt);
  const videoTokens = args.duration * perSecondTokens;
  // Standard rates per 1M tokens: $1.50 input (1,500 nano-USD/tok), $9.00 text/thinking (9,000 nano-USD/tok), $17.50 video output (17,500 nano-USD/tok).
  const nanoUsd =
    BigInt(inputTokens) * 1_500n +
    BigInt(OMNI_THOUGHT_TOKEN_CEILING) * 9_000n +
    BigInt(videoTokens) * 17_500n;
  const estimatedCostMicros = nanoToMicrosCeil(nanoUsd);
  if (estimatedCostMicros === null) return null;

  return {
    estimatedCostMicros,
    source: {
      url: 'https://aistudio.google.com/docs/pricing#gemini-omni-1.1-flash',
      checkedAt: '2026-11-02',
      note: 'Conservative bounded max-token reservation for single-output text-to-video ($1.50/1M input, $9/1M thinking/text output, $17.50/1M video output). Frame, reference, edit and continuation operations remain unpriced.',
    },
    notices: [
      `Bounded max-token reservation (${inputTokens} input-byte ceiling + ${OMNI_THOUGHT_TOKEN_CEILING} thinking/text ceiling + ${videoTokens} ${normalizedRes} video-output token ceiling for ${args.duration}s at standard Gemini Developer API rates); settled against reported modality token usage when unambiguous.`,
    ],
  };
}

/**
 * Deterministic conservative token ceilings for first-party token-priced text-only routes.
 * Flat per-output `route.rates` remain empty on token-billed routes so public tables never
 * misrepresent variable token billing as a fixed per-image or per-second list fee.
 */
export function boundedTokenQuote(route: Route, input: GenerateInput): BoundedTokenQuote | null {
  return (
    openAIBoundedQuote(route, input) ??
    googleNanoBananaBoundedQuote(route, input) ??
    googleOmniBoundedQuote(route, input)
  );
}
