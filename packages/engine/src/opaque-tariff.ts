import {
  resolveRouteUpstreamModelId,
  type GenerateInput,
  type Rate,
  type Route,
} from '@media-router/contracts';
import { isMiniMaxImageModel } from './minimax-image.js';

/**
 * Providers whose task/prediction APIs do not return authoritative per-request USD charges
 * (or where billing-events polling is unconfigured). On verified output delivery, OpenGen can
 * settle the customer immediately at the agreed frozen published tariff while leaving
 * `upstream_cost_micros = null` for independent supplier-invoice reconciliation.
 */
export const OPAQUE_TARIFF_ADAPTERS = new Set(['runway', 'replicate', 'minimax', 'fal']);

export function isOpaqueBillingRoute(route: Pick<Route, 'adapter' | 'upstreamModelId'>): boolean {
  if (!route.adapter || !OPAQUE_TARIFF_ADAPTERS.has(route.adapter)) return false;
  // First-party MiniMax H3 Image auto-settles from conserved token usage.
  if (route.adapter === 'minimax' && isMiniMaxImageModel(route.upstreamModelId)) return false;
  return true;
}

function publishedRateForRoute(
  route: Route,
  operation: GenerateInput['operation'],
  resolution: string | undefined,
): Rate | undefined {
  const target = (resolution ?? '').toLowerCase();
  const specific = route.rates.find(
    (rate) => rate.operation === operation && (rate.resolution ?? '').toLowerCase() === target,
  );
  if (specific) return specific;
  return route.rates.find(
    (rate) => !rate.operation && (rate.resolution ?? '').toLowerCase() === target,
  );
}

/**
 * Computes the deterministic customer charge for an opaque-provider job whose output delivery
 * has been verified (`delivery_status === 'available'`). Mirrors `quote()` exclusions so only
 * complete, fixed-tariff configurations qualify; returns null for token-billed routes,
 * variable-input edits/references, custom sizes, or special unpriced modes.
 */
export function opaquePublishedTariffChargeMicros(
  route: Route,
  input: GenerateInput,
): number | null {
  if (!isOpaqueBillingRoute(route)) return null;
  if ((input.billing ?? 'managed') !== 'managed') return null;
  const args = input.input;
  const rate = publishedRateForRoute(route, input.operation, args.resolution);
  if (!rate) return null;

  const extraInputs = Boolean(
    args.references?.length ||
    args.sourceVideo ||
    args.mask ||
    args.elements?.length ||
    args.keyframes?.length ||
    input.previousJobId,
  );
  if (extraInputs || args.size) return null;

  const upstream = resolveRouteUpstreamModelId(route, input.operation);
  const count = args.count ?? 1;
  const modelExtras = Boolean(
    args.draft ||
    args.draftJobId ||
    args.targetAudio ||
    args.layers ||
    args.thinking ||
    args.grounding ||
    args.shots?.length ||
    args.codec ||
    args.bitrateMode ||
    ((upstream === 'grok-imagine-image-2.0' ||
      upstream === 'xai/grok-imagine-image/v2.0/text-to-image') &&
      (count !== 1 || ![undefined, 'low'].includes(args.quality))) ||
    (route.adapter === 'minimax' &&
      !upstream.startsWith('MiniMax-H3-Image') &&
      args.promptExpansion !== undefined &&
      (upstream !== 'MiniMax-H3-Max' ||
        ![false, 'none', 'disabled'].includes(args.promptExpansion))) ||
    ((upstream === 'minimax/h3-max/text-to-video' ||
      upstream === 'minimax/h3-max-turbo/text-to-video' ||
      upstream === 'minimax/h3/text-to-video' ||
      upstream === 'minimax/h3/image-to-video') &&
      ![undefined, false, 'none', 'disabled'].includes(args.promptExpansion)),
  );
  if (modelExtras) return null;

  let quantity: number | null;
  if (rate.unit === 'output-second') {
    quantity =
      typeof args.duration === 'number' && Number.isInteger(args.duration) && args.duration > 0
        ? args.duration
        : null;
  } else if (rate.unit === 'image') {
    quantity = Number.isInteger(count) && count > 0 ? count : null;
  } else {
    return null;
  }
  if (quantity === null) return null;

  const total = rate.usdMicros * quantity;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
