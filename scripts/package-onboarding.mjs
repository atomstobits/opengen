import { readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { packageCli, tarHeader } from './package-cli.mjs';
import { claimDirectory, sha256 } from './build-cli.mjs';
import { onboardingOutputs } from './build-onboarding.mjs';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = (value) => JSON.stringify(value, null, 2) + '\n';
async function sourceFile(source, path) {
  const target = join(source, path);
  const info = await lstat(target);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 4_000_000 ||
    (await realpath(target)) !== target
  )
    throw new Error('Release inputs must be bounded regular source files without symlinks.');
  return readFile(target);
}
function archiveFiles(entries) {
  const chunks = [];
  const files = {};
  for (const [path, bytes] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    files[path] = { size: bytes.length, sha256: sha256(bytes), mode: '0644' };
    chunks.push(
      tarHeader(`package/${path}`, bytes.length, false),
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return { bytes: gzipSync(Buffer.concat(chunks), { level: 9 }), files };
}
/** Stages only private release-review files. Never publishes or uploads. */
export async function packageOnboarding({ sourceRoot = root, outputDirectory } = {}) {
  if (!isAbsolute(sourceRoot)) throw new Error('Choose an absolute source root.');
  const source = await realpath(sourceRoot);
  const outputs = await onboardingOutputs(source);
  for (const [path, expected] of outputs)
    if ((await sourceFile(source, path)).toString('utf8') !== expected)
      throw new Error(`Generated onboarding is stale: ${path}`);
  const { version } = JSON.parse((await sourceFile(source, 'package.json')).toString('utf8'));
  const destination = await claimDirectory(outputDirectory);
  try {
    const cli = await packageCli({ sourceRoot: source, outputDirectory: join(destination, 'cli') });
    const cliManifest = JSON.parse(await readFile(cli.manifestPath, 'utf8'));
    const cliBytes = await readFile(cli.tarballPath);
    await writeFile(join(destination, cliManifest.tarball.file), cliBytes, {
      flag: 'wx',
      mode: 0o644,
    });
    const artifacts = {
      cli: {
        ...cliManifest.tarball,
        files: Object.fromEntries(
          cliManifest.files.map(({ path, ...metadata }) => [path, metadata]),
        ),
      },
    };
    const license = await sourceFile(source, 'LICENSE'),
      notice = await sourceFile(source, 'NOTICE');
    for (const [kind, entries] of [
      [
        'skill',
        new Map([
          ['SKILL.md', await sourceFile(source, 'skills/opengen/SKILL.md')],
          ['LICENSE', license],
          ['NOTICE', notice],
        ]),
      ],
      [
        'plugin',
        new Map([
          [
            '.claude-plugin/plugin.json',
            await sourceFile(source, 'plugins/opengen/.claude-plugin/plugin.json'),
          ],
          [
            'skills/opengen/SKILL.md',
            await sourceFile(source, 'plugins/opengen/skills/opengen/SKILL.md'),
          ],
          ['LICENSE', license],
          ['NOTICE', notice],
        ]),
      ],
    ]) {
      const { bytes, files } = archiveFiles(entries);
      const file = `opengen-${kind}-${version}.tgz`;
      await writeFile(join(destination, file), bytes, { flag: 'wx', mode: 0o644 });
      artifacts[kind] = { file, size: bytes.length, sha256: sha256(bytes), files };
    }
    const inputs = [];
    for (const path of [
      'docs/agent/SKILL.md',
      'docs/IMAGE-TO-VIDEO.md',
      'scripts/build-onboarding.mjs',
      'scripts/package-onboarding.mjs',
      'scripts/install-opengen.mjs',
      ...outputs.keys(),
    ])
      inputs.push({ path, sha256: sha256(await sourceFile(source, path)) });
    let sourceRevision = null,
      sourceState = 'unavailable';
    try {
      const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[a-f0-9]{40}$/.test(revision)) sourceRevision = revision;
      sourceState = execFileSync(
        'git',
        ['-C', source, 'status', '--porcelain', '--untracked-files=all'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
        ? 'uncommitted-inputs'
        : 'clean';
    } catch {
      /* A supplied source archive may have no Git metadata. Hashes remain authoritative. */
    }
    const provenance = {
      schemaVersion: 1,
      type: 'opengen-local-build-provenance',
      version,
      source: { revision: sourceRevision, state: sourceState, inputs },
      builder: { node: process.versions.node, zlib: process.versions.zlib },
      cliBuildManifestSha256: cliManifest.buildManifestSha256,
      subjects: Object.values(artifacts).map(({ file, sha256 }) => ({ file, sha256 })),
      attestation:
        'Unsigned local evidence. Not a publisher signature, SLSA certification or public release. Verify the expected release-manifest digest through a trusted channel.',
    };
    const provenanceBytes = Buffer.from(json(provenance));
    await writeFile(join(destination, 'PROVENANCE.json'), provenanceBytes, {
      flag: 'wx',
      mode: 0o644,
    });
    const installer = await sourceFile(source, 'scripts/install-opengen.mjs');
    await writeFile(join(destination, 'install-opengen.mjs'), installer, {
      flag: 'wx',
      mode: 0o644,
    });
    const releaseManifest = {
      schemaVersion: 1,
      version,
      publication: 'unpublished-review-candidate',
      artifacts,
      files: {
        'install-opengen.mjs': { sha256: sha256(installer), size: installer.length },
        'PROVENANCE.json': { sha256: sha256(provenanceBytes), size: provenanceBytes.length },
      },
    };
    const manifestBytes = Buffer.from(json(releaseManifest));
    await writeFile(join(destination, 'RELEASE-MANIFEST.json'), manifestBytes, {
      flag: 'wx',
      mode: 0o644,
    });
    const checksums = [
      [sha256(manifestBytes), 'RELEASE-MANIFEST.json'],
      ...Object.values(artifacts).map(({ sha256, file }) => [sha256, file]),
      ...Object.entries(releaseManifest.files).map(([file, { sha256 }]) => [sha256, file]),
    ]
      .map(([hash, file]) => `${hash}  ${file}\n`)
      .join('');
    await writeFile(join(destination, 'SHA256SUMS'), checksums, { flag: 'wx', mode: 0o644 });
    return {
      releaseDirectory: destination,
      version,
      manifestSha256: sha256(manifestBytes),
      publication: releaseManifest.publication,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        'repo-root': { type: 'string' },
        'out-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'Private staging: node scripts/package-onboarding.mjs --repo-root /absolute/source --out-dir /absolute/new/release',
      );
    else
      console.log(
        json(
          await packageOnboarding({
            sourceRoot: values['repo-root'],
            outputDirectory: values['out-dir'],
          }),
        ),
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
