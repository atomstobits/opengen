/** Pure USD fee arithmetic and immutable admission records. No database/network or
 * mutable runtime configuration belongs here. Proposed commercial rules require an
 * explicit fixture policy until BILLING-POLICY-PLAN section 11 is resolved. */
export class BillingFeeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingFeeError';
  }
}
const MAX_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const BPS_SCALE = 10_000n;
export const PROPOSED_SMART_FEE_BPS = 500;
export type BillingMode = 'managed' | 'byok';
export type BillingOutcome =
  'succeeded' | 'failed' | 'cancelled' | 'delivery-partial' | 'delivery-unusable';
export type RoutingService = 'direct' | 'smart' | 'legacy';
export type FeeActivation = 'disabled' | 'fixture';
export interface RoutingFeeConstraints {
  readonly providerIds?: readonly string[];
  readonly deploymentIds?: readonly string[];
  readonly preference?: 'cost' | 'speed' | 'reliability';
  readonly fallback?: boolean;
}
export interface RoutingFeeSelection {
  readonly routeId?: string;
  readonly request?: RoutingFeeConstraints;
  readonly policy?: RoutingFeeConstraints;
}
export interface RoutingServiceClassification {
  readonly service: 'direct' | 'smart';
  readonly reason: 'exact-route' | 'single-deployment' | 'single-provider' | 'selection-service';
  readonly routeId: string | null;
  readonly providerIds: readonly string[] | null;
  readonly deploymentIds: readonly string[] | null;
  readonly preference: 'cost' | 'speed' | 'reliability';
  readonly fallback: boolean;
}
export interface FeePolicy {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly activation: FeeActivation;
  readonly basisPoints: number;
  readonly rounding: 'ceil-micro-usd';
  readonly eligibleOutcomes: readonly BillingOutcome[];
  /** Fixture proposal: collect provider base first, waive fee before absorbing base. */
  readonly overrunAllocation: 'provider-first';
}
export interface AdmissionFeeSnapshot {
  readonly schemaVersion: 1;
  readonly policy: FeePolicy;
  readonly classification: RoutingServiceClassification | null;
  readonly service: RoutingService;
  readonly billing: BillingMode;
  readonly appliedBasisPoints: number;
  readonly admittedAt: string | null;
  readonly reviewDeadlineAt: string | null;
}
const outcomes = new Set<BillingOutcome>([
  'succeeded',
  'failed',
  'cancelled',
  'delivery-partial',
  'delivery-unusable',
]);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function boundedInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new BillingFeeError(
      'invalid_integer',
      `${name} must be a nonnegative safe integer no greater than ${max}.`,
    );
  return value;
}
export function assertMicros(value: unknown, name = 'microUSD'): number {
  return boundedInteger(value, name);
}
function fromBigInt(value: bigint, name: string): number {
  if (value < 0n || value > MAX_MICROS)
    throw new BillingFeeError('money_overflow', `${name} exceeds safe integer microUSD.`);
  return Number(value);
}
export function addMicros(...values: readonly number[]): number {
  return fromBigInt(
    values.reduce((sum, value) => sum + BigInt(assertMicros(value)), 0n),
    'Money total',
  );
}
/** ceil(provider microUSD × basis points / 10000), including sub-micro fees. */
export function routingFeeMicros(providerCostMicros: number, basisPoints: number): number {
  const cost = BigInt(assertMicros(providerCostMicros, 'Provider cost'));
  const bps = BigInt(boundedInteger(basisPoints, 'Basis points', 10_000));
  return fromBigInt((cost * bps + BPS_SCALE - 1n) / BPS_SCALE, 'Routing fee');
}
function identifier(value: unknown, name: string, maxLength = 200): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new BillingFeeError('invalid_reference', `${name} must be a bounded nonempty reference.`);
  return value;
}
function identifiers(values: readonly string[] | undefined, name: string): string[] | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || !values.length || values.length > 1000)
    throw new BillingFeeError('invalid_routing', `${name} must be a nonempty bounded list.`);
  return [...new Set(values.map((value) => identifier(value, name)))].sort();
}
function intersect(a: string[] | null, b: string[] | null, name: string): string[] | null {
  const result = a && b ? a.filter((value) => b.includes(value)) : (a ?? b);
  if (result && !result.length)
    throw new BillingFeeError(
      'routing_policy_conflict',
      `Request and policy have no permitted ${name} in common.`,
    );
  return result;
}
function routing(value: RoutingFeeConstraints | undefined): RoutingFeeConstraints {
  if (!value) return {};
  if (value.fallback !== undefined && typeof value.fallback !== 'boolean')
    throw new BillingFeeError('invalid_routing', 'Fallback must be boolean.');
  if (
    value.preference !== undefined &&
    !['cost', 'speed', 'reliability'].includes(value.preference)
  )
    throw new BillingFeeError('invalid_routing', 'Unsupported routing preference.');
  return value;
}
/** Classification proposal; run only after canonical route/policy compatibility
 * checks. A singleton restriction counts as a pin; candidate count never does. */
export function classifyRoutingService(input: RoutingFeeSelection): RoutingServiceClassification {
  const request = routing(input.request),
    policy = routing(input.policy);
  const providerIds = intersect(
    identifiers(request.providerIds, 'Provider IDs'),
    identifiers(policy.providerIds, 'Policy provider IDs'),
    'providers',
  );
  const deploymentIds = intersect(
    identifiers(request.deploymentIds, 'Deployment IDs'),
    identifiers(policy.deploymentIds, 'Policy deployment IDs'),
    'deployments',
  );
  if (request.fallback === true && policy.fallback === false)
    throw new BillingFeeError(
      'routing_policy_conflict',
      'Request fallback exceeds workspace policy.',
    );
  const fallback = request.fallback ?? policy.fallback ?? false;
  const preference = request.preference ?? policy.preference ?? 'cost';
  const routeId = input.routeId === undefined ? null : identifier(input.routeId, 'Route ID');
  const reason = routeId
    ? 'exact-route'
    : deploymentIds?.length === 1
      ? 'single-deployment'
      : providerIds?.length === 1
        ? 'single-provider'
        : 'selection-service';
  if (reason !== 'selection-service' && fallback)
    throw new BillingFeeError(
      'contradictory_routing',
      'Pinned routing and fallback require an explicit service choice before admission.',
    );
  return freeze({
    service: reason === 'selection-service' ? 'smart' : 'direct',
    reason,
    routeId,
    providerIds,
    deploymentIds,
    preference,
    fallback,
  });
}
export function createFeePolicy(input: {
  id: string;
  version: number;
  activation: FeeActivation;
  basisPoints: number;
  eligibleOutcomes: readonly BillingOutcome[];
  overrunAllocation: 'provider-first';
}): FeePolicy {
  identifier(input.id, 'Policy ID');
  if (boundedInteger(input.version, 'Policy version') < 1)
    throw new BillingFeeError('invalid_policy', 'Policy version must be positive.');
  const basisPoints = boundedInteger(input.basisPoints, 'Basis points', 10_000);
  if (
    !['disabled', 'fixture'].includes(input.activation) ||
    input.overrunAllocation !== 'provider-first'
  )
    throw new BillingFeeError(
      'invalid_policy',
      'Unsupported fee activation/allocation. Production activation requires reviewed policy changes.',
    );
  if (input.activation === 'disabled' && basisPoints !== 0)
    throw new BillingFeeError('invalid_policy', 'Disabled policies must have zero basis points.');
  if (
    !Array.isArray(input.eligibleOutcomes) ||
    input.eligibleOutcomes.some((value) => !outcomes.has(value))
  )
    throw new BillingFeeError('invalid_policy', 'Fee outcome eligibility must be explicit.');
  return freeze({
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    activation: input.activation,
    basisPoints,
    overrunAllocation: input.overrunAllocation,
    eligibleOutcomes: [...new Set(input.eligibleOutcomes)].sort(),
    rounding: 'ceil-micro-usd',
  });
}
export const DEFAULT_FEE_POLICY: FeePolicy = createFeePolicy({
  id: 'fees-disabled-pending-product-decisions',
  version: 1,
  activation: 'disabled',
  basisPoints: 0,
  eligibleOutcomes: [],
  overrunAllocation: 'provider-first',
});
export const LEGACY_FEE_SNAPSHOT: AdmissionFeeSnapshot = freeze({
  schemaVersion: 1,
  policy: DEFAULT_FEE_POLICY,
  classification: null,
  service: 'legacy',
  billing: 'managed',
  appliedBasisPoints: 0,
  admittedAt: null,
  reviewDeadlineAt: null,
});
export function legacyFeeSnapshot(billing: BillingMode = 'managed'): AdmissionFeeSnapshot {
  if (billing !== 'managed' && billing !== 'byok')
    throw new BillingFeeError('invalid_billing', 'Unsupported billing mode.');
  return freeze({ ...LEGACY_FEE_SNAPSHOT, billing });
}
function timestamp(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new BillingFeeError(
      'invalid_timestamp',
      `${name} must be a canonical UTC ISO timestamp.`,
    );
  return value;
}
export function createFeeSnapshot(input: {
  classification: RoutingServiceClassification;
  billing: BillingMode;
  admittedAt: string;
  reviewDeadlineAt: string;
  policy?: FeePolicy;
}): AdmissionFeeSnapshot {
  if (input.billing !== 'managed' && input.billing !== 'byok')
    throw new BillingFeeError('invalid_billing', 'Unsupported billing mode.');
  const policy = createFeePolicy(input.policy ?? DEFAULT_FEE_POLICY);
  const classification = classifyRoutingService({
    routeId: input.classification.routeId ?? undefined,
    request: {
      providerIds: input.classification.providerIds ?? undefined,
      deploymentIds: input.classification.deploymentIds ?? undefined,
      preference: input.classification.preference,
      fallback: input.classification.fallback,
    },
  });
  if (
    classification.service !== input.classification.service ||
    classification.reason !== input.classification.reason
  )
    throw new BillingFeeError(
      'invalid_classification',
      'Admission routing classification is inconsistent.',
    );
  const admittedAt = timestamp(input.admittedAt, 'Admission time'),
    reviewDeadlineAt = timestamp(input.reviewDeadlineAt, 'Review deadline');
  if (Date.parse(reviewDeadlineAt) <= Date.parse(admittedAt))
    throw new BillingFeeError('invalid_timestamp', 'Review deadline must follow admission.');
  return freeze({
    schemaVersion: 1,
    policy,
    classification,
    service: classification.service,
    billing: input.billing,
    appliedBasisPoints:
      policy.activation === 'fixture' && classification.service === 'smart'
        ? policy.basisPoints
        : 0,
    admittedAt,
    reviewDeadlineAt,
  });
}
export type GrossReservation =
  | Readonly<{
      status: 'quoted';
      providerEstimateMicros: number | null;
      nominalFeeEstimateMicros: number;
      customerEstimateMicros: number;
      reservationMicros: number;
      customerCeilingMicros: number;
      estimateOnly: true;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'provider-estimate-unknown' | 'byok-smart-not-qualified';
    }>;
export function quoteGrossReservation(
  snapshot: AdmissionFeeSnapshot,
  providerEstimateMicros: number | null,
  customerCeilingMicros?: number,
): GrossReservation {
  validateSnapshot(snapshot);
  if (providerEstimateMicros !== null) assertMicros(providerEstimateMicros, 'Provider estimate');
  if (customerCeilingMicros !== undefined) assertMicros(customerCeilingMicros, 'Customer ceiling');
  if (snapshot.billing === 'byok' && snapshot.service === 'smart')
    return freeze({ status: 'unavailable', reason: 'byok-smart-not-qualified' });
  if (snapshot.billing === 'byok')
    return freeze({
      status: 'quoted',
      providerEstimateMicros,
      nominalFeeEstimateMicros: 0,
      customerEstimateMicros: 0,
      reservationMicros: 0,
      customerCeilingMicros: 0,
      estimateOnly: true,
    });
  if (providerEstimateMicros === null)
    return freeze({ status: 'unavailable', reason: 'provider-estimate-unknown' });
  const fee = routingFeeMicros(providerEstimateMicros, snapshot.appliedBasisPoints);
  const gross = addMicros(providerEstimateMicros, fee);
  if (customerCeilingMicros !== undefined && gross > customerCeilingMicros)
    throw new BillingFeeError(
      'budget_exceeded',
      'Gross provider estimate plus fee exceeds the customer ceiling.',
    );
  // Reservation itself is the maximum debit authority held by this pure contract.
  return freeze({
    status: 'quoted',
    providerEstimateMicros,
    nominalFeeEstimateMicros: fee,
    customerEstimateMicros: gross,
    reservationMicros: gross,
    customerCeilingMicros: Math.min(gross, customerCeilingMicros ?? gross),
    estimateOnly: true,
  });
}
export interface CostIdentity {
  readonly attemptId: string;
  readonly providerId: string;
  readonly deploymentId: string;
  readonly upstreamReference: string;
}
interface EvidenceIdentity extends CostIdentity {
  readonly reference: string;
}
export type ProviderCostEvidence =
  | (EvidenceIdentity & {
      readonly basis: 'provider-billed-usd';
      readonly currency: 'USD';
      readonly amountMicros: number;
    })
  | (EvidenceIdentity & {
      readonly basis: 'qualified-actual-usage';
      readonly complete: true;
      readonly currency: 'USD';
      readonly tariffId: string;
      readonly tariffVersion: string;
      readonly qualifiedAccountReference: string;
      readonly lines: readonly {
        readonly quantity: number;
        readonly unitRateMicros: number;
        readonly ratePerUnits: number;
      }[];
    })
  | (EvidenceIdentity & {
      readonly basis: 'operator-audited';
      readonly currency: 'USD';
      readonly amountMicros: number;
      readonly auditReference: string;
      readonly operatorId: string;
    });
export interface UnknownProviderCostEvidence {
  readonly basis: 'unknown';
  readonly reason: string;
}
export type VerifiedCostResult =
  | Readonly<{ verified: true; amountMicros: number; evidence: ProviderCostEvidence }>
  | Readonly<{ verified: false; reason: string }>;
/** The producer must authenticate provider evidence or audited operator authority.
 * This validator verifies shape, exact identity, USD arithmetic and completeness;
 * a customer-submitted object is never an authorized evidence producer. */
export function verifyProviderCostEvidence(
  evidence: unknown,
  expected: CostIdentity,
): VerifiedCostResult {
  for (const key of ['attemptId', 'providerId', 'deploymentId', 'upstreamReference'] as const)
    identifier(expected[key], `Expected ${key}`, key === 'upstreamReference' ? 256 : 200);
  if (!evidence || typeof evidence !== 'object')
    return freeze({ verified: false, reason: 'provider-cost-unreported' });
  const value = evidence as Record<string, unknown>;
  if (value.basis === 'unknown')
    return freeze({
      verified: false,
      reason:
        typeof value.reason === 'string' ? value.reason.slice(0, 200) : 'provider-cost-unknown',
    });
  if (
    !['provider-billed-usd', 'qualified-actual-usage', 'operator-audited'].includes(
      String(value.basis),
    )
  )
    return freeze({ verified: false, reason: 'unsupported-cost-basis' });
  for (const key of ['attemptId', 'providerId', 'deploymentId', 'upstreamReference'] as const) {
    if (value[key] !== expected[key])
      return freeze({ verified: false, reason: 'cost-evidence-identity-mismatch' });
  }
  if (value.currency !== 'USD')
    return freeze({ verified: false, reason: 'cost-currency-unqualified' });
  try {
    identifier(value.reference, 'Evidence reference');
    let amount: number;
    if (value.basis === 'qualified-actual-usage') {
      if (value.complete !== true)
        return freeze({ verified: false, reason: 'actual-usage-incomplete' });
      identifier(value.tariffId, 'Tariff ID');
      identifier(value.tariffVersion, 'Tariff version');
      identifier(value.qualifiedAccountReference, 'Qualified account reference');
      if (!Array.isArray(value.lines) || !value.lines.length || value.lines.length > 1000)
        return freeze({ verified: false, reason: 'actual-usage-incomplete' });
      // Sum exact rational line costs; round once at the aggregate to one microUSD.
      let numerator = 0n,
        denominator = 1n;
      for (const line of value.lines) {
        if (!line || typeof line !== 'object')
          return freeze({ verified: false, reason: 'actual-usage-incomplete' });
        const quantity = BigInt(boundedInteger(line.quantity, 'Actual usage quantity'));
        const rate = BigInt(assertMicros(line.unitRateMicros, 'Qualified unit rate'));
        const units = BigInt(boundedInteger(line.ratePerUnits, 'Tariff units'));
        if (units === 0n) return freeze({ verified: false, reason: 'invalid-usage-evidence' });
        numerator = numerator * units + quantity * rate * denominator;
        denominator *= units;
        const divisor = gcd(numerator, denominator);
        numerator /= divisor;
        denominator /= divisor;
      }
      amount = fromBigInt(
        (numerator + denominator - 1n) / denominator,
        'Verified actual usage cost',
      );
    } else {
      amount = assertMicros(value.amountMicros, 'Verified provider cost');
      if (value.basis === 'operator-audited') {
        identifier(value.auditReference, 'Audit reference');
        identifier(value.operatorId, 'Auditing operator');
      }
    }
    const identity: EvidenceIdentity = {
      attemptId: expected.attemptId,
      providerId: expected.providerId,
      deploymentId: expected.deploymentId,
      upstreamReference: expected.upstreamReference,
      reference: value.reference as string,
    };
    // Whitelist the audit fields; raw provider/customer payloads never become line items.
    const selected: ProviderCostEvidence =
      value.basis === 'qualified-actual-usage'
        ? {
            ...identity,
            basis: 'qualified-actual-usage',
            currency: 'USD',
            complete: true,
            tariffId: value.tariffId as string,
            tariffVersion: value.tariffVersion as string,
            qualifiedAccountReference: value.qualifiedAccountReference as string,
            lines: (
              value.lines as { quantity: number; unitRateMicros: number; ratePerUnits: number }[]
            ).map((line) => ({
              quantity: line.quantity,
              unitRateMicros: line.unitRateMicros,
              ratePerUnits: line.ratePerUnits,
            })),
          }
        : value.basis === 'operator-audited'
          ? {
              ...identity,
              basis: 'operator-audited',
              currency: 'USD',
              amountMicros: amount,
              auditReference: value.auditReference as string,
              operatorId: value.operatorId as string,
            }
          : { ...identity, basis: 'provider-billed-usd', currency: 'USD', amountMicros: amount };
    return freeze({ verified: true, amountMicros: amount, evidence: selected });
  } catch (error) {
    if (!(error instanceof BillingFeeError)) throw error;
    return freeze({ verified: false, reason: 'invalid-cost-evidence' });
  }
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1n;
}
function validateSnapshot(snapshot: AdmissionFeeSnapshot): void {
  if (snapshot.schemaVersion !== 1 || !['managed', 'byok'].includes(snapshot.billing))
    throw new BillingFeeError('invalid_snapshot', 'Unsupported admission fee snapshot.');
  const policy = createFeePolicy(snapshot.policy);
  if (snapshot.service === 'legacy') {
    if (
      snapshot.appliedBasisPoints !== 0 ||
      policy.basisPoints !== 0 ||
      policy.activation !== 'disabled' ||
      snapshot.classification !== null
    )
      throw new BillingFeeError('invalid_snapshot', 'Legacy jobs must retain zero fees.');
    return;
  }
  const reconstructed = createFeeSnapshot({
    classification: snapshot.classification!,
    billing: snapshot.billing,
    policy,
    admittedAt: snapshot.admittedAt!,
    reviewDeadlineAt: snapshot.reviewDeadlineAt!,
  });
  if (
    reconstructed.service !== snapshot.service ||
    reconstructed.appliedBasisPoints !== snapshot.appliedBasisPoints
  )
    throw new BillingFeeError('invalid_snapshot', 'Inconsistent applied admission fee.');
}
export interface FeeSettlementStatement {
  readonly currency: 'USD';
  readonly policyId: string;
  readonly policyVersion: number;
  readonly billing: BillingMode;
  readonly service: RoutingService;
  readonly appliedBasisPoints: number;
  readonly providerCostMicros: number;
  readonly customerProviderDebitMicros: number;
  readonly externalProviderCostMicros: number;
  readonly feeEligible: boolean;
  readonly nominalFeeMicros: number;
  readonly collectedFeeMicros: number;
  readonly waivedFeeMicros: number;
  readonly customerTotalMicros: number;
  readonly operatorOverrunMicros: number;
  readonly releasedReservationMicros: number;
  readonly evidence: ProviderCostEvidence;
  readonly outcome: BillingOutcome;
}
export type FeeSettlement =
  | Readonly<{ status: 'settled'; statement: FeeSettlementStatement }>
  | Readonly<{
      status: 'review';
      heldReservationMicros: number;
      reviewDeadlineAt: string | null;
      reason: string;
    }>;
/** Does not debit a ledger. Integrator persists this statement, debit, release,
 * key-month correction and settlement event together under the job/workspace lock. */
export function settleVerifiedCost(
  snapshot: AdmissionFeeSnapshot,
  input: {
    reservedMicros: number;
    customerCeilingMicros: number;
    evidence: unknown;
    expected: CostIdentity;
    outcome: BillingOutcome;
    billableAttemptCount?: number;
  },
): FeeSettlement {
  validateSnapshot(snapshot);
  const reserved = assertMicros(input.reservedMicros, 'Reservation'),
    ceiling = assertMicros(input.customerCeilingMicros, 'Accepted customer ceiling');
  if (!outcomes.has(input.outcome))
    throw new BillingFeeError('invalid_outcome', 'Unsupported billing outcome.');
  if (snapshot.billing === 'byok' && reserved !== 0)
    throw new BillingFeeError(
      'invalid_reservation',
      'BYOK provider cost cannot reserve managed credit.',
    );
  const review = (reason: string): FeeSettlement =>
    freeze({
      status: 'review',
      heldReservationMicros: reserved,
      reviewDeadlineAt: snapshot.reviewDeadlineAt,
      reason,
    });
  if (snapshot.billing === 'byok' && snapshot.service === 'smart')
    return review('byok-smart-not-qualified');
  const attempts = input.billableAttemptCount ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new BillingFeeError('invalid_attempt_count', 'Billable attempt count must be positive.');
  if (attempts !== 1) return review('multiple-billed-attempt-policy-unresolved');
  const cost = verifyProviderCostEvidence(input.evidence, input.expected);
  if (!cost.verified) return review(cost.reason);
  const eligible = snapshot.policy.eligibleOutcomes.includes(input.outcome);
  const nominalFee = routingFeeMicros(
    cost.amountMicros,
    eligible ? snapshot.appliedBasisPoints : 0,
  );
  const limit = snapshot.billing === 'managed' ? Math.min(reserved, ceiling) : 0;
  const baseDebit = Math.min(cost.amountMicros, limit);
  const collectedFee = Math.min(nominalFee, limit - baseDebit);
  return freeze({
    status: 'settled',
    statement: {
      currency: 'USD',
      policyId: snapshot.policy.id,
      policyVersion: snapshot.policy.version,
      billing: snapshot.billing,
      service: snapshot.service,
      appliedBasisPoints: snapshot.appliedBasisPoints,
      providerCostMicros: cost.amountMicros,
      customerProviderDebitMicros: baseDebit,
      externalProviderCostMicros: snapshot.billing === 'byok' ? cost.amountMicros : 0,
      feeEligible: eligible && snapshot.appliedBasisPoints > 0,
      nominalFeeMicros: nominalFee,
      collectedFeeMicros: collectedFee,
      waivedFeeMicros: nominalFee - collectedFee,
      customerTotalMicros: addMicros(baseDebit, collectedFee),
      operatorOverrunMicros: snapshot.billing === 'managed' ? cost.amountMicros - baseDebit : 0,
      releasedReservationMicros: reserved - baseDebit - collectedFee,
      evidence: cost.evidence,
      outcome: input.outcome,
    },
  });
}
