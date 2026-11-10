import type { GenerateInput, Quote, RouteMetrics } from '@media-router/contracts';
import {
  addMicros,
  assertMicros,
  BillingFeeError,
  classifyRoutingService,
  createFeeSnapshot,
  routingFeeMicros,
  type AdmissionFeeSnapshot,
  type FeePolicy,
  type RoutingServiceClassification,
} from './billing-fees.js';

interface QuoteOptions {
  executableRouteIds?: string[];
  metrics?: RouteMetrics[];
}

const BASIS_POINT_SCALE = 10_000n;
const FIXTURE_REVIEW_DELAY_MS = 48 * 60 * 60 * 1000;

function feeQuoteError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

/** Quote the effective routing input after the caller applies workspace policy. */
export function quoteWithGenerationFee(
  input: GenerateInput,
  options: QuoteOptions,
  quote: (input: GenerateInput, options?: QuoteOptions) => Quote,
  policy: FeePolicy | undefined,
  now: Date = new Date(),
): { quote: Quote; snapshot: AdmissionFeeSnapshot | null } {
  const acceptance = input.feeAcceptance;
  if (acceptance === undefined) return { quote: quote(input, options), snapshot: null };

  if (!policy || policy.schemaVersion !== 1 || policy.activation !== 'fixture')
    throw feeQuoteError('fee_policy_unavailable', 'Generation fee terms are unavailable.', 503);
  if (
    !acceptance ||
    acceptance.policyId !== policy.id ||
    acceptance.policyVersion !== policy.version
  )
    throw feeQuoteError(
      'fee_policy_mismatch',
      'Generation fee terms changed. Request a new quote before accepting the fee policy.',
      409,
    );
  if (input.billing !== undefined && input.billing !== 'managed')
    throw feeQuoteError('fee_managed_only', 'Fee acceptance requires managed billing.', 422);

  let classification: RoutingServiceClassification;
  let customerCeiling: number;
  try {
    classification = classifyRoutingService({ routeId: input.routeId, request: input.routing });
    customerCeiling =
      input.maxCostMicros === undefined
        ? Number.MAX_SAFE_INTEGER
        : assertMicros(input.maxCostMicros, 'Customer ceiling');
  } catch (error) {
    if (error instanceof BillingFeeError)
      throw Object.assign(error, {
        statusCode: error.code === 'routing_policy_conflict' ? 409 : 400,
      });
    throw error;
  }

  let snapshot: AdmissionFeeSnapshot;
  try {
    snapshot = createFeeSnapshot({
      classification,
      billing: 'managed',
      policy,
      admittedAt: now.toISOString(),
      reviewDeadlineAt: new Date(now.getTime() + FIXTURE_REVIEW_DELAY_MS).toISOString(),
    });
  } catch (error) {
    if (error instanceof BillingFeeError || error instanceof RangeError)
      throw feeQuoteError('fee_policy_unavailable', 'Generation fee terms are unavailable.', 503);
    throw error;
  }

  const basisPoints = snapshot.appliedBasisPoints;
  // For integer provider cost P, gross is ceil(P * (10000 + bps) / 10000).
  // Its inverse keeps the existing route selection within the gross ceiling.
  const providerCeiling = Number(
    (BigInt(customerCeiling) * BASIS_POINT_SCALE) / (BASIS_POINT_SCALE + BigInt(basisPoints)),
  );
  const { feeAcceptance: _acceptance, ...providerInput } = input;
  const baseQuote = quote({ ...providerInput, maxCostMicros: providerCeiling }, options);

  const candidates = baseQuote.candidates.map((candidate) => {
    const providerEstimateMicros = candidate.estimatedCostMicros;
    let nominalFeeEstimateMicros: number | null = basisPoints === 0 ? 0 : null;
    let customerEstimateMicros: number | null = null;
    let reason = candidate.reason;
    if (providerEstimateMicros === null) {
      reason ??= 'A qualified provider estimate is required.';
    } else {
      try {
        nominalFeeEstimateMicros = routingFeeMicros(providerEstimateMicros, basisPoints);
      } catch (error) {
        if (error instanceof BillingFeeError)
          throw feeQuoteError('invalid_quote_estimate', 'The provider estimate is invalid.', 503);
        throw error;
      }
      if (providerEstimateMicros <= Number.MAX_SAFE_INTEGER - nominalFeeEstimateMicros) {
        customerEstimateMicros = addMicros(providerEstimateMicros, nominalFeeEstimateMicros);
        if (customerEstimateMicros > customerCeiling)
          reason ??= 'Estimated provider cost plus fee exceeds the customer ceiling.';
      } else {
        reason ??= 'The gross estimate exceeds supported microUSD.';
      }
    }
    return {
      ...candidate,
      executable: candidate.executable && reason === null,
      reason,
      billing: { providerEstimateMicros, nominalFeeEstimateMicros, customerEstimateMicros },
    };
  });

  const selected = candidates.find(
    (candidate) => candidate.routeId === baseQuote.selectedRouteId && candidate.executable,
  );
  const fallbacks =
    selected && classification.fallback
      ? candidates
          .filter((candidate) => candidate.routeId !== selected.routeId && candidate.executable)
          .slice(0, 3)
      : [];
  const reservationMicros = selected
    ? Math.max(
        ...[selected, ...fallbacks].map((candidate) => candidate.billing.customerEstimateMicros!),
      )
    : null;

  return {
    quote: {
      ...baseQuote,
      notices: classification.fallback
        ? [
            ...baseQuote.notices,
            'The fee fixture holds the original job when predecessor billing evidence is missing.',
          ]
        : baseQuote.notices,
      candidates,
      selectedRouteId: selected?.routeId ?? null,
      reservationMicros,
      billing: {
        policyId: snapshot.policy.id,
        policyVersion: snapshot.policy.version,
        service: classification.service,
        basisPoints,
      },
    },
    snapshot,
  };
}
