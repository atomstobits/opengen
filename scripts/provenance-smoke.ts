#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { verifyC2pa, type ProvenanceRunner } from '../packages/engine/src/provenance.js';

// Update the version, official asset ID and integrity pins together when upgrading.
const version = '0.28.4';
const archiveAssetId = 679841191;
const archiveSha256 = '097e9efaff765baf7738a40c640012419cad419ce3e1aa36cf68e0576309c971';
const anchorsSha256 = 'a800641aeb9d04c603ba4d20ef676a3da2c243ab8267318356737f7afb189fcf';
const archiveUrl = `https://api.github.com/repos/contentauth/c2patool/releases/assets/${archiveAssetId}`;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const toolPath = '/opt/c2patool/c2patool';

// Original, generated fixture pixels; no user media or downloaded example images.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const value = Buffer.alloc(data.byteLength + 12);
  value.writeUInt32BE(data.byteLength);
  value.write(type, 4, 'ascii');
  value.set(data, 8);
  value.writeUInt32BE(crc32(value.subarray(4, value.length - 4)), value.length - 4);
  return value;
}
export function unsignedPng(red: number): Buffer {
  const width = 32,
    height = 32,
    pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      pixels[offset] = red;
      pixels[offset + 1] = 40;
      pixels[offset + 2] = 90;
      pixels[offset + 3] = 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function findImageData(bytes: Buffer) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert(offset + length + 12 <= bytes.length, 'Malformed fixture PNG.');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') return { offset, length };
    offset += length + 12;
  }
  throw new Error('Fixture PNG lacks image data.');
}
export function tamperedPng(signed: Buffer): Buffer {
  const alternate = unsignedPng(10),
    source = findImageData(alternate),
    target = findImageData(signed);
  assert.equal(source.length, target.length, 'Signing unexpectedly re-encoded the fixture.');
  const changed = Buffer.from(signed);
  // Preserve the embedded C2PA manifest, PNG structure and CRC; change only valid pixel data.
  alternate.copy(changed, target.offset, source.offset, source.offset + source.length + 12);
  assert.notEqual(hash(changed), hash(signed));
  assert.equal(
    inflateSync(changed.subarray(target.offset + 8, target.offset + 8 + target.length)).length,
    32 * (1 + 32 * 4),
  );
  return changed;
}
async function downloadArchive(): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'OpenGen-CI',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const signal = AbortSignal.timeout(60_000);
  let url = new URL(archiveUrl),
    response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(url, { headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (redirects === 3 || !location || !URL.canParse(location, url.href))
      throw new Error(`Pinned c2patool ${version} download has an invalid or excessive redirect.`);
    const next = new URL(location, url.href);
    if (next.protocol !== 'https:' || next.username || next.password)
      throw new Error(`Pinned c2patool ${version} download requires an HTTPS redirect.`);
    // Never restore credentials if a later redirect returns to the original API origin.
    if (next.origin !== url.origin) delete headers.Authorization;
    url = next;
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    throw new Error(`Pinned c2patool ${version} download failed (HTTP ${response?.status ?? 0}).`);
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Verifier archive exceeds its bound.');
      }
      chunks.push(value.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(hash(bytes), archiveSha256, 'Official release archive checksum mismatch.');
  return bytes;
}
export async function provenanceSmoke() {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    !process.getuid ||
    process.getuid() === 0
  )
    throw new Error(
      'This integration smoke requires a non-root Linux x64 user and a local Docker daemon.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'opengen-provenance-smoke-'));
  const dockerConfig = join(directory, 'docker-config');
  await mkdir(dockerConfig, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    DOCKER_CONFIG: dockerConfig,
  };
  const run = (
    executable: string,
    args: string[],
    options: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
  ) =>
    new Promise<{ stdout: string; stderr: string; exitCode: number | string; killed?: boolean }>(
      (resolveResult) => {
        execFile(
          executable,
          args,
          {
            env: environment,
            encoding: 'utf8',
            timeout: options.timeout ?? 60_000,
            maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
            cwd: options.cwd ?? directory,
            shell: false,
            killSignal: 'SIGKILL',
          },
          (error, stdout, stderr) => {
            const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
            resolveResult({
              stdout,
              stderr,
              exitCode: failure?.code ?? 0,
              killed: failure?.killed,
            });
          },
        );
      },
    );
  const checked = async (
    executable: string,
    args: string[],
    options?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => {
    const result = await run(executable, args, options);
    if (result.exitCode !== 0)
      throw new Error(`Fixture setup ${executable} failed: ${result.stderr.slice(-3000)}`);
    return result.stdout.trim();
  };
  let imageId: string | undefined;
  try {
    await checked('docker', ['info', '--format', '{{.ServerVersion}}']);
    const context = join(directory, 'image');
    await mkdir(context);
    const archive = join(directory, 'c2patool.tar.gz');
    await writeFile(archive, await downloadArchive(), { mode: 0o600 });
    // Only the executable and public trust bundle are extracted; packaged development private-key files are excluded.
    await checked('tar', [
      '-xzf',
      archive,
      '-C',
      context,
      '--strip-components=1',
      'c2patool/c2patool',
      'c2patool/sample/trust_anchors.pem',
    ]);
    assert.equal(
      hash(await readFile(join(context, 'sample/trust_anchors.pem'))),
      anchorsSha256,
      'Bundled public test anchors changed.',
    );
    await chmod(join(context, 'c2patool'), 0o755);
    await writeFile(
      join(context, 'Dockerfile'),
      `FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3t64 && rm -rf /var/lib/apt/lists/*\nCOPY c2patool /opt/c2patool/c2patool\nENTRYPOINT ["/opt/c2patool/c2patool"]\n`,
    );
    const image = `opengen-c2pa-smoke:${randomUUID()}`;
    await checked('docker', ['build', '--tag', image, context], {
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    imageId = await checked('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const docker = async (
      workingDirectory: string,
      args: string[],
      writable = false,
      timeout = 15_000,
    ) => {
      const name = `opengen-c2pa-${randomUUID()}`;
      const mapped = args.map((arg) =>
        arg.startsWith(workingDirectory + sep)
          ? '/work/' + relative(workingDirectory, arg).split(sep).join('/')
          : arg,
      );
      try {
        return await run(
          'docker',
          [
            'run',
            '--rm',
            '--pull=never',
            '--name',
            name,
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--pids-limit=32',
            '--memory=256m',
            '--cpus=1',
            '--user',
            `${process.getuid!()}:${process.getgid!()}`,
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=32m',
            '--workdir',
            '/work',
            '--mount',
            `type=bind,source=${workingDirectory},target=/work${writable ? '' : ',readonly'}`,
            '--env',
            'HOME=/tmp',
            '--env',
            'TMPDIR=/tmp',
            '--env',
            'C2PATOOL_SETTINGS=/work/settings.json',
            imageId!,
            ...mapped,
          ],
          { cwd: workingDirectory, timeout },
        );
      } finally {
        await run('docker', ['rm', '--force', name], { timeout: 10_000 });
      }
    };
    const fixture = join(directory, 'fixtures');
    await mkdir(fixture, { mode: 0o700 });
    const offline = {
      version: 1,
      core: {
        allowed_network_hosts: [],
        allow_redirects: false,
        decode_identity_assertions: false,
      },
      verify: { remote_manifest_fetch: false, ocsp_fetch: false, verify_after_reading: true },
    };
    await writeFile(join(fixture, 'settings.json'), JSON.stringify(offline), { mode: 0o600 });
    await writeFile(join(fixture, 'unsigned.png'), unsignedPng(220), { mode: 0o600 });
    await writeFile(
      join(fixture, 'manifest.json'),
      JSON.stringify({
        claim_version: 2,
        title: 'OpenGen synthetic C2PA smoke',
        claim_generator_info: [{ name: 'OpenGen integration fixture', version: '0.1.0' }],
        assertions: [
          {
            label: 'c2pa.actions.v2',
            data: {
              actions: [
                {
                  action: 'c2pa.created',
                  digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalArt',
                },
              ],
              allActionsIncluded: true,
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const toolVersion = await docker(fixture, ['--version']);
    assert.equal(toolVersion.exitCode, 0, toolVersion.stderr);
    assert.match(toolVersion.stdout, /0\.28\.4/);
    // Omitting signer fields deliberately selects the pinned tool's documented built-in development signer, without a TSA URL.
    const signedResult = await docker(
      fixture,
      [
        'unsigned.png',
        '--manifest',
        'manifest.json',
        '--output',
        'signed.png',
        '--settings',
        'settings.json',
      ],
      true,
    );
    assert.equal(signedResult.exitCode, 0, `Development signing failed: ${signedResult.stderr}`);
    const unsigned = await readFile(join(fixture, 'unsigned.png')),
      signed = await readFile(join(fixture, 'signed.png')),
      tampered = tamperedPng(signed);
    const anchors = join(directory, 'test-anchors.pem');
    await writeFile(anchors, await readFile(join(context, 'sample/trust_anchors.pem')), {
      mode: 0o600,
    });
    const diagnostics: {
      exitCode: number | string;
      stderr: string;
      outputPrefix: string;
      outputSuffix: string;
    }[] = [];
    const runner: ProvenanceRunner = async (_executable, args, options) => {
      const result = await docker(options.cwd, args, false, options.timeout);
      // Synthetic fixture reports only, for diagnosing real CLI/settings changes.
      diagnostics.push({
        exitCode: result.exitCode,
        stderr: result.stderr.slice(-2000),
        outputPrefix: result.stdout.slice(0, 4000),
        outputSuffix: result.stdout.slice(-4000),
      });
      return result;
    };
    const common = { toolPath, networkIsolated: true, run: runner };
    const absent = await verifyC2pa(unsigned, 'image/png', common);
    const valid = await verifyC2pa(signed, 'image/png', common);
    const trusted = await verifyC2pa(signed, 'image/png', { ...common, trustAnchorsPath: anchors });
    const invalid = await verifyC2pa(tampered, 'image/png', {
      ...common,
      trustAnchorsPath: anchors,
    });
    const report = {
      toolVersion: toolVersion.stdout.trim(),
      archiveSha256,
      imageId,
      isolation: {
        network: 'none',
        rootFilesystem: 'read-only',
        capabilities: 'ALL dropped',
        noNewPrivileges: true,
        workerMount: 'read-only',
      },
      fixtures:
        'original generated PNG; pinned built-in development signer; public test anchors only',
      results: { absent, valid, trusted, invalid },
      diagnostics,
    };
    if (process.env.PROVENANCE_SMOKE_REPORT) {
      const path = resolve(process.env.PROVENANCE_SMOKE_REPORT);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    assert.equal(absent.status, 'absent', 'Unsigned fixture was not classified absent.');
    assert.equal(
      valid.status,
      'valid',
      'Untrusted development signature was not classified valid.',
    );
    assert.equal(
      trusted.status,
      'trusted',
      'Local development anchors did not establish the expected synthetic trust.',
    );
    assert.equal(
      invalid.status,
      'invalid',
      'Changed valid PNG pixel data did not invalidate the signed asset binding.',
    );
    assert.equal(signed.subarray(0, 8).equals(tampered.subarray(0, 8)), true);
    return report;
  } finally {
    if (imageId) await run('docker', ['image', 'rm', '--force', imageId], { timeout: 30_000 });
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  provenanceSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Provenance integration failed.');
    process.exitCode = 1;
  });
}
