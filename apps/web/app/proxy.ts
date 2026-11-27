import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { createGcpTransport } from './gcp-transport';
import { registeredBackendPath } from './registered-http';

const CLIENT_IP_PROOF_HEADER = 'x-opengen-client-ip-proof';
const TRUSTED_SINGLE_IP_HEADERS = new Set([
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'fly-client-ip',
  'x-real-ip',
]);

function normalizeProxyClientIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f\s%]/.test(trimmed)) return null;
  if (isIP(trimmed) === 4) return trimmed;
  if (isIP(trimmed) !== 6) return null;
  let canonical: string;
  try {
    const parsed = new URL(`http://[${trimmed.toLowerCase()}]/`).hostname;
    if (!parsed.startsWith('[') || !parsed.endsWith(']')) return null;
    canonical = parsed.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
  const mappedDotted = canonical.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted && isIP(mappedDotted[1]!) === 4) return mappedDotted[1]!;
  const mappedHex = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isIP(ipv4) === 4) return ipv4;
  }
  return isIP(canonical) === 6 ? canonical : null;
}

function extractPlatformTrustedClientIp(
  request: Request,
  env: NodeJS.ProcessEnv,
  injectedClientIp?: string | ((request: Request) => string | null),
): string | null {
  if (injectedClientIp !== undefined) {
    const raw =
      typeof injectedClientIp === 'function' ? injectedClientIp(request) : injectedClientIp;
    return normalizeProxyClientIp(raw);
  }
  const explicitHeader = env.OPENGEN_TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase() ?? '';
  if (explicitHeader) {
    const raw = request.headers.get(explicitHeader);
    if (!raw) return null;
    if (TRUSTED_SINGLE_IP_HEADERS.has(explicitHeader)) {
      return raw.includes(',') ? null : normalizeProxyClientIp(raw);
    }
    if (explicitHeader === 'x-forwarded-for') {
      const parts = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      return parts.length > 0 ? normalizeProxyClientIp(parts.at(-1)) : null;
    }
    return null;
  }
  if (env.VERCEL === '1') {
    const vercelIp = request.headers.get('x-vercel-forwarded-for');
    if (!vercelIp) return null;
    const parts = vercelIp
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? normalizeProxyClientIp(parts.at(-1)) : null;
  }
  return null;
}

function signProxyClientIpProof(params: {
  secret: string;
  ip: string;
  method: string;
  pathname: string;
  nowMs: number;
}): string {
  const timestampSec = Math.floor(params.nowMs / 1000);
  const ipB64 = Buffer.from(params.ip, 'utf8').toString('base64url');
  const sig = createHmac('sha256', params.secret)
    .update(
      `opengen-client-ip-v1\n${timestampSec}\n${params.ip}\n${params.method.toUpperCase()}\n${params.pathname}`,
    )
    .digest('base64url');
  return `v1.${timestampSec}.${ipB64}.${sig}`;
}

const unavailable = () =>
  Response.json(
    {
      error:
        'The gateway is not reachable. Start the API service and configure this installation before submitting a generation.',
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
async function requestBody(
  request: Request,
  path: string,
): Promise<{ body: string | ArrayBuffer; contentType: string } | undefined> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return undefined;
  const pathname = path.split('?')[0]!;
  const loginForm = pathname === '/auth/login' && request.method === 'POST';
  const inputType = request.headers.get('content-type') ?? '';
  if (
    loginForm &&
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      inputType,
    )
  )
    throw Object.assign(new Error('Invalid sign-in form media type.'), { status: 415 });
  if (!request.body) return loginForm ? { body: '', contentType: inputType } : undefined;
  const multipart = pathname === '/v1/images/edits' && /^multipart\/form-data\s*;/i.test(inputType);
  const bodyLimit = loginForm
    ? 2048
    : multipart
      ? 256 * 1024
      : pathname.startsWith('/oauth/')
        ? 16384
        : 1_000_000;
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) {
        await reader.cancel();
        throw Object.assign(new Error('Request exceeds the gateway body limit.'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size && !loginForm) return undefined;
  const form =
    loginForm ||
    (['/oauth/token', '/oauth/revoke'].includes(pathname) &&
      /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(inputType));
  if (!multipart && !form && !/^application\/json(?:\s*;|$)/i.test(inputType))
    throw Object.assign(
      new Error('Registered gateway operations accept application/json bodies only.'),
      { status: 415 },
    );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (loginForm) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw Object.assign(new Error('Invalid UTF-8 sign-in form.'), { status: 400 });
    }
  }
  return {
    // Login action fields stay byte-for-byte intact: only the server parses and validates them.
    // Stripe also authenticates the original bytes, including any BOM and whitespace.
    body:
      path === '/webhooks/stripe' || multipart || loginForm
        ? bytes.buffer
        : new TextDecoder().decode(bytes),
    contentType:
      path === '/webhooks/stripe' || multipart || loginForm
        ? inputType
        : form
          ? 'application/x-www-form-urlencoded'
          : 'application/json',
  };
}
export function createForwarder(
  options: {
    env?: NodeJS.ProcessEnv;
    request?: typeof fetch;
    transport?: (backend: string) => Promise<string | undefined>;
    clientIp?: string | ((request: Request) => string | null);
    now?: () => number;
  } = {},
) {
  const env = options.env ?? process.env;
  const requestBackend = options.request ?? fetch;
  const transport = options.transport ?? createGcpTransport({ env, request: requestBackend });
  const now = options.now ?? Date.now;
  return async (request: Request, path: string): Promise<Response> => {
    if (!registeredBackendPath(path, request.method))
      return Response.json(
        { error: 'Unregistered backend operation.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } },
      );
    const stripeWebhook = path === '/webhooks/stripe';
    const loginNotice = path.split('?')[0] === '/auth/login';
    const loginCallback = path.split('?')[0] === '/auth/callback';
    const signature = request.headers.get('stripe-signature');
    if (stripeWebhook && (!signature || signature.length > 4096))
      return Response.json(
        { error: 'Invalid payment webhook signature.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    if (stripeWebhook && !env.MEDIA_ROUTER_API_URL) return unavailable();
    try {
      const backend = new URL(env.MEDIA_ROUTER_API_URL ?? 'http://127.0.0.1:4310');
      if (
        !['http:', 'https:'].includes(backend.protocol) ||
        backend.username ||
        backend.password ||
        backend.pathname !== '/' ||
        backend.search ||
        backend.hash
      )
        return unavailable();
      const body = await requestBody(request, path);
      const compactStatus = /^\/v1\/generations\/[a-f0-9-]{36}\/status$/.test(path.split('?')[0]!);
      const ownedVideo = /^\/v1\/videos\/[a-f0-9-]{36}\/content$/.test(path.split('?')[0]!);
      const headers = new Headers();
      for (const name of stripeWebhook
        ? ['stripe-signature', 'content-type']
        : [
            'authorization',
            'idempotency-key',
            'x-opengen-workspace',
            'x-opengen-recovery-scope',
            'cookie',
            'origin',
            'accept',
            'mcp-protocol-version',
            'mcp-session-id',
            ...(ownedVideo ? ['range', 'if-range'] : []),
          ]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (body !== undefined) headers.set('content-type', body.contentType);
      if (path === '/mcp' && !headers.has('accept'))
        headers.set('accept', 'application/json, text/event-stream');
      const pathname = path.split('?')[0]!;
      const proxyClientSecret = env.OPENGEN_PROXY_CLIENT_SECRET?.trim() ?? '';
      if (
        proxyClientSecret.length >= 32 &&
        (loginNotice || loginCallback || pathname === '/v1/billing/trial-credit')
      ) {
        const trustedClientIp = extractPlatformTrustedClientIp(request, env, options.clientIp);
        if (trustedClientIp) {
          headers.set(
            CLIENT_IP_PROOF_HEADER,
            signProxyClientIpProof({
              secret: proxyClientSecret,
              ip: trustedClientIp,
              method: request.method,
              pathname,
              nowMs: now(),
            }),
          );
        }
      }
      const identity = await transport(backend.origin);
      if (stripeWebhook && !identity) return unavailable();
      if (identity) headers.set('X-Serverless-Authorization', `Bearer ${identity}`);
      const response = await requestBackend(`${backend.origin}${path}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: body.body }),
        signal: AbortSignal.timeout(
          compactStatus ||
            path === '/mcp' ||
            ['/v1/images/generations', '/v1/images/edits'].includes(path.split('?')[0]!) ||
            ownedVideo
            ? 35_000
            : 15_000,
        ),
        cache: 'no-store',
        redirect: 'manual',
      });
      // This ingress has no caller authentication; IAM denial is a transport failure.
      if (stripeWebhook && [401, 403].includes(response.status)) return unavailable();
      const outputHeaders = new Headers({
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      if (!stripeWebhook)
        for (const cookie of response.headers.getSetCookie())
          outputHeaders.append('set-cookie', cookie);
      for (const name of stripeWebhook
        ? ['retry-after']
        : [
            'content-disposition',
            'x-next-cursor',
            'location',
            'www-authenticate',
            'mcp-session-id',
            'mcp-protocol-version',
            'retry-after',
            'allow',
            ...(loginNotice ? ['content-security-policy', 'x-content-type-options'] : []),
            ...(loginNotice || loginCallback ? ['referrer-policy'] : []),
            ...(ownedVideo
              ? ['content-range', 'accept-ranges', 'content-length', 'etag', 'last-modified']
              : []),
            ...(['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(path.split('?')[0]!)
              ? [
                  'access-control-allow-origin',
                  'access-control-allow-methods',
                  'access-control-allow-headers',
                  'access-control-max-age',
                ]
              : []),
          ]) {
        const value = response.headers.get(name);
        if (value) outputHeaders.set(name, value);
      }
      const upstreamCache = response.headers.get('cache-control');
      if (loginNotice && upstreamCache && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(upstreamCache))
        outputHeaders.set('cache-control', upstreamCache);
      return new Response(
        request.method === 'HEAD' || [204, 205, 304].includes(response.status)
          ? null
          : response.body,
        { status: response.status, headers: outputHeaders },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        ([413, 415].includes(Number(error.status)) || (loginNotice && Number(error.status) === 400))
      )
        return Response.json(
          {
            error:
              Number(error.status) === 413
                ? 'Request exceeds the gateway body limit.'
                : loginNotice
                  ? Number(error.status) === 400
                    ? 'The sign-in form must contain valid UTF-8.'
                    : 'The sign-in form requires application/x-www-form-urlencoded with UTF-8.'
                  : 'Registered gateway operations accept application/json bodies only.',
          },
          { status: Number(error.status), headers: { 'Cache-Control': 'no-store' } },
        );
      return unavailable();
    }
  };
}
// Callers supply their own workspace authorization; installation/provider credentials are never injected.
export const forward = createForwarder();
