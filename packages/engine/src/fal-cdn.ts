import { providerJson } from './provider-http.js';
import type { ReadAssetOptions } from './output.js';

// fal's official File ACL guide scopes these rules to v3b CDN objects.
// Do not broaden to a suffix wildcard or accept a host from the token response.
export const falRestrictedCdnHost = 'v3b.fal.media';
const tokenEndpoint = 'https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3';
export class FalCdnTokenError extends Error {
  readonly code = 'fal_cdn_authentication_failed';
  constructor() {
    super('Restricted supplier media authentication is unavailable.');
  }
}
export function isFalRestrictedAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === falRestrictedCdnHost &&
      (!url.port || url.port === '443') &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      /^\/files\/b\/[a-zA-Z0-9_-]+\/[^/]+$/.test(url.pathname) &&
      !/%(?:2f|5c|2e)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
export interface FalCdnReadCapability {
  /** Conservative local use deadline; never cache or expose the bearer headers to a client. */
  expiresAt: string;
  readOptions: ReadAssetOptions;
}
/**
 * Exchange only at fal's fixed REST origin, then bind the short-lived CDN bearer
 * to the exact documented media host. Caller must authorize the persisted
 * job/output and its supplier connection before invoking this internal helper.
 * Source: https://fal.ai/docs/documentation/model-apis/file-access-controls
 */
export async function exchangeFalCdnReadToken({
  apiKey,
  assetUrl,
  expiresInSeconds = 300,
  fetch: request = fetch,
  now = Date.now,
}: {
  apiKey: string;
  assetUrl: string;
  /** OpenGen local safety bound: 60–3600 seconds, not a supplier maximum claim. */
  expiresInSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<FalCdnReadCapability> {
  if (
    !isFalRestrictedAssetUrl(assetUrl) ||
    !/^[\x21-\x7e]{1,8192}$/.test(apiKey) ||
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < 60 ||
    expiresInSeconds > 3600
  )
    throw new FalCdnTokenError();
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt)) throw new FalCdnTokenError();
  try {
    const response = await request(tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiration_seconds: expiresInSeconds }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw new FalCdnTokenError();
    }
    const body = await providerJson(response, 16_384);
    if (
      typeof body.token !== 'string' ||
      !/^[A-Za-z0-9._~+\/-]{1,8192}={0,2}$/.test(body.token) ||
      body.token === apiKey ||
      typeof body.expires_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.expires_at)
    )
      throw new FalCdnTokenError();
    const expiresAt = Math.min(Date.parse(body.expires_at), startedAt + expiresInSeconds * 1000);
    // The bounded downloader can use up to 30 seconds. Do not start with an expiring capability.
    if (!Number.isFinite(expiresAt) || expiresAt <= now() + 30_000) throw new FalCdnTokenError();
    return {
      expiresAt: new Date(expiresAt).toISOString(),
      readOptions: {
        headers: { Authorization: `Bearer ${body.token}` },
        credentialHosts: [falRestrictedCdnHost],
      },
    };
  } catch {
    // Never expose provider bodies, API keys, tokens, URLs or transport errors.
    throw new FalCdnTokenError();
  }
}
