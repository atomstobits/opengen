import { catalog, seriesHref } from '@media-router/catalog';
import type { Operation, Rate, Route } from '@media-router/contracts';

export type HeroModelPricing = {
  modelId: string;
  modelName: string;
  seriesHref: string;
  resolution: string;
  providerName: string | null;
  priceLabel: string | null;
  comparePriceLabel: string | null;
  discountLabel: string | null;
  priceNote: string;
  sourceUrl: string;
};

export type HeroComparisonMedia = {
  heroPosterWebp: string;
  heroPosterAvif?: string;
  heroVideoAv1?: string;
  heroVideoH264: string;
  inputThumbWebp: string;
  inputImageWebp: string;
  inputImagesWebp: string[];
  modalLeftVideo: string;
  modalRightVideo: string;
  modalLeftPoster: string;
  modalRightPoster: string;
};

export type HeroComparisonItem = {
  id: string;
  resolution: '480p' | '720p' | '1080p';
  operation: Operation;
  durationSec: number;
  heroDurationSec: number;
  shortPrompt: string;
  fullPrompt: string;
  inputRole: string;
  inputCount: number;
  left: HeroModelPricing;
  right: HeroModelPricing;
  media: HeroComparisonMedia;
};

type DocumentedPromotion = {
  routeId: string;
  discountPercent: number;
  validThrough: string;
  note: string;
  sourceUrl: string;
};

/**
 * Dated, source-linked active provider promotions.
 * Automatically expires after `validThrough` so homepage badges revert to catalog list rates.
 */
const ACTIVE_PROMOTIONS: DocumentedPromotion[] = [
  {
    routeId: 'runway-undisclosed/kling-kling-4.0',
    discountPercent: 20,
    validThrough: '2026-11-30',
    note: 'Runway Kling 4.0 promotional discount (-20% off list through 2026-11-30)',
    sourceUrl: 'https://dev.runwayml.com/learn/kling-4-0-api',
  },
];

export type ComparisonSeed = {
  id: string;
  resolution: '480p' | '720p' | '1080p';
  operation: Operation;
  durationSec: number;
  heroDurationSec: number;
  inputRole: string;
  inputCount?: number;
  leftModelId: string;
  rightModelId: string;
  shortPrompt: string;
  fullPrompt: string;
};

/**
 * Preferred round-robin right-side model order so visitors immediately see
 * diverse frontier models without back-to-back repeats (starting with Kling 4.0 flagship case-17).
 */
export const HERO_RIGHT_MODEL_ROTATION_ORDER = [
  'kling/kling-4.0',
  'google/gemini-omni-1.2-flash',
  'bfl/flux-3-video',
  'alibaba/wan-3.0',
  'bytedance/seedance-2.0',
  'bytedance/seedance-2.5-flash',
] as const;

export function modelFileSlug(modelId: string): string {
  const raw = modelId.trim();
  const segment = raw.split('/').pop() ?? '';
  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') {
    throw new Error(`Invalid modelId for hero media filename: ${modelId}`);
  }
  return slug;
}

/**
 * Interleaves comparison clips across distinct right-side models in deterministic round-robin order,
 * preserving relative order within each model group so the flagship clip stays first.
 */
export function interleaveComparisonSeeds<T extends { rightModelId: string }>(
  seeds: readonly T[],
  preferredModelOrder: readonly string[] = HERO_RIGHT_MODEL_ROTATION_ORDER,
): T[] {
  const buckets = new Map<string, T[]>();
  for (const seed of seeds) {
    const queue = buckets.get(seed.rightModelId);
    if (queue) queue.push(seed);
    else buckets.set(seed.rightModelId, [seed]);
  }

  const orderedModels = [
    ...preferredModelOrder.filter((modelId) => buckets.has(modelId)),
    ...[...buckets.keys()].filter((modelId) => !preferredModelOrder.includes(modelId)),
  ];

  const result: T[] = [];
  let remaining = seeds.length;
  while (remaining > 0) {
    for (const modelId of orderedModels) {
      const queue = buckets.get(modelId);
      if (queue && queue.length > 0) {
        result.push(queue.shift()!);
        remaining -= 1;
      }
    }
  }
  return result;
}

const BUILTIN_COMPARISON_SEEDS: ComparisonSeed[] = [
  {
    id: 'case-17',
    resolution: '1080p',
    operation: 'reference-to-video',
    durationSec: 10,
    heroDurationSec: 10,
    inputRole: 'Reference (@Image1)',
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'kling/kling-4.0',
    shortPrompt:
      'Hallway to luxury Miami villa match cut from @Image1 — casual sweatshirt to black mini dress and knee-high boots.',
    fullPrompt:
      'subjects: @Image1 role=Character: woman with long layered brown hair parted in the center, tan skin, hazel-green eyes, dark defined eyebrows, and full glossy lips\n\nstyle: Realistic vertical fashion-transformation reel, static smartphone camera, full-body framing with no camera movement throughout\n\nbrief: A woman transforms instantly from an ordinary hallway to a luxury Miami villa via a fake-impact match cut, synchronized to energetic fashion music.\n\nshots: Shot 1 (0.0–2.30 SECONDS): (Energetic fashion music begins). In an ordinary apartment hallway with cream walls, beige flooring, and a plain white door under flat interior lighting, @Image1 wears an oversized gray sweatshirt, loose faded jeans, gray-and-white sneakers, and a dark-brown shoulder tote. She starts close to the stationary camera as though she just pressed record, steps backward into the doorway, and performs an ordinary, slightly awkward dance with small jogging steps, shoulder bounces, relaxed hand flicks, and gentle side-to-side movement.\nShot 1 continuation (2.30–2.77 SECONDS): @Image1 suddenly accelerates toward the open door, tightly crosses both arms over her chest, and performs a sharp sideways hop, throwing one shoulder toward the doorframe while raising one knee and tilting her torso as if about to collide forcefully with the door. She does not actually hit it. Cut at the exact peak of motion immediately before physical contact, with no shoulder contact, door movement, or collision reaction.\nShot 2 (2.77–3.27 SECONDS): Single-frame hard match cut at exactly 2.77 seconds with no visual effect. SFX: <sharp bass hit>. @Image1 begins in nearly the identical crossed-arm angle and screen position, instantly transformed: her attire is now a fitted black sleeveless high-neck mini dress, black knee-high heeled boots, and oversized dark sunglasses, holding a miniature black top-handle handbag. The scene instantly becomes a luxury open-plan Miami villa in bright tropical daylight with cream limestone walls, high ceilings, ivory rounded seating, white sofas, organic wooden coffee table, pale textured rugs, and floor-to-ceiling glass doors showing a palm-filled garden, pool, and patio; the doorframe is replaced by an aligned white villa column. Completing momentum from the fake collision, she lands and rebounds slightly with crossed arms, uncrosses them, plants feet wide, places one hand behind her head, swings the handbag downward, and performs a confident hip sway.\nShot 3 (3.27–3.87 SECONDS): Hard cut at 3.27 seconds synchronized to music beat. In the same Miami villa, @Image1 is suddenly bent forward with both knees flexed and hands on her thighs, looking toward the camera through sunglasses while executing two fast hip bounces.\nShot 4 (3.87–4.47 SECONDS): Hard cut at 3.87 seconds synchronized to music beat. @Image1 is suddenly upright, balancing on one leg with the opposite knee lifted high. One hand holds the raised boot near the shin while the other lifts the handbag beside her face as she waves playfully toward the camera.\nShot 5 (4.47–5.00 SECONDS): Hard cut at 4.47 seconds synchronized to music beat. @Image1 is suddenly upside down in a controlled handstand with palms planted firmly on the villa floor and legs open in a wide V-shaped split, executing one brief scissor kick while the handbag rests securely nearby on the floor.\nShot 6 (5.00–6.03 SECONDS): Hard cut at 5.00 seconds synchronized to music beat. @Image1 is upright again, walking confidently forward toward the stationary camera while swinging her handbag, swaying her hips, and alternating both hands in playful calm-down gestures.\nShot 7 (6.03–10.5 SECONDS): Hard cut at 6.03 seconds synchronized to music beat. @Image1 is suddenly seated on the villa floor leaning back on both hands, one knee bent while the other leg extends vertically upward. Until 10.5 seconds, she performs energetic floor choreography with repeated upward kicks, alternating straight and bent knees, slow scissor movements, pointed boots, hip rocking, and exaggerated glances between her raised boot and the camera, holding one leg high at the finish.\n\nconstraints: No real door collision, no shoulder touching the door, no moving or breaking door, no injury, no impact deformation, no literal collision sound. No gradual transformation, morphing, flash, smoke, or particles. No apartment setting after 2.77 seconds, no Miami villa before 2.77 seconds. Preserve identical Miami villa background continuity across shots 2 through 7. No camera movement; camera remains completely stationary. No floating handbag. No extra characters. No spoken dialogue.',
  },
  {
    id: 'case-26',
    resolution: '720p',
    operation: 'image-to-video',
    durationSec: 30,
    heroDurationSec: 10,
    inputRole: 'First frame (@Image1)',
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'kling/kling-4.0',
    shortPrompt:
      'Five street dancers from @Image1 perform synchronized night choreography in front of a warmly lit food stall.',
    fullPrompt:
      'Use @Image1 as the first frame. subjects: @Image1 role=FirstFrame: opening full shot showing five young women in street-dance outfits standing in a row on an asphalt street in front of a lit food stall at night\nNARI: chestnut twin ponytails, patterned faux-fur jacket, beige skort, brown boot covers\nMIYU: dark cap, sage top, beige shorts, cream leg warmers\nSENA: white beanie, navy top, metallic-gray trousers\nNOA: white fur hat, blue scarf, cream vest, dark flared jeans\nARIA: ash-blond hair, white fur bolero, silver skort, white boot covers\n\nstyle: Photorealistic pop performance in a real neighborhood setting; natural skin texture, detailed knit and metallic fabric, individual faux-fur fibers, grounded shoe contact, realistic asphalt shadows, and consistent warm stall lighting balanced with cool streetlights\n\nbrief: A five-member street-dance performance on an asphalt neighborhood block at night with a red-and-white striped food-stall awning, warm bulbs, metal counter, and red stools in the background. (original rhythmic dance-pop instrumental with a playful bass line and crisp percussion) <restrained neighborhood ambience, faint shoe contact on asphalt>\n\nshots: 0–5 seconds: Continuing directly from @Image1, all five performers step into a synchronized groove with two compact side steps, a shoulder accent, and a clean hand sweep across the waist. NARI remains slightly forward while the others maintain open staggered positions behind and beside her. The camera tracks backward slowly, preserving the lit food stall and the complete group.\n5–10 seconds: The dancers lift one arm into a curved shape above the head while the opposite hand rests near the hip, reverse the arm shape on the next beat, then release into a small torso turn. A brief medium view highlights NARI during the stationary gesture while the other members remain recognizable behind her, returning to a wide view as the phrase ends. Faux fur, ponytails, and loose trousers settle naturally between accents.\n10–15 seconds: The group advances two measured steps toward the camera while it tracks backward at matching speed, revealing faded yellow road markings. The dancers execute alternating knee lifts, small forward extensions below hip height, and grounded step-downs, keeping every lifted leg clearly connected to its body while the stall recedes deeper into the background.\n15–20 seconds: ARIA takes one short diagonal step forward through an open gap as NARI shifts outward. ARIA performs a shoulder roll, a compact hand flourish beside her face, and a controlled quarter-turn back toward the camera, while the other four dancers maintain a simple step-touch. The camera pulls back before ARIA returns to the line, keeping all five present.\n20–25 seconds: Reforming into a shallow line with SENA and NOA slightly offset to keep every face visible, the dancers execute a synchronized sequence: heel-toe step, bent-elbow accent, hands returning to hips, followed by a clean knee lift and grounded recovery, captured in a gently moving three-quarter wide shot keeping the road level and all five full bodies in frame.\n25–28 seconds: All five open spacing with one small outward step, repeating the overhead arm curve, followed by a shoulder accent and a coordinated forward hand gesture, with individual expressive personalities aligned to the shared rhythm.\n28–30 seconds: The group lands the final beat in a balanced formation with NARI near center and complementary poses separated by clear gaps. The dancers hold the pose briefly, easing into small smiles and natural breathing, with all five fully visible against the warmly lit food stall.\n\nconstraints: Maintain exactly five performers throughout. No recognizable lyrics, narration, or subtitles. Avoid duplicated members, merged limbs, changing fur colors, sliding shoes, unstable trouser hems, warped road markings, excessive blur, slow motion, sudden exposure changes, captions, logos, and watermarks.',
  },
];

function formatPerSecondUsd(usdMicros: number, approximate = false): string {
  const dollars = usdMicros / 1_000_000;
  const formatted = dollars.toLocaleString('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  return `${approximate ? '≈' : ''}$${formatted}/s`;
}

function findRouteRate(
  route: Route,
  resolution: string,
): (Rate & { approximate?: boolean }) | null {
  const matches = (rate: Rate) =>
    rate.unit === 'output-second' && rate.resolution.toLowerCase() === resolution.toLowerCase();
  const qualified = route.rates.find(matches);
  if (qualified) return qualified;
  const published = route.publishedPricing?.outputRates?.find(matches);
  return published ?? null;
}

/**
 * Computes the cheapest documented/qualified route price and verified discount
 * for a catalog model variant at a given resolution. Never fabricates unknown prices.
 */
export function resolveHeroModelPricing(
  modelId: string,
  resolution: string,
  nowDate = new Date().toISOString().slice(0, 10),
): HeroModelPricing {
  const model = catalog.models.find((item) => item.id === modelId);
  const modelName = model?.name ?? modelId;
  const canonicalSeriesHref = seriesHref(modelId) ?? '/models';
  const fallbackSourceUrl = model?.source.url ?? 'https://opengen.dev/models';

  const deployments = new Map(catalog.deployments.map((d) => [d.id, d]));
  const providers = new Map(catalog.providers.map((p) => [p.id, p]));

  type PricedCandidate = {
    routeId: string;
    providerId: string;
    providerName: string;
    listUsdMicros: number;
    effectiveUsdMicros: number;
    promo: DocumentedPromotion | null;
    approximate: boolean;
    sourceUrl: string;
  };

  const candidatesByProvider = new Map<string, PricedCandidate>();
  for (const route of catalog.routes) {
    if (route.modelId !== modelId || route.status === 'retired') continue;
    const rate = findRouteRate(route, resolution);
    if (!rate) continue;
    const deployment = deployments.get(route.deploymentId);
    const provider = deployment ? providers.get(deployment.providerId) : undefined;
    if (!deployment || !provider) continue;
    const promo =
      ACTIVE_PROMOTIONS.find(
        (entry) => entry.routeId === route.id && nowDate <= entry.validThrough,
      ) ?? null;
    const effectiveUsdMicros = promo
      ? Math.round((rate.usdMicros * (100 - promo.discountPercent)) / 100)
      : rate.usdMicros;
    const sourceUrl =
      promo?.sourceUrl ?? route.publishedPricing?.source.url ?? route.pricingSource.url;
    const existing = candidatesByProvider.get(provider.id);
    if (!existing || effectiveUsdMicros < existing.effectiveUsdMicros) {
      candidatesByProvider.set(provider.id, {
        routeId: route.id,
        providerId: provider.id,
        providerName: provider.name,
        listUsdMicros: rate.usdMicros,
        effectiveUsdMicros,
        promo,
        approximate: Boolean(rate.approximate),
        sourceUrl,
      });
    }
  }

  const candidates = [...candidatesByProvider.values()].sort(
    (a, b) => a.effectiveUsdMicros - b.effectiveUsdMicros,
  );
  const cheapest = candidates[0];
  if (!cheapest) {
    return {
      modelId,
      modelName,
      seriesHref: canonicalSeriesHref,
      resolution,
      providerName: null,
      priceLabel: null,
      comparePriceLabel: null,
      discountLabel: null,
      priceNote: `Published ${resolution} pricing for ${modelName} is not yet documented.`,
      sourceUrl: fallbackSourceUrl,
    };
  }

  if (cheapest.promo) {
    return {
      modelId,
      modelName,
      seriesHref: canonicalSeriesHref,
      resolution,
      providerName: cheapest.providerName,
      priceLabel: formatPerSecondUsd(cheapest.effectiveUsdMicros, cheapest.approximate),
      comparePriceLabel: formatPerSecondUsd(cheapest.listUsdMicros, false),
      discountLabel: `-${cheapest.promo.discountPercent}%`,
      priceNote: `${cheapest.providerName} ${resolution}: ${cheapest.promo.note}`,
      sourceUrl: cheapest.promo.sourceUrl,
    };
  }

  const highest = [...candidates].sort((a, b) => b.listUsdMicros - a.listUsdMicros)[0];
  if (highest && highest.listUsdMicros > cheapest.effectiveUsdMicros) {
    const savingsPct = Math.round((1 - cheapest.effectiveUsdMicros / highest.listUsdMicros) * 100);
    return {
      modelId,
      modelName,
      seriesHref: canonicalSeriesHref,
      resolution,
      providerName: cheapest.providerName,
      priceLabel: formatPerSecondUsd(cheapest.effectiveUsdMicros, cheapest.approximate),
      comparePriceLabel: formatPerSecondUsd(highest.listUsdMicros, highest.approximate),
      discountLabel: savingsPct > 0 ? `-${savingsPct}%` : null,
      priceNote: `Cheapest published ${resolution} route (${cheapest.providerName} vs ${highest.providerName})`,
      sourceUrl: cheapest.sourceUrl,
    };
  }

  return {
    modelId,
    modelName,
    seriesHref: canonicalSeriesHref,
    resolution,
    providerName: cheapest.providerName,
    priceLabel: formatPerSecondUsd(cheapest.effectiveUsdMicros, cheapest.approximate),
    comparePriceLabel: null,
    discountLabel: null,
    priceNote: `Published ${resolution} route on ${cheapest.providerName}`,
    sourceUrl: cheapest.sourceUrl,
  };
}

/**
 * Validates public hero media base URLs (either a credential-free HTTP(S) origin/base or a root-relative path).
 */
export function validatePublicMediaBaseUrl(raw?: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//')) {
      throw new Error('OPENGEN_HERO_MEDIA_BASE_URL must not be protocol-relative.');
    }
    return trimmed.replace(/\/+$/, '') || '/';
  }
  const url = new URL(trimmed);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'OPENGEN_HERO_MEDIA_BASE_URL must be a public HTTP(S) base URL without credentials or query.',
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function joinMediaUrl(baseUrl: string, relPath: string): string {
  const cleanRel = relPath.replace(/^\/+/, '');
  return baseUrl === '/' ? `/${cleanRel}` : `${baseUrl}/${cleanRel}`;
}

export function buildHeroComparisonsFromSeeds(
  seeds: readonly ComparisonSeed[],
  {
    mediaBaseUrl = process.env.OPENGEN_HERO_MEDIA_BASE_URL,
    version = process.env.OPENGEN_HERO_MEDIA_VERSION ?? 'v2',
    nowDate,
    preferredModelOrder = HERO_RIGHT_MODEL_ROTATION_ORDER,
  }: {
    mediaBaseUrl?: string;
    version?: string;
    nowDate?: string;
    preferredModelOrder?: readonly string[];
  } = {},
): HeroComparisonItem[] {
  const base = validatePublicMediaBaseUrl(mediaBaseUrl);
  if (!base) return [];
  const cleanVersion = version.replace(/^\/+|\/+$/g, '') || 'v2';

  return interleaveComparisonSeeds(seeds, preferredModelOrder).map((seed) => {
    const prefix = `hero/${cleanVersion}/${seed.id}`;
    const leftSlug = modelFileSlug(seed.leftModelId);
    const rightSlug = modelFileSlug(seed.rightModelId);
    const inputCount = Math.max(1, seed.inputCount ?? 1);
    const inputImagesWebp = Array.from({ length: inputCount }, (_, index) =>
      joinMediaUrl(base, `${prefix}/${index === 0 ? 'input.webp' : `input-${index + 1}.webp`}`),
    );
    return {
      id: seed.id,
      resolution: seed.resolution,
      operation: seed.operation,
      durationSec: seed.durationSec,
      heroDurationSec: seed.heroDurationSec,
      shortPrompt: seed.shortPrompt,
      fullPrompt: seed.fullPrompt,
      inputRole: seed.inputRole,
      inputCount,
      left: resolveHeroModelPricing(seed.leftModelId, seed.resolution, nowDate),
      right: resolveHeroModelPricing(seed.rightModelId, seed.resolution, nowDate),
      media: {
        heroPosterWebp: joinMediaUrl(base, `${prefix}/hero-poster.webp`),
        heroPosterAvif: joinMediaUrl(base, `${prefix}/hero-poster.avif`),
        heroVideoAv1: joinMediaUrl(base, `${prefix}/hero-split.av1.mp4`),
        heroVideoH264: joinMediaUrl(base, `${prefix}/hero-split.h264.mp4`),
        inputThumbWebp: joinMediaUrl(base, `${prefix}/input-thumb.webp`),
        inputImageWebp: inputImagesWebp[0]!,
        inputImagesWebp,
        modalLeftVideo: joinMediaUrl(base, `${prefix}/${leftSlug}.mp4`),
        modalRightVideo: joinMediaUrl(base, `${prefix}/${rightSlug}.mp4`),
        modalLeftPoster: joinMediaUrl(base, `${prefix}/left-poster.webp`),
        modalRightPoster: joinMediaUrl(base, `${prefix}/right-poster.webp`),
      },
    };
  });
}

export function getHeroComparisons({
  mediaBaseUrl = process.env.OPENGEN_HERO_MEDIA_BASE_URL,
  version = process.env.OPENGEN_HERO_MEDIA_VERSION ?? 'v2',
  nowDate,
}: {
  mediaBaseUrl?: string;
  version?: string;
  nowDate?: string;
} = {}): HeroComparisonItem[] {
  return buildHeroComparisonsFromSeeds(BUILTIN_COMPARISON_SEEDS, {
    mediaBaseUrl,
    version,
    nowDate,
  });
}

/**
 * Fail-safe wrapper for server page rendering: logs invalid optional configuration
 * and falls back to the static hero poster instead of breaking homepage rendering.
 */
export function getHeroComparisonsSafe(
  options?: Parameters<typeof getHeroComparisons>[0],
): HeroComparisonItem[] {
  try {
    return getHeroComparisons(options);
  } catch (err) {
    console.error(
      'Ignoring invalid optional hero media configuration:',
      err instanceof Error ? err.message : 'Invalid media base URL',
    );
    return [];
  }
}
