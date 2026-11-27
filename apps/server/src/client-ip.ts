import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export const CLIENT_IP_PROOF_HEADER = 'x-opengen-client-ip-proof';
export const CLIENT_IP_PROOF_MAX_SKEW_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;

export interface ResolvedClientIp {
  ip: string;
  source: 'signed-proxy' | 'socket';
}

/**
 * Validates and canonicalizes an IPv4 or IPv6 address literal (RFC 5952 compressed IPv6).
 * Unwraps IPv4-mapped IPv6 addresses (both ::ffff:a.b.c.d and ::ffff:xxxx:yyyy) to dotted IPv4
 * so equivalent numeric representations share one canonical rate-limit key.
 */
export function normalizeClientIp(raw: unknown): string | null {
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

function signMessage(
  secret: string,
  timestampSec: number,
  ip: string,
  method: string,
  pathname: string,
): string {
  return createHmac('sha256', secret)
    .update(`opengen-client-ip-v1\n${timestampSec}\n${ip}\n${method.toUpperCase()}\n${pathname}`)
    .digest('base64url');
}

/**
 * Creates a short-lived HMAC-SHA256 client-IP proof bound to request method and pathname.
 */
export function createClientIpProof(params: {
  secret: string;
  ip: string;
  method: string;
  pathname: string;
  nowMs?: number;
}): string | null {
  if (params.secret.length < MIN_SECRET_LENGTH) return null;
  const canonicalIp = normalizeClientIp(params.ip);
  if (!canonicalIp) return null;
  const timestampSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(timestampSec) || timestampSec <= 0) return null;
  const ipB64 = Buffer.from(canonicalIp, 'utf8').toString('base64url');
  const sig = signMessage(params.secret, timestampSec, canonicalIp, params.method, params.pathname);
  return `v1.${timestampSec}.${ipB64}.${sig}`;
}

/**
 * Verifies a signed proxy client-IP proof header bound to the current request method and pathname.
 * Returns null if the secret is unconfigured or the proof is missing, expired, malformed, or tampered.
 */
export function verifyClientIpProof(params: {
  proof: unknown;
  secret: string | undefined;
  method: string;
  pathname: string;
  nowMs?: number;
}): string | null {
  const secret = params.secret?.trim() ?? '';
  if (secret.length < MIN_SECRET_LENGTH) return null;
  if (typeof params.proof !== 'string' || params.proof.length === 0 || params.proof.length > 256)
    return null;
  const parts = params.proof.split('.');
  if (parts.length !== 4) return null;
  const [version, tsRaw, ipB64, sig] = parts as [string, string, string, string];
  if (
    version !== 'v1' ||
    !/^\d{9,12}$/.test(tsRaw) ||
    !/^[A-Za-z0-9_-]{4,88}$/.test(ipB64) ||
    !/^[A-Za-z0-9_-]{43}$/.test(sig)
  )
    return null;
  const timestampSec = Number(tsRaw);
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (
    !Number.isSafeInteger(timestampSec) ||
    Math.abs(nowSec - timestampSec) > CLIENT_IP_PROOF_MAX_SKEW_SECONDS
  )
    return null;
  let decodedIp: string;
  try {
    decodedIp = Buffer.from(ipB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decodedIp || decodedIp !== decodedIp.trim() || isIP(decodedIp) === 0) return null;
  const canonicalIp = normalizeClientIp(decodedIp);
  if (!canonicalIp) return null;
  // Verify the HMAC against the signed IP text first for compatibility with non-canonicalized
  // proxy deployments, then return the canonicalized address for uniform rate-limit keying.
  const expectedSig = signMessage(secret, timestampSec, decodedIp, params.method, params.pathname);
  const actualBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf))
    return null;
  return canonicalIp;
}

/**
 * Parses an explicit comma-separated allowlist of trusted ingress proxy IP addresses or CIDRs
 * for Fastify's `trustProxy` option. Rejects wildcards, boolean "true", and overly broad CIDRs
 * (IPv4 prefix < 8 or IPv6 prefix < 16) so callers cannot spoof X-Forwarded-For headers.
 */
export function parseTrustedProxies(raw: string | undefined): string[] | false {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return false;
  const entries = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  const validated: string[] = [];
  for (const entry of entries) {
    if (entry.includes('/')) {
      const parts = entry.split('/');
      if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1]!))
        throw new Error(`OPENGEN_TRUSTED_PROXIES contains an invalid CIDR entry: ${entry}`);
      const host = normalizeClientIp(parts[0]!);
      const prefix = Number(parts[1]!);
      const family = host ? isIP(host) : 0;
      const validPrefix =
        (family === 4 && prefix >= 8 && prefix <= 32) ||
        (family === 6 && prefix >= 16 && prefix <= 128);
      if (!host || !validPrefix)
        throw new Error(
          `OPENGEN_TRUSTED_PROXIES CIDR entry must be a specific IPv4 (/8../32) or IPv6 (/16../128) range: ${entry}`,
        );
      validated.push(`${host}/${prefix}`);
    } else {
      const host = normalizeClientIp(entry);
      if (!host)
        throw new Error(
          `OPENGEN_TRUSTED_PROXIES entries must be explicit IP addresses or CIDRs (never boolean/wildcard): ${entry}`,
        );
      validated.push(host);
    }
  }
  return validated;
}

/**
 * Resolves the trusted client IP for rate-limiting without trusting arbitrary X-Forwarded-For headers.
 * Prefers an HMAC-authenticated proxy proof when OPENGEN_PROXY_CLIENT_SECRET is configured,
 * and otherwise falls back to the direct TCP socket peer address (request.ip).
 */
export function resolveTrustedClientIp(
  request: Pick<FastifyRequest, 'ip' | 'headers' | 'method' | 'url'>,
  env: Readonly<Record<string, string | undefined>>,
  nowMs = Date.now(),
): ResolvedClientIp {
  const rawProof = request.headers[CLIENT_IP_PROOF_HEADER];
  const proof = typeof rawProof === 'string' ? rawProof : undefined;
  const pathname = request.url.split('?')[0] ?? request.url;
  const verified = verifyClientIpProof({
    proof,
    secret: env.OPENGEN_PROXY_CLIENT_SECRET,
    method: request.method,
    pathname,
    nowMs,
  });
  if (verified) return { ip: verified, source: 'signed-proxy' };
  return { ip: normalizeClientIp(request.ip) ?? 'unknown', source: 'socket' };
}
