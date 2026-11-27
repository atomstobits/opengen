import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHeroComparisonsFromSeeds,
  getHeroComparisons,
  getHeroComparisonsSafe,
  HERO_RIGHT_MODEL_ROTATION_ORDER,
  interleaveComparisonSeeds,
  modelFileSlug,
  resolveHeroModelPricing,
  validatePublicMediaBaseUrl,
  type ComparisonSeed,
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

  it('derives clean modal video filenames from any canonical model ID', () => {
    expect(modelFileSlug('bytedance/seedance-2.5')).toBe('seedance-2.5');
    expect(modelFileSlug('kling/kling-4.0')).toBe('kling-4.0');
    expect(modelFileSlug('bfl/flux-3-video')).toBe('flux-3-video');
    expect(modelFileSlug('google/gemini-omni-1.2-flash')).toBe('gemini-omni-1.2-flash');
    expect(modelFileSlug('bytedance/seedance-2.0')).toBe('seedance-2.0');
    expect(modelFileSlug('bytedance/seedance-2.5-flash')).toBe('seedance-2.5-flash');
    expect(modelFileSlug('alibaba/wan-3.0')).toBe('wan-3.0');
    expect(() => modelFileSlug('   ')).toThrow('Invalid modelId');
    expect(() => modelFileSlug('vendor/..')).toThrow('Invalid modelId');
  });

  it('interleaves diverse comparison models without back-to-back repeats and builds dynamic multi-ref media URLs', () => {
    const makeSeed = (
      id: string,
      rightModelId: string,
      resolution: '720p' | '1080p',
      inputCount = 1,
    ): ComparisonSeed => ({
      id,
      resolution,
      operation: inputCount > 1 ? 'reference-to-video' : 'image-to-video',
      durationSec: 15,
      heroDurationSec: 10,
      inputRole:
        inputCount > 1
          ? `${inputCount} references (@Image1–@Image${inputCount})`
          : 'First frame (@Image1)',
      inputCount,
      leftModelId: 'bytedance/seedance-2.5',
      rightModelId,
      shortPrompt: `Short prompt for ${id}`,
      fullPrompt: `Full prompt for ${id}`,
    });

    const rawSeeds: ComparisonSeed[] = [
      makeSeed('case-17', 'kling/kling-4.0', '1080p', 1),
      makeSeed('case-26', 'kling/kling-4.0', '720p', 1),
      makeSeed('case-10', 'bfl/flux-3-video', '720p', 1),
      makeSeed('case-01', 'bfl/flux-3-video', '720p', 1),
      makeSeed('case-23', 'google/gemini-omni-1.2-flash', '1080p', 1),
      makeSeed('case-24', 'google/gemini-omni-1.2-flash', '1080p', 5),
      makeSeed('case-20', 'bytedance/seedance-2.0', '1080p', 2),
      makeSeed('case-05', 'bytedance/seedance-2.0', '720p', 1),
      makeSeed('case-27', 'bytedance/seedance-2.5-flash', '720p', 1),
      makeSeed('case-34', 'bytedance/seedance-2.5-flash', '720p', 1),
      makeSeed('case-18', 'alibaba/wan-3.0', '1080p', 4),
      makeSeed('case-22', 'alibaba/wan-3.0', '1080p', 2),
    ];

    const interleaved = interleaveComparisonSeeds(rawSeeds);
    expect(interleaved.map((s) => s.id)).toEqual([
      'case-17',
      'case-23',
      'case-10',
      'case-18',
      'case-20',
      'case-27',
      'case-26',
      'case-24',
      'case-01',
      'case-22',
      'case-05',
      'case-34',
    ]);
    expect(interleaved.slice(0, 6).map((s) => s.rightModelId)).toEqual([
      ...HERO_RIGHT_MODEL_ROTATION_ORDER,
    ]);
    for (let i = 0; i < interleaved.length; i += 1) {
      const next = interleaved[(i + 1) % interleaved.length]!;
      expect(interleaved[i]!.rightModelId).not.toBe(next.rightModelId);
    }

    const clips = buildHeroComparisonsFromSeeds(rawSeeds, {
      mediaBaseUrl: 'https://media.opengen.dev',
      version: 'v3',
      nowDate: '2026-11-26',
    });
    expect(clips).toHaveLength(12);
    expect(clips[0]?.id).toBe('case-17');
    expect(clips[0]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v3/case-17/kling-4.0.mp4',
    );
    expect(clips[1]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v3/case-23/gemini-omni-1.2-flash.mp4',
    );
    expect(clips[2]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v3/case-10/flux-3-video.mp4',
    );
    expect(clips[3]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v3/case-18/wan-3.0.mp4',
    );
    expect(clips[4]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v3/case-20/seedance-2.0.mp4',
    );
    expect(clips[5]?.media.modalRightVideo).toBe(
      'https://media.opengen.dev/hero/v3/case-27/seedance-2.5-flash.mp4',
    );

    const multiRef = clips.find((c) => c.id === 'case-24');
    expect(multiRef?.inputCount).toBe(5);
    expect(multiRef?.media.inputImageWebp).toBe(
      'https://media.opengen.dev/hero/v3/case-24/input.webp',
    );
    expect(multiRef?.media.inputImagesWebp).toEqual([
      'https://media.opengen.dev/hero/v3/case-24/input.webp',
      'https://media.opengen.dev/hero/v3/case-24/input-2.webp',
      'https://media.opengen.dev/hero/v3/case-24/input-3.webp',
      'https://media.opengen.dev/hero/v3/case-24/input-4.webp',
      'https://media.opengen.dev/hero/v3/case-24/input-5.webp',
    ]);
  });

  it('resolves honest catalog pricing across diverse frontier right-side models', () => {
    const flux720 = resolveHeroModelPricing('bfl/flux-3-video', '720p', '2026-11-26');
    expect(flux720.modelName).toBe('FLUX 3 Video');
    expect(flux720.seriesHref).toBe('/bfl/flux-3-video');
    expect(flux720.providerName).toBe('Black Forest Labs');
    expect(flux720.priceLabel).toBe('$0.150/s');
    expect(flux720.comparePriceLabel).toBe('$0.170/s');
    expect(flux720.discountLabel).toBe('-12%');

    const gemini1080 = resolveHeroModelPricing(
      'google/gemini-omni-1.2-flash',
      '1080p',
      '2026-11-26',
    );
    expect(gemini1080.modelName).toBe('Gemini Omni 1.2 Flash');
    expect(gemini1080.seriesHref).toBe('/google/gemini-omni-1.2-flash');
    expect(gemini1080.providerName).toBe('Runway');
    expect(gemini1080.priceLabel).toBe('$0.100/s');
    expect(gemini1080.comparePriceLabel).toBe('≈$0.123/s');
    expect(gemini1080.discountLabel).toBe('-19%');

    const wan1080 = resolveHeroModelPricing('alibaba/wan-3.0', '1080p', '2026-11-26');
    expect(wan1080.modelName).toBe('Wan 3.0');
    expect(wan1080.seriesHref).toBe('/alibaba/wan-3.0');
    expect(wan1080.providerName).toBe('Pika');
    expect(wan1080.priceLabel).toBe('$0.130/s');
    expect(wan1080.comparePriceLabel).toBe('$0.200/s');
    expect(wan1080.discountLabel).toBe('-35%');

    const s20_1080 = resolveHeroModelPricing('bytedance/seedance-2.0', '1080p', '2026-11-26');
    expect(s20_1080.modelName).toBe('Seedance 2.0');
    expect(s20_1080.seriesHref).toBe('/bytedance/seedance-2.0');
    expect(s20_1080.providerName).toBe('BytePlus');
    expect(s20_1080.priceLabel).toBe('≈$0.370/s');
    expect(s20_1080.comparePriceLabel).toBe('≈$0.682/s');
    expect(s20_1080.discountLabel).toBe('-46%');
  });
});
