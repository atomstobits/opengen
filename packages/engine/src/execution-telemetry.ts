import type {
  JobError as CoreJobError,
  JobProgress as CoreJobProgress,
} from '@media-router/contracts';

/**
 * The execution boundary accepts observations, never raw provider response bags.
 * Optional observation extensions remain implementation-local until integration
 * promotes them. Neither a read retry nor telemetry authorizes submission.
 */
export type JobErrorCategory = CoreJobError['category'];
export type JobRecovery = CoreJobError['recovery'];

const errorDefinitions = {
  input_preparation_unavailable: {
    category: 'technical',
    message:
      'The accepted input package is not ready for dispatch. Keep this queued job and retry preparation or ask the operator to restore its inputs.',
    retryable: true,
    recovery: 'same_job',
  },
  invalid_input: {
    category: 'invalid_input',
    message: 'The request contains an unsupported or invalid input.',
    retryable: false,
    recovery: 'edit_request',
  },
  policy_rejected: {
    category: 'policy',
    message: 'The request was rejected by the applicable policy.',
    retryable: false,
    recovery: 'edit_request',
  },
  submission_rejected: {
    category: 'unknown',
    message: 'The provider explicitly rejected submission.',
    retryable: false,
    recovery: 'edit_request',
  },
  submission_unknown: {
    category: 'unknown',
    message: 'Provider acceptance is unknown. Keep this job for reconciliation.',
    retryable: false,
    recovery: 'operator',
  },
  status_unavailable: {
    category: 'technical',
    message: 'Provider status is temporarily unavailable. Resume reading the same job.',
    retryable: true,
    recovery: 'same_job',
  },
  provider_failed: {
    category: 'technical',
    message: 'Provider execution failed. The charge may require reconciliation.',
    retryable: false,
    recovery: 'operator',
  },
  provider_policy_rejected: {
    category: 'policy',
    message: 'The provider rejected the request under its content policy.',
    retryable: false,
    recovery: 'edit_request',
  },
  provider_invalid_input: {
    category: 'invalid_input',
    message: 'The provider reported an invalid input.',
    retryable: false,
    recovery: 'edit_request',
  },
  provider_outcome_unknown: {
    category: 'unknown',
    message: 'The provider outcome is unresolved. Keep this job for reconciliation.',
    retryable: false,
    recovery: 'operator',
  },
  delivery_failed: {
    category: 'technical',
    message:
      'Output delivery could not be completed. Inspect this existing job with operator support; do not submit another generation.',
    retryable: false,
    recovery: 'operator',
  },
  delivery_expired: {
    category: 'technical',
    message:
      'The original output source expired. Inspect this existing job with operator support; do not submit another generation.',
    retryable: false,
    recovery: 'operator',
  },
  delivery_unavailable: {
    category: 'technical',
    message: 'Output delivery is unavailable. Resume recovery of the same job.',
    retryable: true,
    recovery: 'same_job',
  },
  credentials_unavailable: {
    category: 'technical',
    message: 'The original provider connection needs operator attention to resume this job.',
    retryable: false,
    recovery: 'operator',
  },
  capacity_full: {
    category: 'technical',
    message: 'Dispatch capacity is full. The existing queued job can wait for capacity.',
    retryable: true,
    recovery: 'same_job',
  },
  start_deadline_exceeded: {
    category: 'technical',
    message: 'The local queue-start deadline expired before provider submission.',
    retryable: false,
    recovery: 'none',
  },
} as const satisfies Record<
  string,
  { category: JobErrorCategory; message: string; retryable: boolean; recovery: JobRecovery }
>;

export type JobErrorCode = keyof typeof errorDefinitions;
export interface JobError extends CoreJobError {
  code: JobErrorCode;
  category: JobErrorCategory;
  message: string;
  /** Retry a read/recovery of this same job only; never a paid-submit instruction. */
  retryable: boolean;
  recovery: JobRecovery;
  field?: string;
  providerCode?: string;
}

// A syntactically bounded string can still contain a prompt or credential. These
// are explicit known code labels, not a regex that would accept arbitrary text.
const providerCodes = new Set([
  'invalid_request_error',
  'invalid_request',
  'content_policy_violation',
  'rate_limit_exceeded',
  'insufficient_quota',
  'authentication_error',
  'invalid_api_key',
  'task_not_found',
  'internal_error',
  'service_unavailable',
  'timeout',
  'cancelled',
  'INVALID_REQUEST',
  'CONTENT_POLICY_VIOLATION',
  'RATE_LIMIT_EXCEEDED',
  'INSUFFICIENT_QUOTA',
  'AUTHENTICATION_ERROR',
  'TASK_NOT_FOUND',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
]);
const fields = new Set([
  'modelId',
  'operation',
  'routeId',
  'deploymentId',
  'input',
  'input.prompt',
  'input.negativePrompt',
  'input.resolution',
  'input.duration',
  'input.aspectRatio',
  'input.count',
  'input.seed',
  'input.audio',
  'input.firstFrame',
  'input.lastFrame',
  'input.references',
  'input.sourceVideo',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Safe, closed messages: even a stored structured message is never echoed. */
export function jobError(
  code: JobErrorCode,
  details: { field?: unknown; providerCode?: unknown } = {},
): JobError {
  return {
    code,
    ...errorDefinitions[code],
    ...(typeof details.field === 'string' && fields.has(details.field)
      ? { field: details.field }
      : {}),
    ...(typeof details.providerCode === 'string' && providerCodes.has(details.providerCode)
      ? { providerCode: details.providerCode }
      : {}),
  };
}

/** Unknown/legacy error text stays absent; no diagnosis is invented from text. */
export function normalizeJobError(value: unknown): JobError | null {
  const row = object(value);
  return row && typeof row.code === 'string' && Object.hasOwn(errorDefinitions, row.code)
    ? jobError(row.code as JobErrorCode, row)
    : null;
}

/** Maps only a qualified adapter's explicit category; never inspect raw messages. */
export function providerFailureError(
  category: 'technical' | 'policy' | 'invalid' | 'unknown' | undefined,
  providerCode?: unknown,
): JobError {
  const code =
    category === 'technical'
      ? 'provider_failed'
      : category === 'policy'
        ? 'provider_policy_rejected'
        : category === 'invalid'
          ? 'provider_invalid_input'
          : 'provider_outcome_unknown';
  return jobError(code, { providerCode });
}

export type ProgressPhase = CoreJobProgress['phase'];
export type ObservationSource = CoreJobProgress['source'];
export interface JobProgress extends CoreJobProgress {
  providerPhase: 'queued' | 'processing' | null;
  queuePosition: number | null;
}

const progressPhases = new Set<unknown>([
  'queued',
  'submitting',
  'running',
  'delivery',
  'complete',
]);

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function source(value: unknown): value is ObservationSource {
  return value === 'provider' || value === 'gateway';
}

/** No phase-to-percent mapping: a completed task does not imply observed 100%. */
export function normalizeJobProgress(value: unknown): JobProgress | null {
  const row = object(value);
  if (!row || !progressPhases.has(row.phase) || !source(row.source)) return null;
  const observedAt = isoDate(row.observedAt);
  if (!observedAt) return null;
  return {
    phase: row.phase as ProgressPhase,
    percent:
      typeof row.percent === 'number' &&
      Number.isFinite(row.percent) &&
      row.percent >= 0 &&
      row.percent <= 100
        ? row.percent
        : null,
    observedAt,
    source: row.source,
    providerPhase:
      row.source === 'provider' &&
      (row.providerPhase === 'queued' || row.providerPhase === 'processing')
        ? row.providerPhase
        : null,
    queuePosition:
      row.source === 'provider' &&
      typeof row.queuePosition === 'number' &&
      Number.isSafeInteger(row.queuePosition) &&
      row.queuePosition >= 0
        ? row.queuePosition
        : null,
  };
}

export interface TimingObservation {
  durationMs: number;
  source: ObservationSource;
  observedAt: string;
}

export interface JobTimings {
  queue: TimingObservation | null;
  /** Provider-reported runtime or gateway-observed accepted-to-completion span. */
  execution: TimingObservation | null;
  delivery: TimingObservation | null;
  endToEnd: TimingObservation | null;
  /** Actual observed preview only. This is not inferred time to first token. */
  firstPreview: TimingObservation | null;
}

function timing(value: unknown): TimingObservation | null {
  const row = object(value);
  if (
    !row ||
    !source(row.source) ||
    typeof row.durationMs !== 'number' ||
    !Number.isSafeInteger(row.durationMs) ||
    row.durationMs < 0
  )
    return null;
  const observedAt = isoDate(row.observedAt);
  return observedAt ? { durationMs: row.durationMs, source: row.source, observedAt } : null;
}

/** Unknown observations are null and raw metadata never survives projection. */
export function normalizeJobTimings(value: unknown): JobTimings | null {
  const row = object(value);
  if (!row) return null;
  return {
    queue: timing(row.queue),
    execution: timing(row.execution),
    delivery: timing(row.delivery),
    endToEnd: timing(row.endToEnd),
    firstPreview: timing(row.firstPreview),
  };
}

export interface GatewayMilestones {
  createdAt?: string | null;
  dispatchStartedAt?: string | null;
  acceptedAt?: string | null;
  providerCompletedAt?: string | null;
  usableAt?: string | null;
  firstPreviewAt?: string | null;
}

function span(start: unknown, end: unknown): TimingObservation | null {
  const from = isoDate(start);
  const until = isoDate(end);
  if (!from || !until) return null;
  const durationMs = new Date(until).getTime() - new Date(from).getTime();
  return durationMs >= 0 ? { durationMs, source: 'gateway', observedAt: until } : null;
}

/**
 * Build measured gateway spans only. Polling latency may be included in execution;
 * it must not be presented as provider-reported runtime or video TTFT.
 */
export function gatewayJobTimings(milestones: GatewayMilestones): JobTimings {
  return {
    queue: span(milestones.createdAt, milestones.dispatchStartedAt),
    execution: span(milestones.acceptedAt, milestones.providerCompletedAt),
    delivery: span(milestones.providerCompletedAt, milestones.usableAt),
    endToEnd: span(milestones.createdAt, milestones.usableAt),
    firstPreview: span(milestones.createdAt, milestones.firstPreviewAt),
  };
}
