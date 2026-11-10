import { describe, expect, it } from 'vitest';
import {
  addMicros,
  assertMicros,
  classifyRoutingService,
  createFeePolicy,
  createFeeSnapshot,
  DEFAULT_FEE_POLICY,
  LEGACY_FEE_SNAPSHOT,
  legacyFeeSnapshot,
  PROPOSED_SMART_FEE_BPS,
  quoteGrossReservation,
  routingFeeMicros,
  settleVerifiedCost,
  verifyProviderCostEvidence,
  type AdmissionFeeSnapshot,
  type BillingMode,
  type BillingOutcome,
  type CostIdentity,
  type FeePolicy,
  type ProviderCostEvidence,
} from '../packages/engine/src/billing-fees.js';

const expected: CostIdentity = {
  attemptId: 'attempt-1',
  providerId: 'provider-1',
  deploymentId: 'deployment-1',
  upstreamReference: 'task-1',
};
const evidence = (amountMicros: number): ProviderCostEvidence => ({
  ...expected,
  reference: 'provider-response-1',
  basis: 'provider-billed-usd',
  currency: 'USD',
  amountMicros,
});
const fixturePolicy = (overrides: Partial<Parameters<typeof createFeePolicy>[0]> = {}): FeePolicy =>
  createFeePolicy({
    id: 'explicit-fixture-5-percent',
    version: 1,
    activation: 'fixture',
    basisPoints: PROPOSED_SMART_FEE_BPS,
    eligibleOutcomes: ['succeeded'],
    overrunAllocation: 'provider-first',
    ...overrides,
  });
function snapshot(
  options: { direct?: boolean; billing?: BillingMode; policy?: FeePolicy } = {},
): AdmissionFeeSnapshot {
  return createFeeSnapshot({
    classification: classifyRoutingService(
      options.direct ? { routeId: 'provider/region/exact-model' } : {},
    ),
    billing: options.billing ?? 'managed',
    admittedAt: '2026-01-31T23:59:59.000Z',
    reviewDeadlineAt: '2026-02-02T23:59:59.000Z',
    policy: options.policy ?? fixturePolicy(),
  });
}
function settle(
  amount: number,
  options: {
    snapshot?: AdmissionFeeSnapshot;
    reserved?: number;
    ceiling?: number;
    outcome?: BillingOutcome;
  } = {},
) {
  return settleVerifiedCost(options.snapshot ?? snapshot(), {
    reservedMicros: options.reserved ?? 1_050_000,
    customerCeilingMicros: options.ceiling ?? 1_050_000,
    evidence: evidence(amount),
    expected,
    outcome: options.outcome ?? 'succeeded',
  });
}

describe('exact integer fee arithmetic', () => {
  it('calculates 5% and rounds tiny amounts upward once to one microUSD', () => {
    expect(routingFeeMicros(1_000_000, 500)).toBe(50_000);
    expect(routingFeeMicros(1, 500)).toBe(1);
    expect(routingFeeMicros(19, 500)).toBe(1);
    expect(routingFeeMicros(20, 500)).toBe(1);
    expect(routingFeeMicros(21, 500)).toBe(2);
    expect(routingFeeMicros(0, 500)).toBe(0);
    expect(routingFeeMicros(Number.MAX_SAFE_INTEGER, 0)).toBe(0);
    expect(routingFeeMicros(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('uses BigInt intermediates where floating point multiplication loses the fee boundary', () => {
    const amount = Number.MAX_SAFE_INTEGER;
    const exact = Number((BigInt(amount) * 500n + 9999n) / 10000n);
    expect(routingFeeMicros(amount, 500)).toBe(exact);
    expect(addMicros(amount - 1, 1)).toBe(amount);
    expect(() => addMicros(amount, 1)).toThrow(/safe integer/);
    expect(() => quoteGrossReservation(snapshot(), amount)).toThrow(/safe integer/);
  });
  it('rejects fractional, negative, nonfinite and unsafe money/rates', () => {
    for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
      expect(() => assertMicros(invalid)).toThrow();
      expect(() => routingFeeMicros(invalid as number, 500)).toThrow();
    }
    for (const invalid of [-1, 0.1, 10001, Infinity])
      expect(() => routingFeeMicros(100, invalid)).toThrow();
  });
});

describe('routing classification proposal and immutable admission', () => {
  it('classifies model-only provider selection as smart and explicit pins as direct', () => {
    expect(classifyRoutingService({})).toMatchObject({
      service: 'smart',
      reason: 'selection-service',
    });
    expect(classifyRoutingService({ routeId: 'route/exact' })).toMatchObject({
      service: 'direct',
      reason: 'exact-route',
    });
    expect(classifyRoutingService({ request: { providerIds: ['provider-1'] } })).toMatchObject({
      service: 'direct',
      reason: 'single-provider',
    });
    expect(classifyRoutingService({ policy: { deploymentIds: ['region-1'] } })).toMatchObject({
      service: 'direct',
      reason: 'single-deployment',
    });
  });
  it('uses request/policy intersections and rejects empty or contradictory pin/fallback choices', () => {
    expect(
      classifyRoutingService({
        request: { providerIds: ['b', 'a'] },
        policy: { providerIds: ['b', 'c'] },
      }),
    ).toMatchObject({ service: 'direct', providerIds: ['b'] });
    expect(
      classifyRoutingService({
        request: { providerIds: ['a', 'b'] },
        policy: { providerIds: ['a', 'b'], fallback: true },
      }),
    ).toMatchObject({ service: 'smart', fallback: true });
    expect(() =>
      classifyRoutingService({ request: { providerIds: ['a'] }, policy: { providerIds: ['b'] } }),
    ).toThrow(/no permitted/);
    expect(() =>
      classifyRoutingService({ routeId: 'pinned', request: { fallback: true } }),
    ).toThrow(/Pinned/);
    expect(() =>
      classifyRoutingService({ request: { providerIds: ['only'], fallback: true } }),
    ).toThrow(/Pinned/);
    expect(() =>
      classifyRoutingService({ request: { fallback: true }, policy: { fallback: false } }),
    ).toThrow(/exceeds/);
    expect(
      classifyRoutingService({ request: { fallback: false }, policy: { fallback: true } }).fallback,
    ).toBe(false);
    expect(() => classifyRoutingService({ request: { deploymentIds: [] } })).toThrow();
  });
  it('keeps fee activation disabled by default and rejects a hidden nonzero disabled rate', () => {
    expect(DEFAULT_FEE_POLICY).toMatchObject({ activation: 'disabled', basisPoints: 0 });
    const current = createFeeSnapshot({
      classification: classifyRoutingService({}),
      billing: 'managed',
      admittedAt: '2026-11-04T00:00:00.000Z',
      reviewDeadlineAt: '2026-11-05T00:00:00.000Z',
    });
    expect(quoteGrossReservation(current, 1_000_000)).toMatchObject({
      reservationMicros: 1_000_000,
      nominalFeeEstimateMicros: 0,
    });
    expect(() => fixturePolicy({ activation: 'disabled', basisPoints: 500 })).toThrow(/zero basis/);
    expect(() => fixturePolicy({ activation: 'live' as 'fixture' })).toThrow(/Unsupported/);
  });
  it('freezes independent policy/routing snapshots so later configuration changes cannot reprice accepted work', () => {
    const input = {
      id: 'fixture-versioned',
      version: 1,
      activation: 'fixture' as const,
      basisPoints: 500,
      eligibleOutcomes: ['succeeded' as const],
      overrunAllocation: 'provider-first' as const,
    };
    const accepted = snapshot({ policy: createFeePolicy(input) });
    input.basisPoints = 1000;
    input.version = 2;
    input.eligibleOutcomes.push('succeeded');
    expect(accepted.policy.basisPoints).toBe(500);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.policy.eligibleOutcomes)).toBe(true);
    expect(() => {
      (accepted as { appliedBasisPoints: number }).appliedBasisPoints = 999;
    }).toThrow();
    expect(settle(1_000_000, { snapshot: accepted })).toMatchObject({
      status: 'settled',
      statement: { policyVersion: 1, nominalFeeMicros: 50_000 },
    });
  });
  it('keeps legacy zero-fee records and explicit direct managed/BYOK reservations unchanged', () => {
    expect(LEGACY_FEE_SNAPSHOT).toMatchObject({ service: 'legacy', appliedBasisPoints: 0 });
    expect(quoteGrossReservation(legacyFeeSnapshot(), 1_000_000)).toMatchObject({
      reservationMicros: 1_000_000,
      nominalFeeEstimateMicros: 0,
    });
    expect(quoteGrossReservation(snapshot({ direct: true }), 1_000_000)).toMatchObject({
      reservationMicros: 1_000_000,
      nominalFeeEstimateMicros: 0,
    });
    expect(quoteGrossReservation(snapshot({ direct: true, billing: 'byok' }), null)).toMatchObject({
      reservationMicros: 0,
      nominalFeeEstimateMicros: 0,
    });
    expect(quoteGrossReservation(snapshot({ billing: 'byok' }), 1_000_000)).toEqual({
      status: 'unavailable',
      reason: 'byok-smart-not-qualified',
    });
    expect(() =>
      quoteGrossReservation({ ...LEGACY_FEE_SNAPSHOT, appliedBasisPoints: 500 }, 100),
    ).toThrow(/Legacy/);
  });
  it('rejects inconsistent restored snapshots and missing review deadlines', () => {
    const current = snapshot();
    expect(() => quoteGrossReservation({ ...current, service: 'direct' }, 100)).toThrow(
      /Inconsistent/,
    );
    expect(() => quoteGrossReservation({ ...current, appliedBasisPoints: 501 }, 100)).toThrow(
      /Inconsistent/,
    );
    expect(() =>
      createFeeSnapshot({
        classification: classifyRoutingService({}),
        billing: 'managed',
        admittedAt: '2026-11-04T00:00:00.000Z',
        reviewDeadlineAt: '2026-11-03T00:00:00.000Z',
      }),
    ).toThrow(/follow/);
  });
});

describe('verified provider cost evidence', () => {
  it('accepts a bound provider USD bill and an audited operator reference', () => {
    expect(verifyProviderCostEvidence(evidence(0), expected)).toMatchObject({
      verified: true,
      amountMicros: 0,
    });
    expect(
      verifyProviderCostEvidence(
        {
          ...evidence(123),
          basis: 'operator-audited',
          auditReference: 'audit-row-1',
          operatorId: 'operator-1',
        },
        expected,
      ),
    ).toMatchObject({ verified: true, amountMicros: 123 });
    expect(
      verifyProviderCostEvidence({ ...evidence(123), basis: 'operator-audited' }, expected),
    ).toEqual({ verified: false, reason: 'invalid-cost-evidence' });
  });
  it('computes complete actual usage only with a qualified account tariff and exact rational aggregation', () => {
    const usage = {
      ...expected,
      reference: 'usage-report-1',
      basis: 'qualified-actual-usage',
      complete: true,
      currency: 'USD',
      tariffId: 'account-tariff-1',
      tariffVersion: 'v2',
      qualifiedAccountReference: 'account-price-review-1',
      lines: [
        { quantity: 1, unitRateMicros: 1, ratePerUnits: 3 },
        { quantity: 1, unitRateMicros: 1, ratePerUnits: 3 },
      ],
    };
    expect(verifyProviderCostEvidence(usage, expected)).toMatchObject({
      verified: true,
      amountMicros: 1,
    });
    expect(verifyProviderCostEvidence({ ...usage, complete: false }, expected)).toMatchObject({
      verified: false,
      reason: 'actual-usage-incomplete',
    });
    expect(
      verifyProviderCostEvidence({ ...usage, qualifiedAccountReference: '' }, expected),
    ).toMatchObject({ verified: false });
    expect(
      verifyProviderCostEvidence(
        { ...usage, lines: [{ quantity: 1, unitRateMicros: 1, ratePerUnits: 0 }] },
        expected,
      ),
    ).toMatchObject({ verified: false });
    expect(
      verifyProviderCostEvidence(
        {
          ...usage,
          lines: [
            {
              quantity: Number.MAX_SAFE_INTEGER,
              unitRateMicros: Number.MAX_SAFE_INTEGER,
              ratePerUnits: 1,
            },
          ],
        },
        expected,
      ),
    ).toMatchObject({ verified: false });
  });
  it('does not accept estimates, historical averages, incomplete public prices, non-USD bills or another attempt', () => {
    for (const basis of ['estimate', 'historical-average', 'published-price'])
      expect(verifyProviderCostEvidence({ ...evidence(1_000_000), basis }, expected)).toEqual({
        verified: false,
        reason: 'unsupported-cost-basis',
      });
    expect(
      verifyProviderCostEvidence({ ...evidence(100), currency: 'EUR' }, expected),
    ).toMatchObject({ verified: false, reason: 'cost-currency-unqualified' });
    for (const field of ['attemptId', 'providerId', 'deploymentId', 'upstreamReference'])
      expect(
        verifyProviderCostEvidence({ ...evidence(100), [field]: 'foreign' }, expected),
      ).toMatchObject({ verified: false, reason: 'cost-evidence-identity-mismatch' });
    expect(
      verifyProviderCostEvidence({ ...evidence(100), amountMicros: 1.1 }, expected),
    ).toMatchObject({ verified: false });
  });
  it('copies only supported audit fields and never retains an arbitrary raw provider payload', () => {
    const source = { ...evidence(10), rawProviderPayload: { privatePrompt: 'must not persist' } };
    const verified = verifyProviderCostEvidence(source, expected);
    expect(verified).toMatchObject({ verified: true, amountMicros: 10 });
    if (verified.verified) expect(verified.evidence).not.toHaveProperty('rawProviderPayload');
  });
});

describe('gross reservation and explicit settlement statements', () => {
  it('uses identical quote/reservation/settlement rounding and gross ceilings', () => {
    const accepted = snapshot();
    expect(quoteGrossReservation(accepted, 1_000_000)).toMatchObject({
      providerEstimateMicros: 1_000_000,
      nominalFeeEstimateMicros: 50_000,
      customerEstimateMicros: 1_050_000,
      reservationMicros: 1_050_000,
    });
    expect(settle(1_000_000)).toMatchObject({
      status: 'settled',
      statement: {
        providerCostMicros: 1_000_000,
        customerProviderDebitMicros: 1_000_000,
        nominalFeeMicros: 50_000,
        collectedFeeMicros: 50_000,
        waivedFeeMicros: 0,
        customerTotalMicros: 1_050_000,
        operatorOverrunMicros: 0,
        releasedReservationMicros: 0,
      },
    });
    expect(quoteGrossReservation(accepted, 1)).toMatchObject({
      reservationMicros: 2,
      nominalFeeEstimateMicros: 1,
    });
    expect(settle(1, { reserved: 2, ceiling: 2 })).toMatchObject({
      statement: { nominalFeeMicros: 1, customerTotalMicros: 2 },
    });
    expect(() => quoteGrossReservation(accepted, 1_000_000, 1_000_000)).toThrow(/Gross/);
  });
  it('waives nominal fee before allocating a provider overrun without exceeding reservation or accepted ceiling', () => {
    expect(settle(1_020_000)).toMatchObject({
      statement: {
        providerCostMicros: 1_020_000,
        nominalFeeMicros: 51_000,
        collectedFeeMicros: 30_000,
        waivedFeeMicros: 21_000,
        customerTotalMicros: 1_050_000,
        operatorOverrunMicros: 0,
      },
    });
    expect(settle(1_100_000)).toMatchObject({
      statement: {
        providerCostMicros: 1_100_000,
        nominalFeeMicros: 55_000,
        collectedFeeMicros: 0,
        waivedFeeMicros: 55_000,
        customerTotalMicros: 1_050_000,
        operatorOverrunMicros: 50_000,
      },
    });
    expect(settle(1_000_000, { ceiling: 900_000 })).toMatchObject({
      statement: {
        customerTotalMicros: 900_000,
        operatorOverrunMicros: 100_000,
        releasedReservationMicros: 150_000,
      },
    });
    expect(settle(1_000_000, { reserved: 900_000, ceiling: 2_000_000 })).toMatchObject({
      statement: { customerTotalMicros: 900_000, operatorOverrunMicros: 100_000 },
    });
  });
  it('releases unused gross reservation and charges zero fee for verified zero provider cost', () => {
    expect(settle(0)).toMatchObject({
      statement: {
        providerCostMicros: 0,
        nominalFeeMicros: 0,
        customerTotalMicros: 0,
        releasedReservationMicros: 1_050_000,
      },
    });
    expect(settle(500_000)).toMatchObject({
      statement: { customerTotalMicros: 525_000, releasedReservationMicros: 525_000 },
    });
  });
  it('uses explicitly frozen outcome eligibility instead of inferring fees from a provider success flag', () => {
    for (const outcome of ['failed', 'cancelled', 'delivery-partial', 'delivery-unusable'] as const)
      expect(settle(1_000_000, { outcome })).toMatchObject({
        statement: {
          customerProviderDebitMicros: 1_000_000,
          nominalFeeMicros: 0,
          collectedFeeMicros: 0,
          feeEligible: false,
        },
      });
    expect(
      settle(1_000_000, {
        outcome: 'failed',
        snapshot: snapshot({ policy: fixturePolicy({ eligibleOutcomes: ['failed'] }) }),
      }),
    ).toMatchObject({ statement: { nominalFeeMicros: 50_000, feeEligible: true } });
  });
  it('holds unknown liability with the original review deadline rather than settling an estimate or timing out to zero', () => {
    for (const unknown of [
      null,
      { basis: 'unknown', reason: 'provider-cost-pending' },
      { ...evidence(1_000_000), basis: 'estimate' },
    ]) {
      expect(
        settleVerifiedCost(snapshot(), {
          reservedMicros: 1_050_000,
          customerCeilingMicros: 1_050_000,
          evidence: unknown,
          expected,
          outcome: 'succeeded',
        }),
      ).toMatchObject({
        status: 'review',
        heldReservationMicros: 1_050_000,
        reviewDeadlineAt: '2026-02-02T23:59:59.000Z',
      });
    }
    expect(quoteGrossReservation(snapshot(), null)).toEqual({
      status: 'unavailable',
      reason: 'provider-estimate-unknown',
    });
  });
  it('does not double-debit BYOK provider cost and gates smart BYOK regardless of policy rate', () => {
    expect(
      settle(1_000_000, {
        snapshot: snapshot({ direct: true, billing: 'byok' }),
        reserved: 0,
        ceiling: 0,
      }),
    ).toMatchObject({
      statement: {
        providerCostMicros: 1_000_000,
        customerProviderDebitMicros: 0,
        externalProviderCostMicros: 1_000_000,
        nominalFeeMicros: 0,
        customerTotalMicros: 0,
        operatorOverrunMicros: 0,
      },
    });
    expect(
      settle(1_000_000, { snapshot: snapshot({ billing: 'byok' }), reserved: 0, ceiling: 0 }),
    ).toMatchObject({
      status: 'review',
      reason: 'byok-smart-not-qualified',
      heldReservationMicros: 0,
    });
    expect(() =>
      settle(1_000_000, { snapshot: snapshot({ direct: true, billing: 'byok' }), reserved: 1 }),
    ).toThrow(/BYOK/);
  });
  it('retains a zero-fee legacy job and gives deterministic replay after a UTC month boundary', () => {
    const accepted = snapshot();
    const first = settle(1_000_000, { snapshot: accepted });
    const restored = JSON.parse(JSON.stringify(accepted)) as AdmissionFeeSnapshot;
    expect(settle(1_000_000, { snapshot: restored })).toEqual(first);
    expect(
      settle(1_000_000, { snapshot: LEGACY_FEE_SNAPSHOT, reserved: 1_000_000, ceiling: 1_000_000 }),
    ).toMatchObject({ statement: { nominalFeeMicros: 0, customerTotalMicros: 1_000_000 } });
  });
  it('refuses to silently price multiple billed attempts and preserves conservation for all supported single costs', () => {
    expect(
      settleVerifiedCost(snapshot(), {
        reservedMicros: 100,
        customerCeilingMicros: 100,
        evidence: evidence(10),
        expected,
        outcome: 'succeeded',
        billableAttemptCount: 2,
      }),
    ).toMatchObject({ status: 'review', reason: 'multiple-billed-attempt-policy-unresolved' });
    for (const cost of [
      0,
      1,
      19,
      20,
      21,
      100,
      999,
      1_000_000,
      1_100_000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const result = settle(cost);
      expect(result.status).toBe('settled');
      if (result.status !== 'settled') continue;
      const s = result.statement;
      expect(BigInt(s.providerCostMicros) + BigInt(s.nominalFeeMicros)).toBe(
        BigInt(s.customerTotalMicros) + BigInt(s.waivedFeeMicros) + BigInt(s.operatorOverrunMicros),
      );
      expect(s.customerTotalMicros + s.releasedReservationMicros).toBe(1_050_000);
      expect(s.customerTotalMicros).toBeLessThanOrEqual(1_050_000);
    }
  });
});
