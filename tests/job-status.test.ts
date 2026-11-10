import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JobStatusStore,
  projectJobStatus,
  type JobStatusRow,
  type StatusDatabase,
  type StatusIdentity,
} from '../packages/engine/src/job-status.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'workspace-a';
const authorize = async (): Promise<StatusIdentity> => ({ workspaceId, scopes: ['read'] });
function row(change: Partial<JobStatusRow> = {}): JobStatusRow {
  return {
    id: jobId,
    status: 'running',
    delivery_status: null,
    route_id: 'provider/model-region-a',
    deployment_id: 'provider-region-a',
    created_at: '2026-11-04T10:00:00Z',
    updated_at: '2026-11-04T10:01:00Z',
    reserved_micros: '200000',
    settled_micros: null,
    ...change,
  };
}
function fixture(initial = row()) {
  let current = initial;
  const query = vi.fn<StatusDatabase['query']>(async (_sql, parameters) => ({
    rows: parameters[0] === workspaceId && parameters[1] === jobId ? [current] : [],
  }));
  return {
    query,
    database: { query },
    replace(next: JobStatusRow) {
      current = next;
    },
  };
}
async function startWaiting() {
  // Drain the initial authorization/read promises so the wait timer is installed.
  await vi.advanceTimersByTimeAsync(0);
}
afterEach(() => vi.useRealTimers());

describe('compact private job status', () => {
  it('redacts unexpected database and authorization exceptions at the status boundary', async () => {
    const privateError = new Error('Bearer fixture-private-token https://provider.invalid/private');
    const badDatabase = {
      query: async () => {
        throw privateError;
      },
    };
    const failed = new JobStatusStore(badDatabase);
    await expect(failed.get(authorize, jobId)).rejects.toMatchObject({
      code: 'status_unavailable',
      statusCode: 503,
      message: 'Job status is temporarily unavailable.',
    });
    await expect(
      failed.get(async () => {
        throw privateError;
      }, jobId),
    ).rejects.toMatchObject({
      code: 'status_unavailable',
      statusCode: 503,
      message: 'Job status is temporarily unavailable.',
    });
  });

  it('selects only status columns and projects no private generation or output data', async () => {
    const secretRow = {
      ...row(),
      input: { prompt: 'PRIVATE PROMPT' },
      outputs: [{ url: 'https://provider.invalid/private?token=secret' }],
      upstream_id: 'private-upstream-id',
      connection_id: 'private-connection',
      receipts: { secret: true },
      error: 'RAW PROVIDER ERROR SECRET',
    };
    const f = fixture(secretRow);
    const result = await new JobStatusStore(f.database).get(authorize, jobId);
    expect(result).toMatchObject({
      id: jobId,
      status: 'running',
      deliveryStatus: 'unverified',
      reservedMicros: 200000,
      settledMicros: null,
      progress: null,
      structuredError: null,
      timings: null,
    });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(result);
    for (const secret of ['PRIVATE', 'secret', 'private-upstream', 'private-connection'])
      expect(serialized).not.toContain(secret);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('workspace_id=$1 AND id=$2'), [
      workspaceId,
      jobId,
    ]);
    const sql = f.query.mock.calls[0]![0];
    expect(sql).not.toMatch(/SELECT\s+\*|\binput\b|\boutputs\b|\bupstream_id\b|\bconnection_id\b/i);
    expect(sql).toMatch(/^SELECT/);
  });

  it('uses the same absent response for foreign and missing IDs without reading another workspace', async () => {
    const f = fixture();
    const store = new JobStatusStore(f.database);
    await expect(
      store.get(async () => ({ workspaceId: 'foreign', scopes: ['read'] }), jobId),
    ).rejects.toMatchObject({ code: 'job_not_found', statusCode: 404 });
    await expect(
      store.get(authorize, '22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ code: 'job_not_found', statusCode: 404 });
    expect(f.query.mock.calls.map((call) => call[1])).toEqual([
      ['foreign', jobId],
      [workspaceId, '22222222-2222-4222-8222-222222222222'],
    ]);
  });

  it('requires current read authority before querying', async () => {
    const f = fixture();
    const store = new JobStatusStore(f.database);
    await expect(store.get(async () => null, jobId)).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      store.get(async () => ({ workspaceId, scopes: ['generate'] }), jobId),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects malformed job IDs before reaching PostgreSQL', async () => {
    const f = fixture();
    const store = new JobStatusStore(f.database);
    await expect(store.get(authorize, 'invalid')).rejects.toMatchObject({
      code: 'invalid_status_id',
      statusCode: 400,
    });
    await expect(
      store.wait(authorize, '11111111-1111-4111-8111-111111111111 trailing'),
    ).rejects.toMatchObject({ code: 'invalid_status_id', statusCode: 400 });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects revocation during the database read before returning a snapshot', async () => {
    let active = true;
    const query = vi.fn(async () => {
      active = false;
      return { rows: [row()] };
    });
    await expect(
      new JobStatusStore({ query }).get(async () => (active ? authorize() : null), jobId),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('fingerprints generation, delivery and late settlement even if updated_at was unchanged', () => {
    const baseline = projectJobStatus(row({ status: 'succeeded', delivery_status: 'pending' }));
    expect(
      projectJobStatus(row({ status: 'succeeded', delivery_status: 'pending' })).revision,
    ).toBe(baseline.revision);
    expect(
      projectJobStatus(row({ status: 'failed', delivery_status: 'pending' })).revision,
    ).not.toBe(baseline.revision);
    expect(
      projectJobStatus(row({ status: 'succeeded', delivery_status: 'available' })).revision,
    ).not.toBe(baseline.revision);
    expect(
      projectJobStatus(
        row({ status: 'succeeded', delivery_status: 'pending', settled_micros: '150000' }),
      ).revision,
    ).not.toBe(baseline.revision);
  });

  it('preserves unknown progress instead of synthesizing percent or first-token time', () => {
    expect(projectJobStatus(row({ status: 'succeeded' })).progress).toBeNull();
    expect(projectJobStatus(row()).timings).toBeNull();
    const observed = projectJobStatus(
      row({
        execution_progress: {
          phase: 'running',
          percent: null,
          observedAt: '2026-11-04T10:01:00Z',
          source: 'provider',
          providerPhase: 'processing',
          queuePosition: null,
        },
      }),
    );
    expect(observed.progress).toMatchObject({ percent: null, providerPhase: 'processing' });
    expect(JSON.stringify(observed)).not.toMatch(/ttft|firstToken/);
  });

  it('rejects unsafe money rather than fabricating zero or losing integer precision', () => {
    expect(() => projectJobStatus(row({ reserved_micros: '9007199254740992' }))).toThrow(
      'Job status is temporarily unavailable.',
    );
    expect(() => projectJobStatus(row({ settled_micros: '-1' }))).toThrow(
      'Job status is temporarily unavailable.',
    );
  });
});

describe('bounded same-job status waiting', () => {
  function clock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  }
  it('returns immediately without a revision or when the projection already changed', async () => {
    const f = fixture();
    const store = new JobStatusStore(f.database);
    expect(await store.wait(authorize, jobId, { waitMs: 25000 })).toMatchObject({
      changed: true,
      timedOut: false,
    });
    expect(
      await store.wait(authorize, jobId, { waitMs: 25000, afterRevision: 'a'.repeat(64) }),
    ).toMatchObject({ changed: true, timedOut: false });
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it('wakes on delivery changes after upstream completion without signing or fetching output', async () => {
    clock();
    const f = fixture(row({ status: 'succeeded', delivery_status: 'pending' }));
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50 });
    const before = await store.get(authorize, jobId);
    const promise = store.wait(authorize, jobId, { waitMs: 200, afterRevision: before.revision });
    await startWaiting();
    f.replace(row({ status: 'succeeded', delivery_status: 'available' }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toMatchObject({
      changed: true,
      timedOut: false,
      job: { status: 'succeeded', deliveryStatus: 'available' },
    });
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(true);
  });

  it('wakes on late settlement with the same generation and delivery state', async () => {
    clock();
    const f = fixture(row({ status: 'succeeded', delivery_status: 'available' }));
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50 });
    const before = await store.get(authorize, jobId);
    const promise = store.wait(authorize, jobId, { waitMs: 200, afterRevision: before.revision });
    await startWaiting();
    f.replace(row({ status: 'succeeded', delivery_status: 'available', settled_micros: '150000' }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toMatchObject({ changed: true, job: { settledMicros: 150000 } });
  });

  it('client timeout ends only waiting and does not mutate the job, money or lease', async () => {
    clock();
    const original = row({ status: 'submission-unknown' });
    const f = fixture(original);
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50 });
    const before = await store.get(authorize, jobId);
    const promise = store.wait(authorize, jobId, { waitMs: 120, afterRevision: before.revision });
    await startWaiting();
    await vi.advanceTimersByTimeAsync(120);
    expect(await promise).toEqual({ job: before, changed: false, timedOut: true });
    expect(original).toEqual(row({ status: 'submission-unknown' }));
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnect cancels only waiting and frees the waiter without another query', async () => {
    clock();
    const f = fixture();
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50, maxWaiters: 1 });
    const before = await store.get(authorize, jobId);
    const controller = new AbortController();
    const promise = store.wait(authorize, jobId, {
      waitMs: 200,
      afterRevision: before.revision,
      signal: controller.signal,
    });
    const rejected = expect(promise).rejects.toMatchObject({ code: 'status_wait_aborted' });
    await startWaiting();
    const callsBeforeAbort = f.query.mock.calls.length;
    controller.abort('Private request content must not be surfaced.');
    await rejected;
    await vi.advanceTimersByTimeAsync(200);
    expect(f.query).toHaveBeenCalledTimes(callsBeforeAbort);
    expect(vi.getTimerCount()).toBe(0);
    expect(await store.wait(authorize, jobId, { afterRevision: before.revision })).toMatchObject({
      changed: false,
      timedOut: false,
    });
  });

  it('disconnect ends an in-flight status read without returning late data or starting follow-up work', async () => {
    clock();
    let resolveQuery!: (result: { rows: JobStatusRow[] }) => void;
    const query = vi.fn<StatusDatabase['query']>(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const auth = vi.fn(authorize);
    const controller = new AbortController();
    const store = new JobStatusStore({ query });
    const promise = store.wait(auth, jobId, { waitMs: 200, signal: controller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ code: 'status_wait_aborted' });
    await startWaiting();
    controller.abort();
    await rejected;
    resolveQuery({ rows: [row()] });
    await startWaiting();
    expect(query).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled reads and ignores late results without changing a job or its money', async () => {
    clock();
    let resolveQuery!: (result: { rows: JobStatusRow[] }) => void;
    const query = vi.fn<StatusDatabase['query']>(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const auth = vi.fn(authorize);
    const original = row({ status: 'submission-unknown' });
    const store = new JobStatusStore({ query }, { readTimeoutMs: 100 });
    const promise = store.wait(auth, jobId, { waitMs: 200 });
    const rejected = expect(promise).rejects.toMatchObject({
      code: 'status_read_timeout',
      statusCode: 503,
    });
    await startWaiting();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    resolveQuery({ rows: [original] });
    await startWaiting();
    expect(query).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(original).toEqual(row({ status: 'submission-unknown' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revalidates revocation while waiting before another database read', async () => {
    clock();
    let active = true;
    const auth = async () => (active ? authorize() : null);
    const f = fixture();
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50 });
    const before = await store.get(auth, jobId);
    const promise = store.wait(auth, jobId, { waitMs: 200, afterRevision: before.revision });
    const rejected = expect(promise).rejects.toMatchObject({ statusCode: 401 });
    await startWaiting();
    const initialQueries = f.query.mock.calls.length;
    active = false;
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(f.query).toHaveBeenCalledTimes(initialQueries);
  });

  it('pins the original workspace even when a browser session switches while waiting', async () => {
    clock();
    let selectedWorkspace = workspaceId;
    const auth = async () => ({ workspaceId: selectedWorkspace, scopes: ['read'] });
    const f = fixture();
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50 });
    const before = await store.get(auth, jobId);
    const promise = store.wait(auth, jobId, { waitMs: 200, afterRevision: before.revision });
    const rejected = expect(promise).rejects.toMatchObject({ statusCode: 403 });
    await startWaiting();
    selectedWorkspace = 'other-workspace';
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(f.query.mock.calls.every(([, parameters]) => parameters[0] === workspaceId)).toBe(true);
  });

  it('bounds waits and applies read-only backpressure without blocking immediate recovery reads', async () => {
    clock();
    const f = fixture();
    const store = new JobStatusStore(f.database, { pollIntervalMs: 50, maxWaiters: 1 });
    const before = await store.get(authorize, jobId);
    const promise = store.wait(authorize, jobId, { waitMs: 100, afterRevision: before.revision });
    await startWaiting();
    await expect(
      store.wait(authorize, jobId, { waitMs: 100, afterRevision: before.revision }),
    ).rejects.toMatchObject({ code: 'status_backpressure', statusCode: 429 });
    expect(await store.get(authorize, jobId)).toEqual(before);
    await expect(store.wait(authorize, jobId, { waitMs: 25001 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(store.wait(authorize, jobId, { afterRevision: 'invalid' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(true);
  });
});
