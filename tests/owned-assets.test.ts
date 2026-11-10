import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { GenerateInput } from '@media-router/contracts';
import type { AssetStore } from '../packages/engine/src/storage.js';
import { OwnedAssetService, inputPreparationHash } from '../packages/engine/src/owned-assets.js';

let db: PGlite;
let service: OwnedAssetService;
let pool: Pool;
const objects = new Map<string, { bytes: Buffer; mediaType: string }>();
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const facts = (key: string) => {
  const item = objects.get(key);
  if (!item) throw Object.assign(new Error('Not found'), { name: 'NoSuchKey' });
  return {
    ...item,
    storageKey: key,
    size: item.bytes.length,
    sha256: createHash('sha256').update(item.bytes).digest('hex'),
  };
};
const store = {
  prepareUpload: vi.fn(async (workspace: string, mediaType: string, size: number) => ({
    key: `inputs/${workspace}/${randomUUID()}.png`,
    uploadUrl: 'https://synthetic.example/upload',
    headers: {},
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  })),
  readInput: vi.fn(async (_workspace: string, key: string) => facts(key)),
  readInputIfExists: vi.fn(async (_workspace: string, key: string) =>
    objects.has(key) ? facts(key) : null,
  ),
  writeInput: vi.fn(async (_workspace: string, key: string, bytes: Buffer, mediaType: string) => {
    if (objects.has(key) && !facts(key).bytes.equals(bytes)) throw new Error('Immutable conflict');
    objects.set(key, { bytes: Buffer.from(bytes), mediaType });
    return facts(key);
  }),
  removeUpload: vi.fn(async (_workspace: string, key: string) => {
    objects.delete(key);
  }),
  sign: vi.fn(async (key: string, mediaType: string) => ({
    storageKey: key,
    mediaType,
    url: 'https://synthetic.example/short-lived',
  })),
  readOwnedOutput: vi.fn(async (job: string, key: string) => {
    if (!key.startsWith(`outputs/${job}/`)) throw new Error('Foreign output');
    return facts(key);
  }),
};
const download = vi.fn(async (_url: string) => ({
  bytes: png,
  mediaType: 'image/png',
  byteLength: png.length,
  sha256: createHash('sha256').update(png).digest('hex'),
}));
const input: GenerateInput = {
  modelId: 'fixture/image',
  operation: 'image-edit',
  input: {
    prompt: 'Synthetic fixture.',
    references: [
      { type: 'image', asset: { url: 'https://public.example/a.png' } },
      { type: 'image', asset: { url: 'https://public.example/a.png' } },
      { type: 'image', asset: { url: 'https://public.example/b.png' } },
    ],
  },
};
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/001.sql', import.meta.url), 'utf8'),
  );
  await db.exec(
    'ALTER TABLE mr_jobs ADD COLUMN delivery_status text, ADD COLUMN output_evidence jsonb',
  );
  await db.exec(
    await readFile(
      new URL('../packages/engine/src/owned-assets.schema.sql', import.meta.url),
      'utf8',
    ),
  );
  const query = async (text: string, values?: unknown[]) => {
    const result = await db.query(text, values);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}, 90_000);
beforeEach(async () => {
  vi.clearAllMocks();
  objects.clear();
  download.mockImplementation(async () => ({
    bytes: png,
    mediaType: 'image/png',
    byteLength: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  }));
  await db.exec('TRUNCATE mr_workspaces CASCADE');
  await db.query("INSERT INTO mr_workspaces(id,available_micros) VALUES('a',100000),('b',100000)");
  service = new OwnedAssetService(pool, store as unknown as AssetStore, { download });
});
afterAll(async () => {
  await db.close();
});
async function job(workspace = 'a', outputs: unknown[] = []) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros,outputs,delivery_status)
    VALUES($1,$2,$5,$4,'{}','{}','{}','succeeded',0,$3,'available')`,
    [id, workspace, JSON.stringify(outputs), inputPreparationHash(input), id],
  );
  return id;
}
async function uploaded() {
  const upload = await service.prepareUpload('a', 'image/png', png.length);
  const staging = (
    await db.query<{ upload_key: string }>(
      'SELECT upload_key FROM mr_owned_assets WHERE asset_key=$1',
      [upload.key],
    )
  ).rows[0]!.upload_key;
  objects.set(staging, { bytes: png, mediaType: 'image/png' });
  return { upload, staging };
}
it('freezes each distinct URL once and preserves roles, order, hashes across mutable replays', async () => {
  const prepared = await service.prepare({ workspaceId: 'a', idempotencyKey: 'stable', input });
  expect(download).toHaveBeenCalledTimes(2);
  expect(prepared.manifest.map((x) => x.path)).toEqual([
    'references[0].asset',
    'references[1].asset',
    'references[2].asset',
  ]);
  expect(prepared.manifest[0]!.assetKey).toBe(prepared.manifest[1]!.assetKey);
  expect(prepared.input.input.references?.every((x) => 'assetKey' in x.asset)).toBe(true);
  download.mockRejectedValue(new Error('URL changed'));
  expect(await service.prepare({ workspaceId: 'a', idempotencyKey: 'stable', input })).toEqual(
    prepared,
  );
  expect(download).toHaveBeenCalledTimes(2);
  await expect(
    service.prepare({
      workspaceId: 'a',
      idempotencyKey: 'stable',
      input: { ...input, input: { prompt: 'Changed' } },
    }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
it('claims concurrent preparation without holding a transaction while downloading', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  download.mockImplementation(async () => {
    entered();
    await gate;
    return {
      bytes: png,
      mediaType: 'image/png',
      byteLength: png.length,
      sha256: facts([...objects.keys()][0] ?? '').sha256,
    };
  });
  // The download can query the DB while waiting; there is no reservation/transaction yet.
  download.mockImplementationOnce(async () => {
    expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_jobs')).rows[0]).toEqual({
      count: 0,
    });
    entered();
    await gate;
    return {
      bytes: png,
      mediaType: 'image/png',
      byteLength: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    };
  });
  const one = { ...input, input: { firstFrame: { url: 'https://public.example/a.png' } } };
  const pending = service.prepare({ workspaceId: 'a', idempotencyKey: 'race', input: one });
  await observed;
  await expect(
    service.prepare({ workspaceId: 'a', idempotencyKey: 'race', input: one }),
  ).rejects.toMatchObject({ code: 'input_preparation_in_progress' });
  release();
  const prepared = await pending;
  expect(download).toHaveBeenCalledTimes(1);
  expect(await service.prepare({ workspaceId: 'a', idempotencyKey: 'race', input: one })).toEqual(
    prepared,
  );
});
it('failed imports never create jobs, reservations or a retry of a mutable source', async () => {
  download.mockRejectedValue(new Error('Private URL/invalid media/failed download'));
  await expect(
    service.prepare({ workspaceId: 'a', idempotencyKey: 'failed', input }),
  ).rejects.toMatchObject({ code: 'input_preparation_failed' });
  await expect(
    service.prepare({ workspaceId: 'a', idempotencyKey: 'failed', input }),
  ).rejects.toMatchObject({ code: 'input_preparation_failed' });
  expect(download).toHaveBeenCalledTimes(1);
  expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_jobs')).rows[0]).toEqual({
    count: 0,
  });
  expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_ledger')).rows[0]).toEqual({
    count: 0,
  });
  expect(
    (
      await db.query(
        "SELECT available_micros::int,reserved_micros::int FROM mr_workspaces WHERE id='a'",
      )
    ).rows[0],
  ).toEqual({ available_micros: 100000, reserved_micros: 0 });
});
it('rejects unready/foreign assets and freezes upload bytes in a separate immutable input key', async () => {
  const { upload, staging } = await uploaded();
  await expect(service.requireReady('a', upload.key)).rejects.toMatchObject({
    code: 'asset_not_ready',
  });
  await expect(service.completeUpload('b', upload.key)).rejects.toMatchObject({ statusCode: 404 });
  const completed = await service.completeUpload('a', upload.key);
  expect(completed.state).toBe('ready');
  expect(upload.key).not.toBe(staging);
  objects.set(staging, { bytes: Buffer.from('later overwrite'), mediaType: 'image/png' });
  expect(await service.completeUpload('a', upload.key)).toEqual(completed);
  expect(facts(upload.key).bytes).toEqual(png);
  await expect(service.requireReady('a', upload.key, 'audio')).rejects.toMatchObject({
    code: 'invalid_reference_type',
  });
});
it('checks actual uploaded size/type instead of declared facts', async () => {
  const { upload, staging } = await uploaded();
  objects.set(staging, { bytes: Buffer.from('wrong'), mediaType: 'image/png' });
  await expect(service.completeUpload('a', upload.key)).rejects.toMatchObject({
    code: 'upload_mismatch',
  });
  expect((await service.get('a', upload.key)).state).toBe('failed');
  await expect(service.completeUpload('a', upload.key)).rejects.toMatchObject({
    code: 'asset_not_ready',
  });
});
it('pins atomically at admission, tombstones new use and defers cleanup until accepted use releases', async () => {
  const prepared = await service.prepare({ workspaceId: 'a', idempotencyKey: 'pins', input });
  const id = await job();
  const client = await pool.connect();
  await client.query('BEGIN');
  await service.finalizeInTransaction(client, 'a', prepared.id, id, inputPreparationHash(input));
  await client.query('COMMIT');
  const key = prepared.manifest[0]!.assetKey;
  await db.query("UPDATE mr_jobs SET status='submission-unknown' WHERE id=$1", [id]);
  await service.releaseJobPins(client, 'a', id);
  expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_asset_pins')).rows[0]).toEqual({
    count: 2,
  });
  await db.query("UPDATE mr_jobs SET status='succeeded' WHERE id=$1", [id]);
  expect(await service.delete('a', key)).toEqual({ state: 'deleted', inUse: true });
  await expect(service.requireReady('a', key)).rejects.toMatchObject({ code: 'asset_not_ready' });
  expect((await service.signForJob('a', id, key)).url).toContain('short-lived');
  await expect(service.signForJob('b', id, key)).rejects.toMatchObject({ statusCode: 404 });
  expect(await service.cleanup()).toBe(0);
  await service.releaseJobPins(client, 'a', id);
  expect(await service.cleanup()).toBe(1);
  expect(objects.has(key)).toBe(false);
  expect((await service.get('a', key)).state).toBe('deleted');
  expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_jobs')).rows[0]).toEqual({
    count: 1,
  });
  expect((await service.prepare({ workspaceId: 'a', idempotencyKey: 'pins', input })).jobId).toBe(
    id,
  );
});
it('deletion between preparation and admission rolls back admission pins', async () => {
  const prepared = await service.prepare({ workspaceId: 'a', idempotencyKey: 'deleted', input });
  await service.delete('a', prepared.manifest[0]!.assetKey);
  const id = await job();
  const client = await pool.connect();
  await client.query('BEGIN');
  await expect(
    service.finalizeInTransaction(client, 'a', prepared.id, id, inputPreparationHash(input)),
  ).rejects.toMatchObject({ code: 'asset_not_ready' });
  await client.query('ROLLBACK');
  expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_asset_pins')).rows[0]).toEqual({
    count: 0,
  });
});
it('registers owned output reuse privately with lineage and no paid operation', async () => {
  const id = await job();
  const outputKey = `outputs/${id}/${randomUUID()}.png`;
  objects.set(outputKey, { bytes: png, mediaType: 'image/png' });
  await db.query('UPDATE mr_jobs SET outputs=$2 WHERE id=$1', [
    id,
    JSON.stringify([
      { storageKey: outputKey, mediaType: 'image/png', url: 'https://expired.example/never-fetch' },
    ]),
  ]);
  await expect(service.reuse('b', id, 0, 'reuse')).rejects.toMatchObject({ statusCode: 404 });
  const reused = await service.reuse('a', id, 0, 'reuse');
  expect(reused.assetKey).toMatch(/^inputs\/a\//);
  expect(facts(reused.assetKey).bytes).toEqual(png);
  expect(await service.reuse('a', id, 0, 'reuse')).toEqual(reused);
  expect(download).not.toHaveBeenCalled();
  expect(
    (
      await db.query(
        'SELECT source_job_id,source_output_index FROM mr_owned_assets WHERE asset_key=$1',
        [reused.assetKey],
      )
    ).rows[0],
  ).toEqual({ source_job_id: id, source_output_index: 0 });
  expect((await db.query('SELECT COUNT(*)::int AS count FROM mr_ledger')).rows[0]).toEqual({
    count: 0,
  });
  await service.delete('a', reused.assetKey);
  await service.cleanup();
  expect(objects.has(outputKey)).toBe(true);
  await expect(service.reuse('a', id, 0, 'reuse')).rejects.toMatchObject({
    code: 'asset_not_ready',
  });
});
it.each([false, true])(
  'reuses the same original slot across out-of-order delivery (persisted slot: %s)',
  async (persistedSlot) => {
    const id = await job();
    const firstKey = `outputs/${id}/${randomUUID()}.png`;
    const secondKey = `outputs/${id}/${randomUUID()}.png`;
    const secondBytes = Buffer.concat([png, Buffer.from([4])]);
    objects.set(firstKey, { bytes: png, mediaType: 'image/png' });
    objects.set(secondKey, { bytes: secondBytes, mediaType: 'image/png' });
    const first = { storageKey: firstKey, mediaType: 'image/png', outputIndex: 0 };
    const second = {
      storageKey: secondKey,
      mediaType: 'image/png',
      ...(persistedSlot ? { outputIndex: 1 } : {}),
    };
    await db.query(
      "UPDATE mr_jobs SET outputs=$2,delivery_status='partial',output_evidence=$3 WHERE id=$1",
      [
        id,
        JSON.stringify([second]),
        JSON.stringify([
          { index: 0, state: 'pending', outputIndex: null },
          { index: 1, state: 'available', outputIndex: 0 },
        ]),
      ],
    );
    await expect(service.reuse('a', id, 0, 'missing-first')).rejects.toMatchObject({
      statusCode: 404,
    });
    const before = await service.reuse('a', id, 1, 'before-recovery');
    expect(facts(before.assetKey).bytes).toEqual(secondBytes);
    await db.query(
      "UPDATE mr_jobs SET outputs=$2,delivery_status='available',output_evidence=$3 WHERE id=$1",
      [
        id,
        JSON.stringify([first, second]),
        JSON.stringify([
          { index: 0, state: 'available', outputIndex: 0 },
          { index: 1, state: 'available', outputIndex: 1 },
        ]),
      ],
    );
    const after = await service.reuse('a', id, 1, 'after-recovery');
    expect(facts(after.assetKey).bytes).toEqual(secondBytes);
    expect(await service.reuse('a', id, 1, 'before-recovery')).toEqual(before);
    expect(store.readOwnedOutput.mock.calls.map((call) => call[1])).toEqual([secondKey, secondKey]);
  },
);
it('expires retained inputs without purging ledger or preparation records', async () => {
  const { upload } = await uploaded();
  await service.completeUpload('a', upload.key);
  await db.query(
    "UPDATE mr_owned_assets SET expires_at=now()-interval '1 second',upload_expires_at=now()-interval '1 second' WHERE asset_key=$1",
    [upload.key],
  );
  expect((await service.get('a', upload.key)).state).toBe('expired');
  await expect(service.requireReady('a', upload.key)).rejects.toMatchObject({
    code: 'asset_not_ready',
  });
  expect(await service.cleanup()).toBe(1);
  expect((await service.get('a', upload.key)).state).toBe('expired');
});
it('fences delayed writes from physical cleanup and sweeps tombstoned bytes when copying finishes', async () => {
  const id = await job();
  const outputKey = `outputs/${id}/${randomUUID()}.png`;
  objects.set(outputKey, { bytes: png, mediaType: 'image/png' });
  await db.query('UPDATE mr_jobs SET outputs=$2 WHERE id=$1', [
    id,
    JSON.stringify([{ storageKey: outputKey, mediaType: 'image/png' }]),
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.writeInput.mockImplementationOnce(async (_workspace, key, bytes, mediaType) => {
    entered();
    await gate;
    objects.set(key, { bytes: Buffer.from(bytes), mediaType });
    return facts(key);
  });
  const pending = service.reuse('a', id, 0, 'late-copy');
  await observed;
  const key = (
    await db.query<{ asset_key: string }>(
      "SELECT asset_key FROM mr_owned_assets WHERE reuse_idempotency_key='late-copy'",
    )
  ).rows[0]!.asset_key;
  expect(await service.delete('a', key)).toEqual({ state: 'deleted', inUse: false });
  expect(await service.cleanup()).toBe(0);
  release();
  await pending;
  expect(objects.has(key)).toBe(true);
  expect(await service.cleanup()).toBe(1);
  expect(objects.has(key)).toBe(false);
});
it('recovers PUT-before-commit from the same immutable object without refetching the source', async () => {
  const prepared = await service.prepare({ workspaceId: 'a', idempotencyKey: 'recover', input });
  await db.query(
    "UPDATE mr_input_preparations SET state='processing',input=NULL,manifest='[]',lease_until=now()-interval '1 second' WHERE id=$1",
    [prepared.id],
  );
  await db.query(
    "UPDATE mr_owned_assets SET state='processing',media_type=NULL,byte_length=NULL,sha256=NULL WHERE preparation_id=$1",
    [prepared.id],
  );
  download.mockRejectedValue(new Error('Mutable source must never be fetched again'));
  const recovered = await service.prepare({ workspaceId: 'a', idempotencyKey: 'recover', input });
  expect(recovered).toEqual(prepared);
  expect(download).toHaveBeenCalledTimes(2);
});
it('does not refetch an interrupted import whose outcome has no durable bytes', async () => {
  const prepared = await service.prepare({
    workspaceId: 'a',
    idempotencyKey: 'unknown-import',
    input,
  });
  await db.query(
    "UPDATE mr_input_preparations SET state='processing',lease_until=now()-interval '1 second' WHERE id=$1",
    [prepared.id],
  );
  const key = prepared.manifest[0]!.assetKey;
  await db.query("UPDATE mr_owned_assets SET state='processing' WHERE asset_key=$1", [key]);
  objects.delete(key);
  await expect(
    service.prepare({ workspaceId: 'a', idempotencyKey: 'unknown-import', input }),
  ).rejects.toMatchObject({ code: 'input_preparation_failed' });
  expect(download).toHaveBeenCalledTimes(2);
});
it('keeps the ready-state SQL constraint strict when hash/length are missing', async () => {
  await expect(
    db.query(
      "INSERT INTO mr_owned_assets(asset_key,workspace_id,state,media_type) VALUES($1,'a','ready','image/png')",
      [`inputs/a/${randomUUID()}.png`],
    ),
  ).rejects.toThrow();
});
it('persists multipart sessions server-side, resumes and completes idempotently under ownership checks', async () => {
  const staging = `inputs/a/${randomUUID()}.png`;
  const session = {
    key: staging,
    uploadId: 'server-only-upload-id',
    mediaType: 'image/png',
    size: png.length,
    partSize: 5 * 1024 * 1024,
    partCount: 1,
  };
  const multipartStore = {
    ...store,
    initiateMultipart: vi.fn(async () => session),
    signUploadPart: vi.fn(async () => ({
      uploadUrl: 'https://synthetic.example/part',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })),
    resumeMultipart: vi.fn(async () => [{ partNumber: 1, etag: 'one', size: png.length }]),
    completeMultipart: vi.fn(async () => {
      objects.set(staging, { bytes: png, mediaType: 'image/png' });
      return facts(staging);
    }),
    abortMultipart: vi.fn(async () => {}),
  };
  const multipart = new OwnedAssetService(pool, multipartStore as unknown as AssetStore);
  const upload = await multipart.prepareMultipart('a', 'image/png', png.length);
  expect(upload).toEqual({
    key: expect.stringMatching(/^inputs\/a\//),
    partSize: 5 * 1024 * 1024,
    partCount: 1,
  });
  expect(upload).not.toHaveProperty('uploadId');
  await expect(multipart.signMultipartPart('b', upload.key, 1)).rejects.toMatchObject({
    statusCode: 404,
  });
  await multipart.signMultipartPart('a', upload.key, 1);
  expect(multipartStore.signUploadPart).toHaveBeenCalledWith('a', session, 1);
  expect(await multipart.resumeMultipart('a', upload.key)).toHaveLength(1);
  const ready = await multipart.completeMultipart('a', upload.key, [
    { partNumber: 1, etag: 'one' },
  ]);
  expect(ready.state).toBe('ready');
  expect(
    await multipart.completeMultipart('a', upload.key, [{ partNumber: 1, etag: 'one' }]),
  ).toEqual(ready);
  expect(multipartStore.completeMultipart).toHaveBeenCalledTimes(1);
  expect(facts(upload.key).bytes).toEqual(png);
  await expect(multipart.resumeMultipart('a', upload.key)).rejects.toMatchObject({
    code: 'upload_not_active',
  });
  const abandoned = await multipart.prepareMultipart('a', 'image/png', png.length);
  expect(await multipart.abortMultipart('a', abandoned.key)).toEqual({
    state: 'deleted',
    inUse: false,
  });
  expect(await multipart.abortMultipart('a', abandoned.key)).toEqual({
    state: 'deleted',
    inUse: false,
  });
  await expect(
    multipart.completeMultipart('a', abandoned.key, [{ partNumber: 1, etag: 'one' }]),
  ).rejects.toMatchObject({ code: 'upload_not_active' });
});
it('rejects output reuse if retained bytes differ from recorded delivery evidence', async () => {
  const id = await job();
  const key = `outputs/${id}/${randomUUID()}.png`;
  objects.set(key, { bytes: png, mediaType: 'image/png' });
  await db.query('UPDATE mr_jobs SET outputs=$2 WHERE id=$1', [
    id,
    JSON.stringify([
      { storageKey: key, mediaType: 'image/png', sha256: '0'.repeat(64), byteLength: png.length },
    ]),
  ]);
  await expect(service.reuse('a', id, 0, 'changed-output')).rejects.toMatchObject({
    code: 'invalid_output',
  });
});
it('binds the original request hash separately from canonical normalization and rejects canonical changes', async () => {
  const originalHash = inputPreparationHash({
    ...input,
    modelId: 'fixture/legacy-alias',
    metadata: { project: 'private' },
  });
  const prepared = await service.prepare({
    workspaceId: 'a',
    idempotencyKey: 'original',
    input,
    requestHash: originalHash,
  });
  expect(
    await service.prepare({
      workspaceId: 'a',
      idempotencyKey: 'original',
      input,
      requestHash: originalHash,
    }),
  ).toEqual(prepared);
  await expect(
    service.prepare({
      workspaceId: 'a',
      idempotencyKey: 'original',
      input: { ...input, input: { prompt: 'changed' } },
      requestHash: originalHash,
    }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  const id = await job();
  await db.query('UPDATE mr_jobs SET request_hash=$2 WHERE id=$1', [id, originalHash]);
  const client = await pool.connect();
  await client.query('BEGIN');
  await service.finalizeInTransaction(client, 'a', prepared.id, id, originalHash);
  await client.query('COMMIT');
});
it('atomically denies import to a stale preparation owner before any source GET', async () => {
  const original = pool.query.bind(pool);
  const spy = vi.spyOn(pool, 'query').mockImplementation((async (
    sql: string,
    values?: unknown[],
  ) => {
    if (sql.includes('UPDATE mr_owned_assets SET import_started=true')) {
      await db.query('UPDATE mr_input_preparations SET owner_token=$1 WHERE id=$2', [
        randomUUID(),
        values![1],
      ]);
    }
    return original(sql, values);
  }) as never);
  try {
    await expect(
      service.prepare({ workspaceId: 'a', idempotencyKey: 'stale-owner', input }),
    ).rejects.toMatchObject({ code: 'input_preparation_failed' });
    expect(download).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it('does not mark a stale cleanup revision purged after a late writer finishes', async () => {
  const prepared = await service.prepare({ workspaceId: 'a', idempotencyKey: 'revision', input });
  const key = prepared.manifest[0]!.assetKey;
  await service.delete('a', key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.removeUpload.mockImplementationOnce(async (_workspace, deleted) => {
    objects.delete(deleted);
    entered();
    await gate;
  });
  const pending = service.cleanup();
  await observed;
  objects.set(key, { bytes: png, mediaType: 'image/png' });
  await db.query(
    'UPDATE mr_owned_assets SET content_revision=content_revision+1,purged_at=NULL WHERE asset_key=$1',
    [key],
  );
  release();
  expect(await pending).toBe(0);
  expect(
    (await db.query('SELECT purged_at FROM mr_owned_assets WHERE asset_key=$1', [key])).rows[0],
  ).toEqual({ purged_at: null });
  expect(await service.cleanup()).toBe(1);
  expect(objects.has(key)).toBe(false);
});
it('enforces workspace ownership in pin/lineage foreign keys as well as service queries', async () => {
  const prepared = await service.prepare({ workspaceId: 'a', idempotencyKey: 'tenant-fk', input });
  const foreignJob = await job('b');
  await expect(
    db.query('INSERT INTO mr_asset_pins(asset_key,workspace_id,job_id) VALUES($1,$2,$3)', [
      prepared.manifest[0]!.assetKey,
      'a',
      foreignJob,
    ]),
  ).rejects.toThrow();
  await expect(
    db.query('UPDATE mr_owned_assets SET source_job_id=$2 WHERE asset_key=$1', [
      prepared.manifest[0]!.assetKey,
      foreignJob,
    ]),
  ).rejects.toThrow();
});
