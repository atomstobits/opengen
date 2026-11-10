import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, mkdirSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.GITLEAKS_BINARY || 'gitleaks';
try {
  execFileSync(binary, ['version'], { stdio: 'ignore' });
} catch {
  console.error(
    'Gitleaks is required. Install the pinned version from docs/RELEASE.md, or set GITLEAKS_BINARY to its executable.',
  );
  process.exit(2);
}
const config = join(root, '.gitleaks.toml');
const run = (args) =>
  execFileSync(binary, [...args, '--config', config, '--redact', '--no-banner'], {
    cwd: root,
    stdio: 'inherit',
  });
run(['git', root, '--log-opts=--all']);
// Scan the proposed source tree too, including untracked release files but no ignored
// .env, node_modules, .next, local account bindings, evidence or test artifacts.
const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean);
const staging = mkdtempSync(join(tmpdir(), 'opengen-secret-scan-'));
try {
  let failed = false;
  for (const file of new Set(files)) {
    try {
      // Git may list a symlink or a tracked path whose parent was replaced by
      // one. Never stage bytes from outside the proposed source tree.
      let current = root;
      for (const segment of file.split('/')) {
        if (!segment || segment === '.' || segment === '..') throw new Error('invalid source path');
        current = join(current, segment);
        if (lstatSync(current).isSymbolicLink()) throw new Error('symbolic source path');
      }
      if (!lstatSync(current).isFile()) throw new Error('non-file source path');
      const destination = join(staging, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(current, destination);
    } catch (error) {
      // Tracked deletions are absent from the proposed tree; other failures
      // cannot silently hide an unscanned file. Report no external path/value.
      if (error.code !== 'ENOENT') {
        console.error(`${file}: unreadable or symbolic source path`);
        failed = true;
      }
    }
  }
  if (failed) {
    console.error('Source tree staging failed; no secret-scan pass was issued.');
    process.exitCode = 1;
  } else {
    run(['dir', staging]);
    console.log('Gitleaks passed for Git history and proposed source tree.');
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
