import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const destination = process.argv[2];
if (!destination || !destination.endsWith('.tar.gz')) {
  console.error('Usage: npm run release:archive -- /absolute/path/opengen-0.1.0.tar.gz');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
if (git('status', '--porcelain').trim()) {
  console.error(
    'Commit the reviewed release tree before creating an archive; dirty/untracked source would be omitted.',
  );
  process.exit(1);
}
execFileSync(process.execPath, ['scripts/release-check.mjs'], { cwd: root, stdio: 'inherit' });
const commit = git('rev-parse', 'HEAD').trim();
const tar = execFileSync('git', ['archive', '--format=tar', '--prefix=opengen-0.1.0/', commit], {
  cwd: root,
  maxBuffer: 128 * 1024 * 1024,
});
const archive = gzipSync(tar, { level: 9 });
const file = resolve(destination);
writeFileSync(file, archive, { flag: 'wx', mode: 0o644 });
writeFileSync(
  `${file}.sha256`,
  `${createHash('sha256').update(archive).digest('hex')}  ${file.split('/').at(-1)}\n`,
  { flag: 'wx', mode: 0o644 },
);
console.log(
  `Created source archive and SHA-256 for ${commit}. Verify the acceptance checklist before publishing.`,
);
