import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { bucketPolicy } from '../infra/gcp-bootstrap.mjs';

// Offline only. No environment/config loader, cloud driver, database, media or
// credential access. Input/output contain assertions, never hosted proof.
const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const equal = (a, b) => canonical(a) === canonical(b);

export async function readBoundedJson(path) {
  if (!isAbsolute(path)) throw new Error('manifest_path_invalid');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const facts = await file.stat();
    if (!facts.isFile() || facts.size > 131072) throw new Error('manifest_file_invalid');
    const bytes = Buffer.alloc(131073);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 131072) throw new Error('manifest_file_invalid');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally {
    await file.close();
  }
}

async function readSourceFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('source_file_invalid');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function sourceContext() {
  const git = (args) =>
    execFileSync('/usr/bin/git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 262144,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
  const loader = await readSourceFile(join(root, 'packages/engine/src/index.ts'));
  const start = loader.indexOf('const migrations = await Promise.all(');
  const end = loader.indexOf('].map(', start);
  if (start < 0 || end < 0) throw new Error('source_loader_unrecognized');
  const names = [...loader.slice(start, end).matchAll(/'(\d{3}\.sql)'/g)].map((m) => m[1]);
  const files = (await readdir(join(root, 'packages/engine/migrations')))
    .filter((name) => /^\d{3}\.sql$/.test(name))
    .sort();
  if (
    !equal(names, files) ||
    names.length < 21 ||
    names.some((name, i) => name !== `${String(i + 1).padStart(3, '0')}.sql`)
  )
    throw new Error('source_migration_manifest_invalid');
  const migrations = [];
  for (const name of names)
    migrations.push({
      name,
      checksum: digest(await readSourceFile(join(root, 'packages/engine/migrations', name))),
    });
  return {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
    migrations,
  };
}

export const externalGates = [
  'exact-build-image-provenance-and-current-private-ci',
  'exact-candidate-native-upgrade-and-backup-restore',
  'reduced-runtime-role-migration-rehearsal',
  'actual-bucket-pin-lifecycle-and-conditional-multipart-browser-cors',
  'current-core-private-media-refresh-and-revocation',
  'accepted-unknown-original-input-and-credential-reconciliation',
  'isolated-native-tools-and-worker-readiness',
  'human-identity-workspace-consent-and-both-actual-clients',
  'provider-coverage-and-media-rights',
  'approved-execution-scope-and-existing-queued-work-transition',
];

export function exampleManifest(source) {
  const publicOrigin = 'https://gateway.fixture.invalid';
  return {
    schemaVersion: 1,
    evidenceKind: 'synthetic',
    candidate: {
      commit: source.commit,
      tree: source.tree,
      apiImageDigest: `sha256:${'1'.repeat(64)}`,
      workerImageDigest: `sha256:${'1'.repeat(64)}`,
    },
    deployedMigrations: structuredClone(source.migrations.slice(0, 13)),
    storage: {
      publicOrigin,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      ...bucketPolicy({ publicOrigin }),
      signedReadCacheControl: 'private, no-store',
    },
    runtime: {
      apiExecutionScope: 'qualification-sg-v1',
      workerExecutionScope: 'qualification-sg-v1',
      apiQualificationFirstFrameSha256: null,
      workerQualificationFirstFrameSha256: null,
      apiInputRetentionMs: 604800000,
      workerInputRetentionMs: 604800000,
      advertisedInputRetentionMs: 604800000,
      vaultKeyVersionUnchanged: true,
    },
    cutover: {
      admissions: 'paused',
      oldWorkers: 'stopped',
      migrationWriter: 'single',
      acceptedJobs: 'preserve',
      unknownJobs: 'hold-no-resubmit',
      legacyInputs: 'original-or-operator-gate',
      legacyCredentials: 'original-or-operator-gate',
      rollback: 'forward-compatible-only',
    },
  };
}

export function inspectManifest(manifest, source) {
  const checks = [];
  const check = (code, passed) => checks.push({ code, state: passed ? 'passed' : 'blocked' });
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const example = exampleManifest(source);
  const sameKeys = (a, b) =>
    a &&
    typeof a === 'object' &&
    !Array.isArray(a) &&
    equal(Object.keys(a).sort(), Object.keys(b).sort());
  // Reject arbitrary bags (including accidentally pasted .env/secret values).
  check(
    'manifest_shape',
    sameKeys(m, example) &&
      ['candidate', 'storage', 'runtime', 'cutover'].every((key) =>
        sameKeys(m[key], example[key]),
      ) &&
      m.schemaVersion === 1 &&
      ['synthetic', 'operator-sanitized'].includes(m.evidenceKind),
  );
  check('clean_source', source.dirty === false);
  check('exact_source', m.candidate?.commit === source.commit && m.candidate?.tree === source.tree);
  check(
    'same_immutable_runtime_image',
    image.test(m.candidate?.apiImageDigest ?? '') &&
      m.candidate.apiImageDigest === m.candidate.workerImageDigest,
  );
  const deployed = m.deployedMigrations;
  const prefix =
    Array.isArray(deployed) &&
    deployed.length >= 13 &&
    deployed.length <= source.migrations.length &&
    deployed.every(
      (entry, i) => hash.test(entry?.checksum ?? '') && equal(entry, source.migrations[i]),
    );
  check('applied_migrations_immutable_contiguous_prefix', prefix);
  const s = m.storage;
  let originValid = false;
  try {
    const url = new URL(s?.publicOrigin);
    const labels = url.hostname.split('.');
    originValid =
      url.protocol === 'https:' &&
      url.origin === s.publicOrigin &&
      !url.username &&
      !url.password &&
      !isIP(url.hostname) &&
      labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
      /^[a-z]/.test(labels.at(-1)) &&
      !/(?:^|\.)(localhost|local|internal)$/.test(url.hostname);
  } catch {
    /* Missing/malformed origin stays blocked. */
  }
  check('canonical_https_origin', originValid);
  check(
    'private_pin_safe_bucket_policy',
    s?.uniformBucketLevelAccess === true &&
      s?.publicAccessPrevention === 'enforced' &&
      equal(s?.lifecycle, bucketPolicy({ publicOrigin: s?.publicOrigin }).lifecycle),
  );
  check(
    'conditional_upload_cors_policy',
    equal(s?.cors, bucketPolicy({ publicOrigin: s?.publicOrigin }).cors),
  );
  check('private_signed_read_cache', s?.signedReadCacheControl === 'private, no-store');
  const r = m.runtime;
  const scope = r?.apiExecutionScope;
  const firstFrame = r?.apiQualificationFirstFrameSha256;
  check(
    'consistent_explicit_execution_scope',
    ['unrestricted', 'qualification-sg-v1'].includes(scope) &&
      r?.workerExecutionScope === scope &&
      (firstFrame === null ||
        (scope === 'qualification-sg-v1' &&
          typeof firstFrame === 'string' &&
          hash.test(firstFrame))) &&
      r?.workerQualificationFirstFrameSha256 === firstFrame,
  );
  const retention = r?.apiInputRetentionMs;
  check(
    'consistent_honest_input_retention',
    (retention === null || (Number.isSafeInteger(retention) && retention >= 60000)) &&
      r?.workerInputRetentionMs === retention &&
      r?.advertisedInputRetentionMs === retention,
  );
  check('original_vault_key_preserved', r?.vaultKeyVersionUnchanged === true);
  check('quiesced_preserving_cutover', equal(m.cutover, example.cutover));
  return {
    evidenceKind: 'offline-assertions-only',
    result: checks.every((c) => c.state === 'passed') ? 'preflight-passed' : 'preflight-blocked',
    hostedReadiness: 'not-established',
    source: { commit: source.commit, tree: source.tree, dirty: source.dirty },
    checks,
    migrationsToApply: prefix ? source.migrations.slice(deployed.length).map((e) => e.name) : [],
    externalGates,
  };
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (
      !(args.length === 1 && args[0] === '--example') &&
      !(args.length === 2 && args[0] === '--manifest')
    )
      throw new Error('usage');
    const source = await sourceContext();
    if (args[0] === '--example') {
      console.log(JSON.stringify(exampleManifest(source), null, 2));
      return 0;
    }
    const result = inspectManifest(await readBoundedJson(args[1]), source);
    console.log(JSON.stringify(result, null, 2));
    return result.result === 'preflight-passed' ? 0 : 1;
  } catch {
    // Never echo JSON values, paths, subprocess output or parser errors.
    console.error(
      'Offline activation preflight failed. Use --example or --manifest /absolute/sanitized.json; input must be a regular JSON file of at most 128 KiB.',
    );
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main();
