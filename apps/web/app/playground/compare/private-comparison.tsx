'use client';

import { useEffect, useRef, useState } from 'react';
import { getGenerationDefinition } from '@media-router/contracts/generation';
import type {
  Catalog,
  ComparisonChildQuote,
  ComparisonJob,
  ComparisonRun,
  ComparisonSummary,
  Job,
  Route,
} from '@media-router/contracts';
import { GatewayAccess, type BrowserSession } from '../../gateway-access';
import { playgroundHref } from '../../links';
import {
  clearRecovery,
  readRecovery,
  recoveryContext,
  recoveryKey,
  writeRecovery,
  type RecoveryContext,
} from '../../playground-recovery';
import { regionNames } from '../../ui';
import styles from './comparison.module.css';

const usd = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
const runPath = (id: string) => `/v1/comparisons/${encodeURIComponent(id)}`;
const isRunId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f-]{36}$/i.test(value);
const canAdvance = (job: Job) =>
  ['queued', 'submitting', 'running'].includes(job.status) ||
  (job.status === 'succeeded' &&
    ['pending', 'partial', 'unverified'].includes(job.deliveryStatus ?? '')) ||
  (job.status === 'succeeded' && job.settledMicros === null);

class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function routeChoice(catalog: Catalog, route: Route) {
  const model = catalog.models.find((item) => item.id === route.modelId);
  const deployment = catalog.deployments.find((item) => item.id === route.deploymentId);
  const provider = catalog.providers.find((item) => item.id === deployment?.providerId);
  const endpoint = deployment?.endpointRegion ?? 'unknown';
  const modelName = model?.name ?? route.modelId;
  const providerLabel =
    route.providerModelName && route.providerModelName !== modelName
      ? `${provider?.name ?? 'Provider'} · ${route.providerModelName}`
      : (provider?.name ?? 'Provider');
  const region = regionNames[endpoint] ?? endpoint;
  const resolution = getGenerationDefinition(route.modelId, 'text-to-image')?.defaults.resolution;
  const rate = route.rates.find(
    (entry) =>
      entry.resolution === resolution &&
      entry.unit === 'image' &&
      (entry.operation === undefined || entry.operation === 'text-to-image'),
  );
  return { route, modelName, providerLabel, region, rate, resolution };
}

type Choice = ReturnType<typeof routeChoice>;

export function PrivateComparison({ catalog }: { catalog: Catalog }) {
  const [session, setSession] = useState<BrowserSession>({ authenticated: false });
  const active = Boolean(session.authenticated && !session.checkingAuthority);
  const context = recoveryContext(
    { ...session, authenticated: active || session.checkingAuthority === true },
    'comparison',
    'text-to-image',
  );
  const choices = catalog.routes
    .filter(
      (route) =>
        route.status !== 'retired' && route.adapter && route.operations.includes('text-to-image'),
    )
    .map((route) => routeChoice(catalog, route))
    .filter((choice) => choice.rate !== undefined);

  return (
    <>
      <GatewayAccess onChange={() => {}} onSession={setSession} />
      {!active && (
        <p role="status" className={styles.note}>
          {session.checkingAuthority
            ? 'Checking workspace access…'
            : 'Sign in to prepare a private comparison.'}
        </p>
      )}
      {context && context.scopes.includes('read') && (
        <ComparisonWorkspace
          key={JSON.stringify([context.workspaceId, context.recoveryScope, context.scopes])}
          context={context}
          choices={choices}
          active={active}
        />
      )}
      {active && context && !context.scopes.includes('read') && (
        <p role="status">This workspace session needs read access to open comparisons.</p>
      )}
    </>
  );
}

function ComparisonWorkspace({
  context,
  choices,
  active,
}: {
  context: RecoveryContext;
  choices: Choice[];
  active: boolean;
}) {
  const defaultRouteIds: [string, string] = [
    choices[0]?.route.id ?? '',
    choices.find((choice) => choice.route.modelId !== choices[0]?.route.modelId)?.route.id ?? '',
  ];
  const [prompt, setPrompt] = useState('');
  const [routeIds, setRouteIds] = useState(defaultRouteIds);
  const [run, setRun] = useState<ComparisonRun | null>(null);
  const [history, setHistory] = useState<ComparisonSummary[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expired, setExpired] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [pendingChecked, setPendingChecked] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  // Each tab keeps its own paid intent; another tab's completed pair must not erase it.
  const pendingApprovalRef = useRef<string | null>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const requestInFlight = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const draftRevision = useRef(0);
  const currentRunId = useRef<string | null>(null);
  currentRunId.current = run?.id ?? null;
  const namespace = `opengen.comparison.v1:${encodeURIComponent(context.workspaceId)}:${encodeURIComponent(context.recoveryScope)}`;
  const expectedHeaders = {
    'x-opengen-workspace': context.workspaceId,
    'x-opengen-recovery-scope': context.recoveryScope,
  };

  async function gateway<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { ...expectedHeaders, ...init.headers },
    });
    const body = await response.json();
    if (!response.ok)
      throw new GatewayError(
        typeof body.error === 'string'
          ? body.error
          : (body.error?.message ?? 'The comparison gateway could not complete this request.'),
        response.status,
      );
    return body as T;
  }

  function remember(id: string) {
    try {
      localStorage.setItem(namespace, id);
    } catch {
      // Workspace history still recovers admitted comparisons when storage is unavailable.
    }
  }

  function forget() {
    try {
      localStorage.removeItem(namespace);
    } catch {
      // Only the opaque run ID is stored.
    }
  }

  function show(value: ComparisonRun) {
    if (value.id === pendingApprovalRef.current && value.admittedAt) {
      clearRecovery(sessionStorage, context, 'comparison-approval');
      pendingApprovalRef.current = null;
      setPendingApproval(null);
      setPendingChecked(false);
    }
    setRun(value);
    setPrompt(value.children[0].input.input.prompt ?? '');
    setRouteIds(value.children.map((child) => child.input.routeId ?? '') as [string, string]);
    setExpired(false);
    remember(value.id);
  }

  async function refreshHistory(signal?: AbortSignal) {
    const { data } = await gateway<{ data: ComparisonSummary[] }>('/v1/comparisons', { signal });
    if (activeRef.current && !signal?.aborted) setHistory(data);
  }

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const revision = draftRevision.current;
    void refreshHistory(controller.signal).catch(() => {});
    let saved: string | null = null;
    try {
      const raw = sessionStorage.getItem(recoveryKey(context, 'comparison-approval'));
      const pending = readRecovery(sessionStorage, context, 'comparison-approval', isRunId);
      if (raw !== null && !pending) {
        setRecoveryBlocked(true);
        setNotice(
          'Approval recovery is damaged. Ask the installation operator to reconcile existing comparisons before creating another pair.',
        );
        setRestoring(false);
        return () => controller.abort();
      }
      pendingApprovalRef.current = pending;
      setPendingApproval(pending);
      saved = pending ?? localStorage.getItem(namespace);
    } catch {
      setRecoveryBlocked(true);
      setNotice('Browser approval recovery is unavailable. No new comparison can be submitted.');
      setRestoring(false);
      return () => controller.abort();
    }
    if (saved && !currentRunId.current && isRunId(saved)) {
      void gateway<ComparisonRun>(runPath(saved), { signal: controller.signal })
        .then((value) => {
          if (
            activeRef.current &&
            !controller.signal.aborted &&
            revision === draftRevision.current
          ) {
            show(value);
            if (pendingApprovalRef.current === value.id) {
              setPendingChecked(true);
              setNotice(
                'Approval is still unresolved. Recover or retry this original comparison; a new pair remains blocked.',
              );
            }
          }
        })
        .catch((cause: unknown) => {
          if (
            activeRef.current &&
            !controller.signal.aborted &&
            revision === draftRevision.current
          ) {
            if (pendingApprovalRef.current)
              setNotice(
                'The original approval is still unresolved. Check it again or ask the installation operator to reconcile it. Quote expiry or a missing read does not prove that no jobs were admitted.',
              );
            else if (cause instanceof GatewayError && cause.status === 404) forget();
            else setNotice('The saved comparison could not be loaded. Check Recent comparisons.');
          }
        })
        .finally(() => {
          if (activeRef.current && !controller.signal.aborted) setRestoring(false);
        });
    } else setRestoring(false);
    return () => controller.abort();
    // The component is keyed by workspace and authority, so session refresh can only resume this boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, namespace]);

  const runId = run?.id;
  const polling = Boolean(run?.admittedAt && run.jobs.some(canAdvance));
  useEffect(() => {
    if (!active || !runId || !polling) return;
    const controller = new AbortController();
    let pending = false;
    let reads = 0;
    const timer = window.setInterval(async () => {
      if (pending || requestInFlight.current || document.hidden) return;
      if (reads >= 120) {
        window.clearInterval(timer);
        return;
      }
      reads += 1;
      const revision = draftRevision.current;
      pending = true;
      try {
        const value = await gateway<ComparisonRun>(runPath(runId), { signal: controller.signal });
        if (
          activeRef.current &&
          !controller.signal.aborted &&
          currentRunId.current === runId &&
          revision === draftRevision.current
        )
          setRun(value);
      } catch {
        // A transient read failure never changes the existing run or authorizes a retry.
      } finally {
        pending = false;
      }
    }, 4000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, runId, polling]);

  const quoteExpiry = run && !run.admittedAt ? run.expiresAt : null;
  useEffect(() => {
    if (!quoteExpiry) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(quoteExpiry) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [quoteExpiry]);

  function editDraft() {
    draftRevision.current += 1;
    setError('');
    setNotice('');
    if (run && !run.admittedAt && !pendingApprovalRef.current) {
      setRun(null);
      forget();
    }
  }

  async function perform(label: string, action: () => Promise<void>) {
    if (requestInFlight.current || !activeRef.current) return;
    requestInFlight.current = true;
    draftRevision.current += 1;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      if (activeRef.current)
        setError(cause instanceof Error ? cause.message : 'Comparison action failed.');
    } finally {
      requestInFlight.current = false;
      setBusy('');
    }
  }

  function getQuote() {
    if (restoring || recoveryBlocked || pendingApprovalRef.current) return;
    void perform('quote', async () => {
      const value = await gateway<ComparisonRun>('/v1/comparisons/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, routeIds }),
      });
      if (!activeRef.current) return;
      show(value);
      setNotice('Comparison quote ready. Review the combined maximum before approving.');
    });
  }

  function approve(id: string) {
    if (
      restoring ||
      recoveryBlocked ||
      (pendingApprovalRef.current && (pendingApprovalRef.current !== id || !pendingChecked))
    )
      return;
    void perform('approve', async () => {
      if (!writeRecovery(sessionStorage, context, 'comparison-approval', id))
        throw new Error(
          'Browser approval recovery could not be saved. This comparison has not been submitted.',
        );
      pendingApprovalRef.current = id;
      setPendingApproval(id);
      setPendingChecked(false);
      remember(id);
      try {
        const value = await gateway<ComparisonRun>(`${runPath(id)}/approve`, { method: 'POST' });
        if (!activeRef.current) return;
        show(value);
        setNotice('Comparison admitted. Both jobs have been queued.');
        void refreshHistory().catch(() => {});
      } catch {
        throw new Error(
          'Approval could not be confirmed. Check this original comparison before trying again. A new pair remains blocked.',
        );
      }
    });
  }

  function open(id: string) {
    if (pendingApprovalRef.current && pendingApprovalRef.current !== id) return;
    void perform('open', async () => {
      const value = await gateway<ComparisonRun>(runPath(id));
      if (!activeRef.current) return;
      show(value);
      if (pendingApprovalRef.current === id) setPendingChecked(true);
      if (value.admittedAt) void refreshHistory().catch(() => {});
      setNotice(
        value.admittedAt
          ? 'Opened the existing comparison.'
          : pendingApprovalRef.current
            ? 'Approval remains unresolved. You can retry only this original approval; a new pair remains blocked. Ask the installation operator if it has expired.'
            : 'The quote is awaiting approval.',
      );
    });
  }

  function checkJob(job: Job) {
    const runId = currentRunId.current;
    if (!runId) return;
    void perform(job.id, async () => {
      const current = await gateway<ComparisonRun>(runPath(runId));
      if (!activeRef.current) return;
      setRun(current);
      const value = current.jobs.find((item) => item.id === job.id);
      setNotice(
        value
          ? `Existing job status: ${value.status.replaceAll('-', ' ')}.`
          : 'This job is unavailable.',
      );
    });
  }

  function openInPlayground(job: Job) {
    if (!activeRef.current || job.workspaceId !== context.workspaceId) return;
    const receipt = { id: job.id, modelId: job.input.modelId, operation: job.input.operation };
    let saved = false;
    try {
      saved = writeRecovery(sessionStorage, context, 'last-result', receipt);
    } catch {
      // The browser can deny access to sessionStorage itself.
    }
    if (!saved) {
      setError('Browser recovery is unavailable. Open this job from Workspace activity.');
      return;
    }
    window.location.assign(playgroundHref(receipt.modelId, job.routeId, receipt.operation));
  }

  const selected = routeIds.map((id) => choices.find((item) => item.route.id === id));
  const distinct = Boolean(
    selected[0] && selected[1] && selected[0].route.modelId !== selected[1].route.modelId,
  );
  const authorized = context.scopes.includes('generate');
  const review = run && !run.admittedAt ? run : null;
  const result = run?.admittedAt ? run : null;

  if (!active) return null;

  return (
    <div aria-busy={Boolean(busy)}>
      <div className={styles.workspace}>
        <section className={styles.panel} aria-labelledby="comparison-input">
          <span className="eyebrow">01 / SHARED INPUT</span>
          <h2 id="comparison-input">One prompt, one image per model</h2>
          <p className={styles.note}>
            Each route uses its own rendering defaults. This mode uses workspace credits and
            supports text-to-image with a shared prompt.
          </p>
          <fieldset disabled={Boolean(busy) || restoring}>
            <legend className={styles.srOnly}>Comparison settings</legend>
            <label className={styles.field} htmlFor="comparison-prompt">
              Shared prompt
              <textarea
                id="comparison-prompt"
                ref={promptField}
                rows={4}
                maxLength={32_000}
                value={prompt}
                onChange={(event) => {
                  editDraft();
                  setPrompt(event.target.value);
                }}
              />
            </label>
            <div className={styles.pair}>
              {routeIds.map((routeId, index) => (
                <div key={index} className={styles.route}>
                  <label className={styles.field}>
                    Model {index + 1} and route
                    <select
                      value={routeId}
                      onChange={(event) => {
                        editDraft();
                        const next: [string, string] = [...routeIds];
                        next[index] = event.target.value;
                        setRouteIds(next);
                      }}
                    >
                      <option value="">Choose a route</option>
                      {routeId && !selected[index] && <option value={routeId}>{routeId}</option>}
                      {choices.map((choice) => (
                        <option key={choice.route.id} value={choice.route.id}>
                          {choice.modelName} · {choice.providerLabel} · {choice.region}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected[index] && <RouteRate choice={selected[index]} />}
                </div>
              ))}
            </div>
          </fieldset>
          <button
            className="button button-primary"
            disabled={
              !prompt.trim() ||
              !distinct ||
              Boolean(busy) ||
              restoring ||
              recoveryBlocked ||
              Boolean(pendingApproval) ||
              Boolean(review && !expired)
            }
            onClick={getQuote}
          >
            {busy === 'quote' ? 'Getting comparison quote…' : 'Get comparison quote'}
          </button>
          {!distinct && (
            <p className={styles.note}>Choose two different exact models with priced routes.</p>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="comparison-budget">
          <span className="eyebrow">02 / SPEND APPROVAL</span>
          <h2 id="comparison-budget">Comparison budget</h2>
          {pendingApproval && (
            <p className={styles.note}>
              The original approval must be recovered before another pair can run.{' '}
              <button
                className="text-link"
                disabled={Boolean(busy) || restoring}
                onClick={() => open(pendingApproval)}
              >
                Recover original approval
              </button>
            </p>
          )}
          {review ? (
            <>
              <dl className={styles.money}>
                <div>
                  <dt>Combined estimate</dt>
                  <dd>{usd(review.estimatedMicros)}</dd>
                </div>
                <div>
                  <dt>Maximum workspace charge</dt>
                  <dd>{usd(review.ceilingMicros)}</dd>
                </div>
              </dl>
              <p className={styles.note}>
                Approval admits both jobs and reserves their credit together. Any upstream charge
                above the reservation is the installation operator’s responsibility.
              </p>
              <p className={styles.note}>
                {expired ? (
                  pendingApproval ? (
                    'Quote expired while approval is unresolved. Recover the original comparison; do not create a replacement.'
                  ) : (
                    'Quote expired. Get a new quote.'
                  )
                ) : (
                  <>
                    Quote expires{' '}
                    <time dateTime={review.expiresAt}>
                      {new Date(review.expiresAt).toLocaleTimeString()}
                    </time>
                    .
                  </>
                )}
              </p>
              <div className={styles.actions}>
                <button
                  className="button button-primary"
                  disabled={
                    !authorized ||
                    Boolean(busy) ||
                    restoring ||
                    recoveryBlocked ||
                    (pendingApproval ? !pendingChecked : expired)
                  }
                  onClick={() => approve(review.id)}
                >
                  {busy === 'approve'
                    ? 'Approving…'
                    : pendingApproval
                      ? 'Retry original approval'
                      : `Approve up to ${usd(review.ceilingMicros)} and run`}
                </button>
                <button
                  className="button button-outline"
                  disabled={Boolean(busy)}
                  onClick={() => open(review.id)}
                >
                  Check this comparison
                </button>
              </div>
              {!authorized && (
                <p className={styles.note}>
                  This session needs generation access to approve spend.
                </p>
              )}
            </>
          ) : result ? (
            <dl className={styles.money}>
              <div>
                <dt>Approved maximum</dt>
                <dd>{usd(result.ceilingMicros)}</dd>
              </div>
              <div>
                <dt>Actual settled charge</dt>
                <dd>
                  {result.jobs.length === 2 &&
                  result.jobs.every((job) => job.settledMicros !== null)
                    ? usd(result.jobs.reduce((total, job) => total + job.settledMicros!, 0))
                    : 'Pending or unknown'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className={styles.note}>
              Get a request-specific quote to review both prices and the combined workspace limit.
            </p>
          )}
          <p role="status" className={styles.notice}>
            {notice}
          </p>
          {error && (
            <p role="alert" className="error-notice">
              {error}
            </p>
          )}
        </section>
      </div>

      {run && (
        <section className={styles.results} aria-labelledby="comparison-results">
          <div className={styles.resultHeading}>
            <div>
              <span className="eyebrow">03 / PRIVATE {result ? 'RESULTS' : 'QUOTES'}</span>
              <h2 id="comparison-results">{result ? 'One comparison run' : 'Quote by model'}</h2>
              {result && (
                <p className={styles.note}>
                  These outputs reflect this prompt and these routes. Run ID{' '}
                  <code>{result.id}</code>
                </p>
              )}
            </div>
            {result && (
              <button
                className="button button-outline"
                disabled={Boolean(busy)}
                onClick={() => {
                  show(result);
                  setRun(null);
                  setError('');
                  setNotice('Copied to a new draft. Get a new quote before running it.');
                  forget();
                  promptField.current?.focus();
                }}
              >
                Copy comparison settings
              </button>
            )}
          </div>
          {result && (
            <p className={styles.approvedPrompt}>
              <strong>Approved prompt</strong>
              {result.children[0].input.input.prompt}
            </p>
          )}
          <div className={styles.pair}>
            {run.children.map((child, index) => {
              const choice = choices.find((item) => item.route.id === child.input.routeId);
              const job = result?.jobs.find((item) => item.routeId === child.input.routeId);
              return (
                <ChildCard
                  key={child.input.routeId}
                  position={index}
                  child={child}
                  choice={choice}
                  job={job}
                  busy={Boolean(busy)}
                  onCheck={checkJob}
                  onPlayground={openInPlayground}
                />
              );
            })}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <details className={styles.history}>
          <summary>Recent comparisons</summary>
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <button
                  className="text-link"
                  disabled={
                    Boolean(busy) || Boolean(pendingApproval && item.id !== pendingApproval)
                  }
                  onClick={() => open(item.id)}
                >
                  {new Date(item.admittedAt).toLocaleString()} ·{' '}
                  {item.routeIds
                    .map((id) => choices.find((choice) => choice.route.id === id)?.modelName ?? id)
                    .join(' + ')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RouteRate({ choice }: { choice: Choice }) {
  return (
    <>
      <p className={styles.routeLabel}>
        {choice.providerLabel} · {choice.region}
      </p>
      <p className={styles.note}>
        {choice.rate
          ? `Listed ${usd(choice.rate.usdMicros)} per ${choice.resolution} image`
          : 'Published rate unavailable'}
        {' · '}
        <a className="text-link" href={choice.route.pricingSource.url}>
          Price source
        </a>
      </p>
    </>
  );
}

function ChildCard({
  position,
  child,
  choice,
  job,
  busy,
  onCheck,
  onPlayground,
}: {
  position: number;
  child: ComparisonChildQuote;
  choice?: Choice;
  job?: ComparisonJob;
  busy: boolean;
  onCheck: (job: Job) => void;
  onPlayground: (job: Job) => void;
}) {
  return (
    <article className={styles.child}>
      <span className="eyebrow">MODEL {position + 1}</span>
      <h3>{choice?.modelName ?? child.input.modelId}</h3>
      <p className={styles.routeLabel}>
        {choice?.providerLabel ?? child.providerId} ·{' '}
        {regionNames[child.endpointRegion] ?? child.endpointRegion}
      </p>
      <dl className={styles.money}>
        <div>
          <dt>Request estimate</dt>
          <dd>{usd(child.estimatedMicros)}</dd>
        </div>
        {job ? (
          <>
            <div>
              <dt>Credit reservation</dt>
              <dd>{usd(job.reservedMicros)}</dd>
            </div>
            <div>
              <dt>Actual settlement</dt>
              <dd>{job.settledMicros === null ? 'Pending or unknown' : usd(job.settledMicros)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Maximum charge</dt>
            <dd>{usd(child.ceilingMicros)}</dd>
          </div>
        )}
      </dl>
      <p className={styles.note}>
        One {child.input.input.resolution ?? choice?.resolution ?? 'default-resolution'} image.{' '}
        {choice?.rate?.note}
      </p>
      {child.notices.map((notice) => (
        <p className={styles.note} key={notice}>
          {notice}
        </p>
      ))}
      {job && (
        <>
          <p className="job-status" role="status">
            {job.status.replaceAll('-', ' ')}
            {job.deliveryStatus ? ` · delivery ${job.deliveryStatus}` : ''}
          </p>
          <p className={styles.note}>
            Job <code>{job.id}</code>
            {' · '}
            <a className="text-link" href="/app#activity">
              Workspace activity
            </a>
          </p>
          <p className={styles.note}>
            {job.executionTiming
              ? `${(job.executionTiming.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s execution · ${job.executionTiming.source === 'provider' ? 'provider-reported' : 'gateway-observed'}`
              : 'Execution duration unavailable.'}
          </p>
          {job.structuredError?.message && (
            <p className={styles.note}>{job.structuredError.message}</p>
          )}
          {job.status === 'submission-unknown' && (
            <p className={styles.note}>
              Ask the installation operator to reconcile this original job.
            </p>
          )}
          {job.outputs.map((output, index) => {
            const expired = output.expiresAt && Date.parse(output.expiresAt) <= Date.now();
            return expired ? (
              <p key={index} className={styles.note}>
                Private link expired. Check the same job for a fresh link.
              </p>
            ) : (
              <div key={index}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.preview}
                  src={output.url}
                  referrerPolicy="no-referrer"
                  alt={`Image from ${choice?.modelName ?? child.input.modelId}`}
                />
                <a className="text-link" href={output.url} rel="noreferrer" target="_blank">
                  Open private image
                </a>
              </div>
            );
          })}
          <div className={styles.actions}>
            <button className="button button-outline" disabled={busy} onClick={() => onCheck(job)}>
              Check same job
            </button>
            <button
              className="button button-outline"
              disabled={busy}
              onClick={() => onPlayground(job)}
            >
              Open in Playground
            </button>
          </div>
        </>
      )}
    </article>
  );
}
