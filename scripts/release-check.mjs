import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const required = [
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'docs/PLAN.md',
  'docs/STATUS.md',
  'docs/RELEASE.md',
  'docs/DEPENDENCIES.md',
  'docs/OPERATIONS.md',
  '.env.example',
  '.dockerignore',
  'Dockerfile',
  'deploy/compose.yaml',
  '.github/workflows/check.yml',
];
const failures = required
  .filter((file) => !existsSync(new URL(file, root)))
  .map((file) => `Missing ${file}`);
const packages = [
  'package.json',
  'apps/cli/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/contracts/package.json',
  'packages/catalog/package.json',
  'packages/engine/package.json',
  'packages/sdk/package.json',
];
for (const file of packages) {
  const pkg = JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  if (pkg.license !== 'Apache-2.0') failures.push(`${file}: declare Apache-2.0`);
  if (pkg.version !== '0.1.1') failures.push(`${file}: release version differs from 0.1.1`);
}
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const unknown = [];
const restricted = [];
for (const [name, dependency] of Object.entries(lock.packages)) {
  if (!name.includes('node_modules/') || dependency.link) continue;
  if (!dependency.license) unknown.push(name);
  else if (/AGPL|SSPL|BUSL|CC-BY-NC|UNLICENSED/i.test(dependency.license)) restricted.push(name);
}
if (restricted.length)
  failures.push(`Review restricted dependency licenses: ${restricted.join(', ')}`);
// Missing package metadata needs human review; it does not automatically prove an incompatible license.
if (unknown.length) console.warn(`License metadata needs review: ${unknown.join(', ')}`);
try {
  execFileSync(process.execPath, ['scripts/security-check.mjs'], { cwd: root, stdio: 'inherit' });
} catch {
  failures.push('Repository hygiene failed');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Release packaging checks passed. This checks files/licenses, not the live-provider or release acceptance gates in docs/RELEASE.md.',
  );
