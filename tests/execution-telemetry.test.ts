import { describe, expect, it } from 'vitest';
import {
  gatewayJobTimings,
  jobError,
  normalizeJobError,
  normalizeJobProgress,
  normalizeJobTimings,
  providerFailureError,
} from '../packages/engine/src/execution-telemetry.js';

const observedAt = '2026-11-04T10:00:00.000Z';

describe('safe execution errors', () => {
  it('projects a closed error template and drops private provider data', () => {
    const safe = normalizeJobError({
      code: 'status_unavailable',
      category: 'invalid_input',
      message: 'Bearer fixture-private-secret https://private.example/output?token=fixture',
      retryable: false,
      recovery: 'edit_request',
      providerCode: 'private-prompt-as-a-code',
      field: 'private-prompt-as-a-field',
      body: { key: 'fixture-private-secret' },
    });
    expect(safe).toEqual({
      code: 'status_unavailable',
      category: 'technical',
      message: 'Provider status is temporarily unavailable. Resume reading the same job.',
      retryable: true,
      recovery: 'same_job',
    });
    expect(JSON.stringify(safe)).not.toMatch(/private|Bearer|https/);
  });

  it('keeps legacy/raw failures unknown rather than diagnosing their content', () => {
    for (const value of [
      null,
      undefined,
      'content policy violation with private prompt',
      new Error('Bearer fixture-private-secret'),
      { code: 'custom_credential_token', message: 'private' },
      { code: 'toString' },
      { code: '__proto__' },
    ])
      expect(normalizeJobError(value)).toBeNull();
  });

  it('preserves only known field and provider code labels', () => {
    expect(
      jobError('provider_invalid_input', {
        field: 'input.duration',
        providerCode: 'invalid_request_error',
      }),
    ).toMatchObject({ field: 'input.duration', providerCode: 'invalid_request_error' });
    expect(
      jobError('invalid_input', { field: 'input.prompt.private', providerCode: 'sk-fixture' }),
    ).toEqual(jobError('invalid_input'));
  });

  it('maps explicit adapter categories without claiming a refund or resubmit permission', () => {
    expect(providerFailureError('policy').category).toBe('policy');
    expect(providerFailureError('invalid').category).toBe('invalid_input');
    expect(providerFailureError('technical').code).toBe('provider_failed');
    expect(providerFailureError(undefined).code).toBe('provider_outcome_unknown');
    expect(providerFailureError('unknown').recovery).toBe('operator');
    expect(jobError('submission_unknown').retryable).toBe(false);
    expect(jobError('submission_rejected').category).toBe('unknown');
    expect(jobError('status_unavailable').recovery).toBe('same_job');
    expect(jobError('delivery_unavailable').recovery).toBe('same_job');
    expect(jobError('start_deadline_exceeded').message).not.toMatch(/refund|cancel/);
  });

  it('does not mutate the source error or financial data', () => {
    const row = Object.freeze({
      code: 'submission_unknown',
      message: 'private details',
      reservedMicros: 123,
      settledMicros: null,
    });
    const before = JSON.stringify(row);
    expect(normalizeJobError(row)?.recovery).toBe('operator');
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe('observed progress', () => {
  it('keeps absent progress and percentages unknown, including a terminal phase', () => {
    expect(normalizeJobProgress(undefined)).toBeNull();
    expect(normalizeJobProgress(null)).toBeNull();
    expect(normalizeJobProgress({ phase: 'running' })).toBeNull();
    expect(normalizeJobProgress({ phase: 'complete', observedAt, source: 'gateway' })).toEqual({
      phase: 'complete',
      percent: null,
      observedAt,
      source: 'gateway',
      providerPhase: null,
      queuePosition: null,
    });
  });

  it('retains qualified provider phase, position and percentage without raw metadata', () => {
    expect(
      normalizeJobProgress({
        phase: 'running',
        providerPhase: 'queued',
        queuePosition: 0,
        percent: 12.5,
        observedAt,
        source: 'provider',
        prompt: 'private prompt',
        upstreamId: 'private-task',
      }),
    ).toEqual({
      phase: 'running',
      providerPhase: 'queued',
      queuePosition: 0,
      percent: 12.5,
      observedAt,
      source: 'provider',
    });
  });

  it('does not manufacture provider queue facts from gateway state', () => {
    expect(
      normalizeJobProgress({
        phase: 'queued',
        providerPhase: 'queued',
        queuePosition: 12,
        observedAt,
        source: 'gateway',
      }),
    ).toMatchObject({ providerPhase: null, queuePosition: null, percent: null });
  });

  it('rejects unsafe numbers and observations with no valid time/source', () => {
    for (const percent of [NaN, Infinity, -1, 101, '50'])
      expect(
        normalizeJobProgress({ phase: 'running', observedAt, source: 'provider', percent })
          ?.percent,
      ).toBeNull();
    for (const queuePosition of [-1, 1.5, NaN, '2', Number.MAX_SAFE_INTEGER + 1])
      expect(
        normalizeJobProgress({ phase: 'running', observedAt, source: 'provider', queuePosition })
          ?.queuePosition,
      ).toBeNull();
    expect(
      normalizeJobProgress({ phase: 'running', observedAt: 'never', source: 'provider' }),
    ).toBeNull();
    expect(
      normalizeJobProgress({
        phase: 'running',
        observedAt: '2026-02-30T10:00:00Z',
        source: 'provider',
      }),
    ).toBeNull();
    expect(
      normalizeJobProgress({
        phase: 'running',
        observedAt: '2026-11-04T10:00:00',
        source: 'provider',
      }),
    ).toBeNull();
    expect(normalizeJobProgress({ phase: 'running', observedAt, source: 'guessed' })).toBeNull();
  });
});

describe('timing evidence', () => {
  it('preserves provider-reported measurements separately from gateway spans', () => {
    expect(
      normalizeJobTimings({
        execution: { durationMs: 1250, source: 'provider', observedAt, private: 'fixture' },
      }),
    ).toEqual({
      queue: null,
      execution: { durationMs: 1250, source: 'provider', observedAt },
      delivery: null,
      endToEnd: null,
      firstPreview: null,
    });
  });

  it('computes only measured spans and does not infer first preview from completion', () => {
    const result = gatewayJobTimings({
      createdAt: '2026-11-04T10:00:00Z',
      dispatchStartedAt: '2026-11-04T10:00:02Z',
      acceptedAt: '2026-11-04T10:00:03Z',
      providerCompletedAt: '2026-11-04T10:00:10Z',
      usableAt: '2026-11-04T10:00:12Z',
    });
    expect(result.queue?.durationMs).toBe(2000);
    expect(result.execution?.durationMs).toBe(7000);
    expect(result.delivery?.durationMs).toBe(2000);
    expect(result.endToEnd?.durationMs).toBe(12000);
    expect(result.execution?.source).toBe('gateway');
    expect(result.firstPreview).toBeNull();
    expect(JSON.stringify(result)).not.toContain('TTFT');
  });

  it('keeps missing, invalid and reversed timestamps unknown', () => {
    expect(normalizeJobTimings(null)).toBeNull();
    expect(gatewayJobTimings({})).toEqual({
      queue: null,
      execution: null,
      delivery: null,
      endToEnd: null,
      firstPreview: null,
    });
    expect(
      gatewayJobTimings({ createdAt: observedAt, dispatchStartedAt: '2026-11-04T09:00:00Z' }).queue,
    ).toBeNull();
    for (const durationMs of [-1, NaN, Infinity, 1.1, '1', Number.MAX_SAFE_INTEGER + 1])
      expect(
        normalizeJobTimings({ execution: { durationMs, source: 'provider', observedAt } })
          ?.execution,
      ).toBeNull();
  });

  it('records first preview only from explicit preview evidence', () => {
    expect(
      gatewayJobTimings({
        createdAt: '2026-11-04T10:00:00Z',
        firstPreviewAt: '2026-11-04T10:00:04Z',
      }).firstPreview,
    ).toEqual({ durationMs: 4000, source: 'gateway', observedAt: '2026-11-04T10:00:04.000Z' });
  });
});
