import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { loginStatus } from './login.js';

export type BindingClient = 'cursor' | 'claude-code';
export interface BindingOptions {
  client: BindingClient;
  configPath: string;
  baseUrl: string;
  /** Replacing a different existing opengen entry must be explicitly previewed and applied. */
  replace?: boolean;
}
export interface BindingPreview {
  client: BindingClient;
  configPath: string;
  serverName: 'opengen';
  action: 'add' | 'replace' | 'unchanged';
  entry: { url: string; type?: 'http' };
  /** Binds the exact original bytes, destination and requested change. Not an access credential. */
  previewId: string;
  notice: string;
}
const limit = 1_000_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key);
const problem = (message: string) =>
  new Error(`${message} Configuration contents were not printed.`);

function origin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw problem('Supply an HTTPS gateway origin or a local development origin.');
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw problem('Supply an HTTPS gateway origin without credentials, paths or query parameters.');
  return url.origin;
}
function validate(options: BindingOptions) {
  if (!['cursor', 'claude-code'].includes(options.client))
    throw problem('Automatic JSON binding supports cursor and claude-code only.');
  if (!isAbsolute(options.configPath) || /[\x00-\x1f\x7f]/.test(options.configPath))
    throw problem('The configuration destination must be an explicit absolute path.');
  const configPath = resolve(options.configPath);
  if (basename(configPath) !== (options.client === 'cursor' ? 'mcp.json' : '.mcp.json'))
    throw problem(
      'Use mcp.json for Cursor or project .mcp.json for Claude Code; JSONC and TOML are manual.',
    );
  return { ...options, configPath, baseUrl: origin(options.baseUrl) };
}
async function checkParents(path: string) {
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw problem('The configuration directory could not be inspected.');
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw problem('Symlink and non-directory configuration parents are refused.');
  }
}
async function readConfig(path: string): Promise<string | null> {
  await checkParents(path);
  let file;
  try {
    // Nonblocking open lets fstat reject FIFOs without waiting for a writer.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw problem('The configuration must be an accessible regular file, not a symlink.');
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw problem('The configuration must be a regular JSON file of at most 1 MB.');
    const bytes = await file.readFile();
    if (bytes.byteLength > limit) throw problem('The configuration exceeds 1 MB.');
    return bytes.toString('utf8');
  } finally {
    await file.close();
  }
}
function prepare(options: ReturnType<typeof validate>, before: string | null) {
  let config: unknown = {};
  try {
    if (before !== null) config = JSON.parse(before);
  } catch {
    throw problem('The configuration is not valid JSON; JSONC requires manual editing.');
  }
  if (!object(config) || (own(config, 'mcpServers') && !object(config.mcpServers)))
    throw problem('Expected a JSON object with an optional mcpServers object.');
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const entry = {
    ...(options.client === 'claude-code' ? { type: 'http' as const } : {}),
    url: `${options.baseUrl}/mcp`,
  };
  const exists = own(servers, 'opengen');
  const existing = servers.opengen;
  // Only the exact token-free entry is considered unchanged. Extra headers/env are not retained.
  const unchanged =
    object(existing) &&
    Object.keys(existing).length === Object.keys(entry).length &&
    Object.entries(entry).every(([key, value]) => existing[key] === value);
  if (exists && !unchanged && !options.replace)
    throw problem('An opengen server already exists. Preview with replace enabled to change it.');
  const next = { ...config, mcpServers: { ...servers, opengen: entry } };
  const preview: BindingPreview = {
    client: options.client,
    configPath: options.configPath,
    serverName: 'opengen',
    action: unchanged ? 'unchanged' : exists ? 'replace' : 'add',
    entry,
    previewId: digest(
      JSON.stringify({
        client: options.client,
        path: options.configPath,
        before,
        entry,
        replace: Boolean(options.replace),
      }),
    ),
    notice:
      'Only mcpServers.opengen changes. Other JSON settings are preserved; formatting uses two spaces. No token is copied. Authenticate in the client browser flow. Client compatibility is unverified.',
  };
  return { preview, content: `${JSON.stringify(next, null, 2)}\n` };
}

/** Read-only, secret-free change preview. Does not print or return unrelated existing settings. */
export async function previewBinding(input: BindingOptions): Promise<BindingPreview> {
  const options = validate(input);
  return prepare(options, await readConfig(options.configPath)).preview;
}

/** Apply only a reviewed, still-current preview; never chooses a global client destination. */
export async function applyBinding(
  input: BindingOptions & { previewId: string },
): Promise<BindingPreview & { applied: boolean }> {
  const options = validate(input);
  if (!/^[a-f0-9]{64}$/.test(input.previewId)) throw problem('Supply the previewId from preview.');
  const initial = prepare(options, await readConfig(options.configPath));
  if (initial.preview.previewId !== input.previewId)
    throw problem('The preview is stale or belongs to a different change. Preview again.');
  if (initial.preview.action === 'unchanged') return { ...initial.preview, applied: false };
  await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
  await checkParents(options.configPath);
  const lockPath = `${options.configPath}.opengen.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw problem('Another binding update holds the lock. Retry after it finishes.');
  }
  const temporary = `${options.configPath}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    const current = prepare(options, await readConfig(options.configPath));
    if (current.preview.previewId !== input.previewId)
      throw problem('The preview is stale. Preview again before applying.');
    const output = await open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(current.content);
      await output.sync();
    } finally {
      await output.close();
    }
    // Detect clients editing the config during preparation before the atomic replacement.
    const latest = prepare(options, await readConfig(options.configPath));
    if (latest.preview.previewId !== input.previewId)
      throw problem('The configuration changed during apply. Preview again.');
    await rename(temporary, options.configPath);
    return { ...current.preview, applied: true };
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

/** Reuse the CLI's private profile/refresh lock without exposing or copying its tokens. */
export async function bindingLoginStatus(options: {
  baseUrl: string;
  profilePath?: string;
  request?: typeof fetch;
}) {
  return loginStatus({ ...options, baseUrl: origin(options.baseUrl) });
}
