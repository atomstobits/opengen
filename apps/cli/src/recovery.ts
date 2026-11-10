import {
  JobWaitError,
  JobWaitTimeoutError,
  OpenGenAPIError,
  SubmissionUncertainError,
} from '@media-router/sdk';
import type { Job } from '@media-router/contracts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function recoveryCommand(args: string[], baseUrl?: string) {
  return {
    command: `${baseUrl ? `MEDIA_ROUTER_URL=${quote(baseUrl)} ` : ''}opengen ${args.map(quote).join(' ')}`,
    executable: 'opengen',
    args,
    ...(baseUrl ? { environment: { MEDIA_ROUTER_URL: baseUrl } } : {}),
  };
}
export function jobRecovery(job: Job, baseUrl?: string) {
  return {
    jobId: job.id,
    generation: job.status,
    acceptance:
      job.upstreamId || ['running', 'succeeded'].includes(job.status)
        ? 'accepted'
        : job.status === 'queued'
          ? 'pending'
          : 'unknown',
    delivery: job.deliveryStatus ?? 'unverified',
    billing: {
      state:
        job.settledMicros != null ? 'settled' : job.reservedMicros > 0 ? 'reserved' : 'pending',
      reservedMicros: job.reservedMicros ?? null,
      settledMicros: job.settledMicros ?? null,
    },
    resume: recoveryCommand(['job', 'resume', job.id, '--timeout-ms', '900000'], baseUrl),
    nextAction:
      job.status === 'submission-unknown'
        ? 'Ask the installation operator to reconcile upstream acceptance. Resume only reads the same job; never regenerate to recover delivery or an uncertain submission.'
        : 'Resume only reads this existing job and refreshes available output URLs. It never submits or cancels generation.',
  };
}
export function serializeCommandError(error: unknown, options: { baseUrl?: string } = {}) {
  const detail =
    error instanceof JobWaitError || error instanceof SubmissionUncertainError
      ? error.cause
      : error;
  const api = detail instanceof OpenGenAPIError ? detail : undefined;
  const known = error instanceof JobWaitTimeoutError || error instanceof JobWaitError;
  const uncertain = error instanceof SubmissionUncertainError;
  const code = uncertain
    ? 'submission_unknown'
    : error instanceof JobWaitTimeoutError
      ? 'wait_timeout'
      : error instanceof JobWaitError
        ? error.interrupted
          ? 'wait_interrupted'
          : 'job_read_failed'
        : (api?.code ?? 'command_failed');
  return {
    error: {
      code,
      message:
        uncertain || known || api || error instanceof TypeError || error instanceof Error
          ? (error as Error).message
          : 'OpenGen command failed.',
      ...(api ? { status: api.status, serverCode: api.code, issues: api.issues } : {}),
      retryable: !uncertain && known,
      paidResubmissionAllowed: false,
      ...(known
        ? {
            jobId: error.jobId,
            ...(error.lastJob
              ? { state: jobRecovery(error.lastJob, options.baseUrl) }
              : { acceptance: 'unknown', delivery: 'unknown', billing: { state: 'unknown' } }),
            resume: recoveryCommand(
              ['job', 'resume', error.jobId, '--timeout-ms', '900000'],
              options.baseUrl,
            ),
          }
        : {}),
      ...(uncertain
        ? {
            jobId: error.jobId ?? null,
            status: error.status ?? null,
            idempotencyKey: error.idempotencyKey,
            acceptance: 'unknown',
            delivery: 'unknown',
            billing: { state: 'unknown' },
            resume: recoveryCommand(
              error.jobId
                ? ['job', 'resume', error.jobId, '--timeout-ms', '900000']
                : ['job', 'recover', '--idempotency-key', error.idempotencyKey],
              options.baseUrl,
            ),
            nextAction:
              'Retain the exact original input and key. This command performs read-only lookup. A missing lookup is not proof of rejection; repeat lookup later or ask the operator to reconcile. Never switch keys or automatically submit again.',
          }
        : {}),
    },
  };
}
