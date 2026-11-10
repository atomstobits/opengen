import { describe, expect, it } from 'vitest';
import {
  governanceName,
  microsToUsdInput,
  policyFromForm,
  usdInputToMicros,
  type GovernanceRoutingPolicy,
} from '../apps/web/app/governance/form-values';

describe('governance money forms', () => {
  it('preserves micro-USD precision and separates no cap from a zero cap', () => {
    expect(usdInputToMicros('')).toBeNull();
    expect(usdInputToMicros('  ')).toBeNull();
    expect(usdInputToMicros('0')).toBe(0);
    expect(usdInputToMicros('0.000001')).toBe(1);
    expect(usdInputToMicros('00025.000001')).toBe(25_000_001);
    expect(usdInputToMicros('9007199254.740991')).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [0, 1, 10, 999_999, 1_000_000, 25_000_001, Number.MAX_SAFE_INTEGER])
      expect(usdInputToMicros(microsToUsdInput(value))).toBe(value);
    expect(microsToUsdInput(null)).toBe('');
  });

  it('rejects negative, rounded, exponent, nonfinite and unsafe amounts', () => {
    for (const value of [
      '-1',
      '1.0000001',
      '1e2',
      'NaN',
      'Infinity',
      '9007199254.740992',
      '1,000',
      '+1',
      '.5',
      '1.',
    ])
      expect(() => usdInputToMicros(value)).toThrow();
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => microsToUsdInput(value)).toThrow();
  });

  it('bounds private display names without converting them to identity', () => {
    expect(governanceName('  Production agent  ')).toBe('Production agent');
    for (const name of ['', ' ', 'a'.repeat(81), 'hello\nworld', 'test\0key'])
      expect(() => governanceName(name)).toThrow();
  });
});

describe('routing policy form preservation', () => {
  const original: GovernanceRoutingPolicy = {
    providerIds: ['fal'],
    deploymentIds: ['fal/global'],
    endpointRegions: ['global'],
    processingRegions: ['eu'],
    fidelity: 'native',
    preference: 'reliability',
    fallback: false,
  };
  it('keeps every other restriction when adding author and exact-model rules', () => {
    const policy = policyFromForm(original, {
      modelRestriction: 'selected',
      modelIds: ['minimax/h3-max'],
      authorOnly: true,
      modelProviderExceptions: [{ modelId: 'minimax/h3-max', providerIds: ['minimax', 'minimax'] }],
    });
    expect(policy).toEqual({
      ...original,
      modelIds: ['minimax/h3-max'],
      authorOnly: true,
      modelProviderExceptions: [{ modelId: 'minimax/h3-max', providerIds: ['minimax'] }],
    });
    expect(original).not.toHaveProperty('modelIds');
  });

  it('retains explicit deny-all lists and requires deliberate unblock', () => {
    const values = {
      modelIds: [],
      authorOnly: false,
      modelProviderExceptions: [{ modelId: 'minimax/h3-max', providerIds: [] }],
    };
    expect(() => policyFromForm(original, { ...values, modelRestriction: 'selected' })).toThrow(
      'Block all models',
    );
    const blocked = policyFromForm(original, { ...values, modelRestriction: 'none' });
    expect(blocked.modelIds).toEqual([]);
    expect(blocked.modelProviderExceptions?.[0]?.providerIds).toEqual([]);
    expect(policyFromForm(blocked, { ...values, modelRestriction: 'any' })).not.toHaveProperty(
      'modelIds',
    );
  });

  it('rejects ambiguous duplicate or unselected model exceptions', () => {
    const values = { modelRestriction: 'any' as const, modelIds: [], authorOnly: true };
    expect(() =>
      policyFromForm(original, {
        ...values,
        modelProviderExceptions: [
          { modelId: 'minimax/h3-max', providerIds: ['fal'] },
          { modelId: 'minimax/h3-max', providerIds: ['minimax'] },
        ],
      }),
    ).toThrow('one provider exception');
    expect(() =>
      policyFromForm(original, {
        ...values,
        modelProviderExceptions: [{ modelId: '', providerIds: ['fal'] }],
      }),
    ).toThrow('Choose an exact model');
  });
});
