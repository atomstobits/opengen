import { describe, expect, it } from 'vitest';
import {
  prepareFalPrivacyControls,
  falPrivacyHeaders,
  supplierPrivacyIssues,
  type FalPrivacyCapabilities,
  type PrivacyFact,
  type SupplierPrivacyDisclosure,
  type SupplierPrivacyScope,
} from '../packages/engine/src/supplier-privacy.js';

const scope = { providerId: 'fal', deploymentId: 'fal-undisclosed', connectionId: 'fixture-a' };
const evidence = {
  source: 'https://example.com/synthetic-supplier-terms',
  checkedAt: '2026-11-04',
  status: 'documented' as const,
};
const fact = <T>(value: T): PrivacyFact<T> => ({ value, evidence });
const unknown = <T>(): PrivacyFact<T> => ({ value: null, evidence: null });
function disclosure(): SupplierPrivacyDisclosure {
  return {
    scope,
    endpointRegion: fact('eu'),
    inferenceScope: fact('global'),
    processingRegions: unknown(),
    storageRegions: unknown(),
    payloadHistory: fact('disabled'),
    deploymentLogs: unknown(),
    maxDataRetentionSeconds: unknown(),
    zeroDataRetention: unknown(),
  };
}
function capabilities(): FalPrivacyCapabilities {
  return {
    scope: { ...scope, providerId: 'fal' },
    evidence,
    payloadHistoryOptOut: true,
    outputExpirySeconds: { min: 60, max: 86400 },
    privateOutputAcl: true,
    authenticatedIngestion: 'unavailable',
  };
}

describe('supplier privacy requirements', () => {
  it('permits unspecified guarantees without inventing facts', () => {
    expect(supplierPrivacyIssues({}, disclosure(), scope)).toEqual([]);
  });
  it('does not turn an endpoint location or history opt-out into residency or ZDR', () => {
    const issues = supplierPrivacyIssues(
      {
        allowedEndpointRegions: ['eu'],
        allowedProcessingRegions: ['eu'],
        allowedStorageRegions: ['eu'],
        zeroDataRetention: true,
        disablePayloadHistory: true,
        disableDeploymentLogs: true,
        maxDataRetentionSeconds: 0,
      },
      disclosure(),
      scope,
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      'allowedProcessingRegions',
      'allowedStorageRegions',
      'disableDeploymentLogs',
      'zeroDataRetention',
      'maxDataRetentionSeconds',
    ]);
    expect(issues.every((issue) => issue.code === 'privacy_not_established')).toBe(true);
  });
  it('checks inference scope independently from endpoint location', () => {
    expect(
      supplierPrivacyIssues({ allowedInferenceScopes: ['regional'] }, disclosure(), scope),
    ).toEqual([expect.objectContaining({ field: 'allowedInferenceScopes' })]);
  });
  it('requires every reviewed processing and storage location to satisfy the allowlist', () => {
    const facts = disclosure();
    facts.processingRegions = fact(['eu', 'us']);
    facts.storageRegions = fact(['eu']);
    expect(
      supplierPrivacyIssues(
        { allowedProcessingRegions: ['eu'], allowedStorageRegions: ['eu'] },
        facts,
        scope,
      ).map((issue) => issue.field),
    ).toEqual(['allowedProcessingRegions']);
    expect(
      supplierPrivacyIssues(
        { allowedProcessingRegions: ['eu', 'us'], allowedStorageRegions: ['eu'] },
        facts,
        scope,
      ),
    ).toEqual([]);
  });
  it('does not consider empty processing coverage a residency guarantee', () => {
    const facts = disclosure();
    facts.processingRegions = fact([]);
    expect(supplierPrivacyIssues({ allowedProcessingRegions: ['eu'] }, facts, scope)).toHaveLength(
      1,
    );
  });
  it('requires a reviewed source for even affirmative facts', () => {
    const facts = disclosure();
    facts.zeroDataRetention = { value: true, evidence: null };
    expect(supplierPrivacyIssues({ zeroDataRetention: true }, facts, scope)).toHaveLength(1);
    facts.zeroDataRetention = fact(true);
    expect(supplierPrivacyIssues({ zeroDataRetention: true }, facts, scope)).toEqual([]);
    facts.zeroDataRetention.evidence = { ...evidence, source: 'http://example.com' };
    expect(supplierPrivacyIssues({ zeroDataRetention: true }, facts, scope)).toHaveLength(1);
  });
  it.each([
    { ...scope, providerId: 'other' },
    { ...scope, deploymentId: 'other' },
    { ...scope, connectionId: 'other' },
  ])('does not apply deployment/account facts to %j', (other: SupplierPrivacyScope) => {
    expect(
      supplierPrivacyIssues({ disablePayloadHistory: true }, disclosure(), other),
    ).toHaveLength(1);
  });
  it('supports reviewed public terms without assuming a new account-specific guarantee', () => {
    const facts = disclosure();
    facts.scope = { providerId: scope.providerId, deploymentId: scope.deploymentId };
    expect(supplierPrivacyIssues({ disablePayloadHistory: true }, facts, scope)).toEqual([]);
    expect(supplierPrivacyIssues({ zeroDataRetention: true }, facts, scope)).toHaveLength(1);
  });
  it('checks comprehensive retention and validates requested numeric limits', () => {
    const facts = disclosure();
    facts.maxDataRetentionSeconds = fact(3600);
    expect(supplierPrivacyIssues({ maxDataRetentionSeconds: 3600 }, facts, scope)).toEqual([]);
    expect(supplierPrivacyIssues({ maxDataRetentionSeconds: 3599 }, facts, scope)[0]?.code).toBe(
      'privacy_not_established',
    );
    for (const limit of [-1, Infinity, NaN, 0.5])
      expect(supplierPrivacyIssues({ maxDataRetentionSeconds: limit }, facts, scope)[0]?.code).toBe(
        'invalid_privacy_requirement',
      );
  });
  it('rejects an empty requested allowlist', () => {
    expect(supplierPrivacyIssues({ allowedStorageRegions: [] }, disclosure(), scope)).toEqual([
      expect.objectContaining({ code: 'invalid_privacy_requirement' }),
    ]);
  });
});

describe('fal privacy control plan', () => {
  it('leaves unspecified supplier controls explicit and does not claim ZDR', () => {
    expect(prepareFalPrivacyControls({}, capabilities(), scope, 600)).toEqual({
      payloadHistory: 'provider-default',
      outputExpiresInSeconds: null,
      outputAccess: 'provider-default',
      recoveryWindowSeconds: 600,
      establishesZeroDataRetention: false,
    });
  });
  it('plans the reviewed history/expiry controls without enabling private output', () => {
    expect(
      prepareFalPrivacyControls(
        { disablePayloadHistory: true, outputExpiresInSeconds: 3600 },
        capabilities(),
        scope,
        600,
      ),
    ).toMatchObject({
      payloadHistory: 'disabled',
      outputExpiresInSeconds: 3600,
      outputAccess: 'provider-default',
      establishesZeroDataRetention: false,
    });
  });
  it('refuses private supplier output until authenticated ingestion is ready', () => {
    expect(() =>
      prepareFalPrivacyControls(
        { outputAccess: 'private', outputExpiresInSeconds: 3600 },
        capabilities(),
        scope,
        600,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'unsupported_supplier_privacy', field: 'outputAccess' }),
    );
    const reviewed = capabilities();
    reviewed.authenticatedIngestion = 'ready';
    expect(
      prepareFalPrivacyControls(
        { outputAccess: 'private', outputExpiresInSeconds: 3600 },
        reviewed,
        scope,
        600,
      ).outputAccess,
    ).toBe('private');
  });
  it('requires explicit expiry for private output and covers the recovery window', () => {
    const reviewed = capabilities();
    reviewed.authenticatedIngestion = 'ready';
    for (const expiry of [undefined, 599, 86401])
      expect(() =>
        prepareFalPrivacyControls(
          { outputAccess: 'private', outputExpiresInSeconds: expiry },
          reviewed,
          scope,
          600,
        ),
      ).toThrow(expect.objectContaining({ field: 'outputExpiresInSeconds' }));
  });
  it('rejects unsupported or unreviewed capability facts', () => {
    const reviewed = capabilities();
    reviewed.payloadHistoryOptOut = false;
    expect(() =>
      prepareFalPrivacyControls({ disablePayloadHistory: true }, reviewed, scope, 600),
    ).toThrow(expect.objectContaining({ field: 'disablePayloadHistory' }));
    reviewed.payloadHistoryOptOut = true;
    reviewed.evidence = null;
    expect(() =>
      prepareFalPrivacyControls({ disablePayloadHistory: true }, reviewed, scope, 600),
    ).toThrow(expect.objectContaining({ field: 'disablePayloadHistory' }));
    reviewed.evidence = evidence;
    reviewed.outputExpirySeconds = null;
    expect(() =>
      prepareFalPrivacyControls({ outputExpiresInSeconds: 3600 }, reviewed, scope, 600),
    ).toThrow(expect.objectContaining({ field: 'outputExpiresInSeconds' }));
  });
  it.each([
    { ...scope, providerId: 'other' },
    { ...scope, deploymentId: 'other' },
    { ...scope, connectionId: 'other' },
    { providerId: scope.providerId, deploymentId: scope.deploymentId },
  ])('requires exact account/deployment capability scope: %j', (other: SupplierPrivacyScope) => {
    expect(() =>
      prepareFalPrivacyControls({ disablePayloadHistory: true }, capabilities(), other, 600),
    ).toThrow(expect.objectContaining({ code: 'unsupported_supplier_privacy' }));
  });
  it('rejects invalid expiry and recovery values', () => {
    for (const expiry of [0, -1, Infinity, NaN, 1.5])
      expect(() =>
        prepareFalPrivacyControls({ outputExpiresInSeconds: expiry }, capabilities(), scope, 600),
      ).toThrow(expect.objectContaining({ code: 'invalid_supplier_privacy' }));
    expect(() => prepareFalPrivacyControls({}, capabilities(), scope, 0)).toThrow(
      expect.objectContaining({ field: 'recoveryWindowSeconds' }),
    );
  });
});

it('serializes only reviewed fal history, expiry and private-ACL headers', () => {
  const reviewed = capabilities();
  reviewed.authenticatedIngestion = 'ready';
  expect(
    falPrivacyHeaders(
      { disablePayloadHistory: true, outputExpiresInSeconds: 3600, outputAccess: 'private' },
      reviewed,
      scope,
      600,
    ),
  ).toEqual({
    'X-Fal-Store-IO': '0',
    'X-Fal-Object-Lifecycle-Preference': JSON.stringify({
      expiration_duration_seconds: 3600,
      initial_acl: { default: 'forbid', rules: [] },
    }),
  });
  expect(falPrivacyHeaders({}, reviewed, scope, 600)).toEqual({});
  reviewed.authenticatedIngestion = 'unavailable';
  expect(() =>
    falPrivacyHeaders(
      { outputAccess: 'private', outputExpiresInSeconds: 3600 },
      reviewed,
      scope,
      600,
    ),
  ).toThrow(expect.objectContaining({ field: 'outputAccess' }));
});
