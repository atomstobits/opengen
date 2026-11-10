/** Offline original-datastore evidence. Originals are read only; PGlite opens a copy.
 * No environment loader, gateway/provider request, worker, credential or live-journal mutation.
 */
import { constants } from 'node:fs';
import { open, readdir, lstat, realpath, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { SmokeEntry, SmokeReceipt } from './live-smoke';
import type { HistoricalObservation } from './client-qualification-budget';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const denied = () =>
  new Error(
    'Historical snapshot evidence is unavailable or differs. No original data, budget or provider was changed.',
  );
async function regular(path: string, maximum: number) {
  if ((await realpath(path)) !== path) throw denied();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw denied();
    const bytes = await file.readFile();
    if (bytes.length > maximum) throw denied();
    return bytes;
  } finally {
    await file.close();
  }
}
type FileEvidence = { path: string; bytes: number; sha256: string };
async function files(root: string, destination?: string): Promise<FileEvidence[]> {
  const paths: { path: string; offset: string }[] = [];
  const walk = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        stat = await lstat(path);
      const offset = relative(root, path);
      if (stat.isSymbolicLink() || offset.startsWith('..') || isAbsolute(offset)) throw denied();
      if (stat.isDirectory()) {
        if (destination) await mkdir(join(destination, offset), { mode: 0o700 });
        await walk(path);
      } else if (stat.isFile()) paths.push({ path, offset });
      else throw denied();
    }
  };
  await walk(root);
  const result: FileEvidence[] = [];
  let index = 0;
  // Bounded file concurrency keeps an ordinary PG data directory practical without
  // unbounded descriptors or weakening byte/hash/symlink validation.
  await Promise.all(
    Array.from({ length: Math.min(4, paths.length) }, async () => {
      for (;;) {
        const item = paths[index++];
        if (!item) break;
        const bytes = await regular(item.path, 128 * 1024 * 1024);
        if (destination)
          await writeFile(join(destination, item.offset), bytes, { flag: 'wx', mode: 0o600 });
        result.push({ path: item.offset, bytes: bytes.length, sha256: digest(bytes) });
      }
    }),
  );
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function prepareHistoricalSnapshot(options: {
  receiptPath: string;
  sourceDatabaseDirectory: string;
  sourceStorageDirectory: string;
  snapshotDirectory: string;
  /** Confirm process/socket/file-handle ownership before copying a stopped source. */
  originalServicesConfirmedStopped: true;
}) {
  if (
    options.originalServicesConfirmedStopped !== true ||
    Object.values(options).some((value) => typeof value === 'string' && !isAbsolute(value))
  )
    throw denied();
  for (const source of [options.sourceDatabaseDirectory, options.sourceStorageDirectory])
    if ((await realpath(source)) !== source || !(await lstat(source)).isDirectory()) throw denied();
  const receipt = await regular(options.receiptPath, 1_000_000);
  const journal = JSON.parse(receipt.toString()) as SmokeReceipt;
  if (
    journal.version !== 1 ||
    journal.budgetMicros !== 50_000_000 ||
    !Array.isArray(journal.entries)
  )
    throw denied();
  if (
    [options.sourceDatabaseDirectory, options.sourceStorageDirectory].some(
      (source) =>
        options.snapshotDirectory === source || options.snapshotDirectory.startsWith(source + '/'),
    )
  )
    throw denied();
  if ((await realpath(dirname(options.snapshotDirectory))) !== dirname(options.snapshotDirectory))
    throw denied();
  await mkdir(options.snapshotDirectory, { mode: 0o700 });
  const database = join(options.snapshotDirectory, 'database'),
    storage = join(options.snapshotDirectory, 'storage');
  await mkdir(database, { mode: 0o700 });
  await mkdir(storage, { mode: 0o700 });
  const databaseFiles = await files(options.sourceDatabaseDirectory, database);
  const storageFiles = await files(options.sourceStorageDirectory, storage);
  // A concurrent source change invalidates the copy. It never authorizes editing the source.
  if (
    JSON.stringify(databaseFiles) !==
      JSON.stringify(await files(options.sourceDatabaseDirectory)) ||
    JSON.stringify(storageFiles) !== JSON.stringify(await files(options.sourceStorageDirectory)) ||
    digest(receipt) !== digest(await regular(options.receiptPath, 1_000_000))
  )
    throw denied();
  const manifest = {
    schemaVersion: 1,
    kind: 'original-datastore-snapshot',
    createdAt: new Date().toISOString(),
    source: {
      database: options.sourceDatabaseDirectory,
      storage: options.sourceStorageDirectory,
      confirmedStopped: true,
    },
    authority: {
      origin: journal.server,
      workspaceId: journal.workspaceId,
      receiptSha256: digest(receipt),
    },
    databaseFiles,
    storageFiles,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(options.snapshotDirectory, 'receipt.json'), receipt, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(options.snapshotDirectory, 'MANIFEST.json'), manifestBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    snapshotDirectory: options.snapshotDirectory,
    snapshotSha256: digest(manifestBytes),
    authorityReceiptSha256: digest(receipt),
    databaseFileCount: databaseFiles.length,
    storageFileCount: storageFiles.length,
    copiedBytes: [...databaseFiles, ...storageFiles].reduce((sum, file) => sum + file.bytes, 0),
  };
}
export async function openHistoricalObserver(
  snapshotDirectory: string,
  expectedSnapshotSha256: string,
) {
  if (!isAbsolute(snapshotDirectory) || (await realpath(snapshotDirectory)) !== snapshotDirectory)
    throw denied();
  const manifestBytes = await regular(join(snapshotDirectory, 'MANIFEST.json'), 2_000_000);
  if (digest(manifestBytes) !== expectedSnapshotSha256) throw denied();
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'original-datastore-snapshot')
    throw denied();
  const receiptBytes = await regular(join(snapshotDirectory, 'receipt.json'), 1_000_000);
  if (digest(receiptBytes) !== manifest.authority.receiptSha256) throw denied();
  const receipt = JSON.parse(receiptBytes.toString()) as SmokeReceipt;
  const database = join(snapshotDirectory, 'database');
  if (
    (await realpath(database)) !== database ||
    JSON.stringify(await files(database)) !== JSON.stringify(manifest.databaseFiles)
  )
    throw denied();
  const db = new PGlite(database);
  let verifiedObjects = 0;
  const observe = async (
    entry: Readonly<SmokeEntry>,
    origin: string,
    workspaceId: string,
  ): Promise<HistoricalObservation> => {
    if (
      origin !== manifest.authority.origin ||
      workspaceId !== manifest.authority.workspaceId ||
      !receipt.entries.some(
        (saved) =>
          saved.jobId === entry.jobId &&
          saved.inputHash === entry.inputHash &&
          saved.reserveMicros === entry.reserveMicros,
      )
    )
      throw denied();
    // Project stored output metadata only: never read/sign output URLs or contact storage/provider APIs.
    const result = await db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION READ ONLY');
      return tx.query<{
        id: string;
        workspace_id: string;
        input: SmokeEntry['input'];
        route_id: string;
        status: HistoricalObservation['job']['status'];
        delivery_status: HistoricalObservation['job']['deliveryStatus'];
        outputs: { storageKey: string; mediaType: string; sha256: string; byteLength?: number }[];
      }>(
        `SELECT id,workspace_id,input,route_snapshot->>'id' AS route_id,status,delivery_status,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('storageKey',o->>'storageKey','mediaType',o->>'mediaType','sha256',o->>'sha256','byteLength',o->'byteLength')),'[]'::jsonb) FROM jsonb_array_elements(outputs) o) AS outputs
          FROM mr_jobs WHERE id=$1 AND workspace_id=$2`,
        [entry.jobId, workspaceId],
      );
    });
    if (result.rows.length !== 1) throw denied();
    const row = result.rows[0]!;
    if (
      row.route_id !== entry.routeId ||
      row.status !== 'succeeded' ||
      row.delivery_status !== 'available' ||
      !row.outputs.length
    )
      throw denied();
    if (
      JSON.stringify(row.outputs.map((output) => output.sha256)) !==
      JSON.stringify(entry.outputHashes)
    )
      throw denied();
    const bucketDirectories = (
      await readdir(join(snapshotDirectory, 'storage'), { withFileTypes: true })
    ).filter((item) => item.isDirectory());
    for (const output of row.outputs) {
      if (
        !/^outputs\/[a-f0-9-]+\/[a-f0-9-]+\.(png|jpg|webp|mp4)$/.test(output.storageKey) ||
        !output.storageKey.startsWith(`outputs/${entry.jobId}/`) ||
        !/^[a-f0-9]{64}$/i.test(output.sha256)
      )
        throw denied();
      const candidates = [];
      for (const bucket of bucketDirectories) {
        const offset = `${bucket.name}/${output.storageKey}._S3rver_object`;
        const recorded = (manifest.storageFiles as FileEvidence[]).find(
          (file) => file.path === offset,
        );
        if (recorded) candidates.push(recorded);
      }
      if (candidates.length !== 1) throw denied();
      const object = candidates[0]!;
      const bytes = await regular(
        join(snapshotDirectory, 'storage', object.path),
        100 * 1024 * 1024,
      );
      if (
        digest(bytes) !== object.sha256 ||
        digest(bytes) !== output.sha256 ||
        (typeof output.byteLength === 'number' && bytes.length !== output.byteLength) ||
        !entry.outputHashes?.includes(output.sha256)
      )
        throw denied();
      verifiedObjects++;
    }
    return {
      gateway: origin,
      evidence: { kind: 'original-datastore-snapshot', snapshotSha256: expectedSnapshotSha256 },
      job: {
        id: row.id,
        workspaceId: row.workspace_id,
        input: row.input,
        routeId: row.route_id,
        status: row.status,
        deliveryStatus: row.delivery_status,
        outputs: row.outputs,
      },
    };
  };
  return {
    observe,
    close: () => db.close(),
    summary: () => ({
      evidence: 'original-datastore-snapshot',
      verifiedObjects,
      providerCalls: 0,
      originalServicesStarted: false,
      liveJournalWrites: 0,
    }),
  };
}
