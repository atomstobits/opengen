'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Catalog,
  GenerateInput,
  Job,
  Model,
  Operation,
  Quote,
  Route,
} from '@media-router/contracts';
import { collectGenerationAssets } from '@media-router/contracts/generation';
import { GatewayAccess, type BrowserSession } from './gateway-access';
import { PlaygroundAuthority } from './playground-authority';
import { PlaygroundResult } from './playground-result';
import { CanonicalControls } from './playground-controls';
import { PlaygroundExample } from './playground-example';
import { PlaygroundPricing, routeIdentity, usd } from './playground-pricing';
import { CopyButton, Icon, PlaygroundWorkflow, regionNames } from './ui';
import { playgroundHref } from './links';
import {
  initialPlaygroundRequest,
  isPlaygroundDraft,
  validatePlaygroundRequest,
} from './playground-request';
import {
  recoveryContext,
  recoveryKey,
  readRecovery,
  writeRecovery,
  retireLegacyPlaygroundStorage,
  requestFingerprint,
  prepareSubmission,
  recordSubmissionJob,
  recordSubmissionRejection,
  findSubmission,
  findSubmissionForJob,
  type RecoveryContext,
} from './playground-recovery';
import styles from './private-playground.module.css';

const names: Record<Operation, string> = {
  'text-to-image': 'Text to image',
  'image-edit': 'Image editing',
  'text-to-video': 'Text to video',
  'image-to-video': 'Image to video',
  'reference-to-video': 'Reference to video',
  'video-edit': 'Video editing',
  'video-extend': 'Video extension',
};
const singleRegion = (request: GenerateInput) =>
  request.routing?.endpointRegions?.length === 1 ? request.routing.endpointRegions[0] : undefined;

const isSensitiveMediaUrl = (value: string) => {
  const url = new URL(value);
  return (
    !!(url.search || url.hash || url.username || url.password) || url.pathname.startsWith('/api/')
  );
};
const message = (body: any) =>
  typeof body.error === 'string'
    ? body.error
    : (body.error?.message ?? body.message ?? 'The gateway could not complete this request.');
export type ReuseLineage = {
  assetKey: string;
  sourceJobId: string;
  outputIndex: number;
  expiresAt: string | null;
};
export type PlaygroundDraftTransfer = {
  draft: GenerateInput;
  lineage: ReuseLineage[];
  boundary: string;
};
const isLineage = (value: unknown): value is ReuseLineage[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      entry &&
      typeof entry.assetKey === 'string' &&
      typeof entry.sourceJobId === 'string' &&
      Number.isInteger(entry.outputIndex) &&
      (entry.expiresAt === null || typeof entry.expiresAt === 'string'),
  );
const isJobReceipt = (value: unknown): value is { id: string; fingerprint: string } =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as any).id === 'string' &&
  (value as any).id.length <= 160 &&
  typeof (value as any).fingerprint === 'string';
type ResultReceipt = { id: string; modelId: string; operation: Operation };
const isResultReceipt = (value: unknown): value is ResultReceipt =>
  !!value &&
  typeof value === 'object' &&
  'id' in value &&
  typeof value.id === 'string' &&
  value.id.length <= 160 &&
  'modelId' in value &&
  typeof value.modelId === 'string' &&
  'operation' in value &&
  typeof value.operation === 'string' &&
  Object.hasOwn(names, value.operation);
const isTerminal = (job: Job) => ['succeeded', 'failed', 'cancelled'].includes(job.status);
const admissionRejections = new Set([
  '402:insufficient_balance',
  '402:budget_exceeded',
  '409:billing_hold',
  '422:no_executable_route',
]);
const authorityHeaders = (context: RecoveryContext) => ({
  'x-opengen-workspace': context.workspaceId,
  'x-opengen-recovery-scope': context.recoveryScope,
});

function checkJob(
  body: any,
  context: RecoveryContext,
  expected: Omit<ResultReceipt, 'id'> & { id?: string },
) {
  const job = (body.data ?? body) as Job;
  if (
    !job.id ||
    (expected.id && job.id !== expected.id) ||
    job.workspaceId !== context.workspaceId ||
    job.input?.modelId !== expected.modelId ||
    job.input.operation !== expected.operation
  )
    throw new Error('The returned job does not belong to this workspace and request.');
  return job;
}

async function getJob(context: RecoveryContext, expected: ResultReceipt, signal?: AbortSignal) {
  const response = await fetch(`/api/generations/${encodeURIComponent(expected.id)}`, {
    cache: 'no-store',
    headers: authorityHeaders(context),
    signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(message(body));
  return checkJob(body, context, expected);
}

function resultReceipt(job: Job): ResultReceipt {
  return { id: job.id, modelId: job.input.modelId, operation: job.input.operation };
}

export function Playground({
  model,
  routes,
  catalog,
  initialRouteId,
  initialOperation,
  initialRegion,
  gatewayOrigin,
  transferredDraft,
  onModelDraft,
  onDraftTransferConsumed,
}: {
  model: Model;
  routes: Route[];
  catalog: Catalog;
  initialRouteId?: string;
  initialOperation?: Operation;
  initialRegion?: string;
  gatewayOrigin: string;
  transferredDraft?: PlaygroundDraftTransfer;
  onModelDraft?: (transfer: PlaygroundDraftTransfer) => void;
  onDraftTransferConsumed?: () => void;
}) {
  const initial = () =>
    initialPlaygroundRequest(model, routes, initialRouteId, initialOperation, initialRegion);
  const selectionEdited = useRef(false);
  const [draft, setDraft] = useState<GenerateInput>(initial);
  const [authorityPending, setAuthorityPending] = useState(false);
  const [session, setSession] = useState<BrowserSession>({ authenticated: false });
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState('');
  const [jsonDirty, setJsonDirty] = useState(false);
  const [controlsValid, setControlsValid] = useState(true);
  const [controlsRevision, setControlsRevision] = useState(0);
  const regionOf = (route?: Route) =>
    catalog.deployments.find((deployment) => deployment.id === route?.deploymentId)?.endpointRegion;
  const [quote, setQuote] = useState<{ fingerprint: string; value: Quote } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [resultError, setResultError] = useState('');
  const [resultView, setResultView] = useState<'preview' | 'json'>('preview');
  const [newAttempt, setNewAttempt] = useState<{
    jobId: string;
    fingerprint: string;
    sourceFingerprint: string;
  } | null>(null);
  const resultEpoch = useRef(0);
  const [busy, setBusy] = useState<'quote' | 'generate' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lineage, setLineage] = useState<ReuseLineage[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(true);
  const context = recoveryContext(session, model.id, draft.operation);
  const contextKey = context ? recoveryKey(context, 'draft') : null;
  const resultKey = context ? recoveryKey(context, 'last-result') : null;
  const boundary = JSON.stringify([
    session.authenticated,
    session.workspaceId,
    session.recoveryScope,
    [...(session.scopes ?? [])].sort(),
  ]);
  let validRequest: GenerateInput | undefined;
  let validationError = '';
  try {
    validRequest = validatePlaygroundRequest(draft, catalog, model.id);
  } catch (cause) {
    validationError = cause instanceof Error ? cause.message : 'Check the canonical request.';
  }
  const fingerprint = requestFingerprint(validRequest ?? draft);
  // Render-time guard prevents a response landing between a session change and effect cleanup.
  const live = useRef({ boundary, fingerprint, version: 0 });
  if (live.current.boundary !== boundary || live.current.fingerprint !== fingerprint)
    live.current = { boundary, fingerprint, version: live.current.version + 1 };
  const explicitOperation = useRef<{ boundary: string; request: GenerateInput } | null>(null);
  const authChange = useCallback((_authenticated: boolean) => {}, []);
  const sessionChange = useCallback(
    (next: BrowserSession) => {
      if (next.checkingAuthority) {
        live.current.version++;
        resultEpoch.current++;
        setAuthorityPending(true);
        setQuote(null);
        setJob(null);
        setBusy(null);
        return;
      }
      setAuthorityPending(false);
      const nextBoundary = JSON.stringify([
        next.authenticated,
        next.workspaceId,
        next.recoveryScope,
        [...(next.scopes ?? [])].sort(),
      ]);
      if (nextBoundary !== live.current.boundary) {
        live.current.version++;
        resultEpoch.current++;
        setDraft((current) =>
          initialPlaygroundRequest(
            model,
            routes,
            current.routeId,
            current.operation,
            singleRegion(current),
          ),
        );
        setJob(null);
        setQuote(null);
        setJson('');
        setJsonDirty(false);
        setError('');
        setNotice('');
        setResultError('');
        setNewAttempt(null);
      }
      setSession(next);
    },
    [model, routes],
  );

  function update(next: GenerateInput, restoreOperationDraft = false) {
    if (
      next.operation !== draft.operation ||
      next.routeId !== draft.routeId ||
      singleRegion(next) !== singleRegion(draft)
    )
      selectionEdited.current = true;
    if (next.operation !== draft.operation && !restoreOperationDraft)
      explicitOperation.current = { boundary, request: next };
    live.current.version++;
    setBusy(null);
    setDraft(next);
    setQuote(null);
    setError('');
    setNotice('');
  }
  function buildRequest() {
    if (jsonDirty) throw new Error('Apply or discard your JSON edits before continuing.');
    if (!controlsValid)
      throw new Error('Apply or discard the structured field edits before continuing.');
    return validatePlaygroundRequest(draft, catalog, model.id);
  }

  function buildExportRequest() {
    const request = buildRequest();
    if (
      !context?.scopes.includes('read') &&
      (request.previousJobId ||
        collectGenerationAssets(request.input).some(
          ({ asset }) => !!asset.assetKey || (!!asset.url && isSensitiveMediaUrl(asset.url)),
        ))
    ) {
      throw new Error(
        'Sign in with workspace read access to copy a request with private references.',
      );
    }
    return request;
  }

  useEffect(() => {
    // Model-only keys cannot be attributed to an authorized identity. Never import them.
    try {
      retireLegacyPlaygroundStorage(sessionStorage);
      retireLegacyPlaygroundStorage(localStorage);
    } catch {
      /* Storage is optional until submission. */
    }
  }, []);

  useEffect(() => {
    setQuote(null);
    setError('');
    setJsonDirty(false);
    setControlsValid(true);
    setLoadedKey(null);
    const explicit =
      explicitOperation.current?.boundary === boundary &&
      explicitOperation.current.request.operation === draft.operation
        ? explicitOperation.current.request
        : null;
    explicitOperation.current = null;
    let next = explicit ?? draft;
    if (context && !explicit) {
      try {
        const saved = readRecovery(sessionStorage, context, 'draft', isPlaygroundDraft);
        if (saved && saved.modelId === model.id && saved.operation === draft.operation) {
          next = saved;
          const selectedRoutes = routes.filter(
            (route) =>
              route.operations.includes(saved.operation) &&
              (!initialRouteId || route.id === initialRouteId) &&
              (!initialRegion || regionOf(route) === initialRegion),
          );
          const savedFiltersConflict = !selectedRoutes.some((route) => {
            const deployment = catalog.deployments.find((item) => item.id === route.deploymentId);
            return (
              deployment &&
              (!saved.routing?.providerIds ||
                saved.routing.providerIds.includes(deployment.providerId)) &&
              (!saved.routing?.deploymentIds ||
                saved.routing.deploymentIds.includes(deployment.id)) &&
              (!saved.routing?.endpointRegions ||
                saved.routing.endpointRegions.includes(deployment.endpointRegion))
            );
          });
          const selectionChanged = initialRouteId
            ? saved.routeId !== initialRouteId || savedFiltersConflict
            : initialRegion &&
              (saved.routeId || singleRegion(saved) !== initialRegion || savedFiltersConflict);
          if (!selectionEdited.current && selectionChanged) {
            const { routeId: _savedRouteId, ...rest } = saved;
            const {
              endpointRegions: _savedRegions,
              providerIds: _savedProviders,
              deploymentIds: _savedDeployments,
              ...routing
            } = saved.routing ?? {};
            next = {
              ...rest,
              ...(initialRouteId ? { routeId: initialRouteId } : {}),
              routing: {
                ...routing,
                fallback: false,
                ...(initialRegion ? { endpointRegions: [initialRegion] } : {}),
              },
            };
          }
          setNotice(
            'Your private draft was restored for this identity, workspace and operation. Nothing has been submitted.',
          );
        } else setNotice('');
      } catch {
        setStorageReady(false);
      }
    } else if (!explicit) setNotice('');
    setLineage(context ? (readRecovery(sessionStorage, context, 'lineage', isLineage) ?? []) : []);
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
    setLoadedKey(contextKey);
    // Scope/operation changes intentionally reload one namespace. Input edits do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary, contextKey]);

  useEffect(() => {
    if (!context || loadedKey !== contextKey) return;
    try {
      setStorageReady(writeRecovery(sessionStorage, context, 'draft', draft));
    } catch {
      setStorageReady(false);
    }
  }, [draft, contextKey, loadedKey]);

  useEffect(() => {
    if (authorityPending || !context || !context.scopes.includes('read')) return;
    const prior = readRecovery(sessionStorage, context, 'last-result', isResultReceipt);
    const legacy = !prior && readRecovery(sessionStorage, context, 'job', isJobReceipt);
    const saved =
      prior ??
      (legacy ? { id: legacy.id, modelId: context.modelId, operation: context.operation } : null);
    if (!saved) return;
    const abort = new AbortController();
    const epoch = resultEpoch.current;
    void getJob(context, saved, abort.signal)
      .then((next) => {
        if (
          !abort.signal.aborted &&
          boundary === live.current.boundary &&
          epoch === resultEpoch.current
        )
          setJob(next);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [resultKey, authorityPending]);

  async function refreshJob(current: Job) {
    if (!context?.scopes.includes('read')) return;
    const epoch = resultEpoch.current;
    const next = await getJob(context, resultReceipt(current));
    if (boundary !== live.current.boundary || epoch !== resultEpoch.current) return;
    setJob((previous) =>
      previous?.id === next.id && Date.parse(previous.updatedAt) <= Date.parse(next.updatedAt)
        ? next
        : previous,
    );
  }

  useEffect(() => {
    if (
      authorityPending ||
      !context?.scopes.includes('read') ||
      !job ||
      ['failed', 'cancelled', 'submission-unknown'].includes(job.status) ||
      (job.status === 'succeeded' &&
        ['available', 'expired', 'failed', 'unverified'].includes(
          job.deliveryStatus ?? 'unverified',
        ))
    )
      return;
    const timer = setInterval(() => {
      void refreshJob(job).catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [job?.id, job?.status, job?.deliveryStatus, resultKey, authorityPending]);

  useEffect(() => {
    if (!transferredDraft || authorityPending || !context) return;
    onDraftTransferConsumed?.();
    if (transferredDraft.boundary !== boundary || transferredDraft.draft.modelId !== model.id)
      return;
    const next = transferredDraft.draft;
    const target = recoveryContext(session, model.id, next.operation);
    if (target) writeRecovery(sessionStorage, target, 'lineage', transferredDraft.lineage);
    setLineage(transferredDraft.lineage);
    setMode('form');
    setJsonDirty(false);
    setControlsRevision((revision) => revision + 1);
    setControlsValid(true);
    update(next);
    setNotice('Private output attached to this draft. Review settings and get a quote.');
  }, [transferredDraft, resultKey, authorityPending]);

  let savedSubmission: ReturnType<typeof findSubmission>;
  let hasResultSubmission = false;
  try {
    if (context && loadedKey === contextKey)
      savedSubmission = findSubmission(sessionStorage, context, fingerprint);
    if (job) {
      const resultContext = recoveryContext(session, job.input.modelId, job.input.operation);
      if (resultContext)
        hasResultSubmission = !!findSubmissionForJob(sessionStorage, resultContext, job.id);
    }
  } catch {
    // Generation still checks that its key survives a private storage write.
  }
  const pendingAttempt =
    newAttempt?.fingerprint === fingerprint &&
    (!savedSubmission || newAttempt.jobId === savedSubmission.jobId)
      ? newAttempt
      : null;
  const canRecoverSubmission =
    !authorityPending &&
    !!context?.scopes.includes('read') &&
    !!validRequest &&
    !jsonDirty &&
    controlsValid &&
    !!savedSubmission &&
    !savedSubmission.rejected &&
    !pendingAttempt;
  const submissionLabel = canRecoverSubmission
    ? 'Recover same request'
    : pendingAttempt || (savedSubmission?.rejected && savedSubmission.attemptAfter)
      ? 'Generate new attempt'
      : 'Generate';

  useEffect(() => {
    if (newAttempt && (newAttempt.fingerprint !== fingerprint || jsonDirty || !controlsValid))
      setNewAttempt(null);
  }, [fingerprint, jsonDirty, controlsValid, newAttempt]);

  async function request(kind: 'quote' | 'generate') {
    let data: GenerateInput;
    try {
      data = buildRequest();
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    if (kind === 'generate' && !canRecoverSubmission && !canGenerate) return;
    const snapshot = { ...live.current };
    const requestHash = requestFingerprint(data);
    setBusy(kind);
    setError('');
    let submissionSent = false;
    try {
      if (kind === 'quote') {
        setQuote(null);
        const response = await fetch('/api/quotes', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(context ? authorityHeaders(context) : {}),
          },
          body: requestHash,
        });
        const body = await response.json();
        if (snapshot.version !== live.current.version) return;
        if (!response.ok) throw new Error(message(body));
        const quoted = (body.data ?? body) as Quote;
        if (quoted.modelId !== data.modelId || quoted.operation !== data.operation)
          throw new Error('The gateway returned a quote for a different model or operation.');
        setQuote({ fingerprint: requestHash, value: quoted });
        return;
      }

      if (!context) return;
      const checked = await fetch('/api/session', { cache: 'no-store' });
      if (!checked.ok)
        throw new Error('Your session could not be verified. Reconnect to continue.');
      const sessionBody = await checked.json();
      const fresh = (sessionBody.data ?? sessionBody) as BrowserSession;
      const freshContext = recoveryContext(fresh, model.id, data.operation);
      if (!freshContext || recoveryKey(freshContext, 'draft') !== contextKey) {
        sessionChange(fresh);
        return;
      }
      if (snapshot.version !== live.current.version) return;
      const epoch = ++resultEpoch.current;
      const existing = findSubmission(sessionStorage, context, requestHash);
      const recover = !!existing && !existing.rejected && !pendingAttempt;
      if (!recover && (!canGenerate || canRecoverSubmission)) return;
      if (
        pendingAttempt &&
        findSubmission(sessionStorage, context, pendingAttempt.sourceFingerprint)?.jobId !==
          pendingAttempt.jobId
      )
        throw new Error('Recover the latest submission before starting another attempt.');
      const receipt = recover
        ? existing
        : prepareSubmission(
            sessionStorage,
            context,
            data,
            undefined,
            existing ? pendingAttempt?.jobId : undefined,
          );
      const path = recover
        ? receipt.jobId
          ? `/api/generations/${encodeURIComponent(receipt.jobId)}`
          : '/api/generations/lookup'
        : '/api/generations';
      submissionSent = !recover;
      const response = await fetch(path, {
        cache: 'no-store',
        method: recover ? 'GET' : 'POST',
        headers: {
          ...authorityHeaders(context),
          ...(!recover ? { 'content-type': 'application/json' } : {}),
          ...(!receipt.jobId ? { 'idempotency-key': receipt.key } : {}),
        },
        ...(!recover ? { body: requestHash } : {}),
      });
      const body = await response.json();
      if (!response.ok) {
        if (
          !recover &&
          admissionRejections.has(`${response.status}:${body.error?.code}`) &&
          recordSubmissionRejection(sessionStorage, context, receipt)
        ) {
          submissionSent = false;
          if (snapshot.version === live.current.version) {
            setQuote(null);
            setNewAttempt(null);
          }
          throw new Error(`${message(body)} Get a fresh quote to submit the saved request again.`);
        }
        throw new Error(message(body));
      }
      const next = checkJob(body, context, {
        id: receipt.jobId,
        modelId: data.modelId,
        operation: data.operation,
      });
      const saved = recordSubmissionJob(sessionStorage, context, receipt, next.id);
      writeRecovery(sessionStorage, context, 'job', { id: next.id, fingerprint: requestHash });
      if (snapshot.boundary === live.current.boundary && epoch === resultEpoch.current) {
        writeRecovery(sessionStorage, context, 'last-result', resultReceipt(next));
        setJob(next);
        setResultView('preview');
        setResultError(
          saved ? '' : 'Tab storage could not save the receipt. Keep this job ID to recover it.',
        );
        if (snapshot.version === live.current.version) {
          setNewAttempt(null);
          setQuote(null);
          setNotice(recover ? 'Recovered the existing request.' : '');
        }
      }
    } catch (cause) {
      if (snapshot.version === live.current.version)
        setError(
          `${cause instanceof Error ? cause.message : 'Request failed.'}${submissionSent ? ' Your submission key is saved. Use Recover same request to look up its status.' : ''}`,
        );
    } finally {
      if (snapshot.version === live.current.version) setBusy(null);
    }
  }
  useEffect(() => {
    setBusy(null);
  }, [boundary, fingerprint]);

  function applyResultDraft(next: GenerateInput, nextLineage: ReuseLineage[], note: string) {
    if (next.modelId !== model.id) {
      onModelDraft?.({ draft: next, lineage: nextLineage, boundary });
      return;
    }
    const target = recoveryContext(session, model.id, next.operation);
    if (target) writeRecovery(sessionStorage, target, 'lineage', nextLineage);
    setLineage(nextLineage);
    setMode('form');
    setJsonDirty(false);
    setControlsRevision((revision) => revision + 1);
    setControlsValid(true);
    setNewAttempt(null);
    update(next);
    setNotice(note);
    const input = document.getElementById('playground-input');
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'start' });
  }

  function copyResultSettings(current: Job, startNew: boolean) {
    setResultError('');
    try {
      const next = validatePlaygroundRequest(current.input, catalog, current.input.modelId);
      const target = recoveryContext(session, next.modelId, next.operation);
      if (!target) throw new Error('Reconnect your authorized workspace to restore settings.');
      const nextFingerprint = requestFingerprint(next);
      let attempt: typeof newAttempt = null;
      if (startNew) {
        // Admission freezes external references and narrows routing. The returned snapshot can
        // differ from the original browser body, whose submission still guards the new attempt.
        const source = findSubmissionForJob(sessionStorage, target, current.id);
        const matchingDraft = findSubmission(sessionStorage, target, nextFingerprint);
        if (
          !isTerminal(current) ||
          !source ||
          findSubmission(sessionStorage, target, source.fingerprint)?.jobId !== current.id ||
          (matchingDraft && matchingDraft.jobId !== current.id)
        )
          throw new Error(
            'Recover the latest completed submission before preparing another attempt.',
          );
        attempt = {
          jobId: current.id,
          fingerprint: nextFingerprint,
          sourceFingerprint: source.fingerprint,
        };
      }
      const matchingLineage = readRecovery(sessionStorage, target, 'lineage', isLineage) ?? [];
      applyResultDraft(
        next,
        matchingLineage,
        startNew
          ? 'New attempt prepared. Get a fresh quote before approving another charge.'
          : 'Job settings copied to this draft. Get a fresh quote before generating.',
      );
      if (attempt) setNewAttempt(attempt);
    } catch (cause) {
      setResultError((cause as Error).message);
    }
  }

  function applyJson() {
    try {
      const next = validatePlaygroundRequest(JSON.parse(json), catalog, model.id);
      update(next);
      setJson(JSON.stringify(next, null, 2));
      setJsonDirty(false);
      setControlsValid(true);
      setNotice('Settings applied. Nothing has been submitted.');
    } catch (cause) {
      setError(
        `JSON was not applied. ${cause instanceof Error ? cause.message : 'Check its syntax.'} Your previous form is preserved.`,
      );
    }
  }
  const operationRoutes = routes.filter((route) => route.operations.includes(draft.operation));
  const regions = [
    ...new Set(operationRoutes.map(regionOf).filter((region): region is string => !!region)),
  ];
  const requestedRegion = singleRegion(draft);
  const selectedRegion =
    requestedRegion && regions.includes(requestedRegion) ? requestedRegion : undefined;
  const selectionHref = playgroundHref(model.id, draft.routeId, draft.operation, selectedRegion);
  useEffect(() => {
    if (authorityPending || loadedKey !== contextKey) return;
    if (window.location.pathname + window.location.search !== selectionHref)
      window.history.replaceState(null, '', selectionHref);
  }, [selectionHref, authorityPending, loadedKey, contextKey]);
  const currentQuote = quote?.fingerprint === fingerprint ? quote.value : null;
  const selectedQuote = currentQuote?.candidates.find(
    (candidate) => candidate.routeId === currentQuote.selectedRouteId && candidate.executable,
  );
  const ready = !validationError && !jsonDirty && controlsValid;
  const canGenerate =
    !authorityPending &&
    ready &&
    !!context?.scopes.includes('generate') &&
    loadedKey === contextKey &&
    storageReady &&
    !!selectedQuote &&
    (draft.billing === 'byok' || selectedQuote.estimatedCostMicros !== null);
  const quoteBlock = currentQuote?.candidates.find((candidate) => candidate.reason)?.reason;
  let readiness =
    'Review the request estimate and select Generate to approve this billable request.';
  let mobileStatus =
    selectedQuote?.estimatedCostMicros != null
      ? `Quote ${usd(selectedQuote.estimatedCostMicros)}${currentQuote?.reservationMicros ? ` · Hold ${usd(currentQuote.reservationMicros)}` : ''}`
      : 'Request price unavailable · See pricing';
  if (error) {
    readiness = error;
    mobileStatus = 'Request needs attention · See pricing';
  } else if (busy) {
    readiness =
      busy === 'quote'
        ? 'Checking this request’s price and eligible routes…'
        : 'Submitting your approved request…';
    mobileStatus = readiness;
  } else if (canRecoverSubmission) {
    readiness = 'Look up the existing submission with its saved request ID.';
    mobileStatus = 'Existing submission · Recover status';
  } else if (!ready) {
    readiness = jsonDirty
      ? 'Apply or discard your JSON edits.'
      : !controlsValid
        ? 'Apply or discard your advanced field edits.'
        : validationError;
    mobileStatus = jsonDirty ? 'Apply your JSON edits' : 'Input needs attention';
  } else if (!currentQuote) {
    readiness = session.unavailable
      ? 'Workspace access is unavailable. You can still try to get a quote.'
      : 'Get a request estimate and check which routes can run it.';
    mobileStatus = session.unavailable ? 'Workspace access unavailable' : 'Ready to quote';
  } else if (!selectedQuote) {
    readiness = quoteBlock ?? 'No route is eligible for this request. Review quote details.';
    mobileStatus = 'No eligible route · See pricing';
  } else if (!session.authenticated) {
    readiness = session.unavailable
      ? 'Workspace sign-in is unavailable. Retry workspace access.'
      : 'Sign in to your workspace before generating.';
    mobileStatus = session.unavailable ? 'Workspace access unavailable' : 'Sign in to generate';
  } else if (!context?.scopes.includes('generate')) {
    readiness = 'Connect an authorized workspace identity with generation access.';
    mobileStatus = 'Generation access required';
  } else if (!storageReady) {
    readiness = 'Enable tab storage to recover interrupted submissions.';
    mobileStatus = 'Tab storage required';
  }

  return (
    <>
      {authorityPending && <p role="status">Checking your authorized workspace…</p>}
      <div
        className="playground-view"
        style={authorityPending ? { visibility: 'hidden' } : undefined}
      >
        <PlaygroundWorkflow gatewayOrigin={gatewayOrigin} buildRequest={buildExportRequest} />
        <div className="playground-form">
          <div className={styles.selection}>
            <label>
              Operation
              <select
                value={draft.operation}
                onChange={(event) => {
                  const operation = event.target.value as Operation;
                  const { routeId, ...rest } = draft;
                  const { endpointRegions, ...routing } = rest.routing ?? {};
                  const available = routes.filter((route) => route.operations.includes(operation));
                  update(
                    {
                      ...rest,
                      operation,
                      ...(available.some((route) => route.id === routeId) ? { routeId } : {}),
                      routing: {
                        ...routing,
                        ...(endpointRegions &&
                        available.some((route) => endpointRegions.includes(regionOf(route) ?? ''))
                          ? { endpointRegions }
                          : {}),
                      },
                    },
                    true,
                  );
                }}
              >
                {[...new Set(routes.flatMap((route) => route.operations))].map((operation) => (
                  <option key={operation} value={operation}>
                    {names[operation]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Endpoint region
              <select
                value={
                  draft.routeId
                    ? (regionOf(routes.find((route) => route.id === draft.routeId)) ?? '')
                    : (selectedRegion ?? '')
                }
                onChange={(event) => {
                  const { routeId: _, ...rest } = draft;
                  const { endpointRegions: __, ...routing } = draft.routing ?? {};
                  update({
                    ...rest,
                    routing: {
                      ...routing,
                      ...(event.target.value ? { endpointRegions: [event.target.value] } : {}),
                    },
                  });
                }}
              >
                <option value="">Any eligible region</option>
                {regions.map((region) => (
                  <option key={region} value={region}>
                    {regionNames[region] ?? region}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.routeSelect}>
              Provider route
              <select
                aria-label="Provider route"
                value={draft.routeId ?? 'auto'}
                onChange={(event) => {
                  const { routeId: _, ...rest } = draft;
                  update({
                    ...rest,
                    ...(event.target.value !== 'auto' ? { routeId: event.target.value } : {}),
                    routing: { ...draft.routing, fallback: false },
                  });
                }}
              >
                <option value="auto">Automatic routing</option>
                {operationRoutes
                  .filter(
                    (route) =>
                      !selectedRegion ||
                      regionOf(route) === selectedRegion ||
                      route.id === draft.routeId,
                  )
                  .map((route) => {
                    const identity = routeIdentity(catalog, route);
                    return (
                      <option key={route.id} value={route.id}>
                        {identity.label} · {identity.region}
                      </option>
                    );
                  })}
              </select>
            </label>
            <div className={styles.selectionLink}>
              <span>Share the model, operation and route selection.</span>
              <CopyButton text={`${gatewayOrigin}${selectionHref}`} label="Copy setup link" />
            </div>
          </div>
          <PlaygroundPricing
            catalog={catalog}
            model={model}
            routes={routes}
            draft={draft}
            quote={currentQuote}
            job={session.authenticated ? job : null}
            readiness={readiness}
            mobileStatus={mobileStatus}
            busy={busy}
            ready={ready}
            canGenerate={canGenerate || canRecoverSubmission}
            submissionLabel={submissionLabel}
            error={error}
            onQuote={() => void request('quote')}
            onGenerate={() => void request('generate')}
          />
          <div className={styles.modeBar} id="playground-input" tabIndex={-1}>
            <p>One private request. Every setting stays explicit.</p>
            <div aria-label="Input mode">
              {(['form', 'json'] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  disabled={value === 'json' && !controlsValid}
                  onClick={() => {
                    if (value === 'json' && !jsonDirty)
                      setJson(JSON.stringify(validRequest ?? draft, null, 2));
                    setMode(value);
                  }}
                >
                  {value === 'form' ? 'Form' : 'JSON'}
                </button>
              ))}
            </div>
          </div>
          {lineage
            .filter((parent) =>
              collectGenerationAssets(draft.input).some(
                ({ asset }) => asset.assetKey === parent.assetKey,
              ),
            )
            .map((parent) => (
              <p className={styles.lineage} key={parent.assetKey}>
                Private parent job {parent.sourceJobId}, output {parent.outputIndex + 1}. Owned
                input {parent.assetKey}.{' '}
                {parent.expiresAt
                  ? `Input expires ${parent.expiresAt}.`
                  : 'No input expiry reported.'}
              </p>
            ))}
          {notice && (
            <p className="recovery-notice" role="status">
              {notice}
            </p>
          )}
          {mode === 'json' ? (
            <div className={styles.jsonEditor}>
              <label>
                Canonical request JSON
                <textarea
                  value={json}
                  spellCheck={false}
                  onChange={(event) => {
                    setJson(event.target.value);
                    setJsonDirty(true);
                    live.current.version++;
                    setBusy(null);
                    setQuote(null);
                  }}
                />
              </label>
              <p className="detail-note">
                Apply validates the entire request atomically. Invalid JSON leaves the form
                unchanged. Applying settings never submits.
              </p>
              <div className="playground-actions">
                <button className="button button-outline" onClick={applyJson}>
                  Apply JSON
                </button>
                <button
                  className="button button-outline"
                  onClick={() => {
                    setJson(JSON.stringify(validRequest ?? draft, null, 2));
                    setJsonDirty(false);
                    setError('');
                  }}
                >
                  Discard JSON edits
                </button>
              </div>
            </div>
          ) : (
            <>
              <label className="fallback-setting">
                <input
                  type="checkbox"
                  checked={draft.routing?.fallback ?? false}
                  disabled={!!draft.routeId}
                  onChange={(event) =>
                    update({
                      ...draft,
                      routing: { ...draft.routing, fallback: event.target.checked },
                    })
                  }
                />
                <span>Try another eligible provider after a confirmed, unbilled rejection</span>
              </label>
              <p className="fallback-note">
                {draft.routeId
                  ? 'Your exact regional route is pinned.'
                  : 'The exact variant and regional restrictions stay the same. A timeout never starts another paid attempt.'}
              </p>
              <PlaygroundExample
                modelId={model.id}
                operation={draft.operation}
                onLoad={(input) => {
                  const { previousJobId: _, ...fresh } = draft;
                  update({ ...fresh, input });
                  setJsonDirty(false);
                  setControlsRevision((revision) => revision + 1);
                  setControlsValid(true);
                  setNotice('Example loaded into the draft. Review its settings and get a quote.');
                }}
              />
              <PlaygroundAuthority
                value={
                  context
                    ? {
                        'x-opengen-workspace': context.workspaceId,
                        'x-opengen-recovery-scope': context.recoveryScope,
                      }
                    : {}
                }
              >
                <CanonicalControls
                  key={`${boundary}:${draft.operation}:${controlsRevision}`}
                  modelId={model.id}
                  operation={draft.operation}
                  route={routes.find((route) => route.id === draft.routeId)}
                  value={draft.input}
                  authenticated={!authorityPending && !!context?.scopes.includes('generate')}
                  onChange={(input) => update({ ...draft, input })}
                  onValidityChange={setControlsValid}
                />
              </PlaygroundAuthority>
              <label>
                Owned continuation job ID{' '}
                <span className="optional">
                  optional · original model and deployment remain pinned
                </span>
                <input
                  value={draft.previousJobId ?? ''}
                  onChange={(event) => {
                    const { previousJobId: _, ...rest } = draft;
                    update({
                      ...rest,
                      ...(event.target.value ? { previousJobId: event.target.value } : {}),
                    });
                  }}
                />
              </label>
              <div className="field-grid">
                <label>
                  Pay with
                  <select
                    value={draft.billing ?? 'managed'}
                    onChange={(event) =>
                      update({ ...draft, billing: event.target.value as 'managed' | 'byok' })
                    }
                  >
                    <option value="managed">OpenGen workspace credit</option>
                    <option value="byok">My provider account</option>
                  </select>
                </label>
                <label>
                  Maximum spend, USD
                  <input
                    type="number"
                    min="0.000001"
                    step="0.01"
                    value={draft.maxCostMicros === undefined ? '' : draft.maxCostMicros / 1_000_000}
                    onChange={(event) => {
                      const { maxCostMicros: _, ...rest } = draft;
                      update({
                        ...rest,
                        ...(event.target.value
                          ? { maxCostMicros: Math.round(Number(event.target.value) * 1_000_000) }
                          : {}),
                      });
                    }}
                  />
                </label>
              </div>
              {draft.billing === 'byok' && (
                <p className="byok-notice">
                  Your provider bills your saved connection directly. Unknown-priced routes cannot
                  enforce an OpenGen spending ceiling. Remove the optional cap explicitly only if
                  you accept that exposure.
                </p>
              )}
            </>
          )}
          {validationError && (
            <p className={styles.incompatibility}>Review settings: {validationError}</p>
          )}
          {!controlsValid && (
            <p className={styles.incompatibility}>
              Apply or discard the structured field edits before quoting or generating.
            </p>
          )}
          {jsonDirty && mode === 'form' && (
            <p className={styles.incompatibility}>
              You have unapplied JSON edits. Return to JSON to apply or discard them.
            </p>
          )}
          <div id="playground-account" tabIndex={-1}>
            <GatewayAccess onChange={authChange} onSession={sessionChange} />
          </div>
          {session.authenticated && !context && (
            <p className="detail-note">
              This session has no authorized recovery identity. Reconnect after the installation
              enables scoped browser recovery. Quotes remain available.
            </p>
          )}
          {!storageReady && (
            <p className="error-notice">
              Tab storage is unavailable. Enable it before submitting so an interrupted request can
              recover safely.
            </p>
          )}
        </div>
        <div className="job-panel" id="playground-result" tabIndex={-1}>
          <span className="eyebrow">PRIVATE GENERATION</span>
          {!authorityPending && context?.scopes.includes('read') && job ? (
            <PlaygroundResult
              key={job.id}
              job={job}
              draft={draft}
              catalog={catalog}
              view={resultView}
              onView={setResultView}
              resultKey={context.scopes.includes('generate') ? (resultKey ?? undefined) : undefined}
              expectedHeaders={authorityHeaders(context)}
              allowModelTransfer={!!onModelDraft}
              onReuse={(next, outputIndex, lineageNote, asset) => {
                if (boundary !== live.current.boundary || fingerprint !== live.current.fingerprint)
                  return;
                const parent = { ...asset, sourceJobId: job.id, outputIndex };
                const nextLineage = [
                  ...lineage.filter((entry) => entry.assetKey !== asset.assetKey),
                  parent,
                ];
                applyResultDraft(
                  next,
                  nextLineage,
                  `${lineageNote} Settings restored; review and quote before generating.`,
                );
              }}
              onRefresh={() => {
                setResultError('');
                void refreshJob(job).catch((cause) => {
                  if (boundary === live.current.boundary) setResultError(cause.message);
                });
              }}
              onCopySettings={
                job.input.modelId === model.id || onModelDraft
                  ? () => copyResultSettings(job, false)
                  : undefined
              }
              onNewAttempt={
                isTerminal(job) &&
                hasResultSubmission &&
                job.input.modelId === model.id &&
                context.scopes.includes('generate')
                  ? () => copyResultSettings(job, true)
                  : undefined
              }
              onCancel={
                job.status === 'queued' && context.scopes.includes('generate')
                  ? async () => {
                      const epoch = resultEpoch.current;
                      setResultError('');
                      try {
                        const response = await fetch(
                          `/api/generations/${encodeURIComponent(job.id)}/cancel`,
                          {
                            method: 'POST',
                            headers: authorityHeaders(context),
                          },
                        );
                        const body = await response.json();
                        if (epoch !== resultEpoch.current || boundary !== live.current.boundary)
                          return;
                        if (!response.ok) throw new Error(message(body));
                        setJob(checkJob(body, context, resultReceipt(job)));
                      } catch (cause) {
                        if (epoch === resultEpoch.current && boundary === live.current.boundary)
                          setResultError((cause as Error).message);
                      }
                    }
                  : undefined
              }
              error={resultError}
            />
          ) : (
            <div className="job-empty">
              <span className="empty-frame">
                {model.modality === 'video' ? <Icon name="play" size={22} /> : '▧'}
              </span>
              <h4>Your output lands here.</h4>
              <p>Compare a quote, then submit when you’re ready.</p>
              <span className="job-empty-label">PRIVATE TO YOUR AUTHORIZED WORKSPACE</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
