/**
 * Private, reviewed supplier facts. Endpoint location is never substituted for
 * processing or storage residency. A control request is not evidence of ZDR.
 */
export interface PrivacyEvidence {
  source: string;
  checkedAt: string;
  status: 'documented' | 'live-verified';
}
export interface PrivacyFact<T> {
  value: T | null;
  evidence: PrivacyEvidence | null;
}
export interface SupplierPrivacyScope {
  providerId: string;
  deploymentId: string;
  /** Internal connection identity, not a key/token. Omit only for public terms. */
  connectionId?: string;
}
export interface SupplierPrivacyDisclosure {
  scope: SupplierPrivacyScope;
  endpointRegion: PrivacyFact<string>;
  inferenceScope: PrivacyFact<string>;
  processingRegions: PrivacyFact<readonly string[]>;
  storageRegions: PrivacyFact<readonly string[]>;
  payloadHistory: PrivacyFact<'disabled' | 'enabled'>;
  deploymentLogs: PrivacyFact<'disabled' | 'enabled'>;
  /** Comprehensive supplier data retention, not merely the CDN object's TTL. */
  maxDataRetentionSeconds: PrivacyFact<number>;
  zeroDataRetention: PrivacyFact<boolean>;
}
export interface SupplierPrivacyRequirements {
  allowedEndpointRegions?: readonly string[];
  allowedInferenceScopes?: readonly string[];
  allowedProcessingRegions?: readonly string[];
  allowedStorageRegions?: readonly string[];
  disablePayloadHistory?: true;
  disableDeploymentLogs?: true;
  maxDataRetentionSeconds?: number;
  zeroDataRetention?: true;
}
export interface SupplierPrivacyIssue {
  code: 'privacy_not_established' | 'invalid_privacy_requirement';
  field: keyof SupplierPrivacyRequirements;
  message: string;
}
function hasEvidence<T extends PrivacyFact<unknown>>(
  fact: T,
): fact is T & { value: NonNullable<T['value']> } {
  if (fact.value === null || !fact.evidence) return false;
  try {
    const source = new URL(fact.evidence.source);
    return (
      source.protocol === 'https:' &&
      !source.username &&
      !source.password &&
      Number.isFinite(Date.parse(fact.evidence.checkedAt)) &&
      ['documented', 'live-verified'].includes(fact.evidence.status)
    );
  } catch {
    return false;
  }
}
function sameScope(expected: SupplierPrivacyScope, reviewed: SupplierPrivacyScope): boolean {
  return (
    expected.providerId === reviewed.providerId &&
    expected.deploymentId === reviewed.deploymentId &&
    (reviewed.connectionId === undefined || expected.connectionId === reviewed.connectionId)
  );
}
function validRegions(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => typeof value === 'string' && value.trim());
}
/** Evaluate before reservation/submit. Unknown or differently scoped facts fail a requested guarantee. */
export function supplierPrivacyIssues(
  requirements: SupplierPrivacyRequirements,
  disclosure: SupplierPrivacyDisclosure,
  scope: SupplierPrivacyScope,
): SupplierPrivacyIssue[] {
  const issues: SupplierPrivacyIssue[] = [];
  const scoped = sameScope(scope, disclosure.scope);
  const reject = (field: keyof SupplierPrivacyRequirements, invalid = false) => {
    issues.push({
      code: invalid ? 'invalid_privacy_requirement' : 'privacy_not_established',
      field,
      message: invalid
        ? `The ${field} privacy requirement is invalid.`
        : `The selected supplier deployment does not establish ${field}.`,
    });
  };
  for (const [field, fact] of [
    ['allowedEndpointRegions', disclosure.endpointRegion],
    ['allowedInferenceScopes', disclosure.inferenceScope],
  ] as const) {
    const allowed = requirements[field];
    if (allowed === undefined) continue;
    if (!validRegions(allowed)) reject(field, true);
    else if (!scoped || !hasEvidence(fact) || !allowed.includes(fact.value)) reject(field);
  }
  for (const [field, fact] of [
    ['allowedProcessingRegions', disclosure.processingRegions],
    ['allowedStorageRegions', disclosure.storageRegions],
  ] as const) {
    const allowed = requirements[field];
    if (allowed === undefined) continue;
    if (!validRegions(allowed)) reject(field, true);
    else if (
      !scoped ||
      !hasEvidence(fact) ||
      !validRegions(fact.value) ||
      fact.value.some((region) => !allowed.includes(region))
    )
      reject(field);
  }
  for (const [field, fact, value] of [
    ['disablePayloadHistory', disclosure.payloadHistory, 'disabled'],
    ['disableDeploymentLogs', disclosure.deploymentLogs, 'disabled'],
    ['zeroDataRetention', disclosure.zeroDataRetention, true],
  ] as const) {
    if (requirements[field] === undefined) continue;
    if (requirements[field] !== true) reject(field, true);
    else if (!scoped || !hasEvidence(fact) || fact.value !== value) reject(field);
  }
  const retention = requirements.maxDataRetentionSeconds;
  if (retention !== undefined) {
    if (!Number.isSafeInteger(retention) || retention < 0) reject('maxDataRetentionSeconds', true);
    else {
      const fact = disclosure.maxDataRetentionSeconds;
      if (
        !scoped ||
        !hasEvidence(fact) ||
        !Number.isSafeInteger(fact.value) ||
        fact.value < 0 ||
        fact.value > retention
      )
        reject('maxDataRetentionSeconds');
    }
  }
  return issues;
}

/** fal official platform headers / file ACL docs, reviewed 2026-11-04. */
export const falPrivacyHeaderNames = {
  payloadHistory: 'X-Fal-Store-IO',
  outputLifecycle: 'X-Fal-Object-Lifecycle-Preference',
} as const;
export interface FalPrivacyRequest {
  disablePayloadHistory?: true;
  outputExpiresInSeconds?: number;
  outputAccess?: 'private';
}
export interface FalPrivacyCapabilities {
  /** Must describe this exact deployment and connected supplier account. */
  scope: SupplierPrivacyScope & { providerId: 'fal'; connectionId: string };
  evidence: PrivacyEvidence | null;
  payloadHistoryOptOut: boolean;
  outputExpirySeconds: { min: number; max: number } | null;
  privateOutputAcl: boolean;
  /** Runtime capability, not established by the supplier's API documentation. */
  authenticatedIngestion: 'ready' | 'unavailable';
}
export interface FalPrivacyPlan {
  payloadHistory: 'provider-default' | 'disabled';
  outputExpiresInSeconds: number | null;
  outputAccess: 'provider-default' | 'private';
  recoveryWindowSeconds: number;
  /** Controls alone do not establish retention, logs, processing or residency promises. */
  establishesZeroDataRetention: false;
}
export class SupplierPrivacyError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: 'unsupported_supplier_privacy' | 'invalid_supplier_privacy',
    readonly field: keyof FalPrivacyRequest | 'recoveryWindowSeconds',
  ) {
    super(`The selected supplier deployment cannot apply ${field}.`);
  }
}
/**
 * Build a validated control plan. No customer-supplied headers, API keys or
 * media URLs enter this module. Adapter enablement remains gated on integrated
 * authenticated ingestion of private outputs.
 */
export function prepareFalPrivacyControls(
  request: FalPrivacyRequest,
  capabilities: FalPrivacyCapabilities,
  scope: SupplierPrivacyScope,
  recoveryWindowSeconds: number,
): FalPrivacyPlan {
  const invalid = (field: SupplierPrivacyError['field']): never => {
    throw new SupplierPrivacyError('invalid_supplier_privacy', field);
  };
  const unsupported = (field: SupplierPrivacyError['field']): never => {
    throw new SupplierPrivacyError('unsupported_supplier_privacy', field);
  };
  if (!Number.isSafeInteger(recoveryWindowSeconds) || recoveryWindowSeconds < 1)
    invalid('recoveryWindowSeconds');
  const requested = Object.keys(request).length > 0;
  if (
    requested &&
    (scope.providerId !== 'fal' ||
      capabilities.scope.providerId !== 'fal' ||
      !scope.connectionId ||
      capabilities.scope.connectionId !== scope.connectionId ||
      !sameScope(scope, capabilities.scope) ||
      !hasEvidence({ value: true, evidence: capabilities.evidence }))
  )
    unsupported(
      request.disablePayloadHistory !== undefined
        ? 'disablePayloadHistory'
        : request.outputAccess !== undefined
          ? 'outputAccess'
          : 'outputExpiresInSeconds',
    );
  if (request.disablePayloadHistory !== undefined) {
    if (request.disablePayloadHistory !== true) invalid('disablePayloadHistory');
    if (!capabilities.payloadHistoryOptOut) unsupported('disablePayloadHistory');
  }
  if (request.outputAccess !== undefined) {
    if (request.outputAccess !== 'private') invalid('outputAccess');
    if (!capabilities.privateOutputAcl || capabilities.authenticatedIngestion !== 'ready')
      unsupported('outputAccess');
  }
  const expiry = request.outputExpiresInSeconds;
  if (expiry !== undefined) {
    if (!Number.isSafeInteger(expiry) || expiry < 1) invalid('outputExpiresInSeconds');
    const bounds = capabilities.outputExpirySeconds;
    if (
      !bounds ||
      !Number.isSafeInteger(bounds.min) ||
      !Number.isSafeInteger(bounds.max) ||
      bounds.min < 1 ||
      bounds.max < bounds.min ||
      expiry < bounds.min ||
      expiry > bounds.max ||
      expiry < recoveryWindowSeconds
    )
      unsupported('outputExpiresInSeconds');
  }
  // Private outputs need an explicit qualified recovery window, not the supplier default TTL.
  if (request.outputAccess === 'private' && expiry === undefined)
    unsupported('outputExpiresInSeconds');
  return {
    payloadHistory: request.disablePayloadHistory ? 'disabled' : 'provider-default',
    outputExpiresInSeconds: expiry ?? null,
    outputAccess: request.outputAccess ?? 'provider-default',
    recoveryWindowSeconds,
    establishesZeroDataRetention: false,
  };
}

/** Revalidates the named controls and serializes only the reviewed fal headers. */
export function falPrivacyHeaders(
  request: FalPrivacyRequest,
  capabilities: FalPrivacyCapabilities,
  scope: SupplierPrivacyScope,
  recoveryWindowSeconds: number,
): Record<string, string> {
  const plan = prepareFalPrivacyControls(request, capabilities, scope, recoveryWindowSeconds);
  const headers: Record<string, string> = {};
  if (plan.payloadHistory === 'disabled') headers[falPrivacyHeaderNames.payloadHistory] = '0';
  const lifecycle: {
    expiration_duration_seconds?: number;
    initial_acl?: { default: 'forbid'; rules: never[] };
  } = {};
  if (plan.outputExpiresInSeconds !== null)
    lifecycle.expiration_duration_seconds = plan.outputExpiresInSeconds;
  if (plan.outputAccess === 'private') lifecycle.initial_acl = { default: 'forbid', rules: [] };
  if (Object.keys(lifecycle).length)
    headers[falPrivacyHeaderNames.outputLifecycle] = JSON.stringify(lifecycle);
  return headers;
}
