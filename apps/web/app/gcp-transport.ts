import { getVercelOidcToken } from '@vercel/oidc';

type TokenReader = (options: { audience: string }) => Promise<string>;
interface Options {
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  getOidcToken?: TokenReader;
  now?: () => number;
}
const configuredError = () => new Error('Private backend transport is not configured correctly.');
/** Server-only service identity. Never consumes a caller token or downloaded service-account key. */
export function createGcpTransport(options: Options = {}) {
  const env = options.env ?? process.env;
  const request = options.request ?? fetch;
  const readOidc = options.getOidcToken ?? getVercelOidcToken;
  const now = options.now ?? Date.now;
  let cached: { key: string; token: string; expiresAt: number } | undefined;
  let pending: { key: string; promise: Promise<string> } | undefined;
  return async (backendUrl: string): Promise<string | undefined> => {
    const provider = env.GCP_WORKLOAD_IDENTITY_PROVIDER;
    const serviceAccount = env.GCP_SERVICE_ACCOUNT_EMAIL;
    if (!provider && !serviceAccount) return undefined;
    if (
      !provider ||
      !serviceAccount ||
      provider !== provider.trim() ||
      serviceAccount !== serviceAccount.trim() ||
      !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(
        provider,
      ) ||
      !/^[a-zA-Z0-9_-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)
    )
      throw configuredError();
    const backend = new URL(backendUrl);
    if (
      backend.protocol !== 'https:' ||
      !backend.hostname.endsWith('.run.app') ||
      backend.username ||
      backend.password ||
      backend.pathname !== '/' ||
      backend.search ||
      backend.hash ||
      backend.port
    )
      throw configuredError();
    const audience = backend.origin;
    const key = `${provider}|${serviceAccount}|${audience}`;
    if (cached?.key === key && cached.expiresAt > now()) return cached.token;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      // Vercel's JWT custom audience uses HTTPS; STS identifies the same provider by its full resource name.
      const subjectToken = await readOidc({ audience: `https://iam.googleapis.com/${provider}` });
      if (!subjectToken) throw configuredError();
      const exchanged = await request('https://sts.googleapis.com/v1/token', {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
          audience: `//iam.googleapis.com/${provider}`,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
          subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
          subjectToken,
        }),
      });
      if (!exchanged.ok) throw configuredError();
      const sts = (await exchanged.json()) as { access_token?: unknown };
      if (typeof sts.access_token !== 'string' || !sts.access_token) throw configuredError();
      const generated = await request(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateIdToken`,
        {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sts.access_token}`,
          },
          body: JSON.stringify({ audience, includeEmail: true }),
        },
      );
      if (!generated.ok) throw configuredError();
      const result = (await generated.json()) as { token?: unknown };
      if (typeof result.token !== 'string') throw configuredError();
      let claims: { exp?: unknown; aud?: unknown };
      try {
        claims = JSON.parse(Buffer.from(result.token.split('.')[1] ?? '', 'base64url').toString());
      } catch {
        throw configuredError();
      }
      // These HTTPS-returned claims bound the cache only. Cloud Run verifies the token's signature and IAM authority.
      if (
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.aud !== audience ||
        claims.exp * 1000 <= now() + 60_000
      )
        throw configuredError();
      cached = {
        key,
        token: result.token,
        expiresAt: Math.min(claims.exp * 1000 - 60_000, now() + 300_000),
      };
      return result.token;
    })().catch(() => {
      throw configuredError();
    });
    pending = { key, promise };
    try {
      return await promise;
    } finally {
      if (pending?.promise === promise) pending = undefined;
    }
  };
}
