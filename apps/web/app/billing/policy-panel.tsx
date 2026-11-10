'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { hasWorkspaceAuthority, privateWorkspaceHeaders } from '../dashboard/activity-view';
import type { BillingPolicy } from '../../../../packages/engine/src/billing-policy';
import type { RechargeAttempt } from '../../../../packages/engine/src/billing-recharge';
import type { FeeSettlementStatement } from '../../../../packages/engine/src/billing-fees';
import {
  BillingWaitError,
  draftFromPolicy,
  finishSetupRecovery,
  exactUsdDisplay,
  hostedBillingUrl,
  policyFromDraft,
  policyRequest,
  prepareSetupRecovery,
  readSetupRecovery,
  readSetupStatus,
  rememberSetupResult,
  setupStatusId,
  syncDocumentPage,
  type BillingCapabilities,
  type BillingPolicyState,
  type PolicyDraft,
  type SetupResult,
} from './policy-client';
import styles from './policy-panel.module.css';
import { createRechargeAuthenticator } from './recharge-authentication';

type BillingDocument = {
  type: 'receipt' | 'invoice';
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  url: string | null;
  pdfUrl: string | null;
};
type DocumentPage = {
  workspaceId: string;
  data: BillingDocument[];
  hasMore?: boolean;
  nextCursor: string | null;
};
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : 'Billing could not be loaded. Refresh this workspace’s status.';
const dollars = (cents: number) => `$${exactUsdDisplay(cents, 2)}`;
const microDollars = (micros: number) => `$${exactUsdDisplay(micros, 6).replace(/0{1,4}$/, '')}`;
const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const labels: Record<RechargeAttempt['status'], string> = {
  queued: 'Queued',
  submitting: 'Confirming charge',
  unknown: 'Outcome unknown',
  processing: 'Processing',
  requires_authentication: 'Authentication needed',
  review: 'Under review',
  succeeded: 'Credit added',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Private standalone extension. Props control presentation; backend authority is always rechecked. */
export function BillingPolicyPanel({
  workspaceId,
  capabilities,
  recoveryScope,
}: {
  workspaceId: string;
  capabilities: BillingCapabilities;
  recoveryScope: string;
}) {
  if (capabilities.read && !hasWorkspaceAuthority({ workspaceId, recoveryScope }))
    return (
      <section className={styles.limited} role="status">
        Refresh your current workspace session before reading private billing.
      </section>
    );
  if (!capabilities.read)
    return (
      <section className={styles.limited} aria-label="Billing access">
        <span className={styles.eyebrow}>WORKSPACE WALLET</span>
        <p>
          Your generation balance remains available in the workspace. Payment documents and funding
          settings require explicit billing access.
        </p>
      </section>
    );
  return (
    <PrivatePolicyPanel
      key={`${workspaceId}:${recoveryScope}:${capabilities.manage}:${capabilities.setup}`}
      workspaceId={workspaceId}
      capabilities={capabilities}
      recoveryScope={recoveryScope}
    />
  );
}
function PrivatePolicyPanel({
  workspaceId,
  capabilities,
  recoveryScope,
}: {
  workspaceId: string;
  capabilities: BillingCapabilities;
  recoveryScope: string;
}) {
  const id = useId();
  const [state, setState] = useState<BillingPolicyState | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [documents, setDocuments] = useState<DocumentPage | null>(null);
  const [documentType, setDocumentType] = useState<'receipt' | 'invoice'>('receipt');
  const [syncCursors, setSyncCursors] = useState({ receipt: null, invoice: null } as Record<
    'receipt' | 'invoice',
    string | null
  >);
  const [recharges, setRecharges] = useState<RechargeAttempt[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false),
    [chargeAccepted, setChargeAccepted] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupResult | null>(null);
  const [setupPending, setSetupPending] = useState(false),
    [waitUntil, setWaitUntil] = useState(0),
    [clock, setClock] = useState(Date.now());
  const setupLookup = useRef<string | null>(null);
  const setupReadVersion = useRef(0);
  const mounted = useRef(true),
    acting = useRef(false);
  const request = useCallback(
    <T,>(path: string, init: RequestInit = {}) =>
      policyRequest<T>(workspaceId, path, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          ...privateWorkspaceHeaders({ workspaceId, recoveryScope }),
        },
      }),
    [workspaceId, recoveryScope],
  );
  const authenticateRecharge = useMemo(
    () =>
      createRechargeAuthenticator({
        enabled: capabilities.setup && state?.recoveryAvailable === true,
        requestAuthentication: (attemptId, versions) =>
          request(`/api/billing/recharges/${encodeURIComponent(attemptId)}/authentication`, {
            method: 'POST',
            ...json(versions),
          }),
        isCurrent: () => mounted.current,
      }),
    [capabilities.setup, state?.recoveryAvailable, request],
  );
  const refresh = useCallback(async () => {
    const [policy, history] = await Promise.all([
      request<BillingPolicyState>('/api/billing/policy'),
      request<{ workspaceId: string; data: RechargeAttempt[] }>('/api/billing/recharges'),
    ]);
    if (!mounted.current) return;
    setState(policy);
    setDraft(draftFromPolicy(policy.policy));
    setRecharges(history.data);
    setChargeAccepted(false);
  }, [request]);
  const loadExistingSetup = useCallback(
    async (setupId: string, signal?: AbortSignal) => {
      const version = ++setupReadVersion.current;
      const result = await readSetupStatus({ workspaceId, recoveryScope, setupId, signal });
      if (!mounted.current || signal?.aborted || setupReadVersion.current !== version) return;
      setSetupStatus(result);
      if (finishSetupRecovery(window.localStorage, workspaceId, recoveryScope, result)) {
        setSetupPending(false);
        setTermsAccepted(false);
      }
    },
    [workspaceId, recoveryScope],
  );
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (capabilities.setup) {
      try {
        const saved = readSetupRecovery(window.localStorage, workspaceId, recoveryScope);
        setSetupPending(Boolean(saved));
        setupLookup.current = setupStatusId(window.location.search, saved?.setupId);
      } catch (cause) {
        setError(message(cause));
        setupLookup.current = setupStatusId(window.location.search);
      }
      if (setupLookup.current) {
        void loadExistingSetup(setupLookup.current, controller.signal).catch((cause) => {
          if (mounted.current && !controller.signal.aborted) setError(message(cause));
        });
      }
    }
    void refresh().catch((cause) => {
      if (mounted.current && !controller.signal.aborted) setError(message(cause));
    });
    return () => {
      controller.abort();
      mounted.current = false;
    };
  }, [capabilities.setup, loadExistingSetup, refresh, workspaceId, recoveryScope]);
  useEffect(() => {
    const controller = new AbortController();
    void request<DocumentPage>(`/api/billing/documents?type=${documentType}&limit=20`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setDocuments(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [request, documentType]);
  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= waitUntil) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waitUntil]);
  async function act(operation: () => Promise<void>) {
    if (acting.current || waitUntil > Date.now()) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) {
        setError(message(cause));
        if (cause instanceof BillingWaitError) {
          setWaitUntil(Date.now() + cause.retryAfterSeconds * 1000);
          setClock(Date.now());
        }
      }
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const waiting = Math.max(0, Math.ceil((waitUntil - clock) / 1000));
  const disabled = busy || waiting > 0;
  const ownerApproved =
    (state?.ownerAuthorityVersion ?? state?.policy.ownerAuthorityVersion) !== null &&
    (state?.ownerAuthorityVersion ?? state?.policy.ownerAuthorityVersion) !== undefined;
  const mandate = state?.mandate?.status === 'active' ? state.mandate.id : null;
  const rechargeEnabled = Boolean(
    mandate && state?.policy.enabled && state.policy.mandateId === mandate,
  );
  const policyState = !state
    ? 'Loading'
    : (state.ownerAuthorityVersion ?? state.policy.ownerAuthorityVersion) === null
      ? 'Requires owner approval'
      : !state.automaticRechargeAvailable
        ? 'Activation disabled'
        : !mandate
          ? 'Requires setup'
          : rechargeEnabled
            ? 'Enabled'
            : state.policy.enabled
              ? 'Requires updated approval'
              : 'Disabled';
  const set = (key: keyof PolicyDraft, value: string | boolean) =>
    setDraft((prior) => (prior ? { ...prior, [key]: value } : prior));
  async function loadDocuments(cursor?: string) {
    const page = await request<DocumentPage>(
      `/api/billing/documents?type=${documentType}&limit=20${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (mounted.current)
      setDocuments((prior) =>
        cursor && prior ? { ...page, data: [...prior.data, ...page.data] } : page,
      );
  }
  async function syncDocuments(cursor?: string) {
    const nextCursor = await syncDocumentPage({
      workspaceId,
      recoveryScope,
      type: documentType,
      cursor,
    });
    if (!mounted.current) return;
    setSyncCursors((prior) => ({ ...prior, [documentType]: nextCursor }));
    await loadDocuments();
    if (mounted.current)
      setNotice(
        cursor
          ? 'Older documents synced. Use Load more documents to read the saved records.'
          : 'Payment documents synced. A document does not add wallet credit.',
      );
  }
  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`} aria-busy={busy}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>PRIVATE BILLING / CONTROLS & RECORDS</span>
          <h2 id={`${id}-title`}>
            Keep creating.
            <br />
            <span>Keep control.</span>
          </h2>
          <p>Your funding rules, payment setup and documents belong to this workspace.</p>
        </div>
        <span
          className={styles.state}
          data-enabled={state?.automaticRechargeAvailable && rechargeEnabled}
        >
          {policyState}
        </span>
      </header>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {waiting > 0 && (
        <p className={styles.notice} role="status">
          Try this same request again in {waiting} seconds. Existing payments keep their original
          references.
        </p>
      )}
      {state && !state.automaticRechargeAvailable && (
        <div className={styles.activation}>
          <span aria-hidden="true">[ pause ]</span>
          <div>
            <strong>Automatic charging is not active on this installation.</strong>
            <p>
              Settings can be reviewed here. The worker cannot dispatch automatic charges while
              activation is disabled. The proposed 5% smart-routing fee also remains inactive;
              accepted jobs keep their original billing policy.
            </p>
          </div>
        </div>
      )}
      <div className={styles.grid}>
        <section className={styles.settings} aria-labelledby={`${id}-policy`}>
          <div className={styles.cardHeading}>
            <span className={styles.eyebrow}>01 / RECHARGE POLICY</span>
            <span className={styles.version}>v{state?.policy.version ?? '—'}</span>
          </div>
          <h3 id={`${id}-policy`}>
            A balance rule,
            <br />
            with a spending boundary.
          </h3>
          <p className={styles.lead}>
            Automatic recharge adds prepaid credit. It never resets a generation key’s spending
            limit.
          </p>
          {draft && state ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!capabilities.manage || disabled || !ownerApproved) return;
                void act(async () => {
                  if (draft.enabled && !state.automaticRechargeAvailable)
                    throw new Error('Automatic charging remains disabled on this installation.');
                  if (draft.enabled && !chargeAccepted)
                    throw new Error(
                      'Confirm the card-charging disclosure before saving an enabled policy.',
                    );
                  const policy = policyFromDraft(
                    draft,
                    draft.enabled ? mandate : state.policy.mandateId,
                  );
                  const result = await request<{ workspaceId: string; policy: BillingPolicy }>(
                    '/api/billing/policy',
                    {
                      method: 'PUT',
                      ...json({
                        expectedVersion: state.policy.version,
                        expectedAuthorityVersion:
                          state.ownerAuthorityVersion ?? state.policy.ownerAuthorityVersion,
                        policy,
                        ...(capabilities.setup && draft.enabled
                          ? { consentReference: `browser-policy:${crypto.randomUUID()}` }
                          : {}),
                      }),
                    },
                  );
                  if (mounted.current) {
                    setState({ ...state, policy: result.policy });
                    setDraft(draftFromPolicy(result.policy));
                    setNotice(
                      'Billing policy saved. The current activation and mandate checks still apply.',
                    );
                    setChargeAccepted(false);
                  }
                });
              }}
            >
              <fieldset
                disabled={!capabilities.manage || disabled || !ownerApproved}
                className={styles.fields}
              >
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={!state.automaticRechargeAvailable && !draft.enabled}
                    onChange={(event) => set('enabled', event.target.checked)}
                  />
                  <span>
                    <strong>Automatic recharge</strong>
                    <small>Opt in only after payment setup and installation activation.</small>
                  </span>
                </label>
                <div className={styles.fieldGrid}>
                  <label htmlFor={`${id}-threshold`}>
                    When available credit is below <span>USD</span>
                    <input
                      id={`${id}-threshold`}
                      value={draft.threshold}
                      inputMode="decimal"
                      maxLength={20}
                      onChange={(event) => set('threshold', event.target.value)}
                      required
                    />
                  </label>
                  <label htmlFor={`${id}-amount`}>
                    Add credit per recharge <span>USD</span>
                    <input
                      id={`${id}-amount`}
                      value={draft.amount}
                      inputMode="decimal"
                      maxLength={14}
                      onChange={(event) => set('amount', event.target.value)}
                      required
                    />
                  </label>
                  <label htmlFor={`${id}-monthly`}>
                    Automatic funding cap per month <span>USD</span>
                    <input
                      id={`${id}-monthly`}
                      value={draft.monthlyCap}
                      inputMode="decimal"
                      maxLength={14}
                      onChange={(event) => set('monthlyCap', event.target.value)}
                      required
                    />
                  </label>
                  <label htmlFor={`${id}-attempts`}>
                    Maximum attempts per month
                    <input
                      id={`${id}-attempts`}
                      value={draft.maxAttempts}
                      inputMode="numeric"
                      maxLength={10}
                      onChange={(event) => set('maxAttempts', event.target.value)}
                      required
                    />
                  </label>
                  <label htmlFor={`${id}-cooldown`}>
                    Minimum time between attempts <span>seconds</span>
                    <input
                      id={`${id}-cooldown`}
                      value={draft.cooldown}
                      inputMode="numeric"
                      maxLength={10}
                      onChange={(event) => set('cooldown', event.target.value)}
                      required
                    />
                  </label>
                  <label htmlFor={`${id}-failures`}>
                    Stop after this many failures
                    <input
                      id={`${id}-failures`}
                      value={draft.failureLimit}
                      inputMode="numeric"
                      maxLength={10}
                      onChange={(event) => set('failureLimit', event.target.value)}
                      required
                    />
                  </label>
                </div>
                {draft.enabled && (
                  <label className={styles.approval}>
                    <input
                      type="checkbox"
                      checked={chargeAccepted}
                      onChange={(event) => setChargeAccepted(event.target.checked)}
                      required
                    />
                    <span>
                      I understand that enabling this policy authorizes future charges to this
                      workspace’s saved payment method within these limits. No new generation is
                      submitted by saving it.
                    </span>
                  </label>
                )}
                {capabilities.manage && ownerApproved ? (
                  <button
                    type="submit"
                    className={styles.primary}
                    disabled={disabled || (draft.enabled && !state.automaticRechargeAvailable)}
                  >
                    {busy ? 'Saving…' : 'Save billing policy'}
                  </button>
                ) : (
                  <p className={styles.fine}>
                    Changing settings requires explicit billing management access and a current
                    owner-approved funding envelope.
                  </p>
                )}
              </fieldset>
            </form>
          ) : (
            <p className={styles.fine}>Loading this workspace’s current policy…</p>
          )}
        </section>
        <aside className={styles.setup} aria-labelledby={`${id}-setup`}>
          <span className={styles.eyebrow}>02 / PAYMENT METHOD</span>
          <h3 id={`${id}-setup`}>
            Set up on Stripe.
            <br />
            Approve here.
          </h3>
          <p>
            OpenGen stores opaque payment references. Card details stay on Stripe’s hosted page.
          </p>
          <dl className={styles.mandate}>
            <div>
              <dt>Payment authorization</dt>
              <dd>{state?.mandate?.status ?? (mandate ? 'Active' : 'Requires setup')}</dd>
            </div>
            <div>
              <dt>Workspace policy</dt>
              <dd>{state?.policy.enabled ? 'Enabled' : 'Disabled'}</dd>
            </div>
          </dl>
          {capabilities.setup && setupStatus && (
            <div className={styles.notice} role="status">
              <strong>
                {setupStatus.status === 'complete'
                  ? 'Payment method setup confirmed'
                  : setupStatus.status === 'expired'
                    ? 'Original payment setup expired'
                    : setupStatus.status === 'review'
                      ? 'Original payment setup needs review'
                      : 'Original payment setup awaits confirmation'}
              </strong>
              <p>
                Setup reference <code>{setupStatus.id}</code>.{' '}
                {setupStatus.status === 'complete'
                  ? 'Automatic recharge follows the current workspace policy.'
                  : 'Refresh the saved status for this request.'}
              </p>
            </div>
          )}
          {capabilities.setup && ownerApproved ? (
            <>
              {state?.terms ? (
                <details className={styles.terms}>
                  <summary>Payment terms · {state.terms.version}</summary>
                  <p>{state.terms.text}</p>
                </details>
              ) : (
                <p className={styles.fine}>
                  Payment setup is unavailable until this installation provides its reviewed terms.
                </p>
              )}
              <label className={styles.approval}>
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  disabled={disabled || !state?.setupAvailable || !state?.terms}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                />
                <span>
                  I am approving payment setup as this workspace’s authorized funding owner and
                  accept the terms shown above. Setup does not enable automatic recharge by itself.
                </span>
              </label>
              <button
                className={styles.primary}
                disabled={disabled || !termsAccepted || !state?.setupAvailable || !state?.terms}
                onClick={() =>
                  void act(async () => {
                    if (!state?.terms || !termsAccepted)
                      throw new Error('Review and accept the current payment terms first.');
                    const recovery = prepareSetupRecovery(
                      window.localStorage,
                      workspaceId,
                      recoveryScope,
                      state.terms.version,
                    );
                    setupReadVersion.current++;
                    setSetupPending(true);
                    const result = await request<SetupResult>('/api/billing/setup', {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/json',
                        'Idempotency-Key': recovery.idempotencyKey,
                      },
                      body: JSON.stringify({
                        termsVersion: recovery.termsVersion,
                        acceptedTerms: true,
                      }),
                    });
                    if (!mounted.current) return;
                    rememberSetupResult(window.localStorage, recovery, result);
                    setupLookup.current = result.id;
                    setSetupStatus(result);
                    if (result.status === 'open' && result.checkoutUrl)
                      window.location.assign(hostedBillingUrl(result.checkoutUrl, 'checkout'));
                    else {
                      if (
                        finishSetupRecovery(window.localStorage, workspaceId, recoveryScope, result)
                      ) {
                        setSetupPending(false);
                        setTermsAccepted(false);
                      }
                      setNotice(
                        result.status === 'complete'
                          ? 'Payment setup confirmed. Review the policy before enabling recharge.'
                          : `The original payment setup is ${result.status}. Refresh its status before starting another.`,
                      );
                      await refresh();
                    }
                  })
                }
              >
                {setupPending ? 'Resume original payment setup ↗' : 'Set up payment method ↗'}
              </button>
              {mandate && (
                <button
                  className={styles.dangerButton}
                  disabled={disabled}
                  onClick={() =>
                    void act(async () => {
                      if (
                        !window.confirm(
                          'Revoke this workspace’s saved payment authorization? New automatic attempts will stop; already accepted payments still reconcile.',
                        )
                      )
                        return;
                      await request<{ workspaceId: string }>('/api/billing/mandate', {
                        method: 'DELETE',
                        ...json({ id: mandate }),
                      });
                      await refresh();
                      setNotice(
                        'Payment authorization revoked. Accepted payments retain their original reconciliation records.',
                      );
                    })
                  }
                >
                  Revoke payment authorization
                </button>
              )}
            </>
          ) : (
            <p className={styles.fine}>
              The approved funding owner must complete initial payment setup and accept its terms.
              An administrator role or billing delegation alone does not create card consent.
            </p>
          )}
          {capabilities.setup && ownerApproved && (
            <button
              className={styles.secondary}
              disabled={disabled || !mandate || !state?.portalAvailable}
              onClick={() =>
                void act(async () => {
                  const result = await request<{ workspaceId: string; url: string }>(
                    '/api/billing/portal',
                    { method: 'POST', ...json({}) },
                  );
                  if (mounted.current)
                    window.location.assign(hostedBillingUrl(result.url, 'portal'));
                })
              }
            >
              Open billing portal ↗
            </button>
          )}
          <button
            className={styles.textButton}
            disabled={disabled}
            onClick={() =>
              void act(async () => {
                if (capabilities.setup && setupLookup.current)
                  await loadExistingSetup(setupLookup.current);
                await refresh();
                await loadDocuments();
                setNotice('Billing status refreshed.');
              })
            }
          >
            Refresh saved status ↻
          </button>
        </aside>
      </div>
      <section className={styles.records} aria-labelledby={`${id}-recharges`}>
        <div className={styles.recordsHeading}>
          <div>
            <span className={styles.eyebrow}>03 / AUTOMATIC FUNDING</span>
            <h3 id={`${id}-recharges`}>Every attempt has a reference.</h3>
          </div>
          <p>Pending and uncertain attempts count toward funding limits.</p>
        </div>
        {recharges.length ? (
          <div className={styles.tableWrap}>
            <table>
              <caption className={styles.srOnly}>
                Automatic recharge attempts for this workspace
              </caption>
              <thead>
                <tr>
                  <th scope="col">Created / reference</th>
                  <th scope="col">Funding amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {recharges.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString()}
                      </time>
                      <code>{item.id}</code>
                    </td>
                    <td>{dollars(item.amountCents)}</td>
                    <td>
                      <span
                        className={styles.recordStatus}
                        data-review={['review', 'unknown', 'requires_authentication'].includes(
                          item.status,
                        )}
                      >
                        {labels[item.status]}
                      </span>
                      {item.status === 'requires_authentication' &&
                        capabilities.setup &&
                        state?.recoveryAvailable && (
                          <button
                            className={styles.authenticationButton}
                            disabled={disabled}
                            onClick={() =>
                              void act(async () => {
                                const authorityVersion =
                                  state.ownerAuthorityVersion ?? state.policy.ownerAuthorityVersion;
                                if (authorityVersion === null)
                                  throw new Error(
                                    'The funding owner must approve the current policy before authentication.',
                                  );
                                const result = await authenticateRecharge(item, {
                                  expectedPolicyVersion: state.policy.version,
                                  expectedAuthorityVersion: authorityVersion,
                                });
                                if (!mounted.current) return;
                                setNotice(
                                  result.status === 'awaiting_webhook'
                                    ? 'Authentication submitted for the original payment. Credit appears only after the signed payment confirmation is reconciled.'
                                    : result.status === 'requires_authentication'
                                      ? 'Authentication is still required for this original payment. Refresh its status before retrying.'
                                      : 'This original payment needs review. Keep its reference and contact the operator.',
                                );
                                await refresh();
                              })
                            }
                          >
                            Authenticate this {dollars(item.amountCents)} payment
                          </button>
                        )}
                      {['review', 'unknown', 'requires_authentication'].includes(item.status) && (
                        <small>
                          Use this reference for operator review. Do not start another charge to
                          recover it.
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>
            No automatic recharge attempts are recorded. Manual top-ups remain separate.
          </p>
        )}
      </section>
      <section className={styles.records} aria-labelledby={`${id}-documents`}>
        <div className={styles.recordsHeading}>
          <div>
            <span className={styles.eyebrow}>04 / PRIVATE DOCUMENTS</span>
            <h3 id={`${id}-documents`}>
              Receipts and invoices,
              <br />
              with their own meaning.
            </h3>
          </div>
          <div className={styles.documentActions}>
            <label className={styles.srOnly} htmlFor={`${id}-type`}>
              Document type
            </label>
            <select
              id={`${id}-type`}
              value={documentType}
              disabled={disabled}
              onChange={(event) => {
                setDocuments(null);
                setDocumentType(event.target.value as 'receipt' | 'invoice');
              }}
            >
              <option value="receipt">Receipts</option>
              <option value="invoice">Invoices</option>
            </select>
            <button
              className={styles.secondary}
              disabled={disabled}
              onClick={() => void act(() => syncDocuments())}
            >
              Sync documents ↻
            </button>
            {syncCursors[documentType] && (
              <button
                className={styles.secondary}
                disabled={disabled}
                onClick={() => void act(() => syncDocuments(syncCursors[documentType]!))}
              >
                Sync older {documentType === 'receipt' ? 'receipts' : 'invoices'}
              </button>
            )}
          </div>
        </div>
        <p className={styles.fine}>
          A receipt confirms a payment. An invoice is a billing document. Workspace credit appears
          only after the payment’s verified reconciliation.
        </p>
        {documents?.data.length ? (
          <div className={styles.documentList}>
            {documents.data.map((item) => (
              <article key={`${item.type}:${item.id}`}>
                <div>
                  <strong>
                    {item.type === 'invoice' ? 'Invoice' : 'Receipt'} · {item.status}
                  </strong>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </time>
                  <code>{item.id}</code>
                </div>
                <span>
                  {item.currency === 'usd' || item.currency === 'USD'
                    ? dollars(item.amountCents)
                    : `${item.amountCents} ${item.currency.toUpperCase()} minor units`}
                </span>
                <div className={styles.documentLinks}>
                  {item.url && <SafeDocumentLink url={item.url}>View ↗</SafeDocumentLink>}
                  {item.pdfUrl && <SafeDocumentLink url={item.pdfUrl}>PDF ↗</SafeDocumentLink>}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>
            No {documentType === 'receipt' ? 'receipts' : 'invoices'} are saved for this workspace.
          </p>
        )}
        {documents?.nextCursor && (
          <button
            className={styles.secondary}
            disabled={disabled}
            onClick={() => void act(() => loadDocuments(documents.nextCursor!))}
          >
            Load more documents
          </button>
        )}
      </section>
    </section>
  );
}
function SafeDocumentLink({ url, children }: { url: string; children: React.ReactNode }) {
  try {
    return (
      <a href={hostedBillingUrl(url, 'document')} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  } catch {
    return <span className={styles.fine}>Link under review</span>;
  }
}
/** Optional private receipt detail; callers pass the persisted settlement statement. */
export function BillingFeeBreakdown({ statement }: { statement: FeeSettlementStatement }) {
  return (
    <section className={styles.feeBreakdown} aria-label="Verified generation cost">
      <h3>Generation cost</h3>
      <dl>
        <div>
          <dt>Verified provider cost{statement.billing === 'byok' ? ' · billed directly' : ''}</dt>
          <dd>{microDollars(statement.providerCostMicros)}</dd>
        </div>
        <div>
          <dt>Collected routing service fee</dt>
          <dd>{microDollars(statement.collectedFeeMicros)}</dd>
        </div>
        {statement.waivedFeeMicros > 0 && (
          <div>
            <dt>Routing fee waived under accepted ceiling</dt>
            <dd>{microDollars(statement.waivedFeeMicros)}</dd>
          </div>
        )}
        {statement.operatorOverrunMicros > 0 && (
          <div>
            <dt>Provider overrun absorbed by operator</dt>
            <dd>{microDollars(statement.operatorOverrunMicros)}</dd>
          </div>
        )}
        <div className={styles.total}>
          <dt>Workspace credit used</dt>
          <dd>{microDollars(statement.customerTotalMicros)}</dd>
        </div>
      </dl>
      <p>
        Policy {statement.policyId}, version {statement.policyVersion}. This receipt retains the
        billing policy accepted with the original job.
      </p>
    </section>
  );
}
