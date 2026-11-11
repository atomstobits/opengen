'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Footer, SiteHeader } from '../ui';
import { useLegalPresentation } from '../legal/presentation';
import type { BrowserSession } from '../gateway-access';
import { hasWorkspaceAuthority, privateWorkspaceHeaders } from '../dashboard/activity-view';
import { BillingPolicyPanel } from './policy-panel';
import {
  enrollBillingOwner,
  readBillingAccess,
  type BillingCapabilities,
  type BillingOwnerEnrollment,
} from './policy-client';
import {
  billingRequest,
  createOrRecoverOrder,
  dollarsToCents,
  finishTopUp,
  pendingTopUp,
  stripeCheckoutUrl,
  type BillingSummary,
  type PaymentOrder,
  type PendingTopUp,
} from './billing-client';
import styles from './billing.module.css';

const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const statusLabels: Record<PaymentOrder['status'], string> = {
  created: 'Ready for checkout',
  checkout_pending: 'Checking checkout',
  checkout_open: 'Checkout open',
  payment_pending: 'Payment pending',
  payment_failed: 'Payment failed',
  expired: 'Checkout expired',
  credited: 'Credit added',
  review: 'Under review',
};
const resumable = (order: PaymentOrder) =>
  ['created', 'checkout_pending', 'checkout_open'].includes(order.status);
const terminal = (order: PaymentOrder) =>
  ['credited', 'payment_failed', 'expired'].includes(order.status);
const pending = (order: PaymentOrder) =>
  ['checkout_pending', 'checkout_open', 'payment_pending'].includes(order.status);
const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Billing is unavailable. Please try again.';

/** Standalone entry point; the dashboard may instead mount Billing with its selected workspace ID. */
export function BillingPage() {
  const legal = useLegalPresentation();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let pendingSession: AbortController | undefined;
    const refresh = () => {
      pendingSession?.abort();
      const controller = new AbortController();
      pendingSession = controller;
      setSession(null);
      setError('');
      void fetch('/api/session', { cache: 'no-store', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('Your session could not be checked.');
          const result = await response.json();
          const current = result.data ?? result;
          if (typeof current?.authenticated !== 'boolean')
            throw new Error('Your session could not be checked.');
          if (!controller.signal.aborted) setSession(current);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(message(cause));
        });
    };
    const refreshVisible = () => {
      if (!document.hidden) refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'opengen:session-signal') refresh();
    };
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel('opengen-session');
      channel.onmessage = (event) => {
        if (event.data?.type === 'changed') refresh();
      };
    } catch {
      /* Focus and storage signals also recheck the session. */
    }
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('storage', onStorage);
    window.addEventListener('opengen:session-changed', refresh);
    refresh();
    return () => {
      pendingSession?.abort();
      channel?.close();
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('opengen:session-changed', refresh);
    };
  }, []);
  return (
    <>
      <SiteHeader active="dashboard" />
      <main className={styles.page}>
        <a href="/dashboard" className={styles.back}>
          ← Your workspace
        </a>
        {session?.authenticated && session.workspaceId ? (
          <Billing workspaceId={session.workspaceId} recoveryScope={session.recoveryScope} />
        ) : (
          <section className={styles.signedOut}>
            <span className={styles.eyebrow}>BILLING</span>
            <h1>Keep your next idea moving.</h1>
            <p>
              {session
                ? 'Sign in to add credit and see your payment history.'
                : 'Checking your session…'}
            </p>
            <p className="legal-review-links">
              {legal.mode === 'published' ? (
                <>
                  Review the <a href="/terms">Terms of Service</a>,{' '}
                  <a href="/refunds">Refund Policy</a> and <a href="/privacy">Privacy Notice</a>.
                </>
              ) : legal.mode === 'staged' ? (
                <>
                  Review the <a href="/terms">Terms of Service</a>,{' '}
                  <a href="/refunds">Refund Policy</a> and <a href="/privacy">Privacy Notice</a>.
                  Scheduled effective {legal.effectiveAt} — not yet effective.
                </>
              ) : (
                <>
                  Review the <a href="/terms">Terms draft</a>,{' '}
                  <a href="/refunds">Refund policy draft</a> and{' '}
                  <a href="/privacy">Privacy draft</a>. Not yet effective.
                </>
              )}
            </p>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {session?.oidcEnabled ? (
              <a className={styles.primary} href="/auth/login">
                Sign in to OpenGen ↗
              </a>
            ) : session ? (
              <a className={styles.secondary} href="/dashboard">
                Open your workspace
              </a>
            ) : null}
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}

/** Session-backed workspace billing. No card details or Stripe credentials enter this component. */
type BillingWorkspace = { workspaceId: string; recoveryScope?: string };

export function Billing({ workspaceId, recoveryScope }: BillingWorkspace) {
  return (
    <WorkspaceBilling
      key={JSON.stringify([workspaceId, recoveryScope])}
      workspaceId={workspaceId}
      recoveryScope={recoveryScope}
    />
  );
}

function WorkspaceBilling({ workspaceId, recoveryScope }: BillingWorkspace) {
  const legal = useLegalPresentation();
  const [capabilities, setCapabilities] = useState<BillingCapabilities | null>();
  const [policyRefreshKey, setPolicyRefreshKey] = useState(0);
  const [accessError, setAccessError] = useState('');
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [amount, setAmount] = useState('25');
  const [recovery, setRecovery] = useState<PendingTopUp | null>(null);
  const [active, setActive] = useState<PaymentOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const mounted = useRef(true);
  const acting = useRef(false);
  const selection = useRef<string | null>(null);

  const scopedFetch = useCallback<typeof fetch>(
    (url, init) => {
      const authority = { workspaceId, recoveryScope };
      if (!hasWorkspaceAuthority(authority)) return fetch(url, init);
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(privateWorkspaceHeaders(authority)))
        headers.set(name, value);
      return fetch(url, { ...init, headers });
    },
    [workspaceId, recoveryScope],
  );

  useEffect(() => {
    const authority = { workspaceId, recoveryScope };
    if (recoveryScope === undefined) return;
    if (!hasWorkspaceAuthority(authority)) {
      setAccessError('Your billing access could not be verified.');
      return;
    }
    const controller = new AbortController();
    void readBillingAccess(authority, controller.signal)
      .then((access) => {
        if (!controller.signal.aborted) setCapabilities(access);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setAccessError(message(cause));
      });
    return () => controller.abort();
  }, [workspaceId, recoveryScope]);

  // A legacy API returns 404. A scoped runtime must explicitly permit reads before
  // this browser restores workspace-keyed payment references or looks up an order.
  const canReadOrders =
    recoveryScope === undefined || capabilities === null || capabilities?.read === true;

  const load = useCallback(async () => {
    if (!canReadOrders) return;
    const next = await billingRequest<BillingSummary>(workspaceId, '/api/billing', {}, scopedFetch);
    if (!mounted.current) return;
    setSummary(next);
    let saved: PendingTopUp | null = null;
    try {
      saved = pendingTopUp(window.localStorage, workspaceId);
      if (mounted.current) {
        setRecovery(saved);
        setStorageError('');
      }
    } catch (cause) {
      if (mounted.current)
        setStorageError(`${message(cause)} New top-ups are paused until recovery is available.`);
    }
    const query = new URLSearchParams(window.location.search);
    const returnedId = query.get('order');
    const target =
      selection.current ??
      saved?.orderId ??
      (returnedId && orderIdPattern.test(returnedId) ? returnedId : null);
    let current = target ? (next.orders.find((item) => item.id === target) ?? null) : null;
    if (target && !current)
      current = await billingRequest<PaymentOrder>(
        workspaceId,
        `/api/billing/orders/${encodeURIComponent(target)}`,
        {},
        scopedFetch,
      );
    if (mounted.current) {
      setSummary(next);
      setActive(current);
      if (saved) setAmount((saved.amountCents / 100).toFixed(2));
    }
  }, [canReadOrders, workspaceId, scopedFetch]);

  useEffect(() => {
    if (!canReadOrders) return;
    mounted.current = true;
    setLoading(true);
    const query = new URLSearchParams(window.location.search);
    if (query.get('checkout') === 'success')
      setNotice('You’re back from Checkout. Credit appears once your payment is confirmed below.');
    else if (query.get('checkout') === 'cancel')
      setNotice(
        'You returned from Checkout. Review the order status below; you can resume an open checkout.',
      );
    void load()
      .catch((cause) => {
        if (mounted.current) setError(message(cause));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [canReadOrders, load]);

  useEffect(() => {
    if (!summary?.orders.some(pending) && !(active && pending(active))) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !acting.current)
        void load().catch((cause) => {
          if (mounted.current) setError(message(cause));
        });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [summary, active, load]);

  async function act(operation: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) {
        setError(`${message(cause)} Resume or refresh this top-up before starting another.`);
        try {
          setRecovery(pendingTopUp(window.localStorage, workspaceId));
        } catch {
          /* Already shown. */
        }
      }
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function checkout(order: PaymentOrder) {
    if (!mounted.current) return;
    selection.current = order.id;
    setActive(order);
    if (!resumable(order)) {
      await load();
      return;
    }
    const next = await billingRequest<PaymentOrder>(
      workspaceId,
      `/api/billing/orders/${encodeURIComponent(order.id)}/checkout`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      scopedFetch,
    );
    if (!mounted.current) return;
    if (next.id !== order.id || next.amountCents !== order.amountCents)
      throw new Error('The checkout does not match this order. Refresh its status.');
    setActive(next);
    if (next.status === 'checkout_open' && next.checkoutUrl)
      window.location.assign(stripeCheckoutUrl(next.checkoutUrl));
    else {
      setNotice(
        'Your order is saved. Refresh its status while checkout or payment is being confirmed.',
      );
      await load();
    }
  }

  const cents = dollarsToCents(amount);
  const validAmount =
    cents !== null &&
    summary !== null &&
    cents >= summary.minAmountCents &&
    cents <= summary.maxAmountCents;
  const blocked =
    !canReadOrders || busy || !summary?.enabled || summary.billingHold || !!storageError;
  const newFundingDenied = summary?.newFunding?.allowed === false;
  const topUpBlocked =
    blocked || (newFundingDenied && !(recovery && active && active.status !== 'created'));
  const terminalRecovery = !!active && terminal(active) && recovery?.orderId === active.id;
  const incompleteCount = summary?.orders.filter((order) => !terminal(order)).length ?? 0;

  if (accessError)
    return (
      <p className={styles.error} role="alert">
        {accessError}
      </p>
    );
  if (capabilities?.read === false && recoveryScope) {
    if (capabilities.ownerEnrollment)
      return (
        <BillingOwnerEnrollmentCard
          workspaceId={workspaceId}
          recoveryScope={recoveryScope}
          enrollment={capabilities.ownerEnrollment}
          legal={legal}
          onEnrolled={async () => {
            const next = await readBillingAccess({ workspaceId, recoveryScope });
            if (mounted.current) {
              setCapabilities(next);
              setNotice(
                'Prepaid billing is enabled for this workspace. Choose an amount below to add credit.',
              );
            }
          }}
        />
      );
    return (
      <BillingPolicyPanel
        workspaceId={workspaceId}
        recoveryScope={recoveryScope}
        capabilities={capabilities}
      />
    );
  }

  return (
    <section className={styles.billing} aria-labelledby="billing-title" aria-busy={loading}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>YOUR WORKSPACE / BILLING</span>
          <h1 id="billing-title">
            A little credit.
            <br />
            <em>A lot of possibility.</em>
          </h1>
          <p>Add prepaid credit for image and video generation.</p>
        </div>
        <div className={styles.workspace}>
          <span>Paying workspace</span>
          <strong>{workspaceId}</strong>
        </div>
      </header>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {storageError && (
        <p className={styles.error} role="alert">
          {storageError}
        </p>
      )}
      {summary && !summary.enabled && (
        <p className={styles.notice} role="status">
          Online top-ups are unavailable on this installation. Your existing payment history is
          shown below.
        </p>
      )}
      {summary?.billingHold && (
        <p className={styles.hold} role="alert">
          <strong>Billing needs review.</strong> New spending and top-ups are paused. Contact your
          installation operator with the payment reference below.
        </p>
      )}
      {summary?.enabled && newFundingDenied && summary.newFunding?.reason && (
        <p className={styles.notice} role="status">
          {summary.newFunding.reason === 'terms-required' ? (
            <>
              Review the current Terms before starting a new top-up.{' '}
              <a href="/auth/login">Review Terms and sign in</a>.
            </>
          ) : (
            'New top-ups are unavailable until the current Terms are active. Your payment history remains available.'
          )}
        </p>
      )}
      <div className={styles.topUpGrid}>
        <form
          className={styles.topUp}
          onSubmit={(event) => {
            event.preventDefault();
            if (topUpBlocked || !validAmount || cents === null) return;
            void act(async () => {
              const order = await createOrRecoverOrder({
                workspaceId,
                amountCents: cents,
                storage: window.localStorage,
                request: scopedFetch,
              });
              setRecovery(pendingTopUp(window.localStorage, workspaceId));
              await checkout(order);
            });
          }}
        >
          <div className={styles.cardTop}>
            <span className={styles.eyebrow}>01 / ADD CREDIT</span>
            <span className={styles.currency}>USD</span>
          </div>
          <label className={styles.amountLabel} htmlFor="top-up-amount">
            Choose your amount
          </label>
          <div className={styles.amountInput}>
            <span aria-hidden="true">$</span>
            <input
              id="top-up-amount"
              aria-describedby="amount-help"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              maxLength={9}
              disabled={busy || !!recovery}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </div>
          <div className={styles.presets} aria-label="Suggested top-up amounts">
            {[10, 25, 50, 100].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={cents === value * 100}
                disabled={
                  busy ||
                  !!recovery ||
                  !summary ||
                  value * 100 < summary.minAmountCents ||
                  value * 100 > summary.maxAmountCents
                }
                onClick={() => setAmount(String(value))}
              >
                {usd(value * 100)}
              </button>
            ))}
          </div>
          <p id="amount-help" className={styles.help}>
            {summary
              ? `${usd(summary.minAmountCents)}–${usd(summary.maxAmountCents)} per top-up.`
              : 'Loading top-up limits…'}{' '}
            Credit is added after payment confirmation.
          </p>
          <button
            className={styles.primary}
            type="submit"
            disabled={topUpBlocked || !validAmount || terminalRecovery}
          >
            {busy
              ? 'Checking your order…'
              : recovery
                ? 'Resume this top-up ↗'
                : 'Continue to Stripe ↗'}
          </button>
          <p className={styles.finePrint}>One-time payment · Secure hosted checkout</p>
          <p className={`${styles.finePrint} legal-review-links`}>
            {legal.mode === 'published' ? (
              <>
                Governed by the <a href="/terms">Terms of Service</a> and{' '}
                <a href="/refunds">Prepaid Credit and Refund Policy</a>.
              </>
            ) : legal.mode === 'staged' ? (
              <>
                Review the <a href="/terms">Terms of Service</a> and{' '}
                <a href="/refunds">Refund Policy</a>. Scheduled effective {legal.effectiveAt} — not
                yet effective.
              </>
            ) : (
              <>
                Review the <a href="/terms">Terms draft</a> and{' '}
                <a href="/refunds">Refund policy draft</a>. Not yet effective.
              </>
            )}
          </p>
        </form>
        <aside className={styles.explanation}>
          <span className={styles.eyebrow}>MAKE ROOM TO CREATE</span>
          <h2>
            You choose when
            <br />
            to add more.
          </h2>
          <p>
            Your top-up becomes USD service credit in this workspace. Generation costs come from
            that balance.
          </p>
          <ol>
            <li>
              <span>1</span>Choose an amount.
            </li>
            <li>
              <span>2</span>Complete your payment on Stripe.
            </li>
            <li>
              <span>3</span>See confirmed credit in your history.
            </li>
          </ol>
          <a href="/dashboard">
            View your balance and usage ledger <span aria-hidden="true">↗</span>
          </a>
        </aside>
      </div>
      {(active || recovery) && (
        <section className={styles.current} aria-labelledby="current-top-up">
          <div>
            <span className={styles.eyebrow}>CURRENT TOP-UP</span>
            <h2 id="current-top-up">
              {usd(active?.amountCents ?? recovery!.amountCents)}{' '}
              <span className={styles.status} data-status={active?.status}>
                {active ? statusLabels[active.status] : 'Request awaiting confirmation'}
              </span>
            </h2>
            <p>
              {active?.status === 'credited'
                ? 'Payment confirmed. This credit has been added to your workspace.'
                : active?.status === 'payment_pending'
                  ? 'Your payment method is still processing. Credit will appear after confirmation.'
                  : active?.status === 'review'
                    ? 'This order needs operator review before it can be reconciled.'
                    : active?.status === 'payment_failed'
                      ? 'This payment was not confirmed. Review this order before starting another top-up.'
                      : active?.status === 'expired'
                        ? 'This checkout has expired. You can start a new top-up.'
                        : 'Your order is saved. Resume the same top-up or refresh its status.'}
            </p>
            {active && <code className={styles.reference}>{active.id}</code>}
          </div>
          {terminalRecovery && (
            <button
              className={styles.secondary}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const current = await billingRequest<PaymentOrder>(
                    workspaceId,
                    `/api/billing/orders/${encodeURIComponent(active!.id)}`,
                    {},
                    scopedFetch,
                  );
                  if (!mounted.current) return;
                  finishTopUp(window.localStorage, workspaceId, current);
                  setRecovery(null);
                  selection.current = null;
                  setActive(null);
                  setNotice('Ready for a new top-up.');
                  await load();
                })
              }
            >
              Start another top-up
            </button>
          )}
        </section>
      )}
      <section className={styles.history} aria-labelledby="history-title">
        <div className={styles.historyHeading}>
          <div>
            <span className={styles.eyebrow}>02 / PAYMENT HISTORY</span>
            <h2 id="history-title">Every top-up, accounted for.</h2>
            <p>
              {incompleteCount > 0
                ? `${incompleteCount} order${incompleteCount === 1 ? '' : 's'} awaiting completion or review.`
                : 'Confirmed payments and open orders in one place.'}
            </p>
          </div>
          <button
            className={styles.secondary}
            disabled={busy || loading}
            onClick={() =>
              void act(async () => {
                await load();
                setNotice('Payment status refreshed.');
              })
            }
          >
            {busy ? 'Refreshing…' : 'Refresh status ↻'}
          </button>
        </div>
        {summary?.orders.length ? (
          <div className={styles.tableWrap}>
            <table>
              <caption className={styles.visuallyHidden}>
                Recent prepaid credit orders for {workspaceId}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date / reference</th>
                  <th scope="col">Credit value</th>
                  <th scope="col">Payment status</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <time dateTime={order.createdAt}>
                        {new Date(order.createdAt).toLocaleString()}
                      </time>
                      <code>{order.id}</code>
                    </td>
                    <td className={styles.money}>{usd(order.amountCents)}</td>
                    <td>
                      <span className={styles.status} data-status={order.status}>
                        {statusLabels[order.status]}
                      </span>
                    </td>
                    <td>
                      {resumable(order) ? (
                        <button
                          className={styles.rowAction}
                          disabled={blocked || (newFundingDenied && order.status === 'created')}
                          onClick={() => void act(() => checkout(order))}
                        >
                          Resume ↗
                        </button>
                      ) : (
                        <button
                          className={styles.rowAction}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              selection.current = order.id;
                              await load();
                            })
                          }
                        >
                          View status
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.empty}>
            <span aria-hidden="true">[ + ]</span>
            <h3>{loading ? 'Loading payment history…' : 'Your next project starts here.'}</h3>
            <p>
              {loading
                ? 'Checking this workspace’s orders.'
                : 'Your top-ups will appear here, with a clear record of when credit was added.'}
            </p>
          </div>
        )}
        <p className={styles.historyNote}>
          Only “Credit added” means funds are available. Returning from Checkout or closing its
          window never adds credit by itself.
        </p>
      </section>
      {capabilities?.read && recoveryScope && capabilities.ownerEnrollment?.upgradeToRecharge && (
        <BillingAutoRechargeUpgradeCard
          workspaceId={workspaceId}
          recoveryScope={recoveryScope}
          enrollment={capabilities.ownerEnrollment}
          onUpgraded={async () => {
            const next = await readBillingAccess({ workspaceId, recoveryScope });
            if (mounted.current) {
              setCapabilities(next);
              setPolicyRefreshKey((current) => current + 1);
              setNotice(
                'Saved-card automatic recharge authority is now enabled for this workspace.',
              );
            }
          }}
        />
      )}
      {capabilities?.read && recoveryScope && (
        <BillingPolicyPanel
          key={policyRefreshKey}
          workspaceId={workspaceId}
          recoveryScope={recoveryScope}
          capabilities={capabilities}
        />
      )}
    </section>
  );
}

function BillingAutoRechargeUpgradeCard({
  workspaceId,
  recoveryScope,
  enrollment,
  onUpgraded,
}: {
  workspaceId: string;
  recoveryScope: string;
  enrollment: BillingOwnerEnrollment;
  onUpgraded: () => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!enrollment.eligible) return null;

  return (
    <section className={styles.current} aria-labelledby="recharge-upgrade-title">
      <div>
        <span className={styles.eyebrow}>OPTIONAL SAVED-CARD RECHARGE</span>
        <h2 id="recharge-upgrade-title">Enable automatic recharge authority</h2>
        <p>
          This workspace was originally enrolled for one-time manual top-ups only. Approve updated
          workspace funding rails to save a card and configure opt-in automatic recharge limits.
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <label className={styles.consentLabel}>
          <input
            type="checkbox"
            checked={accepted}
            disabled={submitting}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>
            I authorize saved-card setup and opt-in automatic recharge rails for {workspaceId} under
            payment summary {enrollment.terms.version}.
          </span>
        </label>
      </div>
      <button
        className={styles.primary}
        type="button"
        disabled={!accepted || submitting}
        onClick={() => {
          if (!accepted || submitting) return;
          setSubmitting(true);
          setError('');
          void enrollBillingOwner({
            workspaceId,
            recoveryScope,
            expectedAuthorityVersion: enrollment.expectedAuthorityVersion,
            termsVersion: enrollment.terms.version,
          })
            .then(() => onUpgraded())
            .catch((cause) => {
              setError(message(cause));
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        {submitting ? 'Updating authority…' : 'Enable auto-recharge authority →'}
      </button>
    </section>
  );
}

function BillingOwnerEnrollmentCard({
  workspaceId,
  recoveryScope,
  enrollment,
  legal,
  onEnrolled,
}: {
  workspaceId: string;
  recoveryScope: string;
  enrollment: BillingOwnerEnrollment;
  legal: ReturnType<typeof useLegalPresentation>;
  onEnrolled: () => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  return (
    <section className={styles.billing} aria-labelledby="billing-enrollment-title">
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>YOUR WORKSPACE / BILLING</span>
          <h1 id="billing-enrollment-title">
            Enable prepaid
            <br />
            <em>workspace credit.</em>
          </h1>
          <p>Approve manual one-time USD top-ups for image and video generation.</p>
        </div>
        <div className={styles.workspace}>
          <span>Paying workspace</span>
          <strong>{workspaceId}</strong>
        </div>
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.topUpGrid}>
        <form
          className={styles.topUp}
          onSubmit={(event) => {
            event.preventDefault();
            if (!enrollment.eligible || !accepted || submitting) return;
            setSubmitting(true);
            setError('');
            void enrollBillingOwner({
              workspaceId,
              recoveryScope,
              expectedAuthorityVersion: enrollment.expectedAuthorityVersion,
              termsVersion: enrollment.terms.version,
            })
              .then(() => onEnrolled())
              .catch((cause) => {
                setError(message(cause));
              })
              .finally(() => {
                setSubmitting(false);
              });
          }}
        >
          <div className={styles.cardTop}>
            <span className={styles.eyebrow}>01 / ENABLE PREPAID BILLING</span>
            <span className={styles.currency}>USD</span>
          </div>
          {enrollment.eligible ? (
            <>
              <p className={styles.enrollmentLead}>
                {enrollment.allowsAutoRecharge
                  ? 'Establish your administrator account as the funding owner for this workspace. Enable one-time Stripe Checkout top-ups and optional opt-in saved-card automatic recharge within your workspace limits.'
                  : 'Establish your administrator account as the funding owner for this workspace. Manual top-ups are one-time Stripe Checkout payments; automatic recurring charges remain disabled.'}
              </p>
              <details className={styles.termsDisclosure}>
                <summary>Payment and refund summary ({enrollment.terms.version})</summary>
                <p>{enrollment.terms.text}</p>
              </details>
              <label className={styles.consentLabel}>
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={submitting}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  {enrollment.allowsAutoRecharge ? (
                    <>
                      I am an authorized workspace administrator and agree to enable prepaid USD
                      billing under the <a href="/terms">Terms of Service</a> and{' '}
                      <a href="/refunds">Prepaid Credit and Refund Policy</a>.
                    </>
                  ) : (
                    <>
                      I am an authorized workspace administrator and agree to enable manual prepaid
                      USD top-ups under the <a href="/terms">Terms of Service</a> and{' '}
                      <a href="/refunds">Prepaid Credit and Refund Policy</a>.
                    </>
                  )}
                </span>
              </label>
              <button className={styles.primary} type="submit" disabled={!accepted || submitting}>
                {submitting ? 'Enabling prepaid billing…' : 'Enable prepaid billing →'}
              </button>
              <p className={styles.finePrint}>
                {enrollment.allowsAutoRecharge
                  ? 'Prepaid USD credit · Optional opt-in saved-card auto-recharge'
                  : 'One-time prepaid credit · No saved-card auto-recharge'}
              </p>
            </>
          ) : (
            <>
              <div className={styles.enrollmentStatus} role="status">
                {enrollment.reason === 'admin-required' ? (
                  <p>
                    Only a workspace administrator can enable prepaid billing for this workspace.
                    Your existing generation balance and BYOK provider connections remain available.
                  </p>
                ) : enrollment.reason === 'owner-already-active' ? (
                  <p>
                    Prepaid billing is already enabled by another administrator in this workspace.
                    Ask that funding owner to add credit, or spend from your workspace’s available
                    generation balance.
                  </p>
                ) : enrollment.reason === 'terms-required' ? (
                  <p>
                    Review and accept the current Terms of Service before enabling prepaid billing
                    for this workspace.
                  </p>
                ) : enrollment.reason === 'terms-inactive' ? (
                  <p>
                    Prepaid billing enrollment will open once the published Terms of Service take
                    effect.
                  </p>
                ) : (
                  <p>
                    New prepaid billing enrollment and top-ups are temporarily paused. Try again
                    shortly.
                  </p>
                )}
              </div>
              {enrollment.reason === 'terms-required' && (
                <a className={styles.primary} href="/auth/login">
                  Review Terms and sign in ↗
                </a>
              )}
            </>
          )}
          <p className={`${styles.finePrint} legal-review-links`}>
            {legal.mode === 'published' ? (
              <>
                Governed by the <a href="/terms">Terms of Service</a> and{' '}
                <a href="/refunds">Prepaid Credit and Refund Policy</a>.
              </>
            ) : legal.mode === 'staged' ? (
              <>
                Review the <a href="/terms">Terms of Service</a> and{' '}
                <a href="/refunds">Refund Policy</a>. Scheduled effective {legal.effectiveAt} — not
                yet effective.
              </>
            ) : (
              <>
                Review the <a href="/terms">Terms draft</a> and{' '}
                <a href="/refunds">Refund policy draft</a>. Not yet effective.
              </>
            )}
          </p>
        </form>
        <aside className={styles.explanation}>
          <span className={styles.eyebrow}>HOW PREPAID CREDIT WORKS</span>
          <h2>
            Manual top-ups,
            <br />
            clear boundaries.
          </h2>
          <p>
            Enabling prepaid billing records your workspace’s human funding owner without charging a
            card until you choose an amount.
          </p>
          <ol>
            <li>
              <span>1</span>Enable manual prepaid billing as workspace admin.
            </li>
            <li>
              <span>2</span>Add $5.00–$1,000.00 USD via Stripe Checkout when needed.
            </li>
            <li>
              <span>3</span>Spend from your workspace balance across web, REST, MCP, or CLI.
            </li>
          </ol>
          <a href="/dashboard">
            Use BYOK or view your workspace ledger <span aria-hidden="true">↗</span>
          </a>
        </aside>
      </div>
    </section>
  );
}
