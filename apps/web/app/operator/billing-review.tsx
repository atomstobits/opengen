'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { BillingReviewItem } from '../../../../packages/engine/src/billing-operations';
import { exactUsdDisplay, retrySeconds } from '../billing/policy-client';
class ReviewError extends Error {}
import styles from './billing-review.module.css';

const kindLabel: Record<BillingReviewItem['kind'], string> = {
  'stripe-event': 'Stripe event',
  'manual-payment': 'Manual top-up',
  'automatic-payment': 'Automatic recharge',
  'provider-cost': 'Provider cost',
  'risk-hold': 'Billing hold',
};
const guidance: Record<BillingReviewItem['kind'], string> = {
  'stripe-event':
    'Inspect the original signed event and its stored payment identity. Reconcile the original request from authoritative Stripe records; do not create a payment to guess an outcome.',
  'manual-payment':
    'Recover the original Checkout request, session and stable retry identity in the existing payment reconciliation tools. A return URL or old timeout does not prove payment or non-acceptance.',
  'automatic-payment':
    'Inspect the original saved-card attempt and Stripe request record. Bind only its original PaymentIntent, or record verified unpaid evidence. Never initiate another charge to recover an unknown one.',
  'provider-cost':
    'Use the existing operator generation reconciliation and reviewed liability-absorption path. Keep the reservation until supported provider bill/usage or an explicit audited operator decision resolves it; an estimate is not actual cost.',
  'risk-hold':
    'Review the refund/dispute evidence and accounting outcome before clearing this hold. Clearing a hold permits new spending and funding under current policy; it does not issue a refund or alter ledger history.',
};
const kinds = new Set(Object.keys(kindLabel));
const validWorkspace = (value: string) => /^[A-Za-z0-9_-]{1,80}$/.test(value);
const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const money = (value: number, decimals: 2 | 6) => `$${exactUsdDisplay(value, decimals)}`;
function evidenceValid(reference: string, note: string, evidenceUrl: string): boolean {
  try {
    const url = new URL(evidenceUrl);
    return (
      reference.trim().length > 0 &&
      reference.length <= 200 &&
      note.trim().length >= 20 &&
      note.length <= 2000 &&
      evidenceUrl.length <= 2000 &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
/** Operator billing uses its dedicated bearer even if the browser has a workspace session. */
export function operatorBillingRequestInit(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('cookie');
  return { ...init, cache: 'no-store', credentials: 'omit', headers };
}
/** Installation operator only. The token is a caller-owned memory value, never
 * copied into storage, URLs, rendered fields, provider calls or error messages. */
export function BillingReview(props: { token: string; workspaceId?: string }) {
  return (
    <OperatorBillingReview
      key={JSON.stringify([props.token, props.workspaceId ?? null])}
      {...props}
    />
  );
}
function OperatorBillingReview({ token, workspaceId }: { token: string; workspaceId?: string }) {
  const id = useId();
  const [filter, setFilter] = useState(workspaceId ?? ''),
    [items, setItems] = useState<BillingReviewItem[]>([]);
  const [selected, setSelected] = useState<BillingReviewItem | null>(null),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loadedAt, setLoadedAt] = useState<string | null>(null),
    [needsRefresh, setNeedsRefresh] = useState(false);
  const [action, setAction] = useState<'bind' | 'confirmed-unpaid'>('bind'),
    [paymentId, setPaymentId] = useState('');
  const [reference, setReference] = useState(''),
    [note, setNote] = useState(''),
    [evidence, setEvidence] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const identity = useRef(0),
    acting = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    identity.current++;
    setItems([]);
    setSelected(null);
    setLoadedAt(null);
    setNeedsRefresh(false);
    setError('');
    setNotice('');
    setFilter(workspaceId ?? '');
    setConfirmed(false);
    setReference('');
    setNote('');
    setEvidence('');
    setPaymentId('');
  }, [token, workspaceId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      identity.current++;
    };
  }, []);
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(path, operatorBillingRequestInit(token, init));
    if (!response.ok) {
      if (response.status === 409)
        throw new ReviewError(
          'This record or its authority changed. Refresh and inspect the original record before another decision; no retry was sent.',
        );
      if ([401, 403].includes(response.status))
        throw new ReviewError(
          'Current installation operator authority is required. Reconnect before reviewing billing.',
        );
      if (response.status === 429)
        throw new ReviewError(
          `The operator request is temporarily limited. Wait ${retrySeconds(response.headers.get('retry-after'))} seconds, then refresh the same record; no retry was sent.`,
        );
      throw new ReviewError(
        'The billing result could not be confirmed. Refresh the original record and inspect its audit reference before retrying.',
      );
    }
    return response.json() as Promise<unknown>;
  }
  async function act(operation: (version: number) => Promise<void>) {
    if (acting.current || !token) return;
    const version = identity.current;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation(version);
    } catch (cause) {
      if (mounted.current && version === identity.current) {
        setError(
          cause instanceof ReviewError
            ? cause.message
            : 'The review could not be confirmed. Refresh the original record, verify operator authority and inspect any existing resolution before retrying.',
        );
        setNeedsRefresh(true);
      }
    } finally {
      acting.current = false;
      if (mounted.current && version === identity.current) setBusy(false);
    }
  }
  const current = (version: number) => mounted.current && version === identity.current;
  async function load(version: number) {
    if (filter && !validWorkspace(filter)) throw new ReviewError('Invalid workspace filter.');
    const result = (await request(
      `/api/operator/billing${filter ? `?workspaceId=${encodeURIComponent(filter)}` : ''}`,
    )) as { data?: unknown };
    if (!Array.isArray(result.data) || result.data.length > 100)
      throw new ReviewError('Invalid operator queue.');
    const records = result.data as BillingReviewItem[];
    if (
      records.some(
        (item) =>
          !item ||
          !kinds.has(item.kind) ||
          typeof item.id !== 'string' ||
          item.id.length > 200 ||
          typeof item.reason !== 'string' ||
          item.reason.length > 500 ||
          !Number.isFinite(Date.parse(item.createdAt)) ||
          (item.workspaceId !== null &&
            (!validWorkspace(item.workspaceId) || (filter && item.workspaceId !== filter))) ||
          (item.heldMicros !== undefined &&
            (!Number.isSafeInteger(item.heldMicros) || item.heldMicros < 0)) ||
          (item.amountCents !== undefined &&
            (!Number.isSafeInteger(item.amountCents) || item.amountCents < 0)),
      )
    )
      throw new ReviewError('Invalid operator queue.');
    if (!current(version)) return;
    setItems(records);
    setSelected(null);
    setConfirmed(false);
    setLoadedAt(new Date().toISOString());
    setNeedsRefresh(false);
    setNotice('Review queue refreshed. Select a record to inspect its available actions.');
  }
  function inspect(item: BillingReviewItem) {
    setSelected(item);
    setAction('bind');
    setPaymentId('');
    setReference('');
    setNote('');
    setEvidence('');
    setConfirmed(false);
    setError('');
    setNotice('');
  }
  const actionable =
    selected?.workspaceId !== null &&
    (selected?.kind === 'risk-hold' || selected?.kind === 'automatic-payment');
  const valid =
    selected &&
    actionable &&
    confirmed &&
    evidenceValid(reference, note, evidence) &&
    (selected.kind !== 'automatic-payment' ||
      action !== 'bind' ||
      /^pi_[A-Za-z0-9]+$/.test(paymentId));
  const actionText =
    selected?.kind === 'risk-hold'
      ? 'Record hold resolution'
      : action === 'bind'
        ? 'Bind original payment identity'
        : 'Record confirmed unpaid outcome';
  const setField = (setter: (value: string) => void, value: string) => {
    setter(value);
    setConfirmed(false);
  };
  return (
    <section className={styles.review} aria-labelledby={`${id}-title`} aria-busy={busy}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>INSTALLATION OPERATOR / PRIVATE BILLING</span>
          <h2 id={`${id}-title`}>
            Resolve the record.
            <br />
            <span>Preserve the history.</span>
          </h2>
          <p>
            Inspect uncertain payments, provider costs and risk holds using the original evidence.
            No charge, generation, credit or refund is initiated from this queue.
          </p>
        </div>
        <span className={styles.operator}>Operator access</span>
      </header>
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          void act(load);
        }}
      >
        <label htmlFor={`${id}-workspace`}>
          Workspace filter <span>Optional · leave blank for the bounded installation queue</span>
          <input
            id={`${id}-workspace`}
            value={filter}
            maxLength={80}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              identity.current++;
              setFilter(event.target.value);
              setItems([]);
              setSelected(null);
              setLoadedAt(null);
              setConfirmed(false);
              setNeedsRefresh(false);
              setError('');
            }}
          />
        </label>
        <button
          className={styles.primary}
          disabled={busy || !token || (filter !== '' && !validWorkspace(filter))}
        >
          {busy ? 'Checking…' : 'Refresh review queue'}
        </button>
      </form>
      {!token && (
        <p className={styles.notice}>
          Connect the installation operator before fetching private billing records.
        </p>
      )}
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
      {needsRefresh && (
        <p className={styles.warning}>
          Refresh the queue before making another decision. A stale or uncertain result is never
          retried automatically.
        </p>
      )}
      <div className={styles.queueHeading}>
        <h3>
          Review queue <span>{loadedAt ? items.length : '—'}</span>
        </h3>
        <p>
          {loadedAt ? (
            <>
              Loaded <time dateTime={loadedAt}>{new Date(loadedAt).toLocaleString()}</time> · up to
              100 records
            </>
          ) : (
            'Records load only when you request a refresh.'
          )}
        </p>
      </div>
      {items.length ? (
        <div className={styles.queue}>
          {items.map((item) => (
            <button
              type="button"
              key={`${item.kind}:${item.id}`}
              disabled={busy || needsRefresh}
              aria-pressed={selected?.kind === item.kind && selected?.id === item.id}
              onClick={() => inspect(item)}
            >
              <span className={styles.kind}>{kindLabel[item.kind]}</span>
              <span className={styles.rowBody}>
                <strong>{item.reason}</strong>
                <code>{item.id}</code>
                <small>{item.workspaceId ?? 'Workspace identity unresolved'}</small>
              </span>
              <span className={styles.rowAmount}>
                {item.amountCents !== undefined
                  ? money(item.amountCents, 2)
                  : item.heldMicros !== undefined
                    ? `${money(item.heldMicros, 6)} held`
                    : 'Inspect →'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          {loadedAt
            ? 'No records are in this bounded review page. A clear page is not proof that every external payment has reconciled.'
            : 'The queue has not been fetched.'}
        </p>
      )}
      {selected && (
        <section className={styles.detail} aria-labelledby={`${id}-record`}>
          <div className={styles.recordHeading}>
            <div>
              <span className={styles.eyebrow}>
                SELECTED RECORD / {kindLabel[selected.kind].toUpperCase()}
              </span>
              <h3 id={`${id}-record`}>{selected.reason}</h3>
              <code>{selected.id}</code>
            </div>
            <span>
              {selected.amountCents !== undefined
                ? money(selected.amountCents, 2)
                : selected.heldMicros !== undefined
                  ? `${money(selected.heldMicros, 6)} held`
                  : 'Amount not established'}
            </span>
          </div>
          <dl className={styles.recordMeta}>
            <div>
              <dt>Workspace</dt>
              <dd>{selected.workspaceId ?? 'Unresolved · resolve original identity first'}</dd>
            </div>
            <div>
              <dt>Recorded state / reason</dt>
              <dd>{selected.reason}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>
                <time dateTime={selected.createdAt}>
                  {new Date(selected.createdAt).toLocaleString()}
                </time>
              </dd>
            </div>
          </dl>
          <p className={styles.guidance}>{guidance[selected.kind]}</p>
          {selected.kind === 'provider-cost' && (
            <a className={styles.secondary} href="/operator">
              Open generation reconciliation →
            </a>
          )}
          {actionable ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid || busy || needsRefresh || !selected.workspaceId) return;
                const record = { ...selected };
                const body = {
                  workspaceId: record.workspaceId,
                  reference,
                  note,
                  evidenceUrl: evidence,
                  ...(record.kind === 'risk-hold'
                    ? { eventId: record.id }
                    : {
                        id: record.id,
                        action,
                        ...(action === 'bind' ? { paymentIntentId: paymentId } : {}),
                      }),
                };
                void act(async (version) => {
                  await request(
                    record.kind === 'risk-hold'
                      ? '/api/operator/billing/holds/resolve'
                      : '/api/operator/billing/recharges/resolve',
                    { method: 'POST', ...json(body) },
                  );
                  if (!current(version)) return;
                  setConfirmed(false);
                  setNeedsRefresh(true);
                  setNotice(
                    'The audited resolution was recorded. Refresh the queue before making another decision.',
                  );
                });
              }}
              className={styles.resolution}
            >
              {selected.kind === 'automatic-payment' && (
                <>
                  <label htmlFor={`${id}-action`}>
                    Resolution action
                    <select
                      id={`${id}-action`}
                      value={action}
                      disabled={busy || needsRefresh}
                      onChange={(event) => {
                        setAction(event.target.value as 'bind' | 'confirmed-unpaid');
                        setConfirmed(false);
                      }}
                    >
                      <option value="bind">Bind original PaymentIntent</option>
                      <option value="confirmed-unpaid">Record authoritative unpaid evidence</option>
                    </select>
                  </label>
                  {action === 'bind' ? (
                    <label htmlFor={`${id}-payment`}>
                      Original PaymentIntent ID
                      <input
                        id={`${id}-payment`}
                        value={paymentId}
                        disabled={busy || needsRefresh}
                        onChange={(event) => setField(setPaymentId, event.target.value)}
                        maxLength={200}
                        required
                        autoComplete="off"
                      />
                      <small>
                        Match the original Stripe request, customer, method, currency and face
                        value. Binding does not credit the wallet.
                      </small>
                    </label>
                  ) : (
                    <p className={styles.warning}>
                      An old timeout is not unpaid evidence. An accepted PaymentIntent must have
                      authoritative cancellation evidence; active requests and stale state are
                      refused by the backend.
                    </p>
                  )}
                </>
              )}
              <div className={styles.evidenceGrid}>
                <label htmlFor={`${id}-reference`}>
                  Stable evidence reference
                  <input
                    id={`${id}-reference`}
                    value={reference}
                    disabled={busy || needsRefresh}
                    onChange={(event) => setField(setReference, event.target.value)}
                    maxLength={200}
                    required
                    autoComplete="off"
                  />
                </label>
                <label htmlFor={`${id}-evidence`}>
                  Evidence URL · HTTPS
                  <input
                    id={`${id}-evidence`}
                    type="url"
                    value={evidence}
                    disabled={busy || needsRefresh}
                    onChange={(event) => setField(setEvidence, event.target.value)}
                    maxLength={2000}
                    required
                    placeholder="https://…"
                  />
                </label>
              </div>
              <label htmlFor={`${id}-note`}>
                Verification notes
                <textarea
                  id={`${id}-note`}
                  value={note}
                  disabled={busy || needsRefresh}
                  onChange={(event) => setField(setNote, event.target.value)}
                  minLength={20}
                  maxLength={2000}
                  required
                  rows={4}
                />
                <small>
                  Record the actual evidence and decision. Do not paste credentials, client secrets,
                  card details or private generation content.
                </small>
              </label>
              <div className={styles.preview}>
                <span className={styles.eyebrow}>REVIEW BEFORE RECORDING</span>
                <strong>{actionText}</strong>
                <p>
                  Workspace <code>{selected.workspaceId}</code> · record <code>{selected.id}</code>{' '}
                  · state <strong>{selected.reason}</strong>
                </p>
                <p>
                  {selected.amountCents !== undefined
                    ? `Original funding face value: ${money(selected.amountCents, 2)}.`
                    : 'No payment amount is established by this queue item.'}{' '}
                  {selected.kind === 'risk-hold'
                    ? 'This removes the selected spending hold after audit; it makes no refund or ledger adjustment.'
                    : action === 'bind'
                      ? 'This binds the original accepted payment; verified payment reconciliation remains responsible for any credit.'
                      : 'This records the original request as confirmed unpaid; it does not create a replacement payment.'}
                </p>
              </div>
              <label className={styles.approval}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || needsRefresh}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  I inspected the original external record, verified the workspace, existing
                  amount/state and evidence above, and approve this specific audited resolution.
                </span>
              </label>
              <button className={styles.primary} disabled={!valid || busy || needsRefresh}>
                {busy ? 'Recording…' : actionText}
              </button>
            </form>
          ) : (
            <p className={styles.fine}>
              This record has guidance only. Recover its original identity through the existing
              operator tools before any financial resolution.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
