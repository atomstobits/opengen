#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AssetStore } from '../packages/engine/src/storage.ts';
import { cloudDriver } from './gcp-bootstrap.mjs';
/** Uses only synthetic owned bytes and the real AssetStore; never calls a generation provider. */
export async function qualifyStorage({ bootstrapReceipt, output }) {
  if (
    !isAbsolute(bootstrapReceipt) ||
    !isAbsolute(output) ||
    (await realpath(bootstrapReceipt)) !== bootstrapReceipt ||
    (await realpath(dirname(output))) !== dirname(output)
  )
    throw new Error('Use canonical absolute private receipt/output paths.');
  const info = await lstat(bootstrapReceipt);
  if (!info.isFile() || info.size > 1_000_000 || info.mode & 0o077)
    throw new Error('Use a bounded private bootstrap metadata file.');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(bootstrapReceipt, 'utf8'));
  } catch {
    throw new Error('Bootstrap metadata is invalid; private contents suppressed.');
  }
  if (
    metadata.schemaVersion !== 1 ||
    !/^[a-z][a-z0-9-]+$/.test(metadata.project) ||
    !metadata.secrets
  )
    throw new Error('Expected the reviewed OpenGen bootstrap receipt.');
  const driver = cloudDriver();
  const read = async (name) => {
    const version = metadata.secrets[name]?.version;
    if (!/^[1-9][0-9]*$/.test(version ?? ''))
      throw new Error('Missing pinned private storage version.');
    return driver.secretAccess(metadata.project, name, version);
  };
  const accessKeyId = await read('opengen-storage-access'),
    secretAccessKey = await read('opengen-storage-secret');
  const bucket = await read('opengen-storage-bucket'),
    endpoint = await read('opengen-storage-endpoint'),
    region = await read('opengen-storage-region');
  if (
    bucket !== metadata.bucket ||
    endpoint !== 'https://storage.googleapis.com' ||
    region !== 'auto'
  )
    throw new Error('Storage configuration differs from the reviewed receipt.');
  const store = new AssetStore(bucket, { endpoint, region });
  store.client.config.credentials = async () => ({ accessKeyId, secretAccessKey });
  store.client.config.logger = { debug() {}, info() {}, warn() {}, error() {} };
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const workspace = `qualification_${randomUUID().replaceAll('-', '')}`;
  const evidence = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    project: metadata.project,
    region: metadata.region,
    source: 'actual AssetStore against private GCS XML/HMAC',
    synthetic: true,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    steps: {},
    actualClientQualification: false,
  };
  const steps = evidence.steps;
  let key,
    phase = 'prepare';
  try {
    const prepared = await store.prepareUpload(workspace, 'image/png', bytes.length);
    key = prepared.key;
    steps.prepare = true;
    phase = 'signed-upload';
    const uploaded = await fetch(prepared.uploadUrl, {
      method: 'PUT',
      headers: prepared.headers,
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!uploaded.ok) throw new Error('Storage rejected synthetic upload.');
    steps.signedUpload = true;
    phase = 'complete-owned-upload';
    const completed = await store.completeUpload(workspace, key);
    if (completed.mediaType !== 'image/png' || !completed.expiresAt)
      throw new Error('Completed object metadata mismatch.');
    steps.complete = true;
    phase = 'signed-retrieval';
    const response = await fetch(completed.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes))
      throw new Error('Retrieved bytes mismatch.');
    steps.signedRetrieval = true;
    phase = 'unsigned-denial';
    const anonymous = await fetch(`${endpoint}/${bucket}/${key}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (anonymous.ok) throw new Error('Object unexpectedly public.');
    steps.unsignedDenied = true;
    phase = 'expiry';
    const expiring = await store.sign(key, 'image/png', 1);
    await new Promise((done) => setTimeout(done, 2200));
    const expired = await fetch(expiring.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (expired.ok) throw new Error('Expired URL unexpectedly usable.');
    steps.expiredUrlDenied = true;
    phase = 'refresh';
    const refreshed = await store.sign(key, 'image/png');
    const fresh = await fetch(refreshed.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!fresh.ok || !Buffer.from(await fresh.arrayBuffer()).equals(bytes))
      throw new Error('Refreshed URL retrieval failed.');
    steps.refreshedRetrieval = true;
  } catch {
    throw new Error(
      `Storage qualification failed during ${phase}; private URLs, credentials and response payloads suppressed.`,
    );
  } finally {
    if (key) {
      try {
        await store.removeUpload(workspace, key);
        steps.cleanedUp = true;
      } catch {
        steps.cleanedUp = false;
      }
    }
    store.client.destroy();
  }
  if (!steps.cleanedUp)
    throw new Error('Synthetic qualification object cleanup needs operator attention.');
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { 'bootstrap-receipt': { type: 'string' }, output: { type: 'string' } },
    });
    if (!values['bootstrap-receipt'] || !values.output)
      throw new Error(
        'Use --bootstrap-receipt /absolute/private/bootstrap.json --output /absolute/private/new-storage-evidence.json.',
      );
    console.log(
      JSON.stringify(
        await qualifyStorage({
          bootstrapReceipt: values['bootstrap-receipt'],
          output: values.output,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Private storage qualification failed.');
    process.exitCode = 1;
  }
}
