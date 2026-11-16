import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const realRepoRoot = fileURLToPath(new URL('..', import.meta.url));
const realUpdateScript = join(realRepoRoot, 'infra/update-gcp-image.sh');

let sandboxRoot: string;
let toolsDir: string;
let fixtureRepo: string;
let commitSha: string;
let shortSha: string;

const baseEnvLines = [
  '# Git-ignored deployment identifiers fixture',
  'OPENGEN_PROJECT_ID=fixture-project',
  'OPENGEN_REGION=us-central1',
  'OPENGEN_PUBLIC_URL=https://opengen.example',
  'OPENGEN_PROVIDER_EXECUTION_ENABLED=true',
  'OPENGEN_EXECUTION_SCOPE=unrestricted',
  'OPENGEN_API_IMAGE=us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:replace-with-digest',
  'OPENGEN_API_RUNTIME_SA=opengen-api@fixture-project.iam.gserviceaccount.com',
  'OPENGEN_WORKER_RUNTIME_SA=opengen-worker@fixture-project.iam.gserviceaccount.com',
  'OPENGEN_CLOUDSQL_CONNECTION=fixture-project:us-central1:fixture-db',
  'OPENGEN_DATABASE_SECRET=database-url',
  'OPENGEN_API_TOKEN_SECRET=installation-token',
  'OPENGEN_SECRET_VERSION=7',
  'OPENGEN_PROVIDER_SECRET_BINDINGS=FAL_KEY=fal-key:2,MR_VAULT_KEY=vault-master:3',
  'OPENGEN_API_SECRET_BINDINGS=MR_SESSION_SECRET=session-only:7,STRIPE_SECRET_KEY=stripe-only:4',
  'STRIPE_LIVEMODE=false',
  'OPENGEN_BILLABLE_RUNTIME_APPROVED=no',
];

interface GcloudCall {
  args: string[];
  buildConfig?: string;
}

beforeAll(() => {
  sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), 'opengen-update-gcp-image-')));
  toolsDir = join(sandboxRoot, 'tools');
  fixtureRepo = join(sandboxRoot, 'repo');
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(join(fixtureRepo, 'infra/.local'), { recursive: true });

  const fakeGcloud = join(toolsDir, 'gcloud');
  writeFileSync(
    fakeGcloud,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.GCLOUD_FORBID === '1') {
  process.stderr.write('Forbidden gcloud invocation in dry-run test\\n');
  process.exit(99);
}
let buildConfig;
if (args[0] === 'builds' && args[1] === 'submit') {
  const cfgIdx = args.indexOf('--config');
  if (cfgIdx !== -1 && args[cfgIdx + 1]) {
    buildConfig = readFileSync(args[cfgIdx + 1], 'utf8');
  }
}
if (process.env.GCLOUD_TEST_LOG) {
  appendFileSync(process.env.GCLOUD_TEST_LOG, JSON.stringify({ args, buildConfig }) + '\\n');
}
if (args[0] === 'billing' && args[1] === 'projects' && args[2] === 'describe') {
  process.stdout.write((process.env.GCLOUD_BILLING_ENABLED ?? 'True') + '\\n');
  process.exit(0);
}
if (args[0] === 'builds' && args[1] === 'submit') {
  process.exit(0);
}
if (
  args[0] === 'artifacts' &&
  args[1] === 'docker' &&
  args[2] === 'images' &&
  args[3] === 'describe'
) {
  process.stdout.write((process.env.GCLOUD_RESOLVED_DIGEST ?? '') + '\\n');
  process.exit(0);
}
if (args[0] === 'run') {
  process.exit(0);
}
process.stderr.write('Unexpected gcloud subcommand: ' + args.join(' ') + '\\n');
process.exit(98);
`,
    { mode: 0o755 },
  );

  for (const rel of [
    'infra/update-gcp-image.sh',
    'infra/deploy-gcp.sh',
    'infra/opengen.env.example',
    'Dockerfile',
    '.gcloudignore',
    '.gitignore',
  ]) {
    copyFileSync(join(realRepoRoot, rel), join(fixtureRepo, rel));
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'OpenGen Test',
    GIT_AUTHOR_EMAIL: 'test@opengen.example',
    GIT_COMMITTER_NAME: 'OpenGen Test',
    GIT_COMMITTER_EMAIL: 'test@opengen.example',
  };
  execFileSync('git', ['init', '--quiet'], { cwd: fixtureRepo, env: gitEnv });
  execFileSync('git', ['add', '.'], { cwd: fixtureRepo, env: gitEnv });
  execFileSync('git', ['commit', '-m', 'fixture commit', '--quiet', '--no-gpg-sign'], {
    cwd: fixtureRepo,
    env: gitEnv,
  });
  commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixtureRepo,
    encoding: 'utf8',
  }).trim();
  shortSha = commitSha.slice(0, 12);
});

afterAll(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function writeFixtureEnvFile(
  lines: string[] = baseEnvLines,
  relativePath = 'infra/.local/opengen.env',
) {
  const fullPath = join(fixtureRepo, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${lines.join('\n')}\n`, { mode: 0o644 });
  return fullPath;
}

function runUpdate(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    scriptPath?: string;
    forbidGcloud?: boolean;
  } = {},
) {
  const logFile = join(
    sandboxRoot,
    `gcloud-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
  );
  const env: NodeJS.ProcessEnv = {
    PATH: `${toolsDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: sandboxRoot,
    TMPDIR: sandboxRoot,
    GCLOUD_TEST_LOG: logFile,
    ...(options.forbidGcloud ? { GCLOUD_FORBID: '1' } : {}),
    ...options.env,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  const result = spawnSync(
    '/bin/bash',
    [options.scriptPath ?? join(fixtureRepo, 'infra/update-gcp-image.sh'), ...args],
    {
      cwd: options.cwd ?? fixtureRepo,
      env,
      encoding: 'utf8',
    },
  );
  let calls: GcloudCall[] = [];
  try {
    calls = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GcloudCall);
    unlinkSync(logFile);
  } catch {
    // No gcloud calls logged.
  }
  return { ...result, calls };
}

describe('infra/update-gcp-image.sh', () => {
  it('defaults to --plan with zero gcloud calls even when --env-file still has the placeholder digest', () => {
    writeFixtureEnvFile();
    const result = runUpdate(['--env-file', 'infra/.local/opengen.env'], { forbidGcloud: true });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.calls).toEqual([]);
    const expectedTag = `us-central1-docker.pkg.dev/fixture-project/opengen/api:${shortSha}`;
    expect(result.stdout).toContain(`Source commit: ${commitSha}`);
    expect(result.stdout).toContain(`Planned Cloud Build target: server -> ${expectedTag}`);
    expect(result.stdout).toContain('gcloud builds submit');
    expect(result.stdout).toContain('gcloud artifacts docker images describe');
    expect(result.stdout).toContain(
      'us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:<resolved-64-hex-sha256>',
    );
    expect(result.stdout).not.toContain('0'.repeat(64));
    expect(result.stdout).toContain('gcloud run deploy opengen-api');
    expect(result.stdout).toContain('gcloud run worker-pools deploy opengen-worker');
    expect(result.stdout).toContain('No cloud build or runtime mutation performed.');
  });

  it('rejects dirty or untracked source files before any cloud build while ignoring git-ignored .local files', () => {
    writeFixtureEnvFile();
    const untracked = join(fixtureRepo, 'untracked-source.ts');
    writeFileSync(untracked, 'export const dirty = true;\n');
    try {
      for (const mode of ['--plan', '--build', '--apply']) {
        const result = runUpdate(['--env-file', 'infra/.local/opengen.env', mode], {
          forbidGcloud: true,
          env: { OPENGEN_BILLABLE_RUNTIME_APPROVED: 'yes' },
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('uncommitted or untracked source changes');
        expect(result.calls).toEqual([]);
      }
    } finally {
      unlinkSync(untracked);
    }
  });

  it('builds the server target, resolves its immutable SHA-256 digest, updates --env-file atomically (0600) and stops before Cloud Run mutation in --build', () => {
    const priorDigest = `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'1'.repeat(64)}`;
    const nextDigest = `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'a'.repeat(64)}`;
    const envPath = writeFixtureEnvFile(
      baseEnvLines.map((line) =>
        line.startsWith('OPENGEN_API_IMAGE=') ? `OPENGEN_API_IMAGE=${priorDigest}` : line,
      ),
    );

    const result = runUpdate(['--env-file=infra/.local/opengen.env', '--build'], {
      env: { GCLOUD_RESOLVED_DIGEST: nextDigest },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.calls).toHaveLength(2);

    const [buildCall, describeCall] = result.calls as [GcloudCall, GcloudCall];
    expect(buildCall.args.slice(0, 4)).toEqual(['builds', 'submit', fixtureRepo, '--project']);
    expect(buildCall.buildConfig).toContain('DOCKER_BUILDKIT=1');
    expect(buildCall.buildConfig).toContain('- --target\n      - server');
    expect(buildCall.buildConfig).toContain(
      `us-central1-docker.pkg.dev/fixture-project/opengen/api:${shortSha}`,
    );
    expect(describeCall.args).toEqual([
      'artifacts',
      'docker',
      'images',
      'describe',
      `us-central1-docker.pkg.dev/fixture-project/opengen/api:${shortSha}`,
      '--project',
      'fixture-project',
      '--format=value(image_summary.fully_qualified_digest)',
      '--quiet',
    ]);

    expect(result.stdout).toContain(`Previous OPENGEN_API_IMAGE: ${priorDigest}`);
    expect(result.stdout).toContain(`Resolved OPENGEN_API_IMAGE: ${nextDigest}`);
    expect(result.stdout).toContain(nextDigest);
    expect(result.stdout).toContain('Image built and pinned. Runtime services were not modified.');

    const updatedEnv = readFileSync(envPath, 'utf8');
    expect(updatedEnv).toContain(`OPENGEN_API_IMAGE=${nextDigest}\n`);
    expect(updatedEnv).not.toContain(priorDigest);
    expect(lstatSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('fails closed if Artifact Registry returns a non-immutable or mismatched image digest', () => {
    const envPath = writeFixtureEnvFile();
    for (const badDigest of [
      '',
      `us-central1-docker.pkg.dev/fixture-project/opengen/api:${shortSha}`,
      `us-central1-docker.pkg.dev/other-project/opengen/api@sha256:${'b'.repeat(64)}`,
      `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'B'.repeat(64)}`,
      `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'b'.repeat(63)}`,
    ]) {
      const result = runUpdate(['--env-file', 'infra/.local/opengen.env', '--build'], {
        env: { GCLOUD_RESOLVED_DIGEST: badDigest },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('immutable 64-character SHA-256 image digest');
      expect(readFileSync(envPath, 'utf8')).toContain('replace-with-digest');
    }
  });

  it('enforces OPENGEN_BILLABLE_RUNTIME_APPROVED and active billing before building or deploying in --apply', () => {
    writeFixtureEnvFile();
    const unapproved = runUpdate(['--env-file', 'infra/.local/opengen.env', '--apply'], {
      forbidGcloud: true,
    });
    expect(unapproved.status).toBe(2);
    expect(unapproved.stderr).toContain('OPENGEN_BILLABLE_RUNTIME_APPROVED=yes');
    expect(unapproved.calls).toEqual([]);

    const unbilled = runUpdate(['--env-file', 'infra/.local/opengen.env', '--apply'], {
      env: {
        OPENGEN_BILLABLE_RUNTIME_APPROVED: 'yes',
        GCLOUD_BILLING_ENABLED: 'False',
      },
    });
    expect(unbilled.status).toBe(2);
    expect(unbilled.stderr).toContain('Billing is not enabled');
    // Fails after the read-only billing check and before submitting a Cloud Build.
    expect(unbilled.calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['billing', 'projects', 'describe'],
    ]);

    const deployedDigest = `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'c'.repeat(64)}`;
    const applied = runUpdate(['--env-file', 'infra/.local/opengen.env', '--apply'], {
      env: {
        OPENGEN_BILLABLE_RUNTIME_APPROVED: 'yes',
        GCLOUD_BILLING_ENABLED: 'True',
        GCLOUD_RESOLVED_DIGEST: deployedDigest,
      },
    });
    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe('');
    expect(applied.calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['billing', 'projects', 'describe'],
      ['builds', 'submit', fixtureRepo],
      ['artifacts', 'docker', 'images'],
      ['billing', 'projects', 'describe'],
      ['run', 'deploy', 'opengen-api'],
      ['run', 'worker-pools', 'deploy'],
    ]);
    for (const runCall of applied.calls.slice(4)) {
      expect(runCall.args).toContain(deployedDigest);
    }
  });

  it('supports --skip-build for rolling out or rolling back an already-pinned digest, including against the real repository script', () => {
    const pinnedDigest = `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'d'.repeat(64)}`;
    writeFixtureEnvFile();

    expect(
      runUpdate(['--env-file', 'infra/.local/opengen.env', '--build', '--skip-build'], {
        forbidGcloud: true,
      }).status,
    ).toBe(2);

    // Rejects placeholder digest when --skip-build is requested.
    expect(
      runUpdate(['--env-file', 'infra/.local/opengen.env', '--skip-build', '--plan'], {
        forbidGcloud: true,
      }).status,
    ).toBe(2);

    writeFixtureEnvFile(
      baseEnvLines.map((line) =>
        line.startsWith('OPENGEN_API_IMAGE=') ? `OPENGEN_API_IMAGE=${pinnedDigest}` : line,
      ),
    );

    const realScriptPlan = runUpdate(['--skip-build', '--plan'], {
      scriptPath: realUpdateScript,
      cwd: realRepoRoot,
      forbidGcloud: true,
      env: {
        OPENGEN_PROJECT_ID: 'fixture-project',
        OPENGEN_REGION: 'us-central1',
        OPENGEN_PUBLIC_URL: 'https://opengen.example',
        OPENGEN_API_IMAGE: pinnedDigest,
        OPENGEN_API_RUNTIME_SA: 'opengen-api@fixture-project.iam.gserviceaccount.com',
        OPENGEN_WORKER_RUNTIME_SA: 'opengen-worker@fixture-project.iam.gserviceaccount.com',
        OPENGEN_CLOUDSQL_CONNECTION: 'fixture-project:us-central1:fixture-db',
        OPENGEN_DATABASE_SECRET: 'database-url',
        OPENGEN_API_TOKEN_SECRET: 'installation-token',
        OPENGEN_SECRET_VERSION: '7',
        OPENGEN_EXECUTION_SCOPE: 'unrestricted',
      },
    });
    expect(realScriptPlan.status).toBe(0);
    expect(realScriptPlan.stdout).toContain(`Pinned server image (skip-build): ${pinnedDigest}`);

    const skipBuildApply = runUpdate(
      ['--env-file', 'infra/.local/opengen.env', '--skip-build', '--apply'],
      {
        env: {
          OPENGEN_BILLABLE_RUNTIME_APPROVED: 'yes',
          GCLOUD_BILLING_ENABLED: 'True',
        },
      },
    );
    expect(skipBuildApply.status).toBe(0);
    expect(skipBuildApply.calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['billing', 'projects', 'describe'],
      ['billing', 'projects', 'describe'],
      ['run', 'deploy', 'opengen-api'],
      ['run', 'worker-pools', 'deploy'],
    ]);
  });

  it('rejects tracked, unignored, symlinked, shell-expanded or secret-bearing --env-file inputs without echoing values', () => {
    // 1. Tracked template file in repository
    const trackedResult = runUpdate(['--env-file', 'infra/opengen.env.example', '--plan'], {
      forbidGcloud: true,
    });
    expect(trackedResult.status).toBe(2);
    expect(trackedResult.stderr).toContain('Tracked repository files cannot be used');

    // 2. Unignored in-repository files (including ..-prefixed filenames at repo root)
    for (const relUnignored of ['infra/unignored.env', '..unignored.env']) {
      const unignored = join(fixtureRepo, relUnignored);
      writeFileSync(unignored, `${baseEnvLines.join('\n')}\n`);
      try {
        const unignoredResult = runUpdate(['--env-file', relUnignored, '--plan'], {
          forbidGcloud: true,
        });
        expect(unignoredResult.status).toBe(2);
        expect(unignoredResult.stderr).toContain('must be git-ignored');
      } finally {
        unlinkSync(unignored);
      }
    }

    // 3. Symlinked env file and symlinked outside directory pointing to tracked file
    const externalEnv = join(sandboxRoot, 'external-valid.env');
    writeFileSync(externalEnv, `${baseEnvLines.join('\n')}\n`);
    const linkedEnv = join(fixtureRepo, 'infra/.local/linked.env');
    symlinkSync(externalEnv, linkedEnv);
    const linkedDir = join(sandboxRoot, 'linked-infra');
    symlinkSync(join(fixtureRepo, 'infra'), linkedDir);
    try {
      expect(runUpdate(['--env-file', linkedEnv, '--plan'], { forbidGcloud: true }).status).toBe(2);
      expect(
        runUpdate(['--env-file', join(linkedDir, 'opengen.env.example'), '--plan'], {
          forbidGcloud: true,
        }).status,
      ).toBe(2);
    } finally {
      unlinkSync(linkedEnv);
      unlinkSync(linkedDir);
    }

    // 4. Raw secrets, PATH hijack, duplicates, and shell command/variable substitutions
    const secretSentinel = 'inline-private-secret-sentinel-do-not-echo';
    const badContents = [
      [...baseEnvLines, `STRIPE_SECRET_KEY=${secretSentinel}`],
      [...baseEnvLines, `DATABASE_URL=postgresql://opengen:${secretSentinel}@localhost/opengen`],
      [...baseEnvLines, `PATH=/tmp/${secretSentinel}`],
      [...baseEnvLines, 'OPENGEN_REGION=us-east1'],
      baseEnvLines.map((line) =>
        line.startsWith('OPENGEN_PUBLIC_URL=')
          ? `OPENGEN_PUBLIC_URL=$(echo https://${secretSentinel}.example)`
          : line,
      ),
      baseEnvLines.map((line) =>
        line.startsWith('OPENGEN_PUBLIC_URL=')
          ? `OPENGEN_PUBLIC_URL=https://\${${secretSentinel}}.example`
          : line,
      ),
      [...baseEnvLines, 'OPENGEN_ARTIFACT_REPOSITORY=../escape'],
      baseEnvLines.map((line) =>
        line.startsWith('OPENGEN_PROVIDER_SECRET_BINDINGS=')
          ? 'OPENGEN_PROVIDER_SECRET_BINDINGS=OPENGEN_API_IMAGE=wrong:1'
          : line,
      ),
    ];

    for (const lines of badContents) {
      writeFixtureEnvFile(lines);
      const result = runUpdate(['--env-file', 'infra/.local/opengen.env', '--plan'], {
        forbidGcloud: true,
      });
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).not.toContain(secretSentinel);
      expect(result.calls).toEqual([]);
    }
  });
});
