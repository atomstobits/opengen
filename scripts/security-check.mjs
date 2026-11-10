import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Fast repository hygiene, in addition to the required Gitleaks history scan.
// Findings contain paths/rule IDs only; never echo the possible credential.
const root = fileURLToPath(new URL('../', import.meta.url));
const repository = existsSync(join(root, '.git'));
// Archive installation creates these directories. They are not release source.
// Git mode still checks them if someone accidentally tracks a generated file.
const generated = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);
const findings = [];
function archiveFiles(directory = '') {
  const files = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (generated.has(entry.name) || file === 'docs/evidence') continue;
    if (entry.isSymbolicLink()) findings.push(`${file}: symbolic link requires release review`);
    else if (entry.isDirectory()) files.push(...archiveFiles(file));
    else if (entry.isFile()) files.push(file);
    else findings.push(`${file}: unsupported source entry`);
  }
  return files;
}
let files;
try {
  files = repository
    ? [
        ...new Set(
          execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          })
            .split('\0')
            .filter(Boolean),
        ),
      ]
    : archiveFiles();
} catch {
  console.error(
    'Unable to enumerate source files. Check Git metadata or filesystem access; no hygiene pass was issued.',
  );
  process.exit(1);
}
const forbidden =
  /(^|\/)(?:\.vercel|\.local|node_modules|\.next|\.turbo|dist|coverage|test-results|playwright-report|backups|artifacts)(?:\/|$)|^docs\/evidence(?:\/|$)|\.(?:pem|key|p12|pfx|dump|backup|sqlite3?|db|tar\.gz|tgz|tsbuildinfo|log)$|(?:^|\/)(?:credentials[^/]*|[^/]*service-account[^/]*)\.json$|(?:^|\/)\.DS_Store$/i;
const privateEnvironment = /(^|\/)\.env(?:\..*)?(?:\/|$)/i;
const templates = /(?:^|\/)(?:\.env\.example|[^/]+\.env\.example)$/;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['provider-key', /\b(?:sk-proj-|sk-ant-|xai-)[A-Za-z0-9_-]{35,}\b/],
  ['google-service-account', /"type"\s*:\s*"service_account"/],
];
for (const file of files) {
  if (forbidden.test(file) || (privateEnvironment.test(file) && !templates.test(file)))
    findings.push(`${file}: forbidden release path`);
  let body;
  try {
    // Check every component so neither a file link nor a linked parent can
    // cause a Git-listed path to read outside the proposed source tree.
    let current = root;
    for (const segment of file.split('/')) {
      if (!segment || segment === '.' || segment === '..') throw new Error('invalid source path');
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error('symbolic source path');
    }
    if (!lstatSync(current).isFile()) throw new Error('non-file source path');
    body = readFileSync(current, 'utf8');
  } catch (error) {
    // A tracked deletion is absent from the proposed working tree. Other read
    // errors must fail rather than silently hiding an unscanned source file.
    if (!repository || error.code !== 'ENOENT')
      findings.push(`${file}: unreadable or symbolic source path`);
    continue;
  }
  for (const [id, pattern] of rules) if (pattern.test(body)) findings.push(`${file}: ${id}`);
}
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    repository
      ? `Repository hygiene passed (${files.length} source files). Run Gitleaks over Git history before publishing.`
      : `Source archive hygiene passed (${files.length} source files). Git history is absent and was not checked; run Gitleaks on the source repository before publishing.`,
  );
