#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cloudDriver } from './gcp-bootstrap.mjs';

async function loadAssetStore() {
  try {
    return (await import('../packages/engine/src/storage.ts')).AssetStore;
  } catch {
    const { tsImport } = await import('tsx/esm/api');
    return (await tsImport('../packages/engine/src/storage.ts', import.meta.url)).AssetStore;
  }
}

function validatePublicOrigin(publicOrigin) {
  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    /* invalid */
  }
  if (
    !origin ||
    origin.protocol !== 'https:' ||
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password ||
    !origin.hostname.includes('.') ||
    isIP(origin.hostname) ||
    /(?:^|\.)(localhost|local|internal)$/.test(origin.hostname)
  )
    throw new Error('Supply a canonical public HTTPS origin without path, credentials or query.');
  return publicOrigin;
}

function parseHeaderTokens(raw) {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Uses only synthetic owned bytes and the real AssetStore; never calls a generation provider. */
export async function qualifyStorage({
  bootstrapReceipt,
  output,
  publicOrigin,
  driver: injectedDriver,
  store: injectedStore,
  fetchImpl = fetch,
  expiryWaitMs = 2200,
}) {
  if (
    !isAbsolute(bootstrapReceipt) ||
    !isAbsolute(output) ||
    (await realpath(bootstrapReceipt)) !== bootstrapReceipt ||
    (await realpath(dirname(output))) !== dirname(output)
  )
    throw new Error('Use canonical absolute private receipt/output paths.');
  const checkedOrigin = publicOrigin !== undefined ? validatePublicOrigin(publicOrigin) : null;
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
  const driver = injectedDriver ?? cloudDriver();
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
    (endpoint !== 'https://storage.googleapis.com' && !injectedStore) ||
    region !== 'auto'
  )
    throw new Error('Storage configuration differs from the reviewed receipt.');
  let store = injectedStore;
  if (!store) {
    const AssetStore = await loadAssetStore();
    store = new AssetStore(bucket, { endpoint, region });
    store.client.config.credentials = async () => ({ accessKeyId, secretAccessKey });
    store.client.config.logger = { debug() {}, info() {}, warn() {}, error() {} };
  }
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const alternateBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64',
  );
  const workspace = `qualification_${randomUUID().replaceAll('-', '')}`;
  const expectedConditionalHeader =
    endpoint === 'https://storage.googleapis.com' ? 'x-goog-if-generation-match' : 'If-None-Match';
  const expectedConditionalValue = endpoint === 'https://storage.googleapis.com' ? '0' : '*';
  const evidence = {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    project: metadata.project,
    region: metadata.region,
    source: 'actual AssetStore against private GCS XML/HMAC',
    synthetic: true,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    corsOriginChecked: checkedOrigin,
    steps: {},
    actualClientQualification: false,
  };
  const steps = evidence.steps;
  const cleanupKeys = [];
  let mpSessionToAbort = null;
  let abortSessionToClean = null;
  let phase = 'prepare';
  try {
    const prepared = await store.prepareUpload(workspace, 'image/png', bytes.length);
    const key = prepared.key;
    cleanupKeys.push(key);
    if (
      prepared.headers['Content-Type'] !== 'image/png' ||
      prepared.headers[expectedConditionalHeader] !== expectedConditionalValue
    )
      throw new Error('Missing create-only upload precondition headers.');
    steps.prepare = true;
    steps.conditionalCreateHeaders = true;

    if (checkedOrigin) {
      phase = 'cors-preflight';
      const requiredRequestHeaders = Object.keys(prepared.headers).map((header) =>
        header.toLowerCase(),
      );
      const requestedHeaders = Object.keys(prepared.headers).join(', ');
      const preflight = await fetchImpl(prepared.uploadUrl, {
        method: 'OPTIONS',
        headers: {
          Origin: checkedOrigin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': requestedHeaders,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      const allowOrigin = preflight.headers.get('access-control-allow-origin');
      const allowMethods = parseHeaderTokens(preflight.headers.get('access-control-allow-methods'));
      const allowHeaders = new Set(
        parseHeaderTokens(preflight.headers.get('access-control-allow-headers')),
      );
      if (
        !preflight.ok ||
        allowOrigin !== checkedOrigin ||
        !allowMethods.includes('put') ||
        !requiredRequestHeaders.every((header) => allowHeaders.has(header))
      )
        throw new Error('Storage CORS preflight rejected required origin, method or headers.');
      steps.corsPreflight = true;
    }

    phase = 'signed-upload';
    const uploaded = await fetchImpl(prepared.uploadUrl, {
      method: 'PUT',
      headers: prepared.headers,
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!uploaded.ok) throw new Error('Storage rejected synthetic upload.');
    steps.signedUpload = true;

    phase = 'conflicting-replay';
    const replay = await fetchImpl(prepared.uploadUrl, {
      method: 'PUT',
      headers: prepared.headers,
      body: alternateBytes,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (replay.ok || replay.status !== 412)
      throw new Error('Storage did not reject conflicting create-only replay with 412.');
    let conflictStatus = 0;
    try {
      await store.writeInput(workspace, key, alternateBytes, 'image/png');
    } catch (err) {
      conflictStatus = err?.statusCode ?? 0;
    }
    if (conflictStatus !== 409)
      throw new Error('AssetStore.writeInput did not reject conflicting replay with 409.');
    const idempotent = await store.writeInput(workspace, key, bytes, 'image/png');
    if (idempotent.sha256 !== evidence.sha256)
      throw new Error('Idempotent writeInput replay did not preserve original bytes.');
    steps.conflictingReplayRejected = true;

    phase = 'complete-owned-upload';
    const completed = await store.completeUpload(workspace, key);
    if (completed.mediaType !== 'image/png' || !completed.expiresAt)
      throw new Error('Completed object metadata mismatch.');
    steps.complete = true;

    phase = 'signed-retrieval';
    const response = await fetchImpl(completed.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes))
      throw new Error('Retrieved bytes mismatch.');
    steps.signedRetrieval = true;

    phase = 'private-cache-control';
    const isPrivateBrowserUploadCache = (value) =>
      value === 'private, no-store' ||
      (endpoint === 'https://storage.googleapis.com' && value === 'private, max-age=0');
    const cacheControl = (response.headers.get('cache-control') ?? '').trim().toLowerCase();
    if (!isPrivateBrowserUploadCache(cacheControl))
      throw new Error('Signed retrieval missing private Cache-Control.');
    steps.privateNoStoreCache = true;

    phase = 'unsigned-denial';
    const anonymous = await fetchImpl(`${endpoint}/${bucket}/${key}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (anonymous.ok) throw new Error('Object unexpectedly public.');
    steps.unsignedDenied = true;

    phase = 'expiry';
    const expiring = await store.sign(key, 'image/png', 1);
    if (expiryWaitMs > 0) await new Promise((done) => setTimeout(done, expiryWaitMs));
    const expired = await fetchImpl(expiring.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (expired.ok) throw new Error('Expired URL unexpectedly usable.');
    steps.expiredUrlDenied = true;

    phase = 'refresh';
    const refreshed = await store.sign(key, 'image/png');
    const fresh = await fetchImpl(refreshed.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (
      !fresh.ok ||
      !Buffer.from(await fresh.arrayBuffer()).equals(bytes) ||
      !isPrivateBrowserUploadCache((fresh.headers.get('cache-control') ?? '').trim().toLowerCase())
    )
      throw new Error('Refreshed URL retrieval failed.');
    steps.refreshedRetrieval = true;

    phase = 'multipart-complete';
    const mpSession = await store.initiateMultipart(workspace, 'image/png', bytes.length);
    mpSessionToAbort = mpSession;
    cleanupKeys.push(mpSession.key);
    const signedPart = await store.signUploadPart(workspace, mpSession, 1);
    const partResponse = await fetchImpl(signedPart.uploadUrl, {
      method: 'PUT',
      headers: {
        ...signedPart.headers,
        ...(checkedOrigin ? { Origin: checkedOrigin } : {}),
      },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const partEtag = partResponse.headers.get('etag');
    const partExposedHeaders = new Set(
      parseHeaderTokens(partResponse.headers.get('access-control-expose-headers')),
    );
    if (
      !partResponse.ok ||
      !partEtag ||
      (checkedOrigin &&
        (partResponse.headers.get('access-control-allow-origin') !== checkedOrigin ||
          !partExposedHeaders.has('etag')))
    )
      throw new Error('Multipart part upload failed or omitted ETag.');
    const listedParts = await store.resumeMultipart(workspace, mpSession);
    if (
      listedParts.length !== 1 ||
      listedParts[0].partNumber !== 1 ||
      listedParts[0].size !== bytes.length ||
      !listedParts[0].etag
    )
      throw new Error('Multipart part listing mismatch.');
    const mpCompleted = await store.completeMultipart(workspace, mpSession, [
      { partNumber: 1, etag: listedParts[0].etag },
    ]);
    mpSessionToAbort = null;
    if (mpCompleted.sha256 !== evidence.sha256 || mpCompleted.size !== bytes.length)
      throw new Error('Completed multipart object facts mismatch.');
    const mpSigned = await store.sign(mpSession.key, 'image/png');
    const mpRetrieved = await fetchImpl(mpSigned.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (
      !mpRetrieved.ok ||
      !Buffer.from(await mpRetrieved.arrayBuffer()).equals(bytes) ||
      (mpRetrieved.headers.get('cache-control') ?? '').trim().toLowerCase() !== 'private, no-store'
    )
      throw new Error(
        'Completed multipart signed retrieval missing private, no-store Cache-Control.',
      );
    steps.multipartComplete = true;

    phase = 'multipart-abort';
    const abortSession = await store.initiateMultipart(workspace, 'image/png', bytes.length);
    abortSessionToClean = abortSession;
    cleanupKeys.push(abortSession.key);
    const abortPart = await store.signUploadPart(workspace, abortSession, 1);
    const abortPartRes = await fetchImpl(abortPart.uploadUrl, {
      method: 'PUT',
      headers: abortPart.headers,
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!abortPartRes.ok) throw new Error('Multipart abort staging upload failed.');
    await store.abortMultipart(workspace, abortSession);
    abortSessionToClean = null;
    if ((await store.readInputIfExists(workspace, abortSession.key)) !== null)
      throw new Error('Aborted multipart session unexpectedly materialized an object.');
    steps.multipartAbort = true;
  } catch {
    throw new Error(
      `Storage qualification failed during ${phase}; private URLs, credentials and response payloads suppressed.`,
    );
  } finally {
    let allCleaned = true;
    for (const sessionToAbort of [mpSessionToAbort, abortSessionToClean]) {
      if (!sessionToAbort) continue;
      try {
        await store.abortMultipart(workspace, sessionToAbort);
      } catch {
        allCleaned = false;
      }
    }
    for (const candidateKey of cleanupKeys) {
      try {
        await store.removeUpload(workspace, candidateKey);
      } catch {
        allCleaned = false;
      }
    }
    if (cleanupKeys.length > 0) steps.cleanedUp = allCleaned;
    if (!injectedStore) store?.client?.destroy?.();
  }
  if (!steps.cleanedUp)
    throw new Error('Synthetic qualification object cleanup needs operator attention.');
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        'bootstrap-receipt': { type: 'string' },
        output: { type: 'string' },
        'public-origin': { type: 'string' },
      },
    });
    if (!values['bootstrap-receipt'] || !values.output)
      throw new Error(
        'Use --bootstrap-receipt /absolute/private/bootstrap.json --output /absolute/private/new-storage-evidence.json [--public-origin https://opengen.dev].',
      );
    console.log(
      JSON.stringify(
        await qualifyStorage({
          bootstrapReceipt: values['bootstrap-receipt'],
          output: values.output,
          ...(values['public-origin'] !== undefined
            ? { publicOrigin: values['public-origin'] }
            : {}),
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
