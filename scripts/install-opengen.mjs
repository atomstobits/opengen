#!/usr/bin/env node
// Offline installer: reads only a reviewed release bundle, writes only new explicit destinations.
import { constants } from 'node:fs';
import { open, realpath, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function regular(path, limit = 8_000_000) {
  if ((await realpath(path)) !== path) throw new Error('Release files must not use symlinks.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error('Expected a bounded regular release file.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error('Release file exceeded the size limit.');
    return bytes;
  } finally {
    await handle.close();
  }
}
function unpack(archive, expected) {
  const bytes = gunzipSync(archive, { maxOutputLength: 16_000_000 });
  const entries = new Map();
  let offset = 0;
  for (; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('ascii')
        .replace(/\0.*$/s, '');
    const name = field(0, 100),
      type = field(156, 1);
    const path = name.replace(/^package\//, '');
    const checksum = [...header].reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    const size = Number.parseInt(field(124, 12), 8);
    const mode = Number.parseInt(field(100, 8), 8);
    if (
      !name.startsWith('package/') ||
      !Object.hasOwn(expected, path) ||
      entries.has(path) ||
      !['0', ''].includes(type) ||
      field(157, 100) ||
      field(345, 155) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > bytes.length ||
      Number.parseInt(field(148, 8), 8) !== checksum ||
      ![0o644, 0o755].includes(mode)
    )
      throw new Error('Release archive contains an unapproved path, mode or record.');
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    const reviewed = expected[path];
    if (
      reviewed.sha256 !== digest(content) ||
      reviewed.size !== content.length ||
      Number.parseInt(reviewed.mode, 8) !== mode
    )
      throw new Error('Release archive disagrees with its reviewed file manifest.');
    entries.set(path, { content, mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    bytes.length - offset < 1024 ||
    bytes.subarray(offset).some((value) => value !== 0) ||
    entries.size !== Object.keys(expected).length
  )
    throw new Error('Release archive is truncated or has unapproved trailing data.');
  return entries;
}
const paths = {
  cli: [
    'BUILD-MANIFEST.json',
    'LICENSE',
    'NOTICE',
    'README.md',
    'THIRD-PARTY-NOTICES.txt',
    'bin/opengen.mjs',
    'package.json',
  ],
  skill: ['LICENSE', 'NOTICE', 'SKILL.md'],
  plugin: ['.claude-plugin/plugin.json', 'LICENSE', 'NOTICE', 'skills/opengen/SKILL.md'],
};
export async function installOpenGen(args) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error('Node 22.12 or newer is required.');
  const { values } = parseArgs({
    args,
    options: {
      'release-dir': { type: 'string' },
      'expected-manifest-sha256': { type: 'string' },
      prefix: { type: 'string' },
      'skill-dir': { type: 'string' },
      'plugin-dir': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    return 'Offline install: node install-opengen.mjs --release-dir /absolute/reviewed/download --expected-manifest-sha256 REVIEWED_DIGEST --prefix /absolute/new/client --skill-dir /absolute/new/opengen-skill [--plugin-dir /absolute/new/opengen-plugin]';
  if (!/^[a-f0-9]{64}$/.test(values['expected-manifest-sha256'] ?? ''))
    throw new Error('Supply the expected manifest SHA-256 from your trusted release channel.');
  for (const key of [
    'release-dir',
    'prefix',
    'skill-dir',
    ...(values['plugin-dir'] ? ['plugin-dir'] : []),
  ])
    if (!values[key] || !isAbsolute(values[key]))
      throw new Error(`Supply an explicit absolute --${key}.`);
  const release = await realpath(values['release-dir']);
  const manifestBytes = await regular(join(release, 'RELEASE-MANIFEST.json'));
  if (digest(manifestBytes) !== values['expected-manifest-sha256'])
    throw new Error('Release manifest SHA-256 does not match the reviewed digest.');
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) ||
    manifest.publication !== 'unpublished-review-candidate'
  )
    throw new Error('Unsupported release manifest.');
  const targets = {
    cli: resolve(values.prefix),
    skill: resolve(values['skill-dir']),
    ...(values['plugin-dir'] ? { plugin: resolve(values['plugin-dir']) } : {}),
  };
  const decoded = new Map();
  for (const kind of Object.keys(targets)) {
    const artifact = manifest.artifacts?.[kind];
    const expectedName = `opengen-${kind}-${manifest.version}.tgz`;
    if (
      !artifact ||
      artifact.file !== expectedName ||
      JSON.stringify(Object.keys(artifact.files).sort()) !== JSON.stringify(paths[kind])
    )
      throw new Error('Unapproved release artifact/file list.');
    const archive = await regular(join(release, expectedName));
    if (digest(archive) !== artifact.sha256 || archive.length !== artifact.size)
      throw new Error('Release archive checksum mismatch.');
    decoded.set(kind, unpack(archive, artifact.files));
  }
  const destinations = Object.values(targets);
  for (const destination of destinations) {
    if ((await realpath(dirname(destination))) !== dirname(destination))
      throw new Error('Choose real destination parents without symlinks.');
    if (destinations.some((other) => other !== destination && destination.startsWith(other + '/')))
      throw new Error('Install destinations must not contain one another.');
    try {
      await lstat(destination);
      throw new Error('Install destinations must be new; existing files are never overwritten.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (new Set(destinations).size !== destinations.length)
    throw new Error('Choose different CLI, skill and plugin destinations.');
  const created = [];
  try {
    for (const [kind, destination] of Object.entries(targets)) {
      await mkdir(destination, { mode: 0o700 });
      created.push(destination);
      for (const [path, { content, mode }] of decoded.get(kind)) {
        await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(destination, path), content, { flag: 'wx', mode });
      }
    }
  } catch (error) {
    for (const path of created) await rm(path, { recursive: true, force: true });
    throw error;
  }
  return {
    version: manifest.version,
    executable: join(targets.cli, 'bin/opengen.mjs'),
    skillDirectory: targets.skill,
    ...(targets.plugin ? { pluginDirectory: targets.plugin } : {}),
    next: 'Set MEDIA_ROUTER_URL to the configured gateway; run doctor, login, then doctor. No credentials, network calls or client configuration were changed.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await installOpenGen(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
