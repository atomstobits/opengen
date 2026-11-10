import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { GenerateInput } from '@media-router/contracts';
import { OwnedAssetService, inputPreparationHash } from '../packages/engine/src/owned-assets';
import { createInputKey } from '../packages/engine/src/input-media';
import {
  privateInputBytesFixture,
  privateReadyInputFixture,
  privateStorageFixture,
} from './helpers/private-storage';

let db: PGlite;
let pool: Pool;
let storage: ReturnType<typeof privateStorageFixture>;
let service: OwnedAssetService;
const download = vi.fn(async () => {
  throw new Error('Legacy URLs must never be fetched.');
});
const cutover = '2026-11-04T00:00:00Z';
const oldCreated = '2026-11-03T23:00:00Z';
const newCreated = '2026-11-04T00:01:00Z';
const input = (assetKey: string): GenerateInput => ({
  modelId: 'fixture/video',
  operation: 'image-to-video',
  routeId: 'fixture/exact-region',
  input: { prompt: 'Synthetic accepted legacy job.', firstFrame: { assetKey } },
});
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/001.sql', import.meta.url), 'utf8'),
  );
  await db.exec(
    "ALTER TABLE mr_jobs ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'; ALTER TABLE mr_jobs ADD COLUMN attribution jsonb;",
  );
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/015.sql', import.meta.url), 'utf8'),
  );
  await db.exec(
    'CREATE TABLE mr_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL)',
  );
  await db.query("INSERT INTO mr_migrations(name,applied_at) VALUES('015.sql',$1)", [cutover]);
  const query = async (sql: string, values?: unknown[]) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}, 90_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  download.mockClear();
  await db.exec('TRUNCATE mr_workspaces CASCADE');
  await db.exec(
    "INSERT INTO mr_workspaces(id,available_micros,reserved_micros) VALUES('owner',1000,123),('foreign',0,0)",
  );
  storage = privateStorageFixture();
  service = new OwnedAssetService(pool, storage, { download });
});
afterAll(async () => {
  await db.close();
});
async function legacyJob(
  original: GenerateInput,
  options: {
    createdAt?: string;
    status?: string;
    attempts?: number;
    upstreamId?: string | null;
  } = {},
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros,attempt_count,upstream_id,metadata,attribution,created_at)
     VALUES($1::uuid,'owner',$1::text,$2,$3,'{"id":"frozen-route","price":123}','{"id":"frozen-region"}',$4,123,$5,$6,'{"project":"Original history"}',NULL,$7)`,
    [
      id,
      inputPreparationHash(original),
      JSON.stringify(original),
      options.status ?? 'queued',
      options.attempts ?? 0,
      options.upstreamId ?? null,
      options.createdAt ?? oldCreated,
    ],
  );
  return id;
}
async function staging(workspace = 'owner') {
  const key = createInputKey(workspace, 'image/png');
  const facts = privateInputBytesFixture();
  await storage.writeInput(workspace, key, facts.bytes, facts.mediaType);
  return { key, ...facts };
}
async function jobRow(id: string) {
  return (await db.query('SELECT to_jsonb(j) AS value FROM mr_jobs j WHERE id=$1', [id])).rows[0]!
    .value;
}
async function copies(id: string) {
  return (
    await db.query<{
      asset_key: string;
      state: string;
      import_started: boolean;
      source_job_id: string;
      reuse_idempotency_key: string;
      source_output_index: number | null;
    }>('SELECT * FROM mr_owned_assets WHERE source_job_id=$1 ORDER BY asset_key', [id])
  ).rows;
}
async function pinCount(id: string) {
  return (
    await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM mr_asset_pins WHERE job_id=$1',
      [id],
    )
  ).rows[0]!.count;
}

describe('private legacy queued-input cutover', () => {
  it('freezes private staging once, pins the same accepted job and leaves original history unknown and unchanged', async () => {
    const source = await staging();
    const original = input(source.key);
    const id = await legacyJob(original);
    const before = await jobRow(id);
    const read = vi.spyOn(storage, 'readInput');
    const prepared = await service.preparedInputForJob('owner', id, original);
    const frozenKey = prepared.input.input.firstFrame!.assetKey!;
    expect(frozenKey).not.toBe(source.key);
    expect(prepared).toMatchObject({
      jobId: id,
      legacyCutover: { basis: 'current_private_bytes', originalAdmissionBytes: 'unknown' },
      manifest: [{ assetKey: frozenKey, path: 'firstFrame', type: 'image', sha256: source.sha256 }],
    });
    expect(Date.parse(prepared.legacyCutover!.frozenAt)).not.toBeNaN();
    expect(await jobRow(id)).toEqual(before);
    expect(await pinCount(id)).toBe(1);
    expect(read.mock.calls.filter((call) => call[1] === source.key)).toHaveLength(1);
    expect((await copies(id))[0]).toMatchObject({
      source_job_id: id,
      source_output_index: null,
      reuse_idempotency_key: expect.stringMatching(/^legacy-cutover:/),
    });
    await storage.removeUpload('owner', source.key);
    expect(await service.delete('owner', frozenKey)).toEqual({ state: 'deleted', inUse: true });
    await db.query(
      "UPDATE mr_owned_assets SET expires_at=now()-interval '1 hour' WHERE asset_key=$1",
      [frozenKey],
    );
    read.mockClear();
    expect(await service.preparedInputForJob('owner', id, original)).toEqual(prepared);
    expect(read).not.toHaveBeenCalled();
    expect((await service.signForJob('owner', id, frozenKey)).url).toContain(frozenKey);
    expect(await jobRow(id)).toEqual(before);
  });

  it('recovers retained bytes after PUT-before-commit and never adopts a replaced mutable source', async () => {
    const source = await staging();
    const original = input(source.key);
    const id = await legacyJob(original);
    const before = await jobRow(id);
    const read = vi.spyOn(storage, 'readInput');
    const write = storage.writeInput.bind(storage);
    vi.spyOn(storage, 'writeInput').mockImplementationOnce(async (...args) => {
      await write(...args);
      throw new Error('Synthetic crash after retained PUT.');
    });
    await expect(service.preparedInputForJob('owner', id, original)).rejects.toThrow(
      'Synthetic crash',
    );
    const [copy] = await copies(id);
    expect(copy).toMatchObject({ state: 'processing', import_started: true });
    // This deliberately replaces the old mutable staging object with unusable bytes.
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: source.key,
        Body: Buffer.from('source replaced'),
        ContentType: 'image/png',
      }),
    );
    const recovered = await service.preparedInputForJob('owner', id, original);
    expect(recovered.input.input.firstFrame).toEqual({ assetKey: copy!.asset_key });
    expect(recovered.manifest[0]!.sha256).toBe(source.sha256);
    expect(read.mock.calls.filter((call) => call[1] === source.key)).toHaveLength(1);
    expect(await pinCount(id)).toBe(1);
    expect(await jobRow(id)).toEqual(before);
  });

  it('keeps an interrupted source read unavailable when no immutable copy survived, without reading it again', async () => {
    const source = await staging();
    const original = input(source.key);
    const id = await legacyJob(original);
    const read = vi.spyOn(storage, 'readInput');
    vi.spyOn(storage, 'writeInput').mockRejectedValueOnce(new Error('Synthetic crash before PUT.'));
    await expect(service.preparedInputForJob('owner', id, original)).rejects.toThrow(
      'Synthetic crash',
    );
    await expect(service.preparedInputForJob('owner', id, original)).rejects.toMatchObject({
      code: 'legacy_input_unavailable',
    });
    expect(read.mock.calls.filter((call) => call[1] === source.key)).toHaveLength(1);
    expect(await pinCount(id)).toBe(0);
    expect((await copies(id))[0]).toMatchObject({ state: 'processing', import_started: true });
    expect(
      (await db.query('SELECT count(*)::integer AS count FROM mr_input_preparations')).rows[0]!
        .count,
    ).toBe(0);
  });

  it('denies foreign, new, started and changed requests before reading or copying private bytes', async () => {
    const source = await staging();
    const original = input(source.key);
    const old = await legacyJob(original);
    const recent = await legacyJob(original, { createdAt: newCreated });
    const running = await legacyJob(original, {
      status: 'running',
      attempts: 1,
      upstreamId: 'original-task',
    });
    const foreignSource = await staging('foreign');
    const foreignReference = input(foreignSource.key);
    const foreignJob = await legacyJob(foreignReference);
    const read = vi.spyOn(storage, 'readInput');
    await expect(service.preparedInputForJob('foreign', old, original)).rejects.toMatchObject({
      code: 'asset_not_found',
      statusCode: 404,
    });
    await expect(service.preparedInputForJob('owner', recent, original)).rejects.toMatchObject({
      code: 'legacy_input_unavailable',
    });
    await expect(service.preparedInputForJob('owner', running, original)).rejects.toMatchObject({
      code: 'job_not_dispatchable',
    });
    await expect(
      service.preparedInputForJob('owner', old, {
        ...original,
        input: { ...original.input, prompt: 'Changed' },
      }),
    ).rejects.toMatchObject({ code: 'legacy_input_conflict' });
    await expect(
      service.preparedInputForJob('owner', foreignJob, foreignReference),
    ).rejects.toMatchObject({ code: 'legacy_input_unavailable' });
    expect(read).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT count(*)::integer AS count FROM mr_owned_assets')).rows[0]!.count,
    ).toBe(0);
  });

  it('never re-fetches original external URLs for an accepted legacy job', async () => {
    const original: GenerateInput = {
      modelId: 'fixture/video',
      operation: 'image-to-video',
      input: { firstFrame: { url: 'https://mutable.example/original.png' } },
    };
    const id = await legacyJob(original);
    const read = vi.spyOn(storage, 'readInput');
    await expect(service.preparedInputForJob('owner', id, original)).rejects.toMatchObject({
      code: 'legacy_input_unavailable',
    });
    expect(download).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect((await copies(id)).length).toBe(0);
    expect(await pinCount(id)).toBe(0);
  });

  it('returns an existing admitted package for a modern job without treating its broker policy as mutable input', async () => {
    const ready = await privateReadyInputFixture({ pool, storage, ownedAssets: service }, 'owner');
    const original = { ...input(ready.assetKey), routing: { fallback: false } };
    const id = await legacyJob(original, { createdAt: newCreated });
    const prepared = await service.prepare({
      workspaceId: 'owner',
      idempotencyKey: 'modern-accepted',
      input: { ...original, routing: { fallback: true } },
      requestHash: inputPreparationHash(original),
    });
    await db.exec('BEGIN');
    await service.finalizeInTransaction(
      await pool.connect(),
      'owner',
      prepared.id,
      id,
      inputPreparationHash(original),
    );
    await db.exec('COMMIT');
    const read = vi.spyOn(storage, 'readInput');
    await db.exec('ALTER TABLE mr_migrations RENAME TO legacy_fixture_migrations');
    try {
      expect(await service.preparedInputForJob('owner', id, original)).toMatchObject({
        id: prepared.id,
        jobId: id,
        input: original,
      });
    } finally {
      await db.exec('ALTER TABLE legacy_fixture_migrations RENAME TO mr_migrations');
    }
    expect(read).not.toHaveBeenCalled();
    expect(await copies(id)).toEqual([]);
  });

  it('prevents finalization when the queued job is cancelled during copy or final preparation', async () => {
    for (const phase of ['copy', 'prepare']) {
      const source = await staging();
      const original = input(source.key);
      const id = await legacyJob(original);
      const finalize = vi.spyOn(service, 'finalizeInTransaction');
      const read = storage.readInput.bind(storage);
      const prepare = service.prepare.bind(service);
      if (phase === 'copy')
        vi.spyOn(storage, 'readInput').mockImplementationOnce(async (...args) => {
          const value = await read(...args);
          await db.query("UPDATE mr_jobs SET status='cancelled' WHERE id=$1", [id]);
          return value;
        });
      else
        vi.spyOn(service, 'prepare').mockImplementationOnce(async (options) => {
          const value = await prepare(options);
          await db.query("UPDATE mr_jobs SET status='cancelled' WHERE id=$1", [id]);
          return value;
        });
      await expect(service.preparedInputForJob('owner', id, original)).rejects.toMatchObject({
        code: 'job_not_dispatchable',
      });
      expect(finalize).not.toHaveBeenCalled();
      expect(await pinCount(id)).toBe(0);
      expect(
        (await db.query('SELECT state FROM mr_input_preparations WHERE job_id=$1', [id])).rows,
      ).toEqual([]);
      expect(await jobRow(id)).toMatchObject({
        status: 'cancelled',
        reserved_micros: 123,
        input: original,
        metadata: { project: 'Original history' },
        attribution: null,
      });
      vi.restoreAllMocks();
    }
  });

  it('fences an expired copy owner and resumes only its retained immutable target', async () => {
    const source = await staging();
    const original = input(source.key);
    const id = await legacyJob(original);
    const read = vi.spyOn(storage, 'readInput');
    const write = storage.writeInput.bind(storage);
    vi.spyOn(storage, 'writeInput').mockImplementationOnce(async (...args) => {
      const value = await write(...args);
      await db.query(
        "UPDATE mr_owned_assets SET write_owner_token=$2,write_lease_until=now()+interval '1 hour' WHERE source_job_id=$1",
        [id, randomUUID()],
      );
      return value;
    });
    await expect(service.preparedInputForJob('owner', id, original)).rejects.toMatchObject({
      code: 'job_not_dispatchable',
    });
    expect(await pinCount(id)).toBe(0);
    await db.query(
      "UPDATE mr_owned_assets SET write_lease_until=now()-interval '1 second' WHERE source_job_id=$1",
      [id],
    );
    expect((await service.preparedInputForJob('owner', id, original)).manifest[0]!.sha256).toBe(
      source.sha256,
    );
    expect(read.mock.calls.filter((call) => call[1] === source.key)).toHaveLength(1);
  });

  it('allows only one source read while another caller owns the cutover copy', async () => {
    const source = await staging();
    const original = input(source.key);
    const id = await legacyJob(original);
    const read = storage.readInput.bind(storage);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = vi.spyOn(storage, 'readInput').mockImplementation(async (...args) => {
      if (args[1] === source.key) {
        entered();
        await barrier;
      }
      return read(...args);
    });
    const first = service.preparedInputForJob('owner', id, original);
    await started;
    try {
      await expect(service.preparedInputForJob('owner', id, original)).rejects.toMatchObject({
        code: 'asset_write_in_progress',
      });
    } finally {
      release();
    }
    const prepared = await first;
    expect(prepared.jobId).toBe(id);
    expect(observed.mock.calls.filter((call) => call[1] === source.key)).toHaveLength(1);
    expect(await copies(id)).toHaveLength(1);
    expect(await pinCount(id)).toBe(1);
  });
});
