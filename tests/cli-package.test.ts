import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildCli } from '../scripts/build-cli.mjs';
import { packageCli } from '../scripts/package-cli.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const packageFiles = [
  'BUILD-MANIFEST.json',
  'LICENSE',
  'NOTICE',
  'README.md',
  'THIRD-PARTY-NOTICES.txt',
  'bin/opengen.mjs',
  'package.json',
].sort();
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const generation = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'A quiet sea.', resolution: '720p', duration: 5, aspectRatio: '16:9' },
};

async function filesIn(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    expect(item.isSymbolicLink(), relative).toBe(false);
    if (item.isDirectory())
      result.push(...(await filesIn(join(directory, item.name), relative + '/')));
    else {
      expect(item.isFile(), relative).toBe(true);
      result.push(relative);
    }
  }
  return result.sort();
}

async function sourceSnapshot(destination: string) {
  for (const path of [
    'apps/cli/src',
    'apps/cli/packaging',
    'packages/sdk/src',
    'packages/contracts/src',
  ])
    await cp(join(root, path), join(destination, path), { recursive: true });
  for (const path of [
    'package.json',
    'package-lock.json',
    'LICENSE',
    'NOTICE',
    'apps/cli/package.json',
    'packages/sdk/package.json',
    'packages/contracts/package.json',
  ]) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await copyFile(join(root, path), join(destination, path));
  }
  return destination;
}

function unpackTar(bytes: Uint8Array) {
  const tar = gunzipSync(bytes),
    entries: { name: string; mode: number; contents: Buffer }[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
    const type = text(156, 1);
    expect(['', '0'], name).toContain(type);
    expect(text(157, 100), name).toBe('');
    expect(name, 'tar traversal / absolute paths').toMatch(
      /^package\/(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9/_.-]+$/,
    );
    const size = Number.parseInt(text(124, 12).trim(), 8);
    const mode = Number.parseInt(text(100, 8).trim(), 8);
    expect(Number.isSafeInteger(size) && size >= 0, name).toBe(true);
    expect(offset + 512 + size).toBeLessThanOrEqual(tar.length);
    entries.push({ name, mode, contents: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('portable private OpenGen CLI package', () => {
  let directory: string,
    sourceRoot: string,
    outputDirectory: string,
    executable: string,
    cwd: string;
  let artifact: {
    packageDirectory: string;
    tarballPath: string;
    sha256Path: string;
    manifestPath: string;
  };
  let server: Server, baseUrl: string;
  const requests: { method: string; path: string; authorization?: string; body: unknown }[] = [];
  const fixtureErrors: string[] = [];
  const environment = () => ({
    PATH: dirname(process.execPath),
    HOME: join(directory, 'home'),
    XDG_CONFIG_HOME: join(directory, 'private-config'),
    MEDIA_ROUTER_URL: baseUrl,
    NODE_OPTIONS: '',
    NO_COLOR: '1',
    TZ: 'UTC',
  });
  async function execute(args: string[], options: { stdin?: string; fail?: boolean } = {}) {
    const child = execFile(
      process.execPath,
      ['--disallow-code-generation-from-strings', executable, ...args],
      {
        cwd,
        env: environment(),
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);
    return new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolveResult, reject) => {
        let stdout = '',
          stderr = '';
        child.stdout!.setEncoding('utf8').on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr!.setEncoding('utf8').on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => {
          const result = { stdout, stderr, code: code ?? -1 };
          if (code !== 0 && !options.fail)
            reject(new Error(`Detached CLI failed (${code}): ${stderr}`));
          else resolveResult(result);
        });
      },
    );
  }
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'opengen-cli-package-')));
    sourceRoot = join(directory, 'frozen-source');
    outputDirectory = join(directory, 'release');
    cwd = join(directory, 'empty-directory');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(directory, 'home'), { mode: 0o700 });
    // Deliberately omit node_modules, server, engine, catalog, .git and all local config.
    // Build dependencies resolve from the builder's installation, never the source snapshot.
    await sourceSnapshot(sourceRoot);
    artifact = await packageCli({ sourceRoot, outputDirectory });
    // Only the executable is copied here. Neither its package folder nor node_modules
    // is an ancestor of this detached location or its empty working directory.
    executable = join(directory, 'portable', 'opengen.mjs');
    await mkdir(dirname(executable));
    await copyFile(join(artifact.packageDirectory, 'bin/opengen.mjs'), executable);
    await chmod(executable, 0o755);
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '';
      requests.push({
        method: request.method ?? '',
        path,
        authorization: request.headers.authorization,
        body: text ? JSON.parse(text) : undefined,
      });
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && path === '/v1/catalog/search?q=quiet+sea') {
        response.end(JSON.stringify([{ id: 'fixture/image', name: 'Fixture discovery only' }]));
      } else if (request.method === 'POST' && path === '/v1/quotes') {
        response.end(
          JSON.stringify({
            candidates: [],
            notices: ['Synthetic quote; no generation submitted.'],
          }),
        );
      } else if (request.method === 'GET' && path === '/v1/doctor') {
        response.statusCode = 401;
        response.end(
          JSON.stringify({
            error: { code: 'unauthorized', message: 'Sign in to diagnose access.' },
          }),
        );
      } else {
        fixtureErrors.push(`${request.method} ${path}`);
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { message: 'Unexpected fixture request.' } }));
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture server did not bind loopback.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30000);
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('ships an explicit private package with only a bundled executable, licenses and evidence', async () => {
    expect(await filesIn(artifact.packageDirectory)).toEqual(packageFiles);
    const manifest = JSON.parse(
      await readFile(join(artifact.packageDirectory, 'package.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      name: 'opengen-cli',
      private: true,
      license: 'Apache-2.0',
      type: 'module',
      bin: { opengen: 'bin/opengen.mjs' },
    });
    expect(manifest.engines.node).toMatch(/22/);
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'bundledDependencies',
      'scripts',
    ])
      expect(manifest[field] ?? {}).toEqual({});
    expect(manifest.files).toBeInstanceOf(Array);
    expect(manifest.files).not.toContain('*');
    const build = JSON.parse(
      await readFile(join(artifact.packageDirectory, 'BUILD-MANIFEST.json'), 'utf8'),
    );
    expect(build).toMatchObject({
      schemaVersion: 1,
      name: 'opengen-cli',
      version: manifest.version,
      builder: { name: 'esbuild', version: '0.28.2' },
    });
    expect(build.packagingToolInputs.length).toBeGreaterThan(0);
    for (const input of build.packagingToolInputs) {
      expect(isAbsolute(input.path), input.path).toBe(false);
      expect(input.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(build.toolchain).toEqual({
      node: process.versions.node,
      zlib: process.versions.zlib,
      v8: process.versions.v8,
    });
    expect(build.dependencies).toEqual([
      expect.objectContaining({
        name: 'zod',
        license: 'MIT',
        licenseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(build.externalImports.length).toBeGreaterThan(0);
    for (const imported of build.externalImports) expect(isBuiltin(imported), imported).toBe(true);
    for (const input of build.inputs) {
      expect(isAbsolute(input.path), input.path).toBe(false);
      expect(input.path, 'no server/provider/engine/catalog runtime graph').not.toMatch(
        /(?:^|\/)(engine|server|providers|catalog)(?:\/|$)/,
      );
      expect(input.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(build.files.map((file: { path: string }) => file.path).sort()).toEqual(
      packageFiles.filter((file) => file !== 'BUILD-MANIFEST.json'),
    );
    for (const file of build.files) {
      const bytes = await readFile(join(artifact.packageDirectory, file.path));
      expect(file.sha256, file.path).toBe(digest(bytes));
      expect(file.size, file.path).toBe(bytes.length);
    }
    expect(await readFile(join(artifact.packageDirectory, 'LICENSE'), 'utf8')).toContain(
      'Apache License',
    );
    expect(await readFile(join(artifact.packageDirectory, 'NOTICE'), 'utf8')).toContain(
      'OpenGen contributors',
    );
    const notices = await readFile(
      join(artifact.packageDirectory, 'THIRD-PARTY-NOTICES.txt'),
      'utf8',
    );
    expect(notices).toContain('zod');
    expect(notices).toContain('MIT');
    expect(notices).toContain('Colin');
    expect(notices).toContain('Permission is hereby granted, free of charge');
    const code = await readFile(executable, 'utf8');
    expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(code).not.toContain('sourceMappingURL');
    expect(code).not.toContain(root);
    expect(code).not.toContain(directory);
    expect(JSON.stringify(build)).not.toContain(root);
    expect(JSON.stringify(build)).not.toContain(directory);
    if (process.platform !== 'win32')
      expect((await lstat(join(artifact.packageDirectory, 'bin/opengen.mjs'))).mode & 0o777).toBe(
        0o755,
      );
  });

  it('runs catalog, canonical quote, status and bind preview outside the repository without eval', async () => {
    expect(await readdir(cwd)).toEqual([]);
    await rm(sourceRoot, { recursive: true });
    const help = await execute(['--help']);
    expect(help.stdout).toContain('OpenGen');
    expect(help.stdout).toContain('bind');
    const catalog = await execute(['catalog', 'search', 'quiet', 'sea']);
    expect(JSON.parse(catalog.stdout)).toEqual([
      { id: 'fixture/image', name: 'Fixture discovery only' },
    ]);
    const quote = await execute(['quote', '--input', '-'], { stdin: JSON.stringify(generation) });
    expect(JSON.parse(quote.stdout)).toMatchObject({
      candidates: [],
      notices: ['Synthetic quote; no generation submitted.'],
    });
    const status = await execute(['status']);
    expect(JSON.parse(status.stdout)).toMatchObject({
      connected: false,
      baseUrl,
      authentication: 'none',
    });
    const config = join(directory, 'chosen-project', '.cursor', 'mcp.json');
    const preview = await execute([
      'bind',
      'preview',
      '--client',
      'cursor',
      '--config',
      config,
      '--url',
      baseUrl,
    ]);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      configPath: config,
      action: 'add',
      entry: { url: `${baseUrl}/mcp` },
      previewId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(access(config)).rejects.toThrow();
    await expect(access(dirname(config))).rejects.toThrow();
    await expect(access(join(directory, 'private-config'))).rejects.toThrow();
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/catalog/search?q=quiet+sea' });
    expect(requests[1]).toMatchObject({ method: 'POST', path: '/v1/quotes', body: generation });
    expect(requests[2]).toMatchObject({ method: 'GET', path: '/v1/doctor' });
    expect(JSON.parse(status.stdout)).toMatchObject({
      credentialPresent: false,
      authenticated: false,
      nextBlocker: { code: 'credential_missing' },
    });
    expect(requests.every((request) => request.authorization === undefined)).toBe(true);
    expect(fixtureErrors).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('rejects an invalid canonical quote before contacting even the mock gateway', async () => {
    const before = requests.length;
    const result = await execute(['quote', '--input', '-'], {
      stdin: JSON.stringify({
        ...generation,
        input: { ...generation.input, unknownPrivateArgument: 'synthetic-private-input' },
      }),
      fail: true,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('synthetic-private-input');
    expect(requests.length).toBe(before);
  });

  it('packs exactly the allowed regular files and supplies verifiable SHA-256 evidence', async () => {
    const archive = await readFile(artifact.tarballPath);
    const entries = unpackTar(archive);
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      packageFiles.map((path) => `package/${path}`),
    );
    for (const entry of entries) {
      expect(entry.contents).toEqual(
        await readFile(join(artifact.packageDirectory, entry.name.slice('package/'.length))),
      );
      expect(entry.mode).toBe(entry.name === 'package/bin/opengen.mjs' ? 0o755 : 0o644);
    }
    const checksum = await readFile(artifact.sha256Path, 'utf8');
    expect(checksum.trim().split(/\s+/)).toEqual([digest(archive), 'opengen-cli-0.1.0.tgz']);
    const manifest = JSON.parse(await readFile(artifact.manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      name: 'opengen-cli',
      version: '0.1.0',
      tarball: { file: 'opengen-cli-0.1.0.tgz', sha256: digest(archive), size: archive.length },
    });
    expect(manifest.buildManifestSha256).toBe(
      digest(await readFile(join(artifact.packageDirectory, 'BUILD-MANIFEST.json'))),
    );
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual(packageFiles);
    for (const file of manifest.files)
      expect(file.sha256).toBe(digest(await readFile(join(artifact.packageDirectory, file.path))));
  });

  it('installs only the local tarball into an isolated npm prefix and exposes the opengen bin', async () => {
    const prefix = join(directory, 'npm-prefix');
    const userConfig = join(directory, 'user.npmrc');
    const globalConfig = join(directory, 'global.npmrc');
    await writeFile(userConfig, '');
    await writeFile(globalConfig, '');
    const npm =
      process.env.npm_execpath ??
      resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    await run(
      process.execPath,
      [
        npm,
        'install',
        '--prefix',
        prefix,
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--userconfig',
        userConfig,
        '--globalconfig',
        globalConfig,
        artifact.tarballPath,
      ],
      {
        cwd,
        env: {
          ...environment(),
          npm_config_cache: join(directory, 'npm-cache'),
          npm_config_registry: 'http://127.0.0.1:9',
        },
        timeout: 20000,
      },
    );
    const installed = join(prefix, 'node_modules/opengen-cli');
    expect(await filesIn(installed)).toEqual(packageFiles);
    expect(
      (await readdir(join(prefix, 'node_modules'))).filter((name) => !name.startsWith('.')),
    ).toEqual(['opengen-cli']);
    const bin =
      process.platform === 'win32'
        ? join(installed, 'bin/opengen.mjs')
        : join(prefix, 'node_modules/.bin/opengen');
    const args =
      process.platform === 'win32'
        ? ['--disallow-code-generation-from-strings', bin, 'status']
        : ['status'];
    const executablePath = process.platform === 'win32' ? process.execPath : bin;
    const result = await run(executablePath, args, {
      cwd,
      env: { ...environment(), NODE_OPTIONS: '--disallow-code-generation-from-strings' },
      timeout: 10000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ connected: false, baseUrl });
    expect(requests.every((request) => !request.path.includes('generations'))).toBe(true);
  }, 30000);

  it('refuses to overwrite an existing build or release destination', async () => {
    const existing = join(directory, 'existing');
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'unrelated existing data');
    await expect(buildCli({ sourceRoot: root, outputDirectory: existing })).rejects.toThrow();
    await expect(packageCli({ sourceRoot: root, outputDirectory: existing })).rejects.toThrow();
    expect(await readdir(existing)).toEqual(['keep.txt']);
    expect(await readFile(join(existing, 'keep.txt'), 'utf8')).toBe('unrelated existing data');
  });

  it('repackages identical source and tooling into byte-identical portable archives', async () => {
    const repeated = await packageCli({
      sourceRoot: root,
      outputDirectory: join(directory, 'repeat-release'),
    });
    expect(await readFile(repeated.tarballPath)).toEqual(await readFile(artifact.tarballPath));
    expect(await readFile(repeated.manifestPath)).toEqual(await readFile(artifact.manifestPath));
  });

  it('rejects an imported engine file before it can enter the bundle', async () => {
    const poisoned = await sourceSnapshot(join(directory, 'source-with-engine-import'));
    const entry = join(poisoned, 'apps/cli/src/index.ts');
    await mkdir(join(poisoned, 'packages/engine/src'), { recursive: true });
    await writeFile(
      join(poisoned, 'packages/engine/src/forbidden.ts'),
      'export const forbidden = true;',
    );
    await writeFile(
      entry,
      (await readFile(entry, 'utf8')).replace(
        /^(#![^\n]*\n)/,
        "$1import '../../../packages/engine/src/forbidden.ts';\n",
      ),
    );
    const output = join(directory, 'forbidden-output');
    await expect(buildCli({ sourceRoot: poisoned, outputDirectory: output })).rejects.toThrow(
      /reviewed source graph|unapproved/,
    );
    await expect(access(output)).rejects.toThrow();
  });

  it('rejects symlinked source parents even when their target stays within the snapshot', async () => {
    const linked = await sourceSnapshot(join(directory, 'source-with-directory-link'));
    await mkdir(join(linked, 'packages/engine'), { recursive: true });
    await rename(join(linked, 'apps/cli/src'), join(linked, 'packages/engine/src'));
    await symlink(join(linked, 'packages/engine/src'), join(linked, 'apps/cli/src'), 'dir');
    const output = join(directory, 'symlink-output');
    await expect(buildCli({ sourceRoot: linked, outputDirectory: output })).rejects.toThrow(
      /symlink|reviewed graph/,
    );
    await expect(access(output)).rejects.toThrow();
  });

  it('rejects an external source LICENSE symlink without packaging its private target', async () => {
    const linked = await sourceSnapshot(join(directory, 'source-with-license-link'));
    const outside = join(directory, 'outside-license.txt');
    await writeFile(outside, 'synthetic-private-notice');
    await rm(join(linked, 'LICENSE'));
    await symlink(outside, join(linked, 'LICENSE'));
    const output = join(directory, 'license-link-output');
    let failure: unknown;
    try {
      await buildCli({ sourceRoot: linked, outputDirectory: output });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('synthetic-private-notice');
    await expect(access(output)).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('synthetic-private-notice');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a source NOTICE FIFO without blocking on a writer',
    async () => {
      const namedPipe = await sourceSnapshot(join(directory, 'source-with-notice-fifo'));
      const notice = join(namedPipe, 'NOTICE');
      await rm(notice);
      await run('mkfifo', [notice]);
      const output = join(directory, 'notice-fifo-output');
      let failure:
        (Error & { killed?: boolean; code?: number | string; stderr?: string }) | undefined;
      try {
        await run(
          process.execPath,
          [join(root, 'scripts/build-cli.mjs'), '--repo-root', namedPipe, '--out-dir', output],
          {
            cwd,
            env: environment(),
            timeout: 3000,
          },
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.killed).not.toBe(true);
      expect(failure?.code).toBe(1);
      await expect(access(output)).rejects.toThrow();
      expect((await lstat(notice)).isFIFO()).toBe(true);
    },
  );
});
