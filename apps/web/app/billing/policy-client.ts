import { billingRequest, stripeCheckoutUrl } from './billing-client';
import { privateWorkspaceHeaders } from '../dashboard/activity-view';
import type {
  BillingPolicy,
  BillingPolicyValues,
} from '../../../../packages/engine/src/billing-policy';
export type BillingOwnerEnrollmentReason =
  | 'admin-required'
  | 'owner-already-active'
  | 'checkout-paused'
  | 'terms-required'
  | 'terms-inactive';
export interface BillingOwnerEnrollment {
  eligible: boolean;
  expectedAuthorityVersion: number;
  terms: { version: string; text: string };
  reason?: BillingOwnerEnrollmentReason;
}
export interface BillingCapabilities {
  read: boolean;
  manage: boolean;
  setup: boolean;
  ownerEnrollment?: BillingOwnerEnrollment;
}
export interface BillingPolicyState {
  workspaceId: string;
  policy: BillingPolicy;
  automaticRechargeAvailable: boolean;
  setupAvailable: boolean;
  portalAvailable: boolean;
  recoveryAvailable: boolean;
  ownerAuthorityVersion: number | null;
  terms: { version: string; text: string } | null;
  mandate: { id: string; status: string } | null;
}
export class BillingWaitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      `Billing is temporarily limited. Wait ${retryAfterSeconds} seconds, then refresh or retry this same request. Keep the original payment or setup reference.`,
    );
  }
}
export function retrySeconds(value: string | null, now = Date.now()): number {
  if (value && /^\d+$/.test(value)) return Math.max(1, Math.min(86400, Number(value)));
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(1, Math.min(86400, Math.ceil((date - now) / 1000))) : 60;
}
const enrollmentReasons = [
  'admin-required',
  'owner-already-active',
  'checkout-paused',
  'terms-required',
  'terms-inactive',
] as const;

function parseOwnerEnrollment(value: unknown): BillingOwnerEnrollment | undefined {
  if (value === undefined) return undefined;
  const raw = value as Partial<BillingOwnerEnrollment> | null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.eligible !== 'boolean' ||
    typeof raw.expectedAuthorityVersion !== 'number' ||
    !Number.isSafeInteger(raw.expectedAuthorityVersion) ||
    raw.expectedAuthorityVersion < 0 ||
    raw.expectedAuthorityVersion > 2147483646 ||
    typeof raw.terms?.version !== 'string' ||
    !raw.terms.version ||
    raw.terms.version.length > 120 ||
    typeof raw.terms.text !== 'string' ||
    !raw.terms.text ||
    (raw.reason !== undefined &&
      !enrollmentReasons.includes(raw.reason as BillingOwnerEnrollmentReason))
  )
    throw new Error('Your billing access could not be verified.');
  return {
    eligible: raw.eligible,
    expectedAuthorityVersion: raw.expectedAuthorityVersion,
    terms: { version: raw.terms.version, text: raw.terms.text },
    ...(raw.reason ? { reason: raw.reason } : {}),
  };
}

/** Read current browser capabilities without persisting the response or trusting URL state. */
export async function readBillingAccess(
  authority: { workspaceId: string; recoveryScope: string },
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<BillingCapabilities | null> {
  const response = await request('/api/billing/access', {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: privateWorkspaceHeaders(authority),
    signal,
  });
  if (response.status === 404) return null;
  if (response.status === 429)
    throw new BillingWaitError(retrySeconds(response.headers.get('retry-after')));
  if (!response.ok) throw new Error('Your billing access could not be verified.');
  const access = await response.json();
  const capabilities = access?.capabilities;
  if (
    access?.workspaceId !== authority.workspaceId ||
    access.recoveryScope !== authority.recoveryScope ||
    typeof capabilities?.read !== 'boolean' ||
    typeof capabilities.manage !== 'boolean' ||
    typeof capabilities.setup !== 'boolean'
  )
    throw new Error('Your billing access could not be verified.');
  const ownerEnrollment = parseOwnerEnrollment(access.ownerEnrollment);
  return {
    read: capabilities.read,
    manage: capabilities.manage,
    setup: capabilities.setup,
    ...(ownerEnrollment ? { ownerEnrollment } : {}),
  };
}

export async function enrollBillingOwner(input: {
  workspaceId: string;
  recoveryScope: string;
  expectedAuthorityVersion: number;
  termsVersion: string;
  request?: typeof fetch;
}): Promise<{ workspaceId: string; authorityVersion: number }> {
  if (
    !Number.isSafeInteger(input.expectedAuthorityVersion) ||
    input.expectedAuthorityVersion < 0 ||
    input.expectedAuthorityVersion > 2147483646 ||
    !input.termsVersion ||
    input.termsVersion.length > 120
  )
    throw new Error('Refresh this workspace’s billing terms before enabling prepaid billing.');
  const result = await policyRequest<{ workspaceId: string; authorityVersion: number }>(
    input.workspaceId,
    '/api/billing/owner',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opengen-recovery-scope': input.recoveryScope,
      },
      body: JSON.stringify({
        expectedAuthorityVersion: input.expectedAuthorityVersion,
        termsVersion: input.termsVersion,
        acceptedTerms: true,
      }),
    },
    input.request,
  );
  if (!Number.isSafeInteger(result.authorityVersion) || result.authorityVersion <= 0)
    throw new Error('Your workspace funding approval could not be verified. Refresh this page.');
  return result;
}

/** Reuses the existing workspace-bound, no-store, HttpOnly-cookie request helper. */
export function policyRequest<T>(
  workspaceId: string,
  path: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
): Promise<T> {
  if (!new Headers(init.headers).get('x-opengen-recovery-scope'))
    throw new Error('Refresh your browser session before reading private billing.');
  return billingRequest<T>(workspaceId, path, init, async (url, options) => {
    const response = await request(url, options);
    if (response.status === 429)
      throw new BillingWaitError(retrySeconds(response.headers.get('retry-after')));
    // Existing billingRequest unwraps a standard {data: object} envelope. Native
    // paginated billing pages use {workspaceId,data:[],...}; preserve that page.
    if (response.ok) {
      const body = await response.clone().json();
      if (body && typeof body.workspaceId === 'string' && Array.isArray(body.data))
        return Response.json(
          { data: body },
          { status: response.status, headers: response.headers },
        );
    }
    return response;
  });
}
export function hostedBillingUrl(value: string, kind: 'checkout' | 'portal' | 'document'): string {
  if (kind === 'checkout') return stripeCheckoutUrl(value);
  const hosts =
    kind === 'portal' ? ['billing.stripe.com'] : ['invoice.stripe.com', 'pay.stripe.com'];
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new Error(
      'The hosted billing link needs review. Refresh this workspace’s billing status.',
    );
  return url.href;
}
export function exactUsdInput(value: string, decimals: 2 | 6): number | null {
  const expression = decimals === 2 ? /^\d{1,10}(?:\.\d{1,2})?$/ : /^\d{1,10}(?:\.\d{1,6})?$/;
  if (!expression.test(value.trim())) return null;
  const [whole = '0', fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
export function exactUsdDisplay(value: number, decimals: 2 | 6): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid billing amount.');
  const scale = 10n ** BigInt(decimals),
    units = BigInt(value);
  const fraction = (units % scale).toString().padStart(decimals, '0');
  return `${units / scale}.${fraction}`;
}
export type PolicyDraft = {
  enabled: boolean;
  threshold: string;
  amount: string;
  monthlyCap: string;
  maxAttempts: string;
  cooldown: string;
  failureLimit: string;
};
export function draftFromPolicy(policy: BillingPolicy): PolicyDraft {
  return {
    enabled: policy.enabled,
    threshold: exactUsdDisplay(policy.thresholdMicros, 6),
    amount: exactUsdDisplay(policy.amountCents, 2),
    monthlyCap: exactUsdDisplay(policy.monthlyCapCents, 2),
    maxAttempts: String(policy.maxAttemptsPerMonth),
    cooldown: String(policy.cooldownSeconds),
    failureLimit: String(policy.failureLimit),
  };
}
export function policyFromDraft(draft: PolicyDraft, mandateId: string | null): BillingPolicyValues {
  const thresholdMicros = exactUsdInput(draft.threshold, 6),
    amountCents = exactUsdInput(draft.amount, 2),
    monthlyCapCents = exactUsdInput(draft.monthlyCap, 2);
  const integer = (value: string) =>
    /^\d{1,10}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const maxAttemptsPerMonth = integer(draft.maxAttempts),
    cooldownSeconds = integer(draft.cooldown),
    failureLimit = integer(draft.failureLimit);
  if (
    thresholdMicros === null ||
    amountCents === null ||
    monthlyCapCents === null ||
    maxAttemptsPerMonth === null ||
    cooldownSeconds === null ||
    failureLimit === null
  )
    throw new Error('Use whole cents for recharge amounts and whole numbers for frequency limits.');
  if (draft.enabled && !mandateId)
    throw new Error('Complete administrator payment setup before enabling automatic recharge.');
  return {
    enabled: draft.enabled,
    thresholdMicros,
    amountCents,
    monthlyCapCents,
    maxAttemptsPerMonth,
    cooldownSeconds,
    failureLimit,
    mandateId,
  };
}
export interface SetupRecovery {
  version: 1;
  workspaceId: string;
  recoveryScope: string;
  idempotencyKey: string;
  termsVersion: string;
  consentReference: string;
  setupId?: string;
}
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const setupIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type SetupResult = {
  workspaceId: string;
  id: string;
  status: 'pending' | 'open' | 'complete' | 'expired' | 'review';
  checkoutUrl: string | null;
  mandateId: string | null;
  termsVersion: string;
};
const setupKey = (workspaceId: string, recoveryScope: string) =>
  `opengen.billing.setup.v1:${JSON.stringify([workspaceId, recoveryScope])}`;
export function readSetupRecovery(
  storage: RecoveryStorage,
  workspaceId: string,
  recoveryScope: string,
): SetupRecovery | null {
  const raw = storage.getItem(setupKey(workspaceId, recoveryScope));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SetupRecovery;
    if (
      value.version === 1 &&
      value.workspaceId === workspaceId &&
      value.recoveryScope === recoveryScope &&
      (value.setupId === undefined ||
        (typeof value.setupId === 'string' && setupIdPattern.test(value.setupId))) &&
      /^[A-Za-z0-9_-]{8,128}$/.test(value.idempotencyKey) &&
      typeof value.termsVersion === 'string' &&
      value.termsVersion.length > 0 &&
      value.termsVersion.length <= 120 &&
      typeof value.consentReference === 'string' &&
      value.consentReference.length > 0 &&
      value.consentReference.length <= 200
    )
      return value;
  } catch {
    /* Unknown setup must not become another request. */
  }
  throw new Error(
    'Saved payment setup needs review. Ask the administrator to reconcile the original setup.',
  );
}
export function prepareSetupRecovery(
  storage: RecoveryStorage,
  workspaceId: string,
  recoveryScope: string,
  termsVersion: string,
  newKey: () => string = () => crypto.randomUUID(),
): SetupRecovery {
  const prior = readSetupRecovery(storage, workspaceId, recoveryScope);
  if (prior) {
    if (prior.termsVersion !== termsVersion)
      throw new Error(
        'Payment terms changed. Reconcile the original setup before starting another.',
      );
    return prior;
  }
  const key = newKey();
  const value: SetupRecovery = {
    version: 1,
    workspaceId,
    recoveryScope,
    idempotencyKey: key,
    termsVersion,
    consentReference: `browser-setup:${key}`,
  };
  storage.setItem(setupKey(workspaceId, recoveryScope), JSON.stringify(value));
  if (readSetupRecovery(storage, workspaceId, recoveryScope)?.idempotencyKey !== key)
    throw new Error('Allow site storage before starting payment setup.');
  return value;
}

/** Return parameters select an authenticated read. They never establish status or consent. */
export function setupStatusId(search: string, savedId?: string): string | null {
  if (savedId && setupIdPattern.test(savedId)) return savedId;
  const query = new URLSearchParams(search);
  const id = query.get('request');
  return ['success', 'cancel'].includes(query.get('setup') ?? '') && id && setupIdPattern.test(id)
    ? id
    : null;
}
function verifySetupResult(result: SetupResult, workspaceId: string, id?: string): void {
  if (
    !result ||
    result.workspaceId !== workspaceId ||
    typeof result.id !== 'string' ||
    !setupIdPattern.test(result.id) ||
    (id !== undefined && result.id !== id) ||
    typeof result.termsVersion !== 'string' ||
    !result.termsVersion ||
    !['pending', 'open', 'complete', 'expired', 'review'].includes(result.status)
  )
    throw new Error('The payment setup does not match the original request. Refresh its status.');
}
export async function readSetupStatus(input: {
  workspaceId: string;
  recoveryScope: string;
  setupId: string;
  signal?: AbortSignal;
  request?: typeof fetch;
}): Promise<SetupResult> {
  if (!setupIdPattern.test(input.setupId))
    throw new Error('Use the original payment setup reference.');
  const result = await policyRequest<SetupResult>(
    input.workspaceId,
    `/api/billing/setups/${encodeURIComponent(input.setupId)}`,
    {
      method: 'GET',
      headers: { 'x-opengen-recovery-scope': input.recoveryScope },
      signal: input.signal,
    },
    input.request,
  );
  verifySetupResult(result, input.workspaceId, input.setupId);
  return result;
}
/** Persist the ID only from the authenticated response to the original stable-key POST. */
export function rememberSetupResult(
  storage: RecoveryStorage,
  recovery: SetupRecovery,
  result: SetupResult,
): void {
  const prior = readSetupRecovery(storage, recovery.workspaceId, recovery.recoveryScope);
  verifySetupResult(result, recovery.workspaceId, prior?.setupId);
  if (
    !prior ||
    prior.idempotencyKey !== recovery.idempotencyKey ||
    prior.termsVersion !== result.termsVersion
  )
    throw new Error(
      'The saved payment setup changed. Check the original request before continuing.',
    );
  storage.setItem(
    setupKey(prior.workspaceId, prior.recoveryScope),
    JSON.stringify({ ...prior, setupId: result.id }),
  );
  if (readSetupRecovery(storage, prior.workspaceId, prior.recoveryScope)?.setupId !== result.id)
    throw new Error('Allow site storage to save this payment setup reference.');
}

/** An authenticated terminal view may clear only its own saved setup. */
export function finishSetupRecovery(
  storage: RecoveryStorage & Pick<Storage, 'removeItem'>,
  workspaceId: string,
  recoveryScope: string,
  result: SetupResult,
): boolean {
  verifySetupResult(result, workspaceId);
  const prior = readSetupRecovery(storage, workspaceId, recoveryScope);
  if (
    !prior ||
    prior.setupId !== result.id ||
    prior.termsVersion !== result.termsVersion ||
    !['complete', 'expired'].includes(result.status)
  )
    return false;
  storage.removeItem(setupKey(workspaceId, recoveryScope));
  return true;
}

type DocumentType = 'receipt' | 'invoice';
function validDocumentCursor(type: DocumentType, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (type === 'receipt' ? /^ch_[A-Za-z0-9_]{1,197}$/ : /^in_[A-Za-z0-9_]{1,197}$/).test(value)
  );
}
/** This Stripe cursor is distinct from the cached document list's `before` cursor. */
export async function syncDocumentPage(input: {
  workspaceId: string;
  recoveryScope: string;
  type: DocumentType;
  cursor?: string;
  request?: typeof fetch;
}): Promise<string | null> {
  if (input.cursor !== undefined && !validDocumentCursor(input.type, input.cursor))
    throw new Error('Use the original document sync cursor.');
  const page = await policyRequest<{
    workspaceId: string;
    hasMore: boolean;
    nextCursor: string | null;
  }>(
    input.workspaceId,
    '/api/billing/documents/sync',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opengen-recovery-scope': input.recoveryScope,
      },
      body: JSON.stringify({
        type: input.type,
        limit: 20,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    },
    input.request,
  );
  if (page.hasMore === false && page.nextCursor === null) return null;
  if (
    page.hasMore !== true ||
    !validDocumentCursor(input.type, page.nextCursor) ||
    page.nextCursor === input.cursor
  )
    throw new Error(
      'The document sync cursor could not be verified. Refresh the current document list.',
    );
  return page.nextCursor;
}
