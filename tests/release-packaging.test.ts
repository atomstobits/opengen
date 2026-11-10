import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opengen-release-check-'));
  directories.push(directory);
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(
    new URL('../scripts/security-check.mjs', import.meta.url),
    join(directory, 'scripts/security-check.mjs'),
  );
  writeFileSync(join(directory, 'README.md'), '# Synthetic source archive\n');
  return directory;
}
const run = (directory: string) =>
  spawnSync(process.execPath, ['scripts/security-check.mjs'], { cwd: directory, encoding: 'utf8' });
const syntheticToken = () => 'sk-proj-' + 'x'.repeat(40);

it('checks extracted source without Git while excluding installed dependencies and build/test output', () => {
  const directory = fixture();
  for (const output of [
    'node_modules',
    '.next',
    '.turbo',
    'dist',
    'coverage',
    'test-results',
    'playwright-report',
    'docs/evidence',
  ]) {
    mkdirSync(join(directory, output), { recursive: true });
    writeFileSync(join(directory, output, '.env'), syntheticToken());
  }
  writeFileSync(join(directory, '.env.example'), 'PROVIDER_API_KEY=\n');
  const result = run(directory);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Source archive hygiene passed');
  expect(result.stdout).toContain('Git history is absent and was not checked');
});

it('rejects private archive configuration even when its .gitignore excludes it', () => {
  const directory = fixture();
  const token = syntheticToken();
  writeFileSync(join(directory, '.gitignore'), '.env*\n');
  writeFileSync(join(directory, '.env.providers.local'), `PROVIDER_API_KEY=${token}\n`);
  writeFileSync(join(directory, 'credentials-test.json'), '{}');
  const result = run(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('.env.providers.local: forbidden release path');
  expect(result.stderr).toContain('credentials-test.json: forbidden release path');
  expect(result.stdout + result.stderr).not.toContain(token);
});

it('rejects source symlinks without following them outside the archive', () => {
  const directory = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'opengen-release-link-'));
  directories.push(outside);
  writeFileSync(join(outside, 'private.js'), syntheticToken());
  symlinkSync(join(outside, 'private.js'), join(directory, 'linked-file.js'));
  symlinkSync(outside, join(directory, 'linked-directory'));
  const result = run(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('linked-file.js: symbolic link requires release review');
  expect(result.stderr).toContain('linked-directory: symbolic link requires release review');
  expect(result.stderr).not.toContain('provider-key');
});

it('keeps Git source selection when repository metadata exists', () => {
  const directory = fixture();
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  writeFileSync(join(directory, '.gitignore'), '.env\n');
  writeFileSync(join(directory, '.env'), syntheticToken());
  const result = run(directory);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Repository hygiene passed');
  expect(result.stdout).toContain('Run Gitleaks over Git history');
  expect(result.stdout).not.toContain('Source archive hygiene passed');
});

it('does not treat broken Git metadata as a successful archive check', () => {
  const directory = fixture();
  writeFileSync(join(directory, '.git'), `gitdir: ${join(directory, 'missing-git-directory')}\n`);
  const result = run(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unable to enumerate source files');
  expect(result.stdout).not.toContain('hygiene passed');
});

it('does not read through a linked parent of a Git-listed file', () => {
  const directory = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'opengen-release-parent-'));
  directories.push(outside);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src', 'code.js'), '// Synthetic source.\n');
  execFileSync('git', ['add', 'src/code.js'], { cwd: directory });
  rmSync(join(directory, 'src'), { recursive: true });
  writeFileSync(join(outside, 'code.js'), syntheticToken());
  symlinkSync(outside, join(directory, 'src'));
  const result = run(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('src/code.js: unreadable or symbolic source path');
  expect(result.stderr).not.toContain('provider-key');
});

it.each([
  '.local/account.json',
  '.local/.env.example',
  'docs/evidence/private-receipt.json',
  'backups/workspace.dump',
  'dist/generated.js',
  'artifacts/cli/opengen.tgz',
])('rejects forced Git-listed private or generated release path %s', (file) => {
  const directory = fixture();
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  writeFileSync(
    join(directory, '.gitignore'),
    '.local/\ndocs/evidence/\nbackups/\ndist/\nartifacts/\n',
  );
  mkdirSync(join(directory, file, '..'), { recursive: true });
  writeFileSync(join(directory, file), 'Synthetic non-secret release artifact.\n');
  execFileSync('git', ['add', '--force', file], { cwd: directory });
  const result = run(directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file}: forbidden release path`);
  expect(result.stdout).not.toContain('hygiene passed');
});

it.each(['.local/account.json', 'backups/workspace.dump', 'workspace.backup', 'state.sqlite3'])(
  'rejects private or backup archive path %s without Git metadata',
  (file) => {
    const directory = fixture();
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), 'Synthetic non-secret private artifact.\n');
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}: forbidden release path`);
    expect(result.stdout).not.toContain('hygiene passed');
  },
);

it.each(['file', 'parent'] as const)(
  'rejects a linked %s before staging the tree for the directory secret scan',
  (kind) => {
    const directory = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'opengen-release-scan-link-'));
    directories.push(outside);
    copyFileSync(
      new URL('../scripts/scan-secrets.mjs', import.meta.url),
      join(directory, 'scripts/scan-secrets.mjs'),
    );
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    const token = syntheticToken();
    writeFileSync(join(outside, 'private.js'), token);
    const file = kind === 'file' ? 'linked-file.js' : 'src/private.js';
    if (kind === 'file') symlinkSync(join(outside, 'private.js'), join(directory, file));
    else {
      mkdirSync(join(directory, 'src'));
      writeFileSync(join(directory, file), '// Synthetic original source.\n');
      execFileSync('git', ['add', file], { cwd: directory });
      rmSync(join(directory, 'src'), { recursive: true });
      symlinkSync(outside, join(directory, 'src'));
    }
    const binary = join(outside, 'fake-gitleaks.mjs');
    const log = join(outside, 'calls.txt');
    writeFileSync(
      binary,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GITLEAKS_TEST_LOG, process.argv[2] + '\\n');\n`,
    );
    chmodSync(binary, 0o700);
    const result = spawnSync(process.execPath, ['scripts/scan-secrets.mjs'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITLEAKS_BINARY: binary, GITLEAKS_TEST_LOG: log },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}: unreadable or symbolic source path`);
    expect(result.stderr).toContain('Source tree staging failed; no secret-scan pass was issued.');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['version', 'git']);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(outside);
    expect(result.stdout).not.toContain('Gitleaks passed');
  },
);
