import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  DeliveryStore,
  type DeliveryDatabase,
  type DeliveryScope,
  type DeliverySource,
  type DeliveryStorage,
} from '../packages/engine/src/delivery.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const source: DeliverySource = {
  kind: 'url',
  url: 'https://provider.example/private-token',
  mediaType: 'image/png',
};
let pg: PGlite;
let db: DeliveryDatabase;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    await readFile(new URL('../packages/engine/migrations/001.sql', import.meta.url), 'utf8'),
  );
  await pg.exec(
    await readFile(
      new URL('../packages/engine/schema-drafts/output-receipts.sql', import.meta.url),
      'utf8',
    ),
  );
  const query = (text: string, values?: unknown[]) => pg.query(text, values);
  db = {
    query,
    transaction: (operation: (client: unknown) => unknown) =>
      pg.transaction((transaction) => operation(transaction)),
  } as unknown as DeliveryDatabase;
}, 60_000);
beforeEach(async () => {
  await pg.exec('DELETE FROM mr_output_receipts');
});
afterAll(async () => {
  await pg.close();
});
async function fixture(options: ConstructorParameters<typeof DeliveryStore>[1] = {}) {
  const workspaceId = `fixture-${randomUUID()}`,
    jobId = randomUUID();
  const scope: DeliveryScope = {
    workspaceId,
    jobId,
    attempt: 1,
    routeId: 'fixture/route',
    deploymentId: 'fixture/deployment',
    upstreamId: 'same-upstream',
  };
  await pg.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,1000)', [workspaceId]);
  await pg.query(
    `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros,attempt_count,upstream_id) VALUES($1,$2,'stable','hash','{}',$3,$4,'succeeded',100,1,$5)`,
    [
      jobId,
      workspaceId,
      JSON.stringify({ id: scope.routeId }),
      JSON.stringify({ id: scope.deploymentId }),
      scope.upstreamId,
    ],
  );
  const objects = new Map<string, Buffer>();
  const storage: DeliveryStorage = {
    read: vi.fn(async (key) => objects.get(key) ?? null),
    putIfAbsent: vi.fn(async (key, bytes) => {
      if (!objects.has(key)) objects.set(key, bytes);
    }),
  };
  let time = new Date('2026-11-04T10:00:00Z');
  const download = vi.fn(async () => png);
  const store = new DeliveryStore(db, {
    storage,
    download,
    now: () => time,
    leaseMs: 1000,
    ...options,
  });
  return {
    scope,
    store,
    storage,
    objects,
    download,
    advance: () => {
      time = new Date(time.getTime() + 3_600_001);
    },
  };
}
it('persists private descriptors first, preserves bytes, and recovery never changes jobs, attempts or money', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source]);
  const [pending] = await f.store.receipts(f.scope.workspaceId, f.scope.jobId);
  expect(pending).toMatchObject({ state: 'pending', source_url: source.url, slot: 0, attempts: 0 });
  expect(f.download).not.toHaveBeenCalled();
  expect(f.objects.size).toBe(0);
  const before = await pg.query('SELECT * FROM mr_jobs WHERE id=$1', [f.scope.jobId]);
  await f.store.recoverOne();
  const [ready] = await f.store.receipts(f.scope.workspaceId, f.scope.jobId);
  expect(ready).toMatchObject({
    state: 'available',
    source_url: null,
    byte_length: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  });
  expect(ready!.evidence).toMatchObject({
    inspection: { contentSafety: { status: 'not_checked' } },
    c2pa: { status: 'unavailable' },
  });
  expect(f.objects.get(ready!.object_key)).toEqual(png);
  expect(await f.store.result(f.scope)).toMatchObject({
    deliveryStatus: 'available',
    outputs: [{ storageKey: ready!.object_key, url: '', sha256: ready!.sha256 }],
  });
  expect(await f.store.recoverOne()).toBe(false);
  expect(await pg.query('SELECT * FROM mr_jobs WHERE id=$1', [f.scope.jobId])).toEqual(before);
  expect((await pg.query('SELECT * FROM mr_ledger')).rows).toHaveLength(0);
  expect((await pg.query('SELECT * FROM mr_attempts')).rows).toHaveLength(0);
});
it('isolates tenants and frozen attempts; changed scope cannot checkpoint or recover current outputs', async () => {
  const f = await fixture();
  await expect(f.store.capture({ ...f.scope, workspaceId: 'foreign' }, [source])).rejects.toThrow(
    'delivery_attempt_mismatch',
  );
  await expect(
    f.store.capture({ ...f.scope, upstreamId: 'another-job' }, [source]),
  ).rejects.toThrow('delivery_attempt_mismatch');
  await f.store.capture(f.scope, [source]);
  expect(await f.store.receipts('foreign', f.scope.jobId)).toEqual([]);
  await pg.query('UPDATE mr_jobs SET attempt_count=2 WHERE id=$1', [f.scope.jobId]);
  expect(await f.store.recoverOne()).toBe(false);
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'failed',
    error_code: 'attempt_changed',
    source_url: null,
  });
  expect(f.download).not.toHaveBeenCalled();
});
it('makes duplicate callbacks replay-safe and rejects changed slot bodies', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source]);
  await f.store.capture(f.scope, [source]);
  await expect(f.store.capture(f.scope, [source, source])).rejects.toThrow(
    'delivery_receipt_conflict',
  );
  await expect(
    f.store.capture(f.scope, [{ ...source, url: 'https://provider.example/different' }]),
  ).rejects.toThrow('delivery_receipt_conflict');
  expect(await f.store.receipts(f.scope.workspaceId, f.scope.jobId)).toHaveLength(1);
  await f.store.recoverOne();
  await f.store.capture(f.scope, [source]);
  expect(await f.store.recoverOne()).toBe(false);
  expect(f.download).toHaveBeenCalledOnce();
});
it('retries missing slots after partial storage failure with stable object keys', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source, source]);
  await f.store.recoverOne();
  const realPut = f.storage.putIfAbsent;
  f.storage.putIfAbsent = vi.fn(async () => {
    throw new Error('https://private.example/secret');
  });
  await f.store.recoverOne();
  let receipts = await f.store.receipts(f.scope.workspaceId, f.scope.jobId);
  expect(receipts.map((r) => r.state).sort()).toEqual(['available', 'pending']);
  expect(receipts.find((r) => r.state === 'pending')!.error_code).toBe('output_delivery_failed');
  expect(JSON.stringify(receipts)).not.toContain('https://private.example/secret');
  const keys = receipts.map((r) => r.object_key);
  f.storage.putIfAbsent = realPut;
  f.advance();
  await f.store.recoverOne();
  receipts = await f.store.receipts(f.scope.workspaceId, f.scope.jobId);
  expect(receipts.map((r) => r.state)).toEqual(['available', 'available']);
  expect(receipts.map((r) => r.object_key)).toEqual(keys);
  expect(f.objects.size).toBe(2);
});
it('persists original slots when a later receipt is delivered before the first', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source, source]);
  await pg.query('UPDATE mr_output_receipts SET next_attempt_at=$2 WHERE job_id=$1 AND slot=0', [
    f.scope.jobId,
    new Date('2026-11-04T10:30:00Z'),
  ]);
  await f.store.recoverOne();
  const partial = await f.store.result(f.scope);
  expect(partial.deliveryStatus).toBe('partial');
  expect(partial.outputs).toHaveLength(1);
  expect(partial.outputs[0]!.outputIndex).toBe(1);
  expect(partial.outputEvidence).toMatchObject([
    { index: 0, state: 'pending', outputIndex: null },
    { index: 1, state: 'available', outputIndex: 0 },
  ]);
  f.advance();
  await f.store.recoverOne();
  const complete = await f.store.result(f.scope);
  expect(complete.deliveryStatus).toBe('available');
  expect(complete.outputs.map((output) => output.outputIndex)).toEqual([0, 1]);
  expect(complete.outputs[1]).toEqual(partial.outputs[0]);
});
it('recovers a crash after PUT and before database commit from retained bytes without another fetch', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source]);
  const brokenDb = {
    ...db,
    query: vi.fn(async (text, params) => {
      if (text.includes('UPDATE mr_output_receipts')) throw new Error('simulated database loss');
      return db.query(text, params);
    }),
  } as DeliveryDatabase;
  const crashed = new DeliveryStore(brokenDb, { ...f.store.options, now: f.store.options.now });
  await expect(crashed.recoverOne()).rejects.toThrow('simulated database loss');
  expect(f.objects.size).toBe(1);
  f.advance();
  await f.store.recoverOne();
  expect(f.download).toHaveBeenCalledOnce();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]!.state).toBe('available');
});
it('leases before IO; a second worker cannot retrieve the same live lease', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = Promise.withResolvers<void>();
  const f = await fixture({
    download: async () => {
      entered.resolve();
      await blocked;
      return png;
    },
  });
  await f.store.capture(f.scope, [source]);
  const first = f.store.recoverOne();
  await entered.promise;
  expect(await f.store.recoverOne()).toBe(false);
  release();
  await first;
  expect(f.objects.size).toBe(1);
});
it('honestly expires nonrefetchable sources without touching the provider', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [{ ...source, expiresAt: '2026-11-03T00:00:00Z' }]);
  await f.store.recoverOne();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'expired',
    error_code: 'source_expired',
    source_url: null,
  });
  expect(f.download).not.toHaveBeenCalled();
});
it('refreshes expired capabilities using the same upstream identity and slot', async () => {
  const refresh = vi.fn(async () => ({ ...source, url: 'https://provider.example/fresh' }));
  const f = await fixture({ refresh });
  await f.store.capture(f.scope, [
    { ...source, refreshable: true, expiresAt: '2026-11-03T00:00:00Z' },
  ]);
  await f.store.recoverOne();
  expect(refresh).toHaveBeenCalledWith(f.scope, 0);
  expect(f.download).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'https://provider.example/fresh' }),
    f.scope,
  );
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]!.state).toBe('available');
});
it('checkpoints inline bytes even during storage outage; restart uses staging without paid regeneration', async () => {
  const f = await fixture({ storage: undefined, maxAttempts: 2 });
  await f.store.capture(f.scope, [{ kind: 'inline', bytes: png, mediaType: 'image/png' }]);
  await f.store.recoverOne();
  const [staged] = await f.store.receipts(f.scope.workspaceId, f.scope.jobId);
  expect(Buffer.from(staged!.inline_bytes!)).toEqual(png);
  const restarted = new DeliveryStore(db, {
    storage: f.storage,
    now: () => new Date('2026-11-05T00:00:00Z'),
  });
  await restarted.recoverOne();
  expect((await restarted.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'available',
    inline_bytes: null,
  });
  expect(f.download).not.toHaveBeenCalled();
});
it('bounds retries and drops source capabilities at terminal failure', async () => {
  const f = await fixture({
    download: async () => {
      throw new Error('secret');
    },
    maxAttempts: 2,
  });
  await f.store.capture(f.scope, [source]);
  await f.store.recoverOne();
  f.advance();
  await f.store.recoverOne();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'failed',
    attempts: 2,
    source_url: null,
    error_code: 'output_delivery_failed',
  });
  expect(await f.store.recoverOne()).toBe(false);
});
it('rejects malformed, foreign and unsupported descriptors without any fetch', async () => {
  const f = await fixture();
  for (const value of [
    { ...source, url: 'http://provider.example/plain' },
    { ...source, url: 'https://user:password@provider.example/private' },
    { ...source, expiresAt: 'garbage' },
    {
      kind: 'owned',
      storageKey: `outputs/${randomUUID()}/${randomUUID()}.png`,
      mediaType: 'image/png',
    },
    { kind: 'inline', bytes: Buffer.from('not a png'), mediaType: 'image/png' },
  ] as DeliverySource[])
    await expect(f.store.capture(f.scope, [value])).rejects.toThrow();
  expect(await f.store.receipts(f.scope.workspaceId, f.scope.jobId)).toEqual([]);
  expect(f.download).not.toHaveBeenCalled();
});
it('refreshes same-task capabilities with unknown expiry before retry, including frozen connection identity', async () => {
  const refresh = vi.fn(async () => ({ ...source, url: 'https://provider.example/rotated' }));
  const f = await fixture({ refresh });
  const scope = { ...f.scope, providerConnectionId: 'connection-original' };
  await f.store.capture(scope, [{ ...source, refreshable: true }]);
  await expect(
    f.store.capture({ ...scope, providerConnectionId: 'connection-new' }, [
      { ...source, refreshable: true },
    ]),
  ).rejects.toThrow('delivery_receipt_conflict');
  await f.store.recoverOne();
  expect(refresh).toHaveBeenCalledWith(scope, 0);
  expect(f.download).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'https://provider.example/rotated' }),
    scope,
  );
});
it('a superseded live worker cannot resurrect a failed receipt after its download throws', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({
    download: async () => {
      entered.resolve();
      await release.promise;
      throw new Error('old attempt failed');
    },
  });
  await f.store.capture(f.scope, [source]);
  const old = f.store.recoverOne();
  await entered.promise;
  await pg.query('UPDATE mr_jobs SET attempt_count=2 WHERE id=$1', [f.scope.jobId]);
  expect(await f.store.recoverOne()).toBe(false);
  release.resolve();
  await old;
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'failed',
    error_code: 'attempt_changed',
    lease_token: null,
  });
});
it('an expired lease accepts only the replacement worker result and immutable first retained bytes', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const changedPng = Buffer.concat([png, Buffer.from('different bytes')]);
  const f = await fixture({
    download: async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
        return changedPng;
      }
      return png;
    },
  });
  await f.store.capture(f.scope, [source]);
  const old = f.store.recoverOne();
  await entered.promise;
  f.advance();
  await f.store.recoverOne();
  release.resolve();
  await old;
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'available',
    attempts: 2,
    sha256: createHash('sha256').update(png).digest('hex'),
  });
  expect([...f.objects.values()]).toEqual([png]);
});
it('a crash after source download before PUT leaves the same slot pending and performs no job mutation', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source]);
  const realPut = f.storage.putIfAbsent;
  f.storage.putIfAbsent = async () => {
    throw new Error('crash before PUT');
  };
  await f.store.recoverOne();
  expect(f.objects.size).toBe(0);
  f.advance();
  f.storage.putIfAbsent = realPut;
  await f.store.recoverOne();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'available',
    attempts: 2,
  });
  expect(
    (
      await pg.query('SELECT status,reserved_micros,settled_micros FROM mr_jobs WHERE id=$1', [
        f.scope.jobId,
      ])
    ).rows[0],
  ).toMatchObject({ status: 'succeeded', reserved_micros: 100, settled_micros: null });
});

it('normalizes descriptor property order on replay and enforces workspace ownership in the schema', async () => {
  const f = await fixture();
  await f.store.capture(f.scope, [source]);
  await f.store.capture(f.scope, [
    { mediaType: source.mediaType, refreshable: false, url: source.url, kind: 'url' },
  ]);
  const foreign = await fixture();
  await expect(
    pg.query('UPDATE mr_output_receipts SET workspace_id=$1 WHERE job_id=$2', [
      foreign.scope.workspaceId,
      f.scope.jobId,
    ]),
  ).rejects.toThrow(/foreign key/i);
  await f.store.recoverOne();
});
it('finalizes retained bytes after a crash on the last allowed source attempt without another download', async () => {
  const f = await fixture({ maxAttempts: 1 });
  await f.store.capture(f.scope, [source]);
  const brokenDb = {
    ...db,
    query: vi.fn(async (text, params) => {
      if (text.includes('UPDATE mr_output_receipts')) throw new Error('last-attempt database loss');
      return db.query(text, params);
    }),
  } as DeliveryDatabase;
  const crashed = new DeliveryStore(brokenDb, f.store.options);
  await expect(crashed.recoverOne()).rejects.toThrow('last-attempt database loss');
  expect(f.objects.size).toBe(1);
  f.advance();
  await f.store.recoverOne();
  expect(f.download).toHaveBeenCalledOnce();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'available',
    attempts: 2,
  });
});
it('exhausted source retries do not fetch or regenerate when no retained bytes exist', async () => {
  const f = await fixture({ maxAttempts: 1 });
  await f.store.capture(f.scope, [source]);
  await pg.query('UPDATE mr_output_receipts SET attempts=1 WHERE job_id=$1', [f.scope.jobId]);
  await f.store.recoverOne();
  expect(f.download).not.toHaveBeenCalled();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'failed',
    error_code: 'delivery_retry_exhausted',
  });
});
it('keeps known decode failures private and terminal while preserving per-slot evidence', async () => {
  const { inspectOutput } = await import('../packages/engine/src/inspection.js');
  const f = await fixture({
    inspect: async (bytes, mediaType) => ({
      ...(await inspectOutput(bytes, mediaType)),
      decode: { status: 'failed', coverage: 'none', reason: 'decode_rejected' },
      conformance: { status: 'nonconformant', notices: [{ code: 'output_decode_failed' }] },
    }),
  });
  await f.store.capture(f.scope, [source]);
  await f.store.recoverOne();
  const [receipt] = await f.store.receipts(f.scope.workspaceId, f.scope.jobId);
  expect(receipt).toMatchObject({
    state: 'failed',
    error_code: 'output_decode_failed',
    evidence: { inspection: { decode: { status: 'failed' } } },
  });
  const result = await f.store.result(f.scope);
  expect(result.outputs).toEqual([]);
  expect(result.outputEvidence).toEqual([
    expect.objectContaining({
      index: 0,
      state: 'failed',
      outputIndex: null,
      code: 'output_decode_failed',
      inspection: expect.objectContaining({ decode: { status: 'failed', coverage: 'none' } }),
    }),
  ]);
  expect(JSON.stringify(result)).not.toContain(source.url);
  expect(f.objects.size).toBe(1); // retained for audit, never signed as usable output
  expect(await f.store.recoverOne()).toBe(false);
});
it('blocks known requested-output mismatch from usable delivery; missing tooling remains honest unknown', async () => {
  const { inspectOutput } = await import('../packages/engine/src/inspection.js');
  const f = await fixture({
    inspect: async (bytes, mediaType) => ({
      ...(await inspectOutput(bytes, mediaType)),
      decode: { status: 'passed', coverage: 'full' },
      conformance: {
        status: 'nonconformant',
        notices: [
          {
            code: 'requested_output_mismatch',
            field: 'requiresAudio',
            requested: true,
            delivered: false,
          },
        ],
      },
    }),
  });
  await f.store.capture(f.scope, [source]);
  await f.store.recoverOne();
  expect((await f.store.receipts(f.scope.workspaceId, f.scope.jobId))[0]).toMatchObject({
    state: 'failed',
    error_code: 'output_nonconformant',
  });
  expect((await f.store.result(f.scope)).outputs).toEqual([]);
});
