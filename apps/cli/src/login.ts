import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, lstat, unlink, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';

interface LoginAuthority {
  issuer: string;
  resource: string;
}

export interface LoginProfile extends LoginAuthority {
  version: 1;
  baseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
  workspaceId: string;
}
export const defaultLoginProfile = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opengen', 'auth.json');
const loginError = () =>
  new Error(
    'OpenGen sign-in could not be completed. No tokens or private response details were printed.',
  );
function baseOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error(
      'Browser sign-in requires an HTTPS gateway origin or a local development origin.',
    );
  return url.origin;
}
function loginAuthority(
  baseUrl: string,
  issuerValue: unknown,
  resourceValue: unknown,
): LoginAuthority {
  if (typeof issuerValue !== 'string' || typeof resourceValue !== 'string') throw loginError();
  const issuer = baseOrigin(issuerValue),
    url = new URL(issuer);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    issuerValue !== issuer ||
    resourceValue !== `${issuer}/mcp` ||
    (!loopback &&
      (Boolean(isIP(url.hostname)) ||
        !url.hostname.includes('.') ||
        /\.(local|localhost|internal)$/i.test(url.hostname))) ||
    (new URL(baseUrl).protocol === 'https:' && url.protocol !== 'https:')
  )
    throw loginError();
  return { issuer, resource: resourceValue };
}
async function privateProfileExists(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw loginError();
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0) ||
    info.size > 16384
  )
    throw new Error('OpenGen login profile must be a private regular file (0600).');
  return true;
}
async function readProfile(path: string): Promise<LoginProfile | undefined> {
  if (!(await privateProfileExists(path))) return undefined;
  let profile: LoginProfile;
  try {
    profile = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw loginError();
  }
  if (
    profile.version !== 1 ||
    typeof profile.baseUrl !== 'string' ||
    typeof profile.clientId !== 'string' ||
    typeof profile.workspaceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(profile.workspaceId) ||
    typeof profile.scope !== 'string' ||
    !profile.scope ||
    profile.scope.split(' ').some((scope) => !['read', 'generate'].includes(scope)) ||
    !/^og_mcp_a_[A-Za-z0-9_-]{43}$/.test(profile.accessToken) ||
    !/^og_mcp_r_[A-Za-z0-9_-]{43}$/.test(profile.refreshToken) ||
    !Number.isFinite(Date.parse(profile.expiresAt))
  )
    throw loginError();
  baseOrigin(profile.baseUrl);
  loginAuthority(profile.baseUrl, profile.issuer, profile.resource);
  return profile;
}
async function saveProfile(path: string, profile: LoginProfile) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Reject unsafe existing targets rather than replacing a link or a publicly readable credential file.
  await privateProfileExists(path);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(profile) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
function profileFromResponse(
  data: Record<string, unknown>,
  baseUrl: string,
  clientId: string,
  authority: LoginAuthority,
): LoginProfile {
  if (
    typeof data.access_token !== 'string' ||
    !/^og_mcp_a_[A-Za-z0-9_-]{43}$/.test(data.access_token) ||
    typeof data.refresh_token !== 'string' ||
    !/^og_mcp_r_[A-Za-z0-9_-]{43}$/.test(data.refresh_token) ||
    data.token_type !== 'Bearer' ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 3600 ||
    typeof data.scope !== 'string' ||
    !data.scope ||
    typeof data.workspace_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(data.workspace_id) ||
    data.scope.split(' ').some((scope) => !['read', 'generate'].includes(scope))
  )
    throw loginError();
  return {
    version: 1,
    baseUrl,
    clientId,
    issuer: authority.issuer,
    resource: authority.resource,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: data.scope,
    workspaceId: data.workspace_id,
  };
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    !response.body
  )
    throw loginError();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw loginError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw loginError();
    return value;
  } catch {
    throw loginError();
  } finally {
    reader.releaseLock();
  }
}
async function discoverAuthority(
  request: typeof fetch,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<LoginAuthority> {
  const get = async (url: string) =>
    boundedJson(
      await request(url, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      }),
    );
  const resource = await get(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  if (
    !Array.isArray(resource.authorization_servers) ||
    resource.authorization_servers.length !== 1 ||
    !Array.isArray(resource.bearer_methods_supported) ||
    !resource.bearer_methods_supported.includes('header')
  )
    throw loginError();
  const authority = loginAuthority(baseUrl, resource.authorization_servers[0], resource.resource);
  const metadata = await get(`${authority.issuer}/.well-known/oauth-authorization-server`);
  const supports = (field: string, values: string[]) => {
    const available = metadata[field];
    return Array.isArray(available) && values.every((value) => available.includes(value));
  };
  if (
    metadata.issuer !== authority.issuer ||
    metadata.authorization_endpoint !== `${authority.issuer}/oauth/authorize` ||
    metadata.token_endpoint !== `${authority.issuer}/oauth/token` ||
    metadata.registration_endpoint !== `${authority.issuer}/oauth/register` ||
    metadata.revocation_endpoint !== `${authority.issuer}/oauth/revoke` ||
    !supports('response_types_supported', ['code']) ||
    !supports('grant_types_supported', ['authorization_code', 'refresh_token']) ||
    !supports('code_challenge_methods_supported', ['S256']) ||
    !supports('token_endpoint_auth_methods_supported', ['none']) ||
    !supports('scopes_supported', ['read', 'generate'])
  )
    throw loginError();
  return authority;
}
async function post(
  request: typeof fetch,
  url: string,
  body: unknown,
  form = false,
  signal?: AbortSignal,
) {
  const response = await request(url, {
    method: 'POST',
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form
      ? new URLSearchParams(body as Record<string, string>).toString()
      : JSON.stringify(body),
  });
  return boundedJson(response);
}
function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  child.once('error', () => {});
  child.unref();
}
export async function browserLogin(options: {
  baseUrl: string;
  profilePath?: string;
  request?: typeof fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  onLoginUrl?: (url: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const baseUrl = baseOrigin(options.baseUrl),
    request = options.request ?? fetch,
    path = options.profilePath ?? defaultLoginProfile();
  const verifier = randomBytes(32).toString('base64url'),
    state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const timeout = options.timeoutMs ?? 300000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600000)
    throw new Error('Login timeout must be between 1 and 600000 milliseconds.');
  const authority = await discoverAuthority(request, baseUrl, options.signal);
  let settle: (result: { code: string } | Error) => void = () => {};
  const callback = new Promise<{ code: string }>((resolve, reject) => {
    settle = (result) => (result instanceof Error ? reject(result) : resolve(result));
  });
  // Prevent an early timeout/abort from becoming an unhandled rejection during registration.
  void callback.catch(() => {});
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    outgoing.setHeader('Cache-Control', 'no-store');
    outgoing.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (incoming.method !== 'GET' || url.pathname !== '/callback') {
      outgoing.writeHead(404).end('Not found.');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      outgoing.writeHead(400).end('Invalid login state.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.has('error')) {
      outgoing.writeHead(400).end('Access was not granted.');
      settle(loginError());
      return;
    }
    outgoing
      .writeHead(200)
      .end('OpenGen is connected. You can close this tab and return to your agent.');
    settle({ code });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw loginError();
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const aborted = () =>
    settle(new Error('OpenGen login was cancelled. No generation was submitted.'));
  const timer = setTimeout(
    () =>
      settle(new Error('OpenGen login timed out. Start login again; no generation was submitted.')),
    timeout,
  );
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    options.signal?.throwIfAborted();
    const client = await post(request, `${authority.issuer}/oauth/register`, {
      client_name: 'OpenGen CLI',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    if (typeof client.client_id !== 'string') throw loginError();
    const authorize = new URL('/oauth/authorize', authority.issuer);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'read generate',
      state,
      resource: authority.resource,
    }).toString();
    options.onLoginUrl?.(authorize.href);
    await (options.openBrowser ?? openBrowser)(authorize.href);
    const result = await callback;
    const tokens = await post(
      request,
      `${authority.issuer}/oauth/token`,
      {
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: result.code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: authority.resource,
      },
      true,
      options.signal,
    );
    const profile = profileFromResponse(tokens, baseUrl, client.client_id, authority);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await open(`${path}.lock`, 'wx', 0o600);
    } catch {
      throw new Error(
        'Another OpenGen process is updating login. Retry after it finishes; no generation was submitted.',
      );
    }
    try {
      await saveProfile(path, profile);
    } finally {
      await lock.close();
      await unlink(`${path}.lock`).catch(() => {});
    }
    return {
      connected: true,
      baseUrl,
      issuer: authority.issuer,
      resource: authority.resource,
      workspaceId: profile.workspaceId,
      scope: profile.scope,
      profilePath: path,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', aborted);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export async function savedLogin(options: {
  baseUrl: string;
  profilePath?: string;
  request?: typeof fetch;
  refresh?: boolean;
}): Promise<LoginProfile | undefined> {
  const baseUrl = baseOrigin(options.baseUrl),
    path = options.profilePath ?? defaultLoginProfile();
  let profile = await readProfile(path);
  if (!profile || profile.baseUrl !== baseUrl) return undefined;
  if (options.refresh === false || Date.parse(profile.expiresAt) > Date.now() + 60000)
    return profile;
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Another OpenGen process is refreshing login. Try again after it finishes.');
  }
  try {
    profile = await readProfile(path);
    if (!profile || profile.baseUrl !== baseUrl) return undefined;
    if (Date.parse(profile.expiresAt) > Date.now() + 60000) return profile;
    const tokens = await post(
      options.request ?? fetch,
      `${profile.issuer}/oauth/token`,
      {
        grant_type: 'refresh_token',
        client_id: profile.clientId,
        refresh_token: profile.refreshToken,
        resource: profile.resource,
      },
      true,
    );
    const next = profileFromResponse(tokens, baseUrl, profile.clientId, profile);
    if (
      next.workspaceId !== profile.workspaceId ||
      next.scope.split(' ').some((scope) => !profile!.scope.split(' ').includes(scope))
    )
      throw loginError();
    await saveProfile(path, next);
    return next;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
export async function loginStatus(options: {
  baseUrl: string;
  profilePath?: string;
  request?: typeof fetch;
}) {
  const profile = await savedLogin({ ...options, refresh: false });
  const local = {
    connected: false,
    authenticated: false,
    credentialPresent: Boolean(profile),
    verification: 'not-checked' as const,
    nextCommand: 'opengen doctor',
  };
  return profile
    ? {
        ...local,
        baseUrl: profile.baseUrl,
        issuer: profile.issuer,
        resource: profile.resource,
        workspaceId: profile.workspaceId,
        scope: profile.scope,
        expiresAt: profile.expiresAt,
      }
    : { ...local, baseUrl: baseOrigin(options.baseUrl) };
}
export async function logout(options: { profilePath?: string; request?: typeof fetch } = {}) {
  const path = options.profilePath ?? defaultLoginProfile();
  if (!(await readProfile(path))) return { signedOut: true };
  let lock;
  try {
    lock = await open(`${path}.lock`, 'wx', 0o600);
  } catch {
    throw new Error('Another OpenGen process is updating login. Retry logout after it finishes.');
  }
  try {
    const profile = await readProfile(path);
    if (!profile) return { signedOut: true };
    // A failed revocation is visible; retain the local profile so the caller can retry safely.
    const response = await (options.request ?? fetch)(`${profile.issuer}/oauth/revoke`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: profile.clientId,
        token: profile.refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
    });
    if (!response.ok)
      throw new Error(
        'OpenGen could not revoke this app authorization. The private profile was retained; retry logout when the gateway is available.',
      );
    await unlink(path);
    return { signedOut: true };
  } finally {
    await lock.close();
    await unlink(`${path}.lock`).catch(() => {});
  }
}
