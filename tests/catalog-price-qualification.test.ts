import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/catalog-maintenance/prices-scoped.json';
import {
  comparePriceEvidence,
  publicPriceEvidence,
  qualifyPriceEvidence,
  type PriceEvidence,
  type PriceTarget,
} from '../packages/catalog/src/maintenance/price-qualification';

const sample = (key: 'publicList' | 'operatorContract' | 'privateByok' = 'publicList') =>
  structuredClone(fixtures[key]) as PriceEvidence;

describe('scoped tariff evidence qualification (synthetic, no runtime pricing)', () => {
  it.each(['publicList', 'operatorContract', 'privateByok'] as const)(
    'binds the %s fixture to its actual synthetic document bytes',
    (key) => {
      expect(sample(key).source.sha256).toBe(
        createHash('sha256').update(fixtures.syntheticSourceDocuments[key]).digest('hex'),
      );
    },
  );

  it('requires approval even when an exact public-list proposal is complete', () => {
    const evidence = sample();
    expect(qualifyPriceEvidence(evidence, evidence.target)).toEqual({
      qualifiedForProposal: true,
      publicListEligible: true,
      actualChargeKnown: false,
      manualApprovalRequired: true,
      reasons: [],
    });
  });

  it.each(['operatorContract', 'privateByok'] as const)(
    'keeps %s evidence private and tied to its account scope',
    (key) => {
      const evidence = sample(key);
      expect(qualifyPriceEvidence(evidence, evidence.target)).toMatchObject({
        qualifiedForProposal: true,
        publicListEligible: false,
        actualChargeKnown: false,
      });
      expect(publicPriceEvidence(evidence)).toBeNull();
      expect(qualifyPriceEvidence(evidence, sample().target).reasons).toContain(
        'target_mismatch:scope',
      );
      const otherAccount = structuredClone(evidence.target);
      if (otherAccount.scope.kind !== 'public-list')
        otherAccount.scope.scopeRef = 'another-account';
      expect(qualifyPriceEvidence(evidence, otherAccount).qualifiedForProposal).toBe(false);
    },
  );

  it.each([
    'providerId',
    'endpointId',
    'modelId',
    'deploymentId',
    'operation',
    'endpointRegion',
    'inferenceScope',
  ] as const)('does not transfer a tariff across %s', (field) => {
    const evidence = sample();
    const target = { ...evidence.target, [field]: 'a-different-exact-value' };
    expect(qualifyPriceEvidence(evidence, target).reasons).toContain(`target_mismatch:${field}`);
  });

  it('preserves unknown deployment location without inventing regional entitlement', () => {
    const evidence = sample();
    evidence.target.endpointRegion = null;
    evidence.target.inferenceScope = null;
    const before = structuredClone(evidence);
    expect(qualifyPriceEvidence(evidence, evidence.target).qualifiedForProposal).toBe(true);
    expect(publicPriceEvidence(evidence)?.target).toMatchObject({
      endpointRegion: null,
      inferenceScope: null,
    });
    expect(
      qualifyPriceEvidence(evidence, { ...evidence.target, endpointRegion: 'eu-fixture-1' })
        .qualifiedForProposal,
    ).toBe(false);
    expect(evidence).toEqual(before);
  });

  it.each(['historical-estimate', 'billing-unit-header', 'unknown'] as const)(
    'does not treat %s as a tariff or invoice',
    (basis) => {
      const evidence = { ...sample(), basis };
      expect(qualifyPriceEvidence(evidence, evidence.target)).toMatchObject({
        qualifiedForProposal: false,
        publicListEligible: false,
        actualChargeKnown: false,
        reasons: ['unqualified_tariff_basis'],
      });
      expect(publicPriceEvidence(evidence)).toBeNull();
    },
  );

  it('rejects a private/account basis relabeled as a public tariff scope', () => {
    const evidence = sample('privateByok');
    evidence.target.scope = { kind: 'public-list' };
    expect(qualifyPriceEvidence(evidence, evidence.target).reasons).toContain(
      'unqualified_tariff_basis',
    );
    expect(publicPriceEvidence(evidence)).toBeNull();
  });

  it('keeps a known component rate ineligible when the complete request formula is unknown', () => {
    const evidence = sample();
    evidence.formula = { state: 'unknown' };
    expect(qualifyPriceEvidence(evidence, evidence.target).reasons).toContain(
      'unqualified_formula',
    );
    expect(publicPriceEvidence(evidence)).toBeNull();
  });

  it.each(['currency', 'rateMicros', 'unit', 'rounding'] as const)(
    'does not substitute zero/defaults for unknown %s',
    (field) => {
      const evidence = { ...sample(), [field]: null };
      expect(qualifyPriceEvidence(evidence, evidence.target).qualifiedForProposal).toBe(false);
      expect(evidence[field]).toBeNull();
    },
  );

  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid micro-USD rate (%s)',
    (rateMicros) => {
      const evidence = { ...sample(), rateMicros };
      expect(qualifyPriceEvidence(evidence, evidence.target).reasons).toContain(
        'unknown_or_invalid_rate',
      );
    },
  );

  it('accepts zero only when explicitly evidenced, never as a missing value', () => {
    const evidence = { ...sample(), rateMicros: 0 };
    expect(qualifyPriceEvidence(evidence, evidence.target).qualifiedForProposal).toBe(true);
  });

  it.each([
    { url: 'http://provider.example.invalid/pricing' },
    { url: 'https://account:secret@provider.example.invalid/pricing' },
    { url: 'https://provider.example.invalid/pricing?token=secret' },
    { checkedAt: '2026-02-30' },
    { checkedAt: '2026-11-04T00:00:00Z' },
    { sha256: 'not-a-content-hash' },
  ])('requires clean HTTPS source, valid date and SHA256 (%j)', (change) => {
    const evidence = sample();
    Object.assign(evidence.source, change);
    expect(qualifyPriceEvidence(evidence, evidence.target).qualifiedForProposal).toBe(false);
  });

  it('requires a scoped implementation review and bounded meaningful test references', () => {
    const evidence = sample();
    if (evidence.formula.state !== 'qualified') throw new Error('fixture missing formula');
    evidence.formula.testRefs = [];
    expect(qualifyPriceEvidence(evidence, evidence.target).reasons).toContain(
      'unqualified_formula',
    );
    evidence.formula.testRefs = Array(17).fill('synthetic/test');
    expect(qualifyPriceEvidence(evidence, evidence.target).reasons).toContain(
      'unqualified_formula',
    );
    evidence.formula.testRefs = ['synthetic/test'];
    evidence.formula.reviewRef = '';
    expect(qualifyPriceEvidence(evidence, evidence.target).reasons).toContain(
      'unqualified_formula',
    );
  });

  it.each([null, [], {}, { target: null }])(
    'fails closed on malformed imported evidence (%j)',
    (value) => {
      expect(qualifyPriceEvidence(value, sample().target).qualifiedForProposal).toBe(false);
    },
  );

  it('does not compare rates across units, rounding, regions, accounts or implementations', () => {
    const original = sample();
    const revised = sample();
    revised.rateMicros = 45000;
    expect(comparePriceEvidence(original, revised)).toEqual({ comparable: true, reasons: [] });
    expect(comparePriceEvidence(original, { ...revised, unit: 'output-second' }).reasons).toContain(
      'unit_mismatch',
    );
    expect(
      comparePriceEvidence(original, { ...revised, rounding: 'round up to $0.0001' }).reasons,
    ).toContain('rounding_mismatch');
    expect(comparePriceEvidence(original, sample('privateByok')).comparable).toBe(false);
    revised.target.endpointRegion = 'us-fixture-1';
    expect(comparePriceEvidence(original, revised).reasons).toContain(
      'right:target_mismatch:endpointRegion',
    );
    revised.target.endpointRegion = original.target.endpointRegion;
    if (revised.formula.state !== 'qualified') throw new Error('fixture missing formula');
    revised.formula.implementationId = 'another-unreviewed-formula';
    expect(comparePriceEvidence(original, revised).reasons).toContain('implementation_mismatch');
  });

  it('projects only approved public fields and never shares mutable source objects', () => {
    const evidence = Object.assign(sample(), { privateNotes: 'synthetic internal note' });
    Object.assign(evidence.target, { connectionId: 'synthetic-private-connection' });
    const publicView = publicPriceEvidence(evidence)!;
    expect(JSON.stringify(publicView)).not.toContain('privateNotes');
    expect(JSON.stringify(publicView)).not.toContain('connectionId');
    expect(publicView).not.toHaveProperty('formula');
    publicView.source.checkedAt = '2026-11-05';
    publicView.target.endpointRegion = 'changed';
    expect(evidence.source.checkedAt).toBe('2026-11-04');
    expect(evidence.target.endpointRegion).toBe('eu-fixture-1');
    if (evidence.formula.state === 'qualified') expect(evidence.formula.testRefs).toHaveLength(1);
  });

  it('rejects a public-list scope containing an account identifier', () => {
    const evidence = sample();
    const target = {
      ...evidence.target,
      scope: { kind: 'public-list', scopeRef: 'synthetic-account' },
    } as PriceTarget;
    expect(qualifyPriceEvidence({ ...evidence, target }, target).qualifiedForProposal).toBe(false);
  });
});
