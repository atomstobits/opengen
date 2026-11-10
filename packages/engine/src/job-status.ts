import { createHash } from 'node:crypto';
import type {
  DeliveryStatus,
  JobStatus,
  JobStatusView as CoreJobStatusView,
} from '@media-router/contracts';
import {
  normalizeJobError,
  normalizeJobProgress,
  normalizeJobTimings,
  type JobError,
  type JobProgress,
  type JobTimings,
} from './execution-telemetry.js';

/** Private compact customer projection. No inputs, outputs or credential identities are loaded. */
export interface ExecutionStatusView extends CoreJobStatusView {
  deliveryStatus: DeliveryStatus;
  progress: JobProgress | null;
  structuredError: JobError | null;
  timings: JobTimings | null;
  /** Opaque equality token, not a timestamp, sequence number or cancellation capability. */
  revision: string;
}

export interface JobStatusRow {
  id: string;
  status: JobStatus;
  delivery_status: string | null;
  route_id: string;
  deployment_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  reserved_micros: string | number;
  settled_micros: string | number | null;
  execution_progress?: unknown;
  execution_error?: unknown;
  execution_timings?: unknown;
}

export class JobStatusError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'JobStatusError';
  }
}

const deliveryStatuses = new Set<DeliveryStatus>([
  'pending',
  'available',
  'partial',
  'failed',
  'expired',
  'unverified',
]);
const corruptStatus = () =>
  new JobStatusError('status_unavailable', 'Job status is temporarily unavailable.', 503);
function money(value: string | number): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || value === '') throw corruptStatus();
  return amount;
}
function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw corruptStatus();
  return parsed.toISOString();
}

/** Projection changes, including settlement after completion, invalidate the revision. */
export function projectJobStatus(row: JobStatusRow): ExecutionStatusView {
  const body = {
    id: row.id,
    status: row.status,
    deliveryStatus: deliveryStatuses.has(row.delivery_status as DeliveryStatus)
      ? (row.delivery_status as DeliveryStatus)
      : ('unverified' as const),
    routeId: row.route_id,
    deploymentId: row.deployment_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    reservedMicros: money(row.reserved_micros),
    settledMicros: row.settled_micros === null ? null : money(row.settled_micros),
    progress: normalizeJobProgress(row.execution_progress),
    structuredError: normalizeJobError(row.execution_error),
    timings: normalizeJobTimings(row.execution_timings),
  };
  return {
    ...body,
    revision: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

export interface StatusIdentity {
  workspaceId: string;
  scopes: readonly string[];
}
/** Must resolve current authority from the original credential/session/grant on every invocation. */
export type ReauthorizeStatus = () => Promise<StatusIdentity | null>;
export interface StatusDatabase {
  query(sql: string, parameters: unknown[]): Promise<{ rows: JobStatusRow[] }>;
}
export interface JobStatusWaitOptions {
  /** Existing revision to wait past. Omit for an immediate snapshot. */
  afterRevision?: string;
  /** Client wait only; does not alter a queue deadline, runtime, job, hold or lease. */
  waitMs?: number;
  signal?: AbortSignal;
}
export interface JobStatusWaitResult {
  job: ExecutionStatusView;
  changed: boolean;
  timedOut: boolean;
}

function disconnected(): JobStatusError {
  return new JobStatusError('status_wait_aborted', 'Status waiting ended.', 499);
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw disconnected();
}
function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    throw new JobStatusError('invalid_status_id', 'Use a valid job ID.', 400);
}
/** Bounds observation only. The driver must also use query_timeout/statement_timeout to free a stalled connection. */
function observe<T>(
  operation: (observationSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let finished = false;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (finished) return;
      cleanup();
      controller.abort();
      reject(disconnected());
    };
    const timer = setTimeout(() => {
      if (finished) return;
      cleanup();
      controller.abort();
      reject(
        new JobStatusError(
          'status_read_timeout',
          'Job status read timed out; retry this read.',
          503,
        ),
      );
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve()
      .then(() => {
        checkSignal(controller.signal);
        return operation(controller.signal);
      })
      .then(
        (value) => {
          if (finished) return;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (finished) return;
          cleanup();
          // Driver/auth exceptions can include SQL, URLs or credential material.
          reject(error instanceof JobStatusError ? error : corruptStatus());
        },
      );
  });
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(disconnected());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    // Covers an abort between the initial check and listener installation.
    if (signal?.aborted) abort();
  });
}

/**
 * One scoped SELECT per observation. Waiting holds no connection or transaction.
 * HTTP/MCP adapters supply fresh authorization and tie the signal to disconnect.
 */
export class JobStatusStore {
  private waiting = 0;
  private readonly pollIntervalMs: number;
  private readonly maxWaiters: number;
  private readonly readTimeoutMs: number;
  constructor(
    private readonly database: StatusDatabase,
    options: { pollIntervalMs?: number; maxWaiters?: number; readTimeoutMs?: number } = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxWaiters = options.maxWaiters ?? 100;
    this.readTimeoutMs = options.readTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 50 ||
      this.pollIntervalMs > 2_000 ||
      !Number.isInteger(this.maxWaiters) ||
      this.maxWaiters < 1 ||
      this.maxWaiters > 10_000 ||
      !Number.isInteger(this.readTimeoutMs) ||
      this.readTimeoutMs < 100 ||
      this.readTimeoutMs > 5_000
    )
      throw new JobStatusError('invalid_status_options', 'Invalid status service limits.', 400);
  }

  private async authorize(
    reauthorize: ReauthorizeStatus,
    workspaceId?: string,
  ): Promise<StatusIdentity> {
    const identity = await reauthorize();
    if (!identity) throw new JobStatusError('unauthorized', 'Authentication is required.', 401);
    if (
      !identity.scopes.includes('read') ||
      !identity.workspaceId ||
      (workspaceId !== undefined && identity.workspaceId !== workspaceId)
    )
      throw new JobStatusError('policy_denied', 'Job status access is not permitted.', 403);
    return identity;
  }

  private async read(
    id: string,
    reauthorize: ReauthorizeStatus,
    workspaceId?: string,
    signal?: AbortSignal,
    timeoutMs = this.readTimeoutMs,
  ): Promise<{ job: ExecutionStatusView; workspaceId: string }> {
    return observe(
      async (observationSignal) => {
        const identity = await this.authorize(reauthorize, workspaceId);
        checkSignal(observationSignal);
        const { rows } = await this.database.query(
          `SELECT id,status,delivery_status,route_snapshot->>'id' AS route_id,
       deployment_snapshot->>'id' AS deployment_id,created_at,updated_at,
       reserved_micros,settled_micros,execution_progress,execution_error,execution_timings
       FROM mr_jobs WHERE workspace_id=$1 AND id=$2`,
          [identity.workspaceId, id],
        );
        checkSignal(observationSignal);
        // Revocation during a query must not return the previously authorized snapshot.
        await this.authorize(reauthorize, identity.workspaceId);
        checkSignal(observationSignal);
        if (!rows[0]) throw new JobStatusError('job_not_found', 'Job not found.', 404);
        return { job: projectJobStatus(rows[0]), workspaceId: identity.workspaceId };
      },
      timeoutMs,
      signal,
    );
  }

  async get(reauthorize: ReauthorizeStatus, id: string): Promise<ExecutionStatusView> {
    validateId(id);
    return (await this.read(id, reauthorize)).job;
  }

  async wait(
    reauthorize: ReauthorizeStatus,
    id: string,
    options: JobStatusWaitOptions = {},
  ): Promise<JobStatusWaitResult> {
    validateId(id);
    const waitMs = options.waitMs ?? 0;
    if (
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 25_000 ||
      (options.afterRevision !== undefined && !/^[a-f0-9]{64}$/.test(options.afterRevision))
    )
      throw new JobStatusError(
        'invalid_status_wait',
        'Use a status revision and a wait of 0 through 25000 milliseconds.',
        400,
      );
    checkSignal(options.signal);
    const deadline = performance.now() + waitMs;
    const initial = await this.read(id, reauthorize, undefined, options.signal);
    let job = initial.job;
    const changed = options.afterRevision !== job.revision;
    if (changed || waitMs === 0) return { job, changed, timedOut: false };
    if (this.waiting >= this.maxWaiters)
      throw new JobStatusError(
        'status_backpressure',
        'Too many status waits; retry this read.',
        429,
      );
    this.waiting += 1;
    try {
      while (performance.now() < deadline) {
        await delay(Math.min(this.pollIntervalMs, deadline - performance.now()), options.signal);
        if (performance.now() >= deadline) break;
        job = (
          await this.read(
            id,
            reauthorize,
            initial.workspaceId,
            options.signal,
            Math.min(this.readTimeoutMs, deadline - performance.now()),
          )
        ).job;
        if (job.revision !== options.afterRevision) return { job, changed: true, timedOut: false };
      }
      // A timeout response also requires fresh authority; it cannot return a cached pre-revocation view.
      await observe(
        () => this.authorize(reauthorize, initial.workspaceId),
        this.readTimeoutMs,
        options.signal,
      );
      return { job, changed: false, timedOut: true };
    } finally {
      this.waiting -= 1;
    }
  }
}
