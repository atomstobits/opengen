/** Maintenance-only evidence review. This module never evaluates a formula or changes a route. */
export type PriceScope =
  { kind: 'public-list' } | { kind: 'operator-contract' | 'private-byok'; scopeRef: string };

export interface PriceTarget {
  providerId: string;
  endpointId: string;
  modelId: string;
  deploymentId: string;
  operation: string;
  endpointRegion: string | null;
  inferenceScope: string | null;
  scope: PriceScope;
}

export interface PriceEvidence {
  target: PriceTarget;
  source: { url: string; checkedAt: string; sha256: string };
  basis:
    | 'published-tariff'
    | 'contract-tariff'
    | 'account-tariff'
    | 'historical-estimate'
    | 'billing-unit-header'
    | 'unknown';
  currency: 'USD' | null;
  /** Informational rate for the stated unit; no request total is computed here. */
  rateMicros: number | null;
  unit: string | null;
  rounding: string | null;
  /** An identifier for reviewed code, never a user-supplied expression. */
  formula:
    | { state: 'unknown' }
    | { state: 'qualified'; implementationId: string; reviewRef: string; testRefs: string[] };
}

export interface PriceQualification {
  qualifiedForProposal: boolean;
  publicListEligible: boolean;
  /** Tariffs, estimates and headers are never proof of an actual settled charge. */
  actualChargeKnown: false;
  manualApprovalRequired: true;
  reasons: string[];
}

export type PublicPriceEvidence = Pick<
  PriceEvidence,
  'target' | 'source' | 'currency' | 'rateMicros' | 'unit' | 'rounding'
> & { basis: 'published-tariff' };

const identityFields = [
  'providerId',
  'endpointId',
  'modelId',
  'deploymentId',
  'operation',
  'endpointRegion',
  'inferenceScope',
] as const;
const tariffBasis = {
  'public-list': 'published-tariff',
  'operator-contract': 'contract-tariff',
  'private-byok': 'account-tariff',
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum = 200): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validTarget(value: unknown): value is PriceTarget {
  if (!record(value)) return false;
  for (const key of identityFields) {
    if (key === 'endpointRegion' || key === 'inferenceScope') {
      if (value[key] !== null && !boundedText(value[key])) return false;
    } else if (!boundedText(value[key])) return false;
  }
  const scope = value.scope;
  if (!record(scope)) return false;
  if (scope.kind === 'public-list') return Object.keys(scope).length === 1;
  return (
    (scope.kind === 'operator-contract' || scope.kind === 'private-byok') &&
    typeof scope.scopeRef === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(scope.scopeRef) &&
    Object.keys(scope).length === 2
  );
}

function sameScope(left: PriceScope, right: PriceScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'public-list' ||
      (right.kind !== 'public-list' && left.scopeRef === right.scopeRef))
  );
}

function sourceErrors(value: unknown): string[] {
  if (!record(value)) return ['missing_source'];
  const errors: string[] = [];
  try {
    if (!boundedText(value.url, 2048)) throw new Error('invalid URL');
    const url = new URL(value.url);
    // Query strings can carry account credentials; retain a clean documentation URL instead.
    if (url.protocol !== 'https:' || url.username || url.password || url.search)
      throw new Error('unsafe URL');
  } catch {
    errors.push('invalid_source_url');
  }
  const date = value.checkedAt;
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    errors.push('invalid_source_date');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256))
    errors.push('invalid_source_hash');
  return errors;
}

/** Completeness gate for a proposed tariff review, not runtime pricing or source verification. */
export function qualifyPriceEvidence(evidence: unknown, target: PriceTarget): PriceQualification {
  const reasons: string[] = [];
  if (!validTarget(target)) reasons.push('invalid_target');
  if (!record(evidence) || !validTarget(evidence.target)) {
    reasons.push('invalid_evidence_target');
  } else if (validTarget(target)) {
    for (const key of identityFields) {
      if (evidence.target[key] !== target[key]) reasons.push(`target_mismatch:${key}`);
    }
    if (!sameScope(evidence.target.scope, target.scope)) reasons.push('target_mismatch:scope');
  }
  if (record(evidence)) {
    reasons.push(...sourceErrors(evidence.source));
    if (!validTarget(evidence.target) || evidence.basis !== tariffBasis[evidence.target.scope.kind])
      reasons.push('unqualified_tariff_basis');
    if (evidence.currency !== 'USD') reasons.push('unknown_currency');
    if (!Number.isSafeInteger(evidence.rateMicros) || (evidence.rateMicros as number) < 0)
      reasons.push('unknown_or_invalid_rate');
    if (!boundedText(evidence.unit)) reasons.push('unknown_unit');
    if (!boundedText(evidence.rounding, 512)) reasons.push('unknown_rounding');
    const formula = evidence.formula;
    if (
      !record(formula) ||
      formula.state !== 'qualified' ||
      !boundedText(formula.implementationId) ||
      !boundedText(formula.reviewRef) ||
      !Array.isArray(formula.testRefs) ||
      formula.testRefs.length === 0 ||
      formula.testRefs.length > 16 ||
      !formula.testRefs.every((ref) => boundedText(ref))
    )
      reasons.push('unqualified_formula');
  } else reasons.push('invalid_evidence');
  return {
    qualifiedForProposal: reasons.length === 0,
    publicListEligible: reasons.length === 0 && target.scope.kind === 'public-list',
    actualChargeKnown: false,
    manualApprovalRequired: true,
    reasons,
  };
}

/** Compare only the same qualified scope, unit and implementation; no unit conversions. */
export function comparePriceEvidence(
  left: PriceEvidence,
  right: PriceEvidence,
): { comparable: boolean; reasons: string[] } {
  const reasons = [
    ...qualifyPriceEvidence(left, left.target).reasons.map((reason) => `left:${reason}`),
    ...qualifyPriceEvidence(right, left.target).reasons.map((reason) => `right:${reason}`),
  ];
  if (left.unit !== right.unit) reasons.push('unit_mismatch');
  if (left.rounding !== right.rounding) reasons.push('rounding_mismatch');
  if (
    left.formula.state !== 'qualified' ||
    right.formula.state !== 'qualified' ||
    left.formula.implementationId !== right.formula.implementationId
  )
    reasons.push('implementation_mismatch');
  return { comparable: reasons.length === 0, reasons };
}

/** Explicit projection prevents a private discount/account reference from becoming public metadata. */
export function publicPriceEvidence(evidence: PriceEvidence): PublicPriceEvidence | null {
  if (!qualifyPriceEvidence(evidence, evidence.target).publicListEligible) return null;
  return {
    target: {
      providerId: evidence.target.providerId,
      endpointId: evidence.target.endpointId,
      modelId: evidence.target.modelId,
      deploymentId: evidence.target.deploymentId,
      operation: evidence.target.operation,
      endpointRegion: evidence.target.endpointRegion,
      inferenceScope: evidence.target.inferenceScope,
      scope: { kind: 'public-list' },
    },
    source: {
      url: evidence.source.url,
      checkedAt: evidence.source.checkedAt,
      sha256: evidence.source.sha256,
    },
    basis: 'published-tariff',
    currency: evidence.currency,
    rateMicros: evidence.rateMicros,
    unit: evidence.unit,
    rounding: evidence.rounding,
  };
}
