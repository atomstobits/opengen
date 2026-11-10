import { describe, expect, it } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import {
  clearRecovery,
  findSubmission,
  prepareSubmission,
  readRecovery,
  recordSubmissionJob,
  recordSubmissionRejection,
  recoveryContext,
  recoveryKey,
  requestFingerprint,
  retireLegacyPlaygroundStorage,
  writeRecovery,
} from '../apps/web/app/playground-recovery';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const session = {
  authenticated: true,
  workspaceId: 'synthetic-team',
  recoveryScope: 'opaque-synthetic-member-scope',
  scopes: ['read', 'generate'],
};
const context = recoveryContext(session, 'alibaba/wan-3.0', 'text-to-video')!;
const request: GenerateInput = {
  modelId: context.modelId,
  operation: context.operation,
  input: { prompt: 'Synthetic private prompt.', resolution: '720p', duration: 5 },
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  billing: 'managed',
  maxCostMicros: 1_000_000,
};
const isRequest = (value: unknown): value is GenerateInput =>
  value !== null && typeof value === 'object' && 'modelId' in value && 'input' in value;

describe('private playground browser recovery', () => {
  it('requires an authorized identity projection instead of a workspace-only fallback', () => {
    expect(recoveryContext(null, request.modelId, request.operation)).toBeNull();
    for (const changed of [
      { authenticated: false },
      { workspaceId: undefined },
      { recoveryScope: undefined },
      { recoveryScope: ' ' },
      { scopes: undefined },
      { scopes: ['read', ''] },
    ])
      expect(
        recoveryContext({ ...session, ...changed }, request.modelId, request.operation),
      ).toBeNull();
    expect(recoveryContext(session, request.modelId, request.operation)).toEqual(context);
  });

  it('binds recovery to workspace, identity, effective permissions, model and operation', () => {
    const storage = new MemoryStorage();
    expect(writeRecovery(storage, context, 'draft', request)).toBe(true);
    const otherContexts = [
      { ...context, workspaceId: 'another-team' },
      { ...context, recoveryScope: 'another-member' },
      { ...context, scopes: ['generate'] },
      { ...context, modelId: 'minimax/h3-max' },
      { ...context, operation: 'image-to-video' as const },
    ];
    for (const other of otherContexts)
      expect(readRecovery(storage, other, 'draft', isRequest)).toBeNull();
    expect(readRecovery(storage, context, 'draft', isRequest)).toEqual(request);
    expect(recoveryKey({ ...context, scopes: ['generate', 'read', 'read'] }, 'draft')).toBe(
      recoveryKey(context, 'draft'),
    );
    expect(recoveryKey({ ...context, workspaceId: 'a:b' }, 'draft')).not.toBe(
      recoveryKey({ ...context, workspaceId: 'a', recoveryScope: 'b:scope' }, 'draft'),
    );
  });

  it('rejects copied, unknown-version, corrupted and invalid envelopes without touching valid drafts', () => {
    const storage = new MemoryStorage();
    writeRecovery(storage, context, 'draft', request);
    const key = recoveryKey(context, 'draft');
    const good = storage.getItem(key)!;
    const other = { ...context, recoveryScope: 'another-member' };
    storage.setItem(recoveryKey(other, 'draft'), good);
    expect(readRecovery(storage, other, 'draft', isRequest)).toBeNull();
    expect(storage.getItem(recoveryKey(other, 'draft'))).toBeNull();
    expect(readRecovery(storage, context, 'draft', isRequest)).toEqual(request);
    for (const raw of [
      '{',
      JSON.stringify({ ...JSON.parse(good), version: 99 }),
      JSON.stringify({ ...JSON.parse(good), value: null }),
    ]) {
      storage.setItem(key, raw);
      expect(readRecovery(storage, context, 'draft', isRequest)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it('retires unattributed legacy state while retaining scoped recovery and unrelated application storage', () => {
    const storage = new MemoryStorage();
    for (const prefix of ['opengen:draft:', 'media-router:job:', 'media-router:submission:'])
      storage.setItem(`${prefix}alibaba/wan-3.0`, 'legacy-private-content');
    storage.setItem('opengen.billing.v1:synthetic-team', 'unrelated');
    writeRecovery(storage, context, 'draft', request);
    const first = prepareSubmission(storage, context, request, () => 'stable-id');
    expect(retireLegacyPlaygroundStorage(storage)).toBe(3);
    expect(retireLegacyPlaygroundStorage(storage)).toBe(0);
    expect(readRecovery(storage, context, 'draft', isRequest)).toEqual(request);
    expect(prepareSubmission(storage, context, request, () => 'must-not-change')).toEqual(first);
    expect(storage.getItem('opengen.billing.v1:synthetic-team')).toBe('unrelated');
  });

  it('keeps the same idempotency after reload, reordered JSON, and edit-away/edit-back', () => {
    const storage = new MemoryStorage();
    const first = prepareSubmission(storage, context, request, () => 'first-key');
    expect(
      prepareSubmission(
        storage,
        context,
        { ...request, input: { duration: 5, resolution: '720p', prompt: request.input.prompt } },
        () => 'unexpected',
      ),
    ).toEqual(first);
    const changed = {
      ...request,
      input: { ...request.input, prompt: 'Changed synthetic prompt.' },
    };
    expect(prepareSubmission(storage, context, changed, () => 'second-key').key).toBe('second-key');
    expect(prepareSubmission(storage, context, request, () => 'unexpected')).toEqual(first);
    expect(recordSubmissionJob(storage, context, first, 'job-a')).toBe(true);
    expect(prepareSubmission(storage, context, request, () => 'unexpected')).toEqual({
      ...first,
      jobId: 'job-a',
    });
  });

  it('binds payer, cap, route and settings to idempotency and rejects conflicting late job receipts', () => {
    const storage = new MemoryStorage();
    const first = prepareSubmission(storage, context, request, () => 'original');
    let serial = 0;
    for (const changed of [
      { ...request, billing: 'byok' as const },
      { ...request, maxCostMicros: 2_000_000 },
      { ...request, routeId: 'alibaba/eu-central-1/wan-3.0' },
      { ...request, input: { ...request.input, duration: 6 } },
    ])
      expect(
        prepareSubmission(storage, context, changed, () => `changed-${serial++}`).key,
      ).not.toBe(first.key);
    expect(recordSubmissionJob(storage, context, first, 'job-a')).toBe(true);
    expect(recordSubmissionJob(storage, context, first, 'job-b')).toBe(false);
    expect(
      recordSubmissionJob(storage, context, { ...first, fingerprint: 'changed' }, 'job-b'),
    ).toBe(false);
    expect(
      recordSubmissionJob(storage, { ...context, workspaceId: 'foreign' }, first, 'job-b'),
    ).toBe(false);
    expect(() =>
      prepareSubmission(storage, context, { ...request, modelId: 'foreign-model' }),
    ).toThrow('selected model');
    expect(() =>
      prepareSubmission(storage, context, { ...request, maxCostMicros: 5 }, () => first.key),
    ).toThrow('changed settings');
  });

  it('opens a new key only after explicitly choosing the latest accepted attempt', () => {
    const storage = new MemoryStorage();
    const original = prepareSubmission(storage, context, request, () => 'original');
    expect(() =>
      prepareSubmission(storage, context, request, () => 'replacement', 'unknown'),
    ).toThrow('latest submission');
    expect(recordSubmissionJob(storage, context, original, 'original-job')).toBe(true);
    const replacement = prepareSubmission(
      storage,
      context,
      request,
      () => 'replacement',
      'original-job',
    );
    expect(replacement.key).toBe('replacement');
    expect(findSubmission(storage, context, original.fingerprint)).toEqual(replacement);
    expect(prepareSubmission(storage, context, request, () => 'unexpected')).toEqual(replacement);
    expect(() =>
      prepareSubmission(storage, context, request, () => 'third', 'original-job'),
    ).toThrow('latest submission');
  });

  it('keeps the same key after a confirmed pre-admission rejection and resets it before re-sending', () => {
    const storage = new MemoryStorage();
    const receipt = prepareSubmission(storage, context, request, () => 'saved-key');
    expect(recordSubmissionRejection(storage, context, receipt)).toBe(true);
    expect(findSubmission(storage, context, receipt.fingerprint)).toEqual({
      ...receipt,
      rejected: true,
    });
    expect(prepareSubmission(storage, context, request, () => 'wrong-key')).toEqual(receipt);
    expect(findSubmission(storage, context, receipt.fingerprint)).toEqual(receipt);
    expect(recordSubmissionJob(storage, context, receipt, 'accepted-job')).toBe(true);
    expect(recordSubmissionRejection(storage, context, receipt)).toBe(false);
  });

  it('fails closed before submit if a durable key cannot be saved, while drafts remain optional', () => {
    const unavailable = {
      getItem() {
        throw new Error('Storage disabled.');
      },
      setItem() {
        throw new Error('Storage disabled.');
      },
      removeItem() {
        throw new Error('Storage disabled.');
      },
    };
    expect(readRecovery(unavailable, context, 'draft', isRequest)).toBeNull();
    expect(writeRecovery(unavailable, context, 'draft', request)).toBe(false);
    expect(() => prepareSubmission(unavailable, context, request)).toThrow(
      'has not been submitted',
    );
    const lostWrite = { getItem: () => null, setItem() {}, removeItem() {} };
    expect(() => prepareSubmission(lostWrite, context, request)).toThrow('has not been submitted');
  });

  it('does not silently replace a corrupt receipt after upstream acceptance may be unknown', () => {
    const storage = new MemoryStorage();
    storage.setItem(recoveryKey(context, 'submission'), '{');
    let generated = false;
    expect(() =>
      prepareSubmission(storage, context, request, () => {
        generated = true;
        return 'replacement-key';
      }),
    ).toThrow('Review existing workspace jobs');
    expect(generated).toBe(false);
    expect(() => prepareSubmission(storage, context, request)).toThrow(
      'Review existing workspace jobs',
    );
  });

  it('clears only the explicitly selected recovery record', () => {
    const storage = new MemoryStorage();
    writeRecovery(storage, context, 'draft', request);
    const first = prepareSubmission(storage, context, request, () => 'first-key');
    clearRecovery(storage, context, 'draft');
    expect(readRecovery(storage, context, 'draft', isRequest)).toBeNull();
    expect(prepareSubmission(storage, context, request)).toEqual(first);
  });

  it('keeps comparison approval intent separate from editable drafts and other authorities', () => {
    const storage = new MemoryStorage();
    const comparison = recoveryContext(session, 'comparison', 'text-to-image')!;
    const id = 'e1bf67ee-603e-423f-8b37-e5dbb70df276';
    const isId = (value: unknown): value is string => value === id;
    expect(writeRecovery(storage, comparison, 'comparison-approval', id)).toBe(true);
    clearRecovery(storage, comparison, 'draft');
    expect(readRecovery(storage, comparison, 'comparison-approval', isId)).toBe(id);
    for (const other of [
      { ...comparison, workspaceId: 'another-workspace' },
      { ...comparison, recoveryScope: 'another-authority' },
      { ...comparison, scopes: ['read'] },
    ])
      expect(readRecovery(storage, other, 'comparison-approval', isId)).toBeNull();
    const lostWrite = { getItem: () => null, setItem() {}, removeItem() {} };
    expect(writeRecovery(lostWrite, comparison, 'comparison-approval', id)).toBe(false);
  });

  it('retains a damaged comparison approval record for reconciliation instead of silently clearing it', () => {
    const storage = new MemoryStorage();
    const comparison = recoveryContext(session, 'comparison', 'text-to-image')!;
    const key = recoveryKey(comparison, 'comparison-approval');
    storage.setItem(key, '{');
    expect(
      readRecovery(storage, comparison, 'comparison-approval', (_value): _value is string => false),
    ).toBeNull();
    expect(storage.getItem(key)).toBe('{');
  });

  it('fingerprints exact JSON semantics without non-finite or executable values', () => {
    expect(JSON.parse(requestFingerprint(request))).toEqual(request);
    expect(requestFingerprint({ ...request, routing: undefined })).toBe(
      requestFingerprint(request),
    );
    for (const value of [NaN, Infinity, new Date(), () => 'unexpected', 1n])
      expect(() =>
        requestFingerprint({ ...request, input: { prompt: value } } as GenerateInput),
      ).toThrow('JSON');
    const circular = { ...request } as GenerateInput & { self?: unknown };
    circular.self = circular;
    expect(() => requestFingerprint(circular)).toThrow('circular');
  });
});
