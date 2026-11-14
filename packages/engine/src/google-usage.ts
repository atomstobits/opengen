import { providerObject } from './provider-http.js';

const NANO_PER_MICRO = 1_000n;

function safeNonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nanoToMicrosCeil(nanoUsd: bigint): number | null {
  if (nanoUsd < 0n) return null;
  const micros = (nanoUsd + NANO_PER_MICRO - 1n) / NANO_PER_MICRO;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

function parseGoogleInteractionTokens(
  body: Record<string, unknown>,
  mediaModality: 'image' | 'video',
): { inputTokens: number; textAndThoughtTokens: number; mediaOutputTokens: number } | null {
  if (!body.usage || typeof body.usage !== 'object' || Array.isArray(body.usage)) return null;
  const usage = providerObject(body.usage);

  const totalTokens = safeNonnegativeInt(usage.total_tokens);
  const inputTokens = safeNonnegativeInt(usage.total_input_tokens);
  const outputTokens = safeNonnegativeInt(usage.total_output_tokens);
  if (totalTokens === null || inputTokens === null || outputTokens === null) return null;

  const thoughtTokens =
    usage.total_thought_tokens === undefined ? 0 : safeNonnegativeInt(usage.total_thought_tokens);
  const cachedTokens =
    usage.total_cached_tokens === undefined ? 0 : safeNonnegativeInt(usage.total_cached_tokens);
  const toolTokens =
    usage.total_tool_use_tokens === undefined ? 0 : safeNonnegativeInt(usage.total_tool_use_tokens);
  if (thoughtTokens === null || cachedTokens === null || toolTokens === null) return null;
  // Fail closed when cached or tool tokens appear so discounted/grounding tiers are never mispriced.
  if (cachedTokens !== 0 || toolTokens !== 0) return null;
  // Require strict token conservation across the interaction response.
  if (inputTokens + outputTokens + thoughtTokens !== totalTokens) return null;

  if (!Array.isArray(usage.output_tokens_by_modality)) return null;
  let textOutputTokens = 0;
  let mediaOutputTokens = 0;
  for (const item of usage.output_tokens_by_modality) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = providerObject(item);
    const modality = typeof entry.modality === 'string' ? entry.modality.toLowerCase() : '';
    const tokens = safeNonnegativeInt(entry.tokens);
    if (tokens === null) return null;
    if (modality === 'text') textOutputTokens += tokens;
    else if (modality === mediaModality) mediaOutputTokens += tokens;
    else if (tokens > 0) return null;
  }
  if (textOutputTokens + mediaOutputTokens !== outputTokens) return null;

  return {
    inputTokens,
    textAndThoughtTokens: textOutputTokens + thoughtTokens,
    mediaOutputTokens,
  };
}

const googleImageTokenNanoUsd: Record<string, readonly [bigint, bigint, bigint]> = {
  'gemini-nano-banana-2.1': [1_500n, 7_500n, 30_000n],
  'gemini-3-pro-image': [2_000n, 12_000n, 120_000n],
  'gemini-3.1-flash-image': [500n, 3_000n, 60_000n],
  'gemini-3.1-flash-lite-image': [250n, 1_500n, 30_000n],
};

const googleVideoOutputNanoUsd: Record<string, bigint> = {
  'gemini-omni-1.1-flash': 17_500n,
  'gemini-omni-1.2-flash': 12_000n,
};

/** Exact Gemini Developer API standard image token rates per model checkpoint. */
export function observedGoogleImageCostMicros(
  body: Record<string, unknown>,
  upstreamModelId = 'gemini-nano-banana-2.1',
): number | null {
  const rates = googleImageTokenNanoUsd[upstreamModelId];
  if (!rates) return null;
  const parsed = parseGoogleInteractionTokens(body, 'image');
  if (!parsed) return null;
  const nanoUsd =
    BigInt(parsed.inputTokens) * rates[0] +
    BigInt(parsed.textAndThoughtTokens) * rates[1] +
    BigInt(parsed.mediaOutputTokens) * rates[2];
  return nanoToMicrosCeil(nanoUsd);
}

/** Gemini Omni 1.1 ($17.50/1M video out) and 1.2 ($12/1M video out) standard token rates. */
export function observedGoogleVideoCostMicros(
  body: Record<string, unknown>,
  upstreamModelId = 'gemini-omni-1.1-flash',
): number | null {
  const videoNano = googleVideoOutputNanoUsd[upstreamModelId];
  if (videoNano === undefined) return null;
  const parsed = parseGoogleInteractionTokens(body, 'video');
  if (!parsed) return null;
  const nanoUsd =
    BigInt(parsed.inputTokens) * 1_500n +
    BigInt(parsed.textAndThoughtTokens) * 9_000n +
    BigInt(parsed.mediaOutputTokens) * videoNano;
  return nanoToMicrosCeil(nanoUsd);
}
