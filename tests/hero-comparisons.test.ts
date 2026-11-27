import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getHeroComparisons,
  getHeroComparisonsSafe,
  resolveHeroModelPricing,
  validatePublicMediaBaseUrl,
} from '../apps/web/app/hero-comparisons';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('hero comparison pricing and media configuration', () => {
  it('computes honest catalog prices and cross-provider discounts from @media-router/catalog', () => {
    const seedance720 = resolveHeroModelPricing('bytedance/seedance-2.5', '720p', '2026-11-25');
    expect(seedance720.modelName).toBe('Seedance 2.5');
    expect(seedance720.seriesHref).toBe('/bytedance/seedance-2.5');
    expect(seedance720.providerName).toBe('BytePlus');
    expect(seedance720.priceLabel).toBe('≈$0.231/s');
    expect(seedance720.comparePriceLabel).toBe('≈$0.473/s');
    expect(seedance720.discountLabel).toBe('-51%');

    const seedance1080 = resolveHeroModelPricing('bytedance/seedance-2.5', '1080p', '2026-11-25');
    expect(seedance1080.providerName).toBe('BytePlus');
    expect(seedance1080.priceLabel).toBe('≈$0.569/s');
    expect(seedance1080.comparePriceLabel).toBe('≈$1.164/s');
    expect(seedance1080.discountLabel).toBe('-51%');
  });

  it('applies documented Kling 4.0 launch promotion before expiry and reverts cleanly after expiry', () => {
    const active1080 = resolveHeroModelPricing('kling/kling-4.0', '1080p', '2026-11-25');
    expect(active1080.modelName).toBe('Kling 4.0');
    expect(active1080.seriesHref).toBe('/kling/kling-4.0');
    expect(active1080.providerName).toBe('Runway');
    expect(active1080.priceLabel).toBe('$0.188/s');
    expect(active1080.comparePriceLabel).toBe('$0.235/s');
    expect(active1080.discountLabel).toBe('-20%');

    const active720 = resolveHeroModelPricing('kling/kling-4.0', '720p', '2026-11-25');
    expect(active720.priceLabel).toBe('$0.126/s');
    expect(active720.comparePriceLabel).toBe('$0.157/s');
    expect(active720.discountLabel).toBe('-20%');

    const expired = resolveHeroModelPricing('kling/kling-4.0', '1080p', '2026-12-01');
    expect(expired.priceLabel).toBe('$0.235/s');
    expect(expired.comparePriceLabel).toBeNull();
    expect(expired.discountLabel).toBeNull();
  });

  it('resolves official Kling 4.0 4K pricing and returns null when a model resolution is undocumented', () => {
    const kling4k = resolveHeroModelPricing('kling/kling-4.0', '4K', '2026-11-25');
    expect(kling4k.providerName).toBe('Kling AI');
    expect(kling4k.priceLabel).toBe('$0.549/s');
    expect(kling4k.comparePriceLabel).toBeNull();
    expect(kling4k.discountLabel).toBeNull();

    const unknown = resolveHeroModelPricing('kling/kling-4.0-flash', '4K', '2026-11-25');
    expect(unknown.priceLabel).toBeNull();
    expect(unknown.comparePriceLabel).toBeNull();
    expect(unknown.discountLabel).toBeNull();
  });

  it('validates public media base URLs and rejects credentials, queries or protocol-relative inputs', () => {
    expect(validatePublicMediaBaseUrl(undefined)).toBeNull();
    expect(validatePublicMediaBaseUrl('')).toBeNull();
    expect(validatePublicMediaBaseUrl('https://media.opengen.dev/')).toBe(
      'https://media.opengen.dev',
    );
    expect(validatePublicMediaBaseUrl('/hero-media/')).toBe('/hero-media');
    expect(() => validatePublicMediaBaseUrl('//media.opengen.dev')).toThrow('protocol-relative');
    expect(() => validatePublicMediaBaseUrl('https://user:pass@media.opengen.dev')).toThrow(
      'without credentials',
    );
    expect(() => validatePublicMediaBaseUrl('https://media.opengen.dev?token=abc')).toThrow(
      'without credentials',
    );
  });

  it('returns no comparisons when OPENGEN_HERO_MEDIA_BASE_URL is unset and builds 3-tier CDN URLs when configured', () => {
    vi.stubEnv('OPENGEN_HERO_MEDIA_BASE_URL', '');
    expect(getHeroComparisons()).toEqual([]);

    const clips = getHeroComparisons({
      mediaBaseUrl: 'https://media.opengen.dev',
      version: 'v1',
      nowDate: '2026-11-25',
    });
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      id: 'case-17',
      resolution: '1080p',
      operation: 'reference-to-video',
      durationSec: 10,
      heroDurationSec: 10,
    });
    expect(clips[0]?.left.discountLabel).toBe('-51%');
    expect(clips[0]?.right.discountLabel).toBe('-20%');
    expect(clips[0]?.media.heroPosterAvif).toBe(
      'https://media.opengen.dev/hero/v1/case-17/hero-poster.avif',
    );
    expect(clips[0]?.media.heroVideoAv1).toBe(
      'https://media.opengen.dev/hero/v1/case-17/hero-split.av1.mp4',
    );
    expect(clips[0]?.media.heroVideoH264).toBe(
      'https://media.opengen.dev/hero/v1/case-17/hero-split.h264.mp4',
    );
    expect(clips[0]?.media.modalLeftVideo).toBe(
      'https://media.opengen.dev/hero/v1/case-17/seedance-2.5.mp4',
    );
    expect(clips[0]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v1/case-17/kling-4.0.mp4',
    );
    expect(clips[1]).toMatchObject({
      id: 'case-26',
      resolution: '720p',
      operation: 'image-to-video',
      durationSec: 30,
      heroDurationSec: 10,
    });
    expect(clips[1]?.left.discountLabel).toBe('-51%');
    expect(clips[1]?.right.discountLabel).toBe('-20%');

    vi.stubEnv('OPENGEN_HERO_MEDIA_VERSION', '');
    const defaultClips = getHeroComparisons({
      mediaBaseUrl: 'https://media.opengen.dev',
      nowDate: '2026-11-25',
    });
    expect(defaultClips[0]?.media.heroPosterAvif).toBe(
      'https://media.opengen.dev/hero/v2/case-17/hero-poster.avif',
    );
    expect(defaultClips[0]?.media.heroVideoAv1).toBe(
      'https://media.opengen.dev/hero/v2/case-17/hero-split.av1.mp4',
    );
  });

  it('falls back safely to an empty comparison list when optional hero media URL is malformed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getHeroComparisonsSafe({ mediaBaseUrl: 'https://user:pass@media.opengen.dev' })).toEqual(
      [],
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
