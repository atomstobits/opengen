import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  exampleManifest,
  inspectManifest,
  readBoundedJson,
  sourceContext,
} from '../scripts/core-activation-preflight.mjs';

const source = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  dirty: false,
  migrations: Array.from({ length: 31 }, (_, i) => ({
    name: `${String(i + 1).padStart(3, '0')}.sql`,
    checksum: (i + 1).toString(16).padStart(64, '0'),
  })),
};
const folders: string[] = [];
async function temp() {
  const folder = await mkdtemp(join(tmpdir(), 'opengen-activation-fixture-'));
  folders.push(folder);
  return folder;
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
const blocked = (manifest: ReturnType<typeof exampleManifest>, code: string) => {
  const result = inspectManifest(manifest, source);
  expect(result.result).toBe('preflight-blocked');
  expect(result.checks).toContainEqual({ code, state: 'blocked' });
  expect(result.hostedReadiness).toBe('not-established');
};

describe('offline current-core activation assertions', () => {
  it('plans only forward 014–031 without implying hosted readiness', () => {
    const result = inspectManifest(exampleManifest(source), source);
    expect(result.result).toBe('preflight-passed');
    expect(result.migrationsToApply).toEqual(source.migrations.slice(13).map((m) => m.name));
    expect(result.evidenceKind).toBe('offline-assertions-only');
    expect(result.hostedReadiness).toBe('not-established');
    expect(result.externalGates).toContain('reduced-runtime-role-migration-rehearsal');
    expect(result.externalGates).toContain('isolated-native-tools-and-worker-readiness');
    expect(result.externalGates).toContain(
      'human-identity-workspace-consent-and-both-actual-clients',
    );
  });

  it('requires the same exact clean source and immutable API/worker image', () => {
    const m = exampleManifest(source);
    m.candidate.commit = 'c'.repeat(40);
    blocked(m, 'exact_source');
    m.candidate.commit = source.commit;
    m.candidate.tree = 'd'.repeat(40);
    blocked(m, 'exact_source');
    m.candidate.tree = source.tree;
    m.candidate.workerImageDigest = `sha256:${'2'.repeat(64)}`;
    blocked(m, 'same_immutable_runtime_image');
    expect(inspectManifest(exampleManifest(source), { ...source, dirty: true }).result).toBe(
      'preflight-blocked',
    );
  });

  it.each(['changed', 'gap', 'reordered', 'extra', 'too-old'])(
    'rejects %s applied migration history',
    (kind) => {
      const m = exampleManifest(source);
      if (kind === 'changed') m.deployedMigrations[0].checksum = 'f'.repeat(64);
      if (kind === 'gap') m.deployedMigrations.splice(4, 1);
      if (kind === 'reordered') m.deployedMigrations.reverse();
      if (kind === 'extra')
        m.deployedMigrations = [
          ...source.migrations,
          { name: '031.sql', checksum: 'f'.repeat(64) },
        ];
      if (kind === 'too-old') m.deployedMigrations = m.deployedMigrations.slice(0, 12);
      blocked(m, 'applied_migrations_immutable_contiguous_prefix');
      expect(inspectManifest(m, source).migrationsToApply).toEqual([]);
    },
  );

  it('plans billing, comparison and serializer migrations from the previous immutable core prefix', () => {
    const m = exampleManifest(source);
    m.deployedMigrations = structuredClone(source.migrations.slice(0, 21));
    expect(inspectManifest(m, source)).toMatchObject({
      result: 'preflight-passed',
      migrationsToApply: [
        '022.sql',
        '023.sql',
        '024.sql',
        '025.sql',
        '026.sql',
        '027.sql',
        '028.sql',
        '029.sql',
        '030.sql',
        '031.sql',
      ],
      hostedReadiness: 'not-established',
    });
  });

  it('accepts an already upgraded immutable migration prefix', () => {
    const m = exampleManifest(source);
    m.deployedMigrations = structuredClone(source.migrations);
    expect(inspectManifest(m, source).migrationsToApply).toEqual([]);
    expect(inspectManifest(m, source).result).toBe('preflight-passed');
  });

  it.each(['inputs/', '', 'input'])(
    'rejects lifecycle deletion bypassing SQL pins: %s',
    (prefix) => {
      const m = exampleManifest(source);
      m.storage.lifecycle.rule.push({
        action: { type: 'Delete' },
        condition: { age: 7, matchesPrefix: [prefix] },
      });
      blocked(m, 'private_pin_safe_bucket_policy');
    },
  );

  it.each(['Content-Type', 'ETag', 'If-None-Match', 'x-goog-if-generation-match'])(
    'requires browser upload header %s',
    (header) => {
      const m = exampleManifest(source);
      m.storage.cors[0].responseHeader = m.storage.cors[0].responseHeader.filter(
        (h) => h !== header,
      );
      blocked(m, 'conditional_upload_cors_policy');
    },
  );

  it.each([
    'http://example.invalid',
    'https://example.invalid/path',
    'https://example.invalid?secret=value',
    'https://127.0.0.1',
    'https://localhost',
    'https://service.internal',
    'https://name:password@example.invalid',
  ])('rejects noncanonical public origin %s', (origin) => {
    const m = exampleManifest(source);
    m.storage.publicOrigin = origin;
    blocked(m, 'canonical_https_origin');
  });

  it('requires private cache policy and private bucket access', () => {
    const m = exampleManifest(source);
    m.storage.signedReadCacheControl = 'public, max-age=604800';
    blocked(m, 'private_signed_read_cache');
    m.storage.uniformBucketLevelAccess = false;
    blocked(m, 'private_pin_safe_bucket_policy');
  });

  it('allows explicitly unconfigured retention only without an advertised lifetime', () => {
    const m = exampleManifest(source);
    m.runtime.apiInputRetentionMs = null;
    m.runtime.workerInputRetentionMs = null;
    blocked(m, 'consistent_honest_input_retention');
    m.runtime.advertisedInputRetentionMs = null;
    expect(inspectManifest(m, source).result).toBe('preflight-passed');
  });

  it('requires an explicit shared API and worker execution scope and fixture pin', () => {
    const m = exampleManifest(source);
    m.runtime.apiQualificationFirstFrameSha256 = '0'.repeat(64);
    m.runtime.workerQualificationFirstFrameSha256 = '0'.repeat(64);
    expect(inspectManifest(m, source).result).toBe('preflight-passed');
    m.runtime.workerExecutionScope = 'unrestricted';
    blocked(m, 'consistent_explicit_execution_scope');
    m.runtime.workerExecutionScope = m.runtime.apiExecutionScope;
    m.runtime.workerQualificationFirstFrameSha256 = '1'.repeat(64);
    blocked(m, 'consistent_explicit_execution_scope');
    expect(JSON.stringify(inspectManifest(m, source))).not.toContain('1'.repeat(64));
  });

  it.each(['', 'unknown', null, undefined])(
    'rejects missing or invalid execution scope %s',
    (scope) => {
      const m = exampleManifest(source);
      m.runtime.apiExecutionScope = scope;
      m.runtime.workerExecutionScope = scope;
      blocked(m, 'consistent_explicit_execution_scope');
    },
  );

  it('permits an explicitly unrestricted self-host only without a qualification fixture pin', () => {
    const m = exampleManifest(source);
    m.runtime.apiExecutionScope = 'unrestricted';
    m.runtime.workerExecutionScope = 'unrestricted';
    expect(inspectManifest(m, source).result).toBe('preflight-passed');
    m.runtime.apiQualificationFirstFrameSha256 = '0'.repeat(64);
    m.runtime.workerQualificationFirstFrameSha256 = '0'.repeat(64);
    blocked(m, 'consistent_explicit_execution_scope');
  });

  it.each(['', 'not-a-digest', 'a'.repeat(63), 'a'.repeat(65), undefined, { toString: 1 }])(
    'rejects malformed or missing fixture pin assertions %s',
    (pin) => {
      const m = exampleManifest(source);
      m.runtime.apiQualificationFirstFrameSha256 = pin;
      m.runtime.workerQualificationFirstFrameSha256 = pin;
      blocked(m, 'consistent_explicit_execution_scope');
    },
  );

  it.each([0, 59999, 60000.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid input lifetime %s',
    (retention) => {
      const m = exampleManifest(source);
      m.runtime.apiInputRetentionMs = retention;
      m.runtime.workerInputRetentionMs = retention;
      m.runtime.advertisedInputRetentionMs = retention;
      blocked(m, 'consistent_honest_input_retention');
    },
  );

  it('rejects changed vault version, old workers, retries and database rewind', () => {
    const m = exampleManifest(source);
    m.runtime.vaultKeyVersionUnchanged = false;
    blocked(m, 'original_vault_key_preserved');
    for (const [key, value] of Object.entries({
      oldWorkers: 'running',
      unknownJobs: 'retry',
      rollback: 'restore-old-database',
    })) {
      const other = exampleManifest(source);
      other.cutover[key] = value;
      blocked(other, 'quiesced_preserving_cutover');
    }
  });

  it('does not echo unknown manifest fields or claim operator assertions are hosted proof', () => {
    const m = { ...exampleManifest(source), privateFixture: 'never-echo-this-fixture' };
    blocked(m, 'manifest_shape');
    expect(JSON.stringify(inspectManifest(m, source))).not.toContain('never-echo');
    const operator = exampleManifest(source);
    operator.evidenceKind = 'operator-sanitized';
    expect(inspectManifest(operator, source).hostedReadiness).toBe('not-established');
  });

  it('reads the actual explicit migration loader and hashes source only', async () => {
    const actual = await sourceContext();
    expect(actual.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(actual.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(actual.migrations.map((m) => m.name)).toEqual(source.migrations.map((m) => m.name));
    expect(actual.migrations.every((m) => /^[a-f0-9]{64}$/.test(m.checksum))).toBe(true);
    expect(actual.migrations[12].checksum).toBe(
      'b1e85fada297f91f580b07e62951a346d89025e637a04b57eebe433d00d41a90',
    );
  });
});

describe('bounded dry-run file boundary', () => {
  it('rejects relative paths, symlinks, nonregular files and oversized JSON', async () => {
    const dir = await temp();
    const path = join(dir, 'manifest.json');
    await writeFile(path, JSON.stringify(exampleManifest(source)));
    const link = join(dir, 'link.json');
    await symlink(path, link);
    await expect(readBoundedJson('manifest.json')).rejects.toThrow();
    await expect(readBoundedJson(link)).rejects.toThrow();
    await expect(readBoundedJson(dir)).rejects.toThrow();
    expect(await readBoundedJson(path)).toEqual(exampleManifest(source));
    await writeFile(path, ' '.repeat(131073));
    await expect(readBoundedJson(path)).rejects.toThrow();
  });

  it('CLI never prints malformed input, paths or ambient credential-like fixture values', async () => {
    const path = join(await temp(), 'private-fixture-name.json');
    await writeFile(path, '{"bad":"private-fixture-content"');
    const child = spawnSync(
      process.execPath,
      ['scripts/core-activation-preflight.mjs', '--manifest', path],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          FAL_KEY: 'ambient-fixture-value',
          DATABASE_URL: 'must-not-connect',
        },
        timeout: 10000,
      },
    );
    expect(child.status).toBe(2);
    expect(child.stdout + child.stderr).not.toMatch(
      /private-fixture|ambient-fixture|must-not-connect/,
    );
    expect(child.stderr).toContain('Offline activation preflight failed');
  });
});
