import { builtinModules, createRequire, isBuiltin } from 'node:module';
import { constants } from 'node:fs';
import { writeFile, mkdir, realpath, lstat, chmod, rm, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

async function readRegular(boundary, logical, limit = 4_000_000) {
  const path = resolve(boundary, logical);
  const offset = relative(boundary, path);
  if (!offset || offset.startsWith('..') || isAbsolute(offset) || (await realpath(path)) !== path)
    throw new Error('Packaging metadata must stay in its reviewed directory without symlinks.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error('Packaging inputs must be bounded regular files.');
    const bytes = await file.readFile();
    if (bytes.length > limit || (await realpath(path)) !== path)
      throw new Error('Packaging input changed or exceeded its size limit.');
    return bytes;
  } finally {
    await file.close();
  }
}
const toolingRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const config = JSON.parse(
  (await readRegular(toolingRoot, 'apps/cli/packaging/build-config.json')).toString('utf8'),
);
export const packageFiles = Object.freeze([
  'BUILD-MANIFEST.json',
  'LICENSE',
  'NOTICE',
  'README.md',
  'THIRD-PARTY-NOTICES.txt',
  'bin/opengen.mjs',
  'package.json',
]);
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, path) =>
  path === root || (!relative(root, path).startsWith('..') && !isAbsolute(relative(root, path)));
const sourcePrefixes = ['apps/cli/src/', 'packages/sdk/src/', 'packages/contracts/src/'];
const sourceAllowed = (path) =>
  sourcePrefixes.some((prefix) => path.startsWith(prefix)) &&
  /\.(ts|js|mjs)$/.test(path) &&
  !path
    .split('/')
    .some((part) => part.startsWith('.') || /(?:^__tests__$|\.test\.|\.spec\.)/.test(part));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export async function claimDirectory(path) {
  if (!path || !isAbsolute(path)) throw new Error('Choose a new absolute output directory.');
  const target = resolve(path);
  // Existing destinations are never overwritten, including symlinks.
  await realpath(dirname(target));
  await mkdir(target, { mode: 0o700 });
  return target;
}
async function dependency(name, expected) {
  const manifestPath = require.resolve(`${name}/package.json`);
  const root = await realpath(dirname(manifestPath));
  const manifest = JSON.parse((await readRegular(root, 'package.json')).toString('utf8'));
  if (manifest.name !== name || manifest.version !== expected)
    throw new Error(
      `CLI packaging requires ${name} ${expected}; synchronize the reviewed build dependency lock.`,
    );
  return { root, manifest };
}
const json = (value) => JSON.stringify(value, null, 2) + '\n';

/** Build a closed portable graph from an explicit read-only source tree. Does not install/publish. */
export async function buildCli({ sourceRoot = toolingRoot, outputDirectory } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error('CLI packaging requires Node 22.12 or newer.');
  if (!isAbsolute(sourceRoot)) throw new Error('Choose an absolute source repository root.');
  const root = await realpath(sourceRoot);
  const esbuildDependency = await dependency('esbuild', config.buildDependency.version);
  const zodDependency = await dependency('zod', config.bundledDependency.version);
  const esbuild = require('esbuild');
  if (esbuild.version !== esbuildDependency.manifest.version)
    throw new Error('Unexpected esbuild implementation.');
  if (zodDependency.manifest.license !== 'MIT')
    throw new Error('Review the bundled Zod license before packaging.');
  const template = JSON.parse(
    (await readRegular(toolingRoot, 'apps/cli/packaging/package.template.json')).toString('utf8'),
  );
  const project = JSON.parse((await readRegular(root, 'package.json')).toString('utf8'));
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(project.version) ||
    project.license !== 'Apache-2.0'
  )
    throw new Error('Source version and Apache-2.0 license must be reviewed before CLI packaging.');
  template.version = project.version;
  const inputs = new Map();
  const aliases = {
    'opengen:cli': 'apps/cli/src/index.ts',
    '@media-router/contracts': 'packages/contracts/src/index.ts',
    '@media-router/contracts/generation': 'packages/contracts/src/generation.ts',
    '@media-router/sdk': 'packages/sdk/src/index.ts',
  };
  const entry = `import 'opengen:jitless';
import { runCommand, help, serializeCommandError } from 'opengen:cli';
const args = process.argv.slice(2);
const controller = new AbortController();
const stop = () => controller.abort(new Error('Client interrupted. Existing provider work was not cancelled or replaced.'));
process.once('SIGINT', stop);
try {
  if (args.length === 1 && args[0] === '--version') console.log(${JSON.stringify(`${template.name} ${template.version}`)});
  else {
    const result = await runCommand(args, { signal: controller.signal, onLoginUrl: (url) => console.error('Complete OpenGen sign-in in your browser: ' + url) });
    let output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (result === help) output = output.replaceAll('npm run cli --', 'opengen') + '\\nPortable local package: opengen bind --help; opengen --version. Not published to npm.\\n';
    console.log(output);
  }
} catch (error) {
  console.error(JSON.stringify(serializeCommandError(error, { baseUrl: process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310' }), null, 2));
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally { process.removeListener('SIGINT', stop); }
`;
  async function locate(logical) {
    const zod = logical.startsWith('node_modules/zod/');
    if (!zod && !sourceAllowed(logical))
      throw new Error('CLI dependency escaped its reviewed source graph.');
    if (zod && (!/\.(js|mjs)$/.test(logical) || logical.includes('/../')))
      throw new Error('Unreviewed bundled dependency file.');
    const boundary = zod ? zodDependency.root : root;
    const path = join(boundary, zod ? logical.slice('node_modules/zod/'.length) : logical);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000)
      throw new Error('CLI inputs must be bounded regular files.');
    const physical = await realpath(path);
    if (!inside(boundary, physical) || physical !== path)
      throw new Error('CLI source symlink escaped its reviewed graph.');
    return physical;
  }
  const plugin = {
    name: 'opengen-closed-cli-graph',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.path === 'opengen:entry')
          return { path: 'entry.mjs', namespace: 'opengen-wrapper' };
        if (args.path === 'opengen:jitless')
          return { path: 'jitless.mjs', namespace: 'opengen-wrapper' };
        if (isBuiltin(args.path) && builtins.has(args.path))
          return {
            path: args.path.startsWith('node:') ? args.path : `node:${args.path}`,
            external: true,
          };
        if (args.kind === 'dynamic-import' || args.kind === 'require-call')
          throw new Error(
            'Dynamic code/module loading is not permitted in the portable CLI graph.',
          );
        let logical = Object.hasOwn(aliases, args.path) ? aliases[args.path] : undefined;
        if (args.path === 'zod') logical = 'node_modules/zod/index.js';
        if (!logical && args.path.startsWith('.') && args.namespace === 'opengen-source') {
          logical = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
          const candidates =
            logical.endsWith('.js') && !logical.startsWith('node_modules/')
              ? [logical.slice(0, -3) + '.ts', logical]
              : /\.(ts|js|mjs)$/.test(logical)
                ? [logical]
                : [logical + '.ts', logical + '.js'];
          let found;
          for (const candidate of candidates) {
            try {
              await locate(candidate);
              found = candidate;
              break;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          logical = found;
        }
        if (!logical) throw new Error('Portable CLI imported an unapproved package or file.');
        await locate(logical);
        return { path: logical, namespace: 'opengen-source' };
      });
      build.onLoad({ filter: /.*/, namespace: 'opengen-wrapper' }, (args) => ({
        contents:
          args.path === 'entry.mjs'
            ? entry
            : "import { config } from 'zod'; config({ jitless: true });",
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'opengen-source' }, async (args) => {
        await locate(args.path);
        const contents = (
          await readRegular(
            args.path.startsWith('node_modules/zod/') ? zodDependency.root : root,
            args.path.startsWith('node_modules/zod/')
              ? args.path.slice('node_modules/zod/'.length)
              : args.path,
          )
        ).toString('utf8');
        inputs.set(args.path, sha256(contents));
        return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
      });
    },
  };
  // The sentinel makes imported source entry guards false; the portable wrapper dispatches once,
  // including through npm's bin symlink. No private source URL is embedded in the output.
  const result = await esbuild.build({
    entryPoints: ['opengen:entry'],
    absWorkingDir: toolingRoot,
    outfile: 'opengen.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.12',
    write: false,
    metafile: true,
    sourcemap: false,
    sourcesContent: false,
    legalComments: 'none',
    minifyWhitespace: true,
    treeShaking: true,
    define: { 'import.meta.url': JSON.stringify('opengen:bundled-library') },
    banner: {
      js: '#!/usr/bin/env node\n// OpenGen portable CLI. Apache-2.0; bundled dependency notices accompany this file.',
    },
    plugins: [plugin],
    logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
  });
  for (const [path, metadata] of Object.entries(result.metafile.inputs)) {
    const logical = path.startsWith('opengen-source:')
      ? path.slice('opengen-source:'.length)
      : undefined;
    if (
      !(logical && inputs.has(logical)) &&
      !['opengen-wrapper:entry.mjs', 'opengen-wrapper:jitless.mjs'].includes(path)
    )
      throw new Error('esbuild included an input outside the reviewed virtual graph.');
    if (metadata.imports.some((item) => item.external && !isBuiltin(item.path)))
      throw new Error('An input requires an external runtime package.');
  }
  const output = result.outputFiles;
  if (output.length !== 1)
    throw new Error('Portable CLI must contain exactly one executable bundle.');
  const externalImports = [
    ...new Set(
      Object.values(result.metafile.outputs).flatMap((item) =>
        item.imports.filter((entry) => entry.external).map((entry) => entry.path),
      ),
    ),
  ].sort();
  if (externalImports.some((path) => !path.startsWith('node:') || !isBuiltin(path)))
    throw new Error('Portable CLI has an external runtime package dependency.');
  const code = output[0].text;
  if (
    code.includes(root) ||
    code.includes(toolingRoot) ||
    /sourceMappingURL|\bimport\s*\(|\beval\s*\(|\b__require\b/.test(code)
  )
    throw new Error(
      'Portable CLI contains a forbidden output construct: ' +
        (code.includes(root) || code.includes(toolingRoot)
          ? 'absolute source path'
          : /sourceMappingURL/.test(code)
            ? 'source map'
            : /\bimport\s*\(/.test(code)
              ? 'dynamic import'
              : /\beval\s*\(/.test(code)
                ? 'eval'
                : 'dynamic require'),
    );
  const zodLicense = (await readRegular(zodDependency.root, 'LICENSE')).toString('utf8');
  const esbuildLicense = (await readRegular(esbuildDependency.root, 'LICENSE.md')).toString('utf8');
  const files = new Map([
    ['bin/opengen.mjs', Buffer.from(code)],
    ['package.json', Buffer.from(json(template))],
    ['LICENSE', await readRegular(root, 'LICENSE')],
    ['NOTICE', await readRegular(root, 'NOTICE')],
    [
      'README.md',
      Buffer.from(
        (await readRegular(toolingRoot, 'apps/cli/packaging/README.template.md'))
          .toString('utf8')
          .replaceAll('{{VERSION}}', template.version),
      ),
    ],
    [
      'THIRD-PARTY-NOTICES.txt',
      Buffer.from(
        `OpenGen portable CLI: bundled third-party notices\n\nBundled runtime library: zod ${zodDependency.manifest.version} (MIT)\n${zodLicense}\n\nBuild tool only, not included as a runtime library: esbuild ${esbuildDependency.manifest.version} (MIT)\n${esbuildLicense}`,
      ),
    ],
  ]);
  const packagingToolInputs = [];
  for (const path of [
    'scripts/build-cli.mjs',
    'scripts/package-cli.mjs',
    'apps/cli/packaging/build-config.json',
    'apps/cli/packaging/package.template.json',
    'apps/cli/packaging/README.template.md',
  ])
    packagingToolInputs.push({ path, sha256: sha256(await readRegular(toolingRoot, path)) });
  const manifest = {
    schemaVersion: 1,
    name: template.name,
    version: template.version,
    node: template.engines.node,
    builder: { name: 'esbuild', version: esbuild.version },
    toolchain: {
      node: process.versions.node,
      zlib: process.versions.zlib,
      v8: process.versions.v8,
    },
    dependencies: [
      {
        name: 'zod',
        version: zodDependency.manifest.version,
        license: 'MIT',
        licenseSha256: sha256(zodLicense),
      },
    ],
    externalImports,
    packagingToolInputs,
    inputs: [...inputs]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, hash]) => ({ path, sha256: hash })),
    modifications: [
      'Source modules are bundled; imported direct-execution guards use a public sentinel.',
      'Zod optional JIT is disabled through its public jitless configuration before CLI schemas initialize.',
    ],
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => ({
        path,
        sha256: sha256(bytes),
        size: bytes.length,
        mode: path === 'bin/opengen.mjs' ? '0755' : '0644',
      })),
  };
  files.set('BUILD-MANIFEST.json', Buffer.from(json(manifest)));
  for (const [path, bytes] of files) {
    const text = bytes.toString('utf8');
    if (text.includes(root) || text.includes(toolingRoot))
      throw new Error('Package metadata contains a private source path.');
  }
  const destination = await claimDirectory(outputDirectory);
  try {
    await mkdir(join(destination, 'bin'), { mode: 0o755 });
    for (const [path, bytes] of files) {
      await writeFile(join(destination, path), bytes, {
        flag: 'wx',
        mode: path === 'bin/opengen.mjs' ? 0o755 : 0o644,
      });
    }
    await chmod(join(destination, 'bin/opengen.mjs'), 0o755);
    return { packageDirectory: destination, manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export function buildArguments(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'repo-root': { type: 'string' },
        'out-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch {
    throw new Error('Use --repo-root /absolute/source and --out-dir /absolute/new/destination.');
  }
  return values;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = buildArguments(process.argv.slice(2));
    if (values.help)
      console.log(
        'Build only: node scripts/build-cli.mjs --repo-root /absolute/source --out-dir /absolute/new/package',
      );
    else {
      const result = await buildCli({
        sourceRoot: values['repo-root'],
        outputDirectory: values['out-dir'],
      });
      console.log(`Built private portable CLI at ${result.packageDirectory}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CLI build failed.');
    process.exitCode = 1;
  }
}
