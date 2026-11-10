'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import type { Job } from '@media-router/contracts';
import { GatewayAccess } from '../gateway-access';
import Link from 'next/link';

export function OperatorPanel() {
  const identityVersion = useRef(0);
  const [connected, setConnected] = useState(false),
    [operator, setOperator] = useState(false);
  const [workspace, setWorkspace] = useState('local'),
    [id, setId] = useState('');
  const [record, setRecord] = useState<{ key: string; job: Job } | null>(null);
  const [action, setAction] = useState('resume'),
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
  async function inspect() {
    const version = identityVersion.current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace)}/generations/${encodeURIComponent(id)}`,
        { cache: 'no-store' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Job could not be loaded.');
      if (version === identityVersion.current) setRecord({ key, job: data });
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
            ...(action === 'settle' ? { billedCostMicros: Number(cost) } : {}),
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
        Resolve an uncertain provider submission or a completed job’s pending cost using verified
        provider evidence. Every action creates an audit record.
      </p>
      <GatewayAccess onChange={connectionChanged} />
      {connected && !operator && <p>This page requires installation operator access.</p>}
      {operator && (
        <section className="workspace-settings operator-form">
          <label>
            Workspace ID
            <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
          </label>
          <label>
            Generation ID
            <input value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <button className="button button-outline" onClick={inspect} disabled={busy || !id}>
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
                </select>
              </label>
              {action === 'resume' && (
                <label>
                  Original upstream task ID
                  <input value={upstream} onChange={(e) => setUpstream(e.target.value)} />
                </label>
              )}
              {action === 'settle' && (
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
                    1,000,000 micro-USD = $1. The existing reservation caps the customer debit.
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
                  (action === 'settle' && cost === '')
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
