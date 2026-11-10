import { describe, expect, it, vi } from 'vitest';
import {
  exchangeFalCdnReadToken,
  isFalRestrictedAssetUrl,
} from '../packages/engine/src/fal-cdn.js';
import { readPublicAsset } from '../packages/engine/src/output.js';

const apiKey = 'synthetic-account:key';
const assetUrl = 'https://v3b.fal.media/files/b/fixture/output.png';
const now = () => Date.parse('2026-11-04T12:00:00Z');
const tokenResponse = (extra: Record<string, unknown> = {}) =>
  Response.json({
    token: 'synthetic.cdn.token',
    token_type: 'Bearer',
    expires_at: '2026-11-04T12:05:00Z',
    ...extra,
  });

describe('fal restricted CDN authentication', () => {
  it('exchanges only at the fixed REST endpoint and returns a host-bound bearer', async () => {
    const request = vi.fn(async () => tokenResponse({ base_url: 'https://untrusted.example' }));
    const capability = await exchangeFalCdnReadToken({
      apiKey,
      assetUrl,
      now,
      fetch: request as typeof fetch,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      'https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiration_seconds: 300 }),
      }),
    );
    expect(capability).toEqual({
      expiresAt: '2026-11-04T12:05:00.000Z',
      readOptions: {
        headers: { Authorization: 'Bearer synthetic.cdn.token' },
        credentialHosts: ['v3b.fal.media'],
      },
    });
    expect(JSON.stringify(capability)).not.toContain(apiKey);
    // Existing downloader rejects before DNS/GET. It cannot send the CDN token to another host.
    await expect(
      readPublicAsset('https://evil.example/output.png', capability.readOptions),
    ).rejects.toThrow('Asset credentials are not permitted for this host.');
    await expect(
      readPublicAsset('https://v3b.fal.media.evil.example/output.png', capability.readOptions),
    ).rejects.toThrow('Asset credentials are not permitted for this host.');
  });
  it.each([
    'https://fal.media/files/b/fixture/output.png',
    'https://vf.fal.media/files/b/fixture/output.png',
    'https://v3.fal.media/files/b/fixture/output.png',
    'https://v3b.fal.media.evil.example/files/b/fixture/output.png',
    'https://evil.example/files/b/fixture/output.png',
    'http://v3b.fal.media/files/b/fixture/output.png',
    'https://v3b.fal.media:444/files/b/fixture/output.png',
    'https://user@v3b.fal.media/files/b/fixture/output.png',
    'https://v3b.fal.media/files/b/fixture/output.png?identity=another',
    'https://v3b.fal.media/files/b/fixture/output.png#fragment',
    'https://v3b.fal.media/files/upload',
    'https://v3b.fal.media/files/b/fixture/%2e%2e%2fsecret.png',
  ])('refuses unsupported target %s before using the API key', async (url) => {
    const request = vi.fn();
    expect(isFalRestrictedAssetUrl(url)).toBe(false);
    await expect(
      exchangeFalCdnReadToken({ apiKey, assetUrl: url, now, fetch: request as typeof fetch }),
    ).rejects.toMatchObject({ code: 'fal_cdn_authentication_failed' });
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds local use even if the supplier returns a much longer token expiry', async () => {
    const capability = await exchangeFalCdnReadToken({
      apiKey,
      assetUrl,
      now,
      expiresInSeconds: 60,
      fetch: vi.fn(async () =>
        tokenResponse({ expires_at: '2026-12-04T12:00:00Z' }),
      ) as typeof fetch,
    });
    expect(capability.expiresAt).toBe('2026-11-04T12:01:00.000Z');
  });
  it.each([
    { token: '' },
    { token: apiKey },
    { token: 'not\na\nheader' },
    { token: 'x'.repeat(8193) },
    { expires_at: null },
    { expires_at: 1793793900 },
    { expires_at: 'tomorrow' },
    { expires_at: '2026-11-04T11:59:00Z' },
    { expires_at: '2026-11-04T12:00:30Z' },
  ])('fails closed on invalid or expiring token response %j', async (body) => {
    await expect(
      exchangeFalCdnReadToken({
        apiKey,
        assetUrl,
        now,
        fetch: vi.fn(async () => tokenResponse(body)) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'fal_cdn_authentication_failed' });
  });
  it('bounds response bytes and returns no provider payload in the error', async () => {
    const secret = 'synthetic-private-provider-body';
    for (const response of [
      new Response(secret, { status: 403 }),
      new Response(secret, { status: 302, headers: { Location: 'https://evil.example' } }),
      new Response(secret.repeat(1000)),
      new Response('{not-json'),
    ]) {
      const request = vi.fn(async () => response);
      const result = await exchangeFalCdnReadToken({
        apiKey,
        assetUrl,
        now,
        fetch: request as typeof fetch,
      }).catch((error: Error) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe(
        'Restricted supplier media authentication is unavailable.',
      );
      expect(request).toHaveBeenCalledOnce();
    }
  });
  it('does not automatically retry a transport failure or expose its error', async () => {
    const request = vi.fn(async () => {
      throw new Error(`upstream error ${apiKey}`);
    });
    await expect(
      exchangeFalCdnReadToken({ apiKey, assetUrl, now, fetch: request as typeof fetch }),
    ).rejects.toThrow('Restricted supplier media authentication is unavailable.');
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects invalid local lifetime or credentials without an exchange', async () => {
    const request = vi.fn();
    for (const lifetime of [0, 59, 3601, NaN, Infinity, 60.5])
      await expect(
        exchangeFalCdnReadToken({
          apiKey,
          assetUrl,
          now,
          expiresInSeconds: lifetime,
          fetch: request as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'fal_cdn_authentication_failed' });
    await expect(
      exchangeFalCdnReadToken({ apiKey: 'key\n', assetUrl, now, fetch: request as typeof fetch }),
    ).rejects.toMatchObject({ code: 'fal_cdn_authentication_failed' });
    expect(request).not.toHaveBeenCalled();
  });
});
