import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  lstat,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { hashInput, type SmokeEntry } from '../scripts/live-smoke';
import {
  prepareHistoricalSnapshot,
  openHistoricalObserver,
} from '../scripts/historical-qualification-evidence';
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'historical-fixture-')));
  roots.push(root);
  const database = join(root, 'original-db'),
    storage = join(root, 'original-storage');
  await mkdir(storage, { mode: 0o700 });
  const id = randomUUID(),
    storageKey = `outputs/${id}/${randomUUID()}.mp4`,
    bytes = Buffer.from('Synthetic stored bytes; no actual media.');
  const object = join(storage, 'fixture-bucket', storageKey + '._S3rver_object');
  await mkdir(join(storage, 'fixture-bucket', `outputs/${id}`), { recursive: true, mode: 0o700 });
  await writeFile(object, bytes, { mode: 0o600 });
  const input = {
    modelId: 'minimax/h3-lite',
    operation: 'text-to-video' as const,
    input: {
      prompt: 'PRIVATE SYNTHETIC MUST NOT APPEAR IN SUMMARY',
      resolution: '480p',
      duration: 4,
    },
    billing: 'managed' as const,
  };
  const entry: SmokeEntry = {
    routeId: 'minimax-undisclosed/minimax-h3-lite',
    input,
    inputHash: hashInput(input),
    idempotencyKey: randomUUID(),
    estimateMicros: 100_000,
    reserveMicros: 200_000,
    actualCostMicros: null,
    phase: 'accepted',
    jobId: id,
    jobStatus: 'succeeded',
    deliveryStatus: 'available',
    outputHashes: [sha(bytes)],
    sources: [],
    createdAt: '2026-11-03T00:00:00Z',
  };
  const db = new PGlite(database);
  await db.exec(
    'CREATE TABLE mr_jobs(id uuid,workspace_id text,input jsonb,route_snapshot jsonb,status text,delivery_status text,outputs jsonb)',
  );
  await db.query('INSERT INTO mr_jobs VALUES($1,$2,$3,$4,$5,$6,$7)', [
    id,
    'original-workspace',
    input,
    { id: entry.routeId },
    'succeeded',
    'available',
    [
      {
        storageKey,
        mediaType: 'video/mp4',
        sha256: sha(bytes),
        byteLength: bytes.length,
        url: 'https://private.example/SIGNED-NEVER-LOAD',
      },
    ],
  ]);
  await db.close();
  const receiptPath = join(root, 'original-budget.json');
  await writeFile(
    receiptPath,
    JSON.stringify({
      version: 1,
      server: 'http://127.0.0.1:4510',
      workspaceId: 'original-workspace',
      budgetMicros: 50_000_000,
      entries: [entry],
    }),
    { mode: 0o600 },
  );
  return {
    root,
    entry,
    receiptPath,
    sourceDatabaseDirectory: database,
    sourceStorageDirectory: storage,
    snapshotDirectory: join(root, 'private-copy'),
    originalServicesConfirmedStopped: true as const,
    object,
  };
}
describe('offline historical evidence from a copy only', () => {
  let original: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    original = await fixture();
  });
  it('queries a copied database and hashes only the owned copied object without loading output URLs', async () => {
    const f = { ...original, snapshotDirectory: join(original.root, 'first-copy') };
    const originalReceipt = await readFile(f.receiptPath),
      originalObject = await readFile(f.object);
    const result = await prepareHistoricalSnapshot(f);
    expect(result.databaseFileCount).toBeGreaterThan(0);
    expect(result.storageFileCount).toBe(1);
    expect((await lstat(f.snapshotDirectory)).mode & 0o777).toBe(0o700);
    const observer = await openHistoricalObserver(f.snapshotDirectory, result.snapshotSha256);
    try {
      const evidence = await observer.observe(
        f.entry,
        'http://127.0.0.1:4510',
        'original-workspace',
      );
      expect(evidence.evidence).toEqual({
        kind: 'original-datastore-snapshot',
        snapshotSha256: result.snapshotSha256,
      });
      expect(evidence.job.id).toBe(f.entry.jobId);
      expect(evidence.job.outputs[0]?.sha256).toBe(f.entry.outputHashes![0]);
      expect(JSON.stringify(evidence)).not.toContain('SIGNED-NEVER-LOAD');
      expect(JSON.stringify(observer.summary())).not.toContain('PRIVATE SYNTHETIC');
      expect(observer.summary()).toMatchObject({
        verifiedObjects: 1,
        providerCalls: 0,
        originalServicesStarted: false,
        liveJournalWrites: 0,
      });
      await expect(
        observer.observe(f.entry, 'https://different.example', 'original-workspace'),
      ).rejects.toThrow('Historical snapshot');
      await expect(
        observer.observe(f.entry, 'http://127.0.0.1:4510', 'different-workspace'),
      ).rejects.toThrow('Historical snapshot');
    } finally {
      await observer.close();
    }
    expect(await readFile(f.receiptPath)).toEqual(originalReceipt);
    expect(await readFile(f.object)).toEqual(originalObject);
  });
  it('rejects changed copied objects and database symlinks instead of opening originals', async () => {
    const f = { ...original, snapshotDirectory: join(original.root, 'second-copy') };
    const snapshot = await prepareHistoricalSnapshot(f);
    const observer = await openHistoricalObserver(f.snapshotDirectory, snapshot.snapshotSha256);
    try {
      const manifest = JSON.parse(
        await readFile(join(f.snapshotDirectory, 'MANIFEST.json'), 'utf8'),
      );
      await writeFile(
        join(f.snapshotDirectory, 'storage', manifest.storageFiles[0].path),
        'tampered',
      );
      await expect(
        observer.observe(f.entry, 'http://127.0.0.1:4510', 'original-workspace'),
      ).rejects.toThrow('Historical snapshot');
    } finally {
      await observer.close();
    }
    await rm(join(f.snapshotDirectory, 'database'), { recursive: true });
    await symlink(f.sourceDatabaseDirectory, join(f.snapshotDirectory, 'database'));
    await expect(
      openHistoricalObserver(f.snapshotDirectory, snapshot.snapshotSha256),
    ).rejects.toThrow('Historical snapshot');
  });
  it('requires a stopped-source confirmation and a new destination outside original data', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'historical-path-fixture-')));
    roots.push(root);
    const f = {
      root,
      receiptPath: join(root, 'budget.json'),
      sourceDatabaseDirectory: join(root, 'db'),
      sourceStorageDirectory: join(root, 'storage'),
      snapshotDirectory: join(root, 'copy'),
      originalServicesConfirmedStopped: true as const,
    };
    await mkdir(f.sourceDatabaseDirectory);
    await mkdir(f.sourceStorageDirectory);
    await writeFile(
      f.receiptPath,
      JSON.stringify({ version: 1, budgetMicros: 50_000_000, entries: [] }),
      { mode: 0o600 },
    );
    await expect(
      prepareHistoricalSnapshot({ ...f, originalServicesConfirmedStopped: false as never }),
    ).rejects.toThrow('Historical snapshot');
    await expect(
      prepareHistoricalSnapshot({
        ...f,
        snapshotDirectory: join(f.sourceDatabaseDirectory, 'recursive-copy'),
      }),
    ).rejects.toThrow('Historical snapshot');
  });
});
