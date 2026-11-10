import { readFile, writeFile, lstat, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildCli, buildArguments, claimDirectory, packageFiles, sha256 } from './build-cli.mjs';

// Fixed USTAR records avoid npm lifecycle hooks, external archive tools and environment metadata.
// npm accepts the standard package/ prefix. No symlinks, PAX metadata or arbitrary file glob is used.
export function tarHeader(name, size, executable) {
  if (!/^package\/[A-Za-z0-9./_-]+$/.test(name) || Buffer.byteLength(name) > 100)
    throw new Error('Unapproved package archive path.');
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
  const octal = (offset, length, value) =>
    field(offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
  field(0, 100, name);
  octal(100, 8, executable ? 0o755 : 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  header.fill(0x20, 148, 156);
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}
async function contents(root, prefix = '') {
  const files = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('Symlinks are forbidden in CLI packages.');
    if (info.isDirectory()) files.push(...(await contents(root, path)));
    else if (info.isFile()) files.push(path);
    else throw new Error('Only regular files can enter the CLI package.');
  }
  return files.sort();
}

/** Build and pack a new local npm-installable archive. Never executes npm or package scripts. */
export async function packageCli({ sourceRoot, outputDirectory } = {}) {
  const destination = await claimDirectory(outputDirectory);
  try {
    const { packageDirectory, manifest } = await buildCli({
      sourceRoot,
      outputDirectory: join(destination, 'package'),
    });
    const paths = await contents(packageDirectory);
    if (JSON.stringify(paths) !== JSON.stringify(packageFiles))
      throw new Error('CLI package contains a file outside the exact allowlist.');
    const chunks = [],
      files = [];
    for (const path of paths) {
      const bytes = await readFile(join(packageDirectory, path));
      const hash = sha256(bytes);
      const executable = path === 'bin/opengen.mjs';
      const reviewed = manifest.files.find((file) => file.path === path);
      if (
        path !== 'BUILD-MANIFEST.json' &&
        (!reviewed || reviewed.sha256 !== hash || reviewed.size !== bytes.length)
      )
        throw new Error('CLI package changed after its build manifest was created.');
      files.push({ path, size: bytes.length, sha256: hash, mode: executable ? '0755' : '0644' });
      chunks.push(
        tarHeader(`package/${path}`, bytes.length, executable),
        bytes,
        Buffer.alloc((512 - (bytes.length % 512)) % 512),
      );
    }
    chunks.push(Buffer.alloc(1024));
    const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
    const filename = `${manifest.name}-${manifest.version}.tgz`;
    const tarballPath = join(destination, filename);
    const sha256Path = `${tarballPath}.sha256`;
    const manifestPath = join(destination, `${manifest.name}-${manifest.version}.manifest.json`);
    const hash = sha256(archive);
    const releaseManifest = {
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version,
      tarball: { file: filename, size: archive.length, sha256: hash },
      buildManifestSha256: files.find((file) => file.path === 'BUILD-MANIFEST.json').sha256,
      files,
    };
    await writeFile(tarballPath, archive, { flag: 'wx', mode: 0o644 });
    await writeFile(sha256Path, `${hash}  ${filename}\n`, { flag: 'wx', mode: 0o644 });
    await writeFile(manifestPath, JSON.stringify(releaseManifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o644,
    });
    return { packageDirectory, tarballPath, sha256Path, manifestPath };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = buildArguments(process.argv.slice(2));
    if (values.help)
      console.log(
        'Package locally: node scripts/package-cli.mjs --repo-root /absolute/source --out-dir /absolute/new/release',
      );
    else
      console.log(
        JSON.stringify(
          await packageCli({ sourceRoot: values['repo-root'], outputDirectory: values['out-dir'] }),
          null,
          2,
        ),
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CLI packaging failed.');
    process.exitCode = 1;
  }
}
