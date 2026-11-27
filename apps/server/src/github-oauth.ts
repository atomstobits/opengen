import { createHash, timingSafeEqual } from 'node:crypto';

export const GITHUB_OAUTH_ISSUER = 'https://github.com' as const;

export interface GitHubOAuthConfiguration {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  issuer: string;
}

export interface VerifiedGitHubIdentity {
  iss: string;
  sub: string;
  email: string;
  email_verified: true;
}

const DEFAULT_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const DEFAULT_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_API_BASE_URL = 'https://api.github.com';

const githubAuthError = (message = 'GitHub sign-in could not be completed.') =>
  Object.assign(new Error(message), {
    statusCode: 401,
    code: 'unauthorized',
  });

function requireHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`${label} must be a canonical HTTPS URL without credentials or query strings.`);
  return parsed.href.replace(/\/$/, '');
}

/** Env-gated GitHub OAuth configuration. Returns null when unconfigured. */
export function readGitHubOAuthConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): GitHubOAuthConfiguration | null {
  const clientId = env.OPENGEN_GITHUB_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.OPENGEN_GITHUB_CLIENT_SECRET?.trim() ?? '';
  if (!clientId || !clientSecret || !env.MR_SESSION_SECRET) return null;
  if (env.MR_SESSION_SECRET.length < 32)
    throw new Error('MR_SESSION_SECRET must contain at least 32 characters for GitHub OAuth.');
  return {
    clientId,
    clientSecret,
    authorizeUrl: requireHttpsUrl(
      env.OPENGEN_GITHUB_AUTHORIZE_URL?.trim() || DEFAULT_AUTHORIZE_URL,
      'OPENGEN_GITHUB_AUTHORIZE_URL',
    ),
    tokenUrl: requireHttpsUrl(
      env.OPENGEN_GITHUB_TOKEN_URL?.trim() || DEFAULT_TOKEN_URL,
      'OPENGEN_GITHUB_TOKEN_URL',
    ),
    apiBaseUrl: requireHttpsUrl(
      env.OPENGEN_GITHUB_API_URL?.trim() || DEFAULT_API_BASE_URL,
      'OPENGEN_GITHUB_API_URL',
    ),
    issuer: GITHUB_OAUTH_ISSUER,
  };
}

export function buildGitHubAuthorizationUrl(
  config: GitHubOAuthConfiguration,
  params: {
    redirectUri: string;
    state: string;
    codeVerifier: string;
  },
): URL {
  const codeChallenge = createHash('sha256').update(params.codeVerifier).digest('base64url');
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

function normalizeVerifiedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length < 3 ||
    trimmed.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(trimmed)
  )
    return null;
  const [local, domain] = trimmed.split('@');
  if (
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !domain?.includes('.') ||
    domain.includes('..')
  )
    return null;
  return `${local}@${domain.toLowerCase()}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Exchanges a GitHub OAuth authorization code with PKCE + state verification,
 * fetches the immutable numeric GitHub user ID, and requires a verified primary email.
 */
export async function exchangeGitHubCode(
  config: GitHubOAuthConfiguration,
  params: {
    callbackUrl: URL;
    redirectUri: string;
    expectedState: string;
    codeVerifier: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<VerifiedGitHubIdentity> {
  const query = params.callbackUrl.searchParams;
  if (query.get('error')) throw githubAuthError();
  const codes = query.getAll('code');
  const states = query.getAll('state');
  if (codes.length !== 1 || states.length !== 1) throw githubAuthError();
  const code = codes[0]!;
  const state = states[0]!;
  if (
    !code ||
    code.length > 512 ||
    !state ||
    state.length > 512 ||
    !safeEqual(state, params.expectedState)
  )
    throw githubAuthError();

  const fetchFn = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? 10_000;

  const tokenBody = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  const tokenRes = await fetchFn(config.tokenUrl, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'OpenGen',
    },
    body: tokenBody.toString(),
  });
  if (!tokenRes.ok) throw githubAuthError();
  const tokenJson = (await tokenRes.json()) as {
    access_token?: unknown;
    token_type?: unknown;
    error?: unknown;
  };
  if (
    tokenJson.error ||
    typeof tokenJson.access_token !== 'string' ||
    !tokenJson.access_token ||
    tokenJson.access_token.length > 4096 ||
    (tokenJson.token_type !== undefined &&
      (typeof tokenJson.token_type !== 'string' || tokenJson.token_type.toLowerCase() !== 'bearer'))
  )
    throw githubAuthError();

  const apiHeaders = {
    Authorization: `Bearer ${tokenJson.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenGen',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const [userRes, emailsRes] = await Promise.all([
    fetchFn(`${config.apiBaseUrl}/user`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: apiHeaders,
    }),
    fetchFn(`${config.apiBaseUrl}/user/emails`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: apiHeaders,
    }),
  ]);
  if (!userRes.ok || !emailsRes.ok) throw githubAuthError();

  const user = (await userRes.json()) as { id?: unknown };
  if (typeof user?.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0)
    throw githubAuthError();

  const emails = (await emailsRes.json()) as unknown;
  if (!Array.isArray(emails)) throw githubAuthError();
  const primaryVerified = emails.find(
    (entry): entry is { email: string; primary: true; verified: true } =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { primary?: unknown }).primary === true &&
      (entry as { verified?: unknown }).verified === true &&
      typeof (entry as { email?: unknown }).email === 'string',
  );
  const verifiedEmail = primaryVerified ? normalizeVerifiedEmail(primaryVerified.email) : null;
  if (!verifiedEmail) throw githubAuthError();

  return {
    iss: config.issuer,
    sub: String(user.id),
    email: verifiedEmail,
    email_verified: true,
  };
}
