'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import type { Job } from '@media-router/contracts';
import { GatewayAccess } from '../gateway-access';
import Link from 'next/link';

interface PendingHold {
  id: string;
  workspaceId: string;
  pendingKind: 'customer-hold' | 'supplier-cost';
  status: string;
  routeId: string;
  providerId: string | null;
  upstreamId: string | null;
  reservedMicros: number;
  settledMicros: number | null;
  billingPollPending: boolean;
  ageMinutes: number;
}

export function OperatorPanel() {
  const identityVersion = useRef(0);
  const [connected, setConnected] = useState(false),
    [operator, setOperator] = useState(false);
  const [workspace, setWorkspace] = useState('local'),
    [id, setId] = useState('');
  const [record, setRecord] = useState<{ key: string; job: Job } | null>(null);
  const [pendingHolds, setPendingHolds] = useState<PendingHold[] | null>(null);
  const [action, setAction] = useState('resume'),
    [terminalStatus, setTerminalStatus] = useState<'failed' | 'cancelled'>('failed'),
    [upstream, setUpstream] = useState(''),
    [cost, setCost] = useState('');
  const [reference, setReference] = useState(''),
    [note, setNote] = useState(''),
    [evidence, setEvidence] = useState('');
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const connectionChanged = useCallback((value: boolean) => setConnected(value), []);
  const key = `${workspace}/${id}`;
  useEffect(() => {
    identityVersion.current++;
    setOperator(false);
    setRecord(null);
    setPendingHolds(null);
    if (!connected) return;
    const controller = new AbortController();
    fetch('/api/session', { signal: controller.signal, cache: 'no-store' })
      .then((r) => r.json())
      .then((session) => {
        if (controller.signal.aborted) return;
        setOperator(session.isOperator === true);
        setWorkspace(session.workspaceId ?? 'local');
      })
      .catch(() => {});
    return () => controller.abort();
  }, [connected]);
  async function loadPending(kind: 'customer-hold' | 'supplier-cost' = 'customer-hold') {
    const version = identityVersion.current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/operator/reconciliations/pending?kind=${encodeURIComponent(kind)}&limit=50`,
        {
          cache: 'no-store',
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.message ?? 'Pending holds could not be loaded.');
      if (version === identityVersion.current)
        setPendingHolds(Array.isArray(data.data) ? data.data : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pending holds could not be loaded.');
    } finally {
      setBusy(false);
    }
  }
  async function inspect(targetWorkspace = workspace, targetId = id) {
    const version = identityVersion.current;
    const targetKey = `${targetWorkspace}/${targetId}`;
    setWorkspace(targetWorkspace);
    setId(targetId);
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(targetWorkspace)}/generations/${encodeURIComponent(targetId)}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Job could not be loaded.');
      if (version === identityVersion.current) setRecord({ key: targetKey, job: data });
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Job could not be loaded.');
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    const version = identityVersion.current;
    if (!record || record.key !== key || !confirmed) return;
    setBusy(true);
    setError('');
    try {
      const needsCost =
        action === 'settle' || action === 'resolve' || action === 'record-supplier-cost';
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace)}/generations/${encodeURIComponent(id)}/reconcile`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            reference,
            note,
            evidenceUrl: evidence,
            ...(action === 'resume' ? { upstreamId: upstream } : {}),
            ...(action === 'resolve' ? { terminalStatus } : {}),
            ...(needsCost
              ? {
                  billedCostMicros: Number(cost),
                  ...(action !== 'record-supplier-cost' ? { costBasis: 'operator-audited' } : {}),
                }
              : {}),
          }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.message ?? 'Reconciliation could not be applied.');
      if (version === identityVersion.current) setRecord({ key, job: data });
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reconciliation could not be applied.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="page-width docs-page">
      <Link href="/dashboard">← Workspace</Link>
      <h1>Operator reconciliation</h1>
      <p>
        Resolve an uncertain or expired provider submission or a completed job’s pending cost using
        verified provider evidence. Every action creates an audit record.
      </p>
      <GatewayAccess onChange={connectionChanged} />
      {connected && !operator && <p>This page requires installation operator access.</p>}
      {operator && (
        <section className="workspace-settings operator-form">
          <div>
            <button
              className="button button-outline"
              onClick={() => void loadPending('customer-hold')}
              disabled={busy}
            >
              Load pending holds
            </button>{' '}
            <button
              className="button button-outline"
              onClick={() => void loadPending('supplier-cost')}
              disabled={busy}
            >
              Load pending supplier invoices
            </button>
            {pendingHolds && (
              <div style={{ marginTop: '0.75rem' }}>
                {pendingHolds.length === 0 ? (
                  <p>No pending reconciliation items.</p>
                ) : (
                  <ul>
                    {pendingHolds.map((item) => (
                      <li key={item.id}>
                        <code>{item.workspaceId}</code> / <code>{item.id}</code> —{' '}
                        {item.pendingKind === 'supplier-cost'
                          ? 'supplier invoice pending'
                          : item.status}{' '}
                        ({item.routeId},{' '}
                        {item.pendingKind === 'supplier-cost'
                          ? `customer settled ${item.settledMicros ?? 0} micro-USD`
                          : `held ${item.reservedMicros} micro-USD`}
                        , age {item.ageMinutes}m
                        {item.billingPollPending ? ', billing poll pending' : ''}){' '}
                        <button
                          className="button button-outline"
                          type="button"
                          disabled={busy}
                          onClick={() => void inspect(item.workspaceId, item.id)}
                        >
                          Inspect
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <label>
            Workspace ID
            <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
          </label>
          <label>
            Generation ID
            <input value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <button
            className="button button-outline"
            onClick={() => void inspect()}
            disabled={busy || !id}
          >
            Inspect generation
          </button>
          {record?.key === key && (
            <>
              <dl>
                <dt>Status</dt>
                <dd>{record.job.status}</dd>
                <dt>Provider route</dt>
                <dd>{record.job.routeId}</dd>
                <dt>Upstream ID</dt>
                <dd>{record.job.upstreamId ?? 'Acceptance unknown'}</dd>
                <dt>Reserved / settled micro-USD</dt>
                <dd>
                  {record.job.reservedMicros} / {record.job.settledMicros ?? 'Pending'}
                </dd>
              </dl>
              <label>
                Action
                <select
                  value={action}
                  onChange={(e) => {
                    setAction(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="resume">Resume a confirmed provider task</option>
                  <option value="reject">Confirm that submission was not accepted</option>
                  <option value="settle">Record a completed job’s provider cost</option>
                  <option value="resolve">
                    Resolve a stuck or expired task to terminal and settle cost
                  </option>
                  <option value="record-supplier-cost">
                    Record supplier invoice cost (customer already settled)
                  </option>
                </select>
              </label>
              {action === 'resume' && (
                <label>
                  Original upstream task ID
                  <input value={upstream} onChange={(e) => setUpstream(e.target.value)} />
                </label>
              )}
              {action === 'resolve' && (
                <label>
                  Final status
                  <select
                    value={terminalStatus}
                    onChange={(e) => setTerminalStatus(e.target.value as 'failed' | 'cancelled')}
                  >
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
              )}
              {(action === 'settle' ||
                action === 'resolve' ||
                action === 'record-supplier-cost') && (
                <label>
                  Verified provider cost, micro-USD
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                  />
                  <small>
                    1,000,000 micro-USD = $1.{' '}
                    {action === 'record-supplier-cost'
                      ? 'Records internal supplier cost without changing customer balance.'
                      : 'The existing reservation caps the customer debit.'}
                  </small>
                </label>
              )}
              <label>
                Stable evidence reference
                <input value={reference} onChange={(e) => setReference(e.target.value)} />
              </label>
              <label>
                Provider evidence URL
                <input type="url" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
              </label>
              <label>
                Verification notes
                <textarea value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I verified the original provider record and the action above.
              </label>
              <button
                className="button button-dark"
                onClick={reconcile}
                disabled={
                  busy ||
                  !confirmed ||
                  note.length < 20 ||
                  !reference ||
                  !evidence ||
                  (action === 'resume' && !upstream) ||
                  ((action === 'settle' ||
                    action === 'resolve' ||
                    action === 'record-supplier-cost') &&
                    cost === '')
                }
              >
                Apply reconciliation
              </button>
            </>
          )}
        </section>
      )}
      {error && <p role="status">{error}</p>}
    </main>
  );
}
