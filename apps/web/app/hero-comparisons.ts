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
    inputCount: 1,
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
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'kling/kling-4.0',
    shortPrompt:
      'Five street dancers from @Image1 perform synchronized night choreography in front of a warmly lit food stall.',
    fullPrompt:
      'Use @Image1 as the first frame. subjects: @Image1 role=FirstFrame: opening full shot showing five young women in street-dance outfits standing in a row on an asphalt street in front of a lit food stall at night\nNARI: chestnut twin ponytails, patterned faux-fur jacket, beige skort, brown boot covers\nMIYU: dark cap, sage top, beige shorts, cream leg warmers\nSENA: white beanie, navy top, metallic-gray trousers\nNOA: white fur hat, blue scarf, cream vest, dark flared jeans\nARIA: ash-blond hair, white fur bolero, silver skort, white boot covers\n\nstyle: Photorealistic pop performance in a real neighborhood setting; natural skin texture, detailed knit and metallic fabric, individual faux-fur fibers, grounded shoe contact, realistic asphalt shadows, and consistent warm stall lighting balanced with cool streetlights\n\nbrief: A five-member street-dance performance on an asphalt neighborhood block at night with a red-and-white striped food-stall awning, warm bulbs, metal counter, and red stools in the background. (original rhythmic dance-pop instrumental with a playful bass line and crisp percussion) <restrained neighborhood ambience, faint shoe contact on asphalt>\n\nshots: 0–5 seconds: Continuing directly from @Image1, all five performers step into a synchronized groove with two compact side steps, a shoulder accent, and a clean hand sweep across the waist. NARI remains slightly forward while the others maintain open staggered positions behind and beside her. The camera tracks backward slowly, preserving the lit food stall and the complete group.\n5–10 seconds: The dancers lift one arm into a curved shape above the head while the opposite hand rests near the hip, reverse the arm shape on the next beat, then release into a small torso turn. A brief medium view highlights NARI during the stationary gesture while the other members remain recognizable behind her, returning to a wide view as the phrase ends. Faux fur, ponytails, and loose trousers settle naturally between accents.\n10–15 seconds: The group advances two measured steps toward the camera while it tracks backward at matching speed, revealing faded yellow road markings. The dancers execute alternating knee lifts, small forward extensions below hip height, and grounded step-downs, keeping every lifted leg clearly connected to its body while the stall recedes deeper into the background.\n15–20 seconds: ARIA takes one short diagonal step forward through an open gap as NARI shifts outward. ARIA performs a shoulder roll, a compact hand flourish beside her face, and a controlled quarter-turn back toward the camera, while the other four dancers maintain a simple step-touch. The camera pulls back before ARIA returns to the line, keeping all five present.\n20–25 seconds: Reforming into a shallow line with SENA and NOA slightly offset to keep every face visible, the dancers execute a synchronized sequence: heel-toe step, bent-elbow accent, hands returning to hips, followed by a clean knee lift and grounded recovery, captured in a gently moving three-quarter wide shot keeping the road level and all five full bodies in frame.\n25–28 seconds: All five open spacing with one small outward step, repeating the overhead arm curve, followed by a shoulder accent and a coordinated forward hand gesture, with individual expressive personalities aligned to the shared rhythm.\n28–30 seconds: The group lands the final beat in a balanced formation with NARI near center and complementary poses separated by clear gaps. The dancers hold the pose briefly, easing into small smiles and natural breathing, with all five fully visible against the warmly lit food stall.\n\nconstraints: Maintain exactly five performers throughout. No recognizable lyrics, narration, or subtitles. Avoid duplicated members, merged limbs, changing fur colors, sliding shoes, unstable trouser hems, warped road markings, excessive blur, slow motion, sudden exposure changes, captions, logos, and watermarks.',
  },
  {
    id: 'case-23',
    resolution: '1080p',
    operation: 'reference-to-video',
    durationSec: 15,
    heroDurationSec: 10,
    inputRole: 'Reference (@Image1)',
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'google/gemini-omni-1.2-flash',
    shortPrompt:
      'Glamorous vintage vanity close-up from @Image1 — stirring a glass of rolled bills with a watching black cat.',
    fullPrompt:
      "subjects: @Image1 role=Character: an adult woman sitting at an ornate vintage vanity table, preserving the exact facial identity from @Image1 throughout, styled with a long, smooth, voluminous blowout hairstyle, wearing a black satin plunge-neck camisole beneath a sheer black lace robe with delicate embroidery and soft feather-trimmed cuffs, adorned with a short pearl necklace, small earrings, elegant rings, and thin bracelets\nA sleek black cat sitting upright on the left side of the vanity table, quietly watching\nA tall transparent cylindrical glass held near the center of the woman's chest in her left hand, tightly packed with rolled banknotes arranged vertically, and a slim silver stirring stick held in her right hand\n\nstyle: Photorealistic, warm diffused boudoir lighting, luxurious pink-and-gold palette, realistic satin, lace, glass, and pearl textures, subtle vintage-film softness\n\nbrief: A glamorous feminine dressing room with an ornate vintage vanity decorated with sparkling crystal perfume bottles, loose pearl necklaces, a rhinestone hairbrush, and an open vintage book, backed by a large ornate gold mirror, blush-pink satin curtains, and softly displayed vintage clothing\n\nshots: One uninterrupted locked medium close-up shot with no cuts, stationary camera directly in front at upper-chest height with a slightly low intimate phone-camera angle, framing the woman across approximately 70% of the frame with subtle natural phone-camera feel. 0.0–2.4 seconds: She slowly stirs between the rolled banknotes with the silver stick while looking directly into the camera with a relaxed, knowing smile as her bracelets and feather-trimmed cuff move naturally with her wrist, while the cat makes one subtle head movement. 2.4–3.2 seconds: She tilts her head slightly, raises the silver stick toward her lips like a drinking straw, and gives the camera a playful expression. 3.2–4.7 seconds: She closes her lips around the end of the stick and pretends to drink from the glass, her cheeks drawing inward slightly while her eyes glance upward as if evaluating the taste of money. 4.7–5.9 seconds: She stops drinking while keeping the stick close to her lips, tightening her eyebrows, narrowing one eye in an exaggerated skeptical expression, then releasing the stick into a dissatisfied pout suggesting the drink needs more money. 5.9–7.4 seconds: She resumes stirring slowly while looking down into the glass, then glances back toward the camera with a small knowing smile. 7.4–8.4 seconds: She removes her right hand from the glass, brings a neatly folded banknote into view beside her face, and presents it briefly toward the camera with a mischievous smirk. 8.4–9.4 seconds: She holds the folded banknote above the glass and drops it inside, letting it settle naturally between the rolled bills without altering the glass's shape. 9.4–10.7 seconds: She uses the silver stick to gently push the new banknote down, stirs again, transitions into a satisfied smile, looks directly into the camera, and holds the final glamorous pose.",
  },
  {
    id: 'case-03',
    resolution: '1080p',
    operation: 'reference-to-video',
    durationSec: 15,
    heroDurationSec: 10,
    inputRole: '5 references (@Image1–@Image5)',
    inputCount: 5,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'google/gemini-omni-1.2-flash',
    shortPrompt:
      'Overhead ceiling-fan blade wipes across five streetwear outfits (@Image1–@Image5) in one continuous shot.',
    fullPrompt:
      'subjects: @Image1 role=Character: Male character identity and Outfit 1 reference, featuring a tan complexion, short dark hair, beard, backward maroon cap, brown logo jacket, black trousers with side stripes, and sneakers.\n@Image2 role=Character: Same male character identity and Outfit 2 reference, featuring a black quarter-zip sweater, beige trousers, and white sneakers.\n@Image3 role=Character: Same male character identity and Outfit 3 reference, featuring a black hoodie, matching black sweatpants, and white sneakers.\n@Image4 role=Character: Same male character identity and Outfit 4 reference, featuring a black graphic hoodie, black cargo pants, and chunky black sneakers.\n@Image5 role=Character: Same male character identity and Outfit 5 reference, featuring a cream crewneck sweatshirt, olive green cargo pants, and white gum-soled sneakers.\n\nstyle: Photorealistic fashion video aesthetic, soft warm editorial lighting, consistent realistic shadows, natural fabric movement and texture, restrained natural motion blur on fan blades.\n\nbrief: One continuous shot from a completely stationary camera pointing vertically downward at exactly 90 degrees. The camera views past a large foreground polished chrome ceiling fan toward the muted blue carpet floor and a curved blush-pink sofa partially cropped along the left edge. The man lies on the floor, head toward top of frame and feet toward bottom, kept fully in frame after rolling off the sofa.\n\nshots: 0.0–1.5 seconds: Wearing Outfit 1 from @Image1, the man starts lying fully on top of the pink sofa, his entire body supported by its cushions, then rolls sideways off the edge toward screen-right and naturally drops onto the carpet, landing on his back with his head toward the top of the frame and feet toward the bottom.\n1.5–2.3 seconds: He looks upward toward the camera, relaxes his shoulders, and straightens his legs with elbows bent beside him.\n2.3–4.4 seconds: He reaches for a small silver remote on the carpet at screen-right, lifts it toward the ceiling fan, and presses its button once.\n4.4–5.5 seconds: He lowers his hand as the polished chrome ceiling fan begins rotating clockwise; a broad chrome blade sweeps down across his body, wiping across the frame to conceal the first outfit change.\n5.5–8.2 seconds: As the blade passes, Outfit 2 from @Image2 is revealed behind its trailing edge. He remains in the same position on the carpet, placing both hands near his waist, elbows outward, ankles lightly crossed, with a subtle head turn.\n8.2–10.9 seconds: The next clockwise blade sweep conceals and reveals Outfit 3 from @Image3. One hand rests on his hip, the other on the carpet, with knees angled slightly to one side.\n10.9–13.3 seconds: Another clockwise blade sweep reveals Outfit 4 from @Image4. He folds his arms across his chest and lightly crosses his ankles, looking confidently upward.\n13.3–15.0 seconds: The final blade sweep reveals Outfit 5 from @Image5. One hand rests on his stomach, the other extends gently outward. He turns his face slightly toward the sofa with a relaxed expression, ending with the final outfit clearly visible.\n\nconstraints: Completely stationary camera: no zoom, pan, tilt, orbit, or angle changes. Exactly five outfits and four outfit changes. Each outfit change and pose change must be fully concealed by the passing chrome blade, with the preceding look ahead of the leading edge and the next look revealed behind the trailing edge. No visible clothing morphing, dissolves, flashes, or exposed jump cuts. Preserve consistent face, skin tone, physique, and hairstyle of the same male character across all outfits. Continuous room geometry, body scale, and floor position without duplicated people, extra limbs, or additional scene cuts.',
  },
  {
    id: 'case-13',
    resolution: '720p',
    operation: 'image-to-video',
    durationSec: 15,
    heroDurationSec: 10,
    inputRole: 'First frame (@Image1)',
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'bfl/flux-3-video',
    shortPrompt:
      '1950s diner single take from @Image1 — a spilled tray freezes in mid-air and reverses behind a milkshake.',
    fullPrompt:
      'Use @Image1 as the first frame. subjects: @Image1 role=FirstFrame: the woman at the counter with the exact identity, face, hairstyle, skin tone, and body proportions from Image 1, wearing a pink floral flutter-sleeve dress and sandals.\nWaitress: a woman in the background carrying a tray with eggs, bacon, and a glass coffee pot.\nOlder woman: a patron sitting in a booth behind the counter.\nDiner: a realistic 1950s American diner with chrome counter surfaces, red vinyl booths, and checkerboard flooring.\n\nstyle: Photorealistic modern realism, authentic 1950s diner aesthetic, warm practical lighting, soft natural window light, heavy organic film grain, 35mm lens look, subtle stabilized handheld micro-movement, realistic fluid surface tension.\n\nbrief: A single uninterrupted 15-second take in a 1950s diner where a chaotic accident freezes and reverses behind a woman calmly drinking a milkshake.\n\nshots: 0–3 seconds: From a left-front three-quarter angle, the camera begins a slow forward dolly and a gentle lateral 65-degree arc. The main woman sits calmly at the counter drinking a thick milkshake through a straw. Behind her, a waitress approaches with a tray of food and a coffee pot, while an older woman begins rising from a nearby booth.\n3–6 seconds: The older woman lightly bumps into the waitress, causing the tray to tilt. Eggs, bacon, and the coffee pot rise into the air with realistic coffee droplets in slow motion. At the highest point of the spill, everyone and every flying object freezes completely except the main woman. The camera continues along the same continuous path.\n6–10 seconds: The camera continues its slow forward dolly and 65-degree arc toward a frontal angle. All frozen people and objects remain locked in their exact physical positions, and coffee droplets retain their size and shape. The main woman calmly continues drinking and glances toward the frozen accident.\n10–13 seconds: The accident reverses over a short physical distance as each droplet, piece of',
  },
  {
    id: 'case-01',
    resolution: '720p',
    operation: 'image-to-video',
    durationSec: 20,
    heroDurationSec: 10,
    inputRole: 'First frame (@Image1)',
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'bfl/flux-3-video',
    shortPrompt:
      'Fantasy first-frame journey from @Image1 — shrinking inside a countertop popcorn machine kettle into a striped box.',
    fullPrompt:
      'Use @Image1 as the first frame. subjects: @Image1 role=FirstFrame: opening frame showing the woman in a kitchen pressing the glowing button on the red countertop popcorn machine\n\nbrief: A fantasy sequence moving from a warm kitchen into the giant macro interior of the popcorn machine kettle, ending in a popcorn box on the counter.\n\nshots: Shot 1: Opening composition anchored by @Image1. Medium shot, starting stationary before a fast push-in camera move. The woman presses the glowing button on the red popcorn machine; bright blue electric sparks crackle up her arm and wrap around her entire body. She gasps in surprise, and in a bright flash of light, she shrinks and vanishes from the kitchen. Sound: <button click>, <electric buzz and crackle>, <quick whoosh>.\nShot 2: Low macro shot inside the glass kettle of the popcorn machine. The same woman, now tiny, lands on her hands and knees among giant golden corn kernels as big as boulders, looking up in awe at the huge steel kettle above her. The camera slides low along the kernels toward her. Sound: <kernels clattering>, <oil sizzling>, <her small gasp>.\nShot 3: Wide dynamic shot inside the popcorn machine. The giant kernels around her begin popping into enormous fluffy white popcorn. She jumps, dodges, and climbs onto a giant piece of popcorn as it bounces upward, laughing. The camera orbits around her, moving into slow motion during the biggest pop. Sound: <loud popping bursts>, <her laughter>.\nShot 4: Side tracking shot. The tiny woman slides down the red metal chute of the popcorn machine and drops into a red-and-white striped popcorn box resting on the kitchen counter. Popcorn pours in after her until she is buried up to her shoulders, smiling and waving at the camera. Sound: <sliding whoosh>, <cardboard thud>, <popcorn rustling>.\n\nconstraints: No music.',
  },
  {
    id: 'case-18',
    resolution: '1080p',
    operation: 'reference-to-video',
    durationSec: 30,
    heroDurationSec: 10,
    inputRole: '4 references (@Image1–@Image4)',
    inputCount: 4,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'alibaba/wan-3.0',
    shortPrompt:
      'Christmas mansion payoff melodrama (@Image1–@Image4) revealed as a TV short drama watched on a living-room sofa.',
    fullPrompt:
      "subjects: @Image1 role=Character: Wealthy mother with a short wavy blonde bob, wearing a belted tan coat with fur collar and cuffs over a cream dress, beige pumps, and gold earrings.\nCharacter 2: The son's girlfriend.\n@Image2 role=Character: The son, an athletic fair-skinned man with wavy light brown hair, wearing a beige blazer, light blue button-down shirt, and brown pleated trousers.\n@Image3 role=Character: Woman watching the drama, slim with wavy shoulder-length blonde hair, wearing a black long-sleeved dress with white collar and cuffs.\n@Image4 role=Character: Man watching the drama, lean with dark wavy hair and facial stubble, wearing a black v-neck sweater over a white collared shirt and black trousers.\n\nstyle: Glossy luxury short-drama cinematography with exaggerated acting, extreme reaction close-ups, dramatic rack focus, macro product inserts, fast whip transitions, warm mansion lighting, shallow depth of field, Christmas bokeh, cinematic anamorphic highlights, and rich saturated colors, shifting to bright natural daytime interior lighting for the modern living room reveal.\n\nbrief: A melodramatic short-drama parody where a wealthy mother attempts to pay off her son's girlfriend inside a lavish Christmas-decorated mansion, only for the scene to be revealed as a television drama watched on a sofa by a couple in a modern apartment.\n\nshots: SHOT 1 — 0.0–0.6 SECONDS: Extreme macro tabletop shot of numerous neatly bundled stacks of US currency covering a gray marble table in very shallow focus. The camera quickly slides forward across the money toward Character 1 (@Image1) standing behind it.\nSHOT 2 — 0.6–2.5 SECONDS: Low-angle medium shot inside a dark, luxurious wood-paneled mansion decorated for Christmas with a chandelier, glowing Christmas tree, and wrapped gifts. Character 1 (@Image1) holds several bundles of cash and stares downward with cold authority. Character 1 says in English {Take this and leave my son.} She throws the bundles directly toward Character 2 and the camera. The cash flies past the lens in dramatic slow motion <money fluttering> accompanied by a melodramatic orchestral hit (music). Character 2 keeps her mouth naturally closed while listening.\nSHOT 3 — 2.5–4.8 SECONDS: Frontal beauty close-up of Character 2 calmly catching one banknote while remaining cash falls around her against warm circular Christmas bokeh. Character 2 says in English {Our son.} Character 2 pauses, looks directly toward Character 1 (@Image1) with a slight smirk, and says in English {He called me mommy too.} Character 1 keeps her mouth naturally closed while listening.\nSHOT 4 — 4.8–6.2 SECONDS: Smash cut to an extreme close-up of Character 1 (@Image1). Her eyes widen in stunned disbelief as the camera executes a subtle dramatic push-in paired with a low musical sting (music). Hold on her reaction.\nSHOT 5 — 6.2–10.0 SECONDS: Fast horizontal whip-pan back to Character 2 in a medium shot across the marble table. Character 2 lifts her chin and pushes the offered cash aside. Character 2 says in English {Anyway, you think money can make me leave him?} The camera slowly lowers until the marble tabletop obscures the lower part of her body, emphasizing her proud expression. Character 1 (@Image1) keeps her mouth naturally closed while listening.\nSHOT 6 — 10.0–11.6 SECONDS: Macro table-level insert. Character 1 (@Image1)'s hand slides a red luxury sports-car key across the polished marble toward Character 2, with an aggressive rack focus from Character 2 in the background to the key. Character 1 says in English {The keys to a Ferrari parked outside.} Push extremely close to the glossy red key until its red surface fills the entire frame for a red color-wipe transition.\nSHOT 7 — 11.6–13.8 SECONDS: The red transition clears into a very low table-level shot of Character 2 slowly lifting her eyes above the edge of the marble table, with the cash and car key in the foreground. Character 2 says in English {I don’t want your money.} Her eyes drift toward the car key despite her words.\nSHOT 8 — 13.8–15.6 SECONDS: Intimate side-profile two-shot. Character 1 (@Image1) dramatically presents a large property envelope directly beside Character 2's face. Character 1 says in English {A mansion in Miami.} Rack focus from Character 1's jeweled hand and envelope to Character 2's shocked profile as her lips part and her resistance weakens. Character 2 keeps her mouth naturally closed while listening.\nSHOT 9 — 15.6–17.3 SECONDS: Extreme close-up of a black luxury briefcase with polished gold hardware being placed on the table. Character 1 (@Image1) opens and pushes it toward Character 2 with audible briefcase hardware clicks <sound effect>. Character 1 says in English {Ten million dollars. It’s in your name.} Cut to Character 2 staring at the briefcase in disbelief, her hand reaching for its handle. Character 2 keeps her mouth naturally closed while listening.\nSHOT 10 — 17.3–19.0 SECONDS: Low rear tracking shot as Character 2 confidently walks away through the mansion carrying the heavy briefcase. Character 3 (@Image2) stands inside the large wooden doorway watching her leave. As she passes, Character 3 looks back toward Character 1 (@Image1). Character 3 says in English {I told you who she was.} Character 1 and Character 2 keep their mouths naturally closed while listening.\nSHOT 11 — 19.0–20.7 SECONDS: Hard cut to bright daylight outside the mansion. Low-angle wide shot of a red Ferrari convertible driving through the estate gates onto a palm-lined driveway <luxury-car engine sounds>. The camera pans beside the car as sunlight flashes across the bodywork.\nSHOT 12 — 20.7–22.2 SECONDS: Side medium shot into the moving convertible. Character 3 (@Image2) drives while Character 2 sits beside him with bundles of money and the briefcase. Character 3 gives her a satisfied smile and says in English {Told you she would pay.} Character 2 looks back at him knowingly with her mouth naturally closed while listening.\nSHOT 13 — 22.2–23.4 SECONDS: The camera rapidly zooms backward <fast transition whoosh>, revealing that the Ferrari scene is playing on a television screen mounted inside a bright modern living room. The camera pulls back to show Character 4 (@Image3) and Character 5 (@Image4) from behind, sitting together on a deep blue sofa watching the drama in natural room tone.\nSHOT 14 — 23.4–25.0 SECONDS: Reverse medium two-shot of Character 4 (@Image3) and Character 5 (@Image4) on the sofa. They glance awkwardly at one another after watching the television ending; Character 5 gives a small amused smile while Character 4 appears increasingly thoughtful.\nSHOT 15 — 25.0–28.2 SECONDS: Character 4 (@Image3) throws aside the blanket and rises from the sofa, followed by a quick handheld camera adjustment as she stands. She plants both hands on her hips, leans toward Character 5 (@Image4) with exaggerated seriousness, and says in English {When is your mum going to give me the money…} She leans even closer and says in English {…so I can leave you?} Character 5 recoils slightly into the sofa in disbelief, keeping his mouth naturally closed while listening.\nSHOT 16 — 28.2–30.0 SECONDS: Character 5 (@Image4) slowly removes his glasses, looks up at Character 4 (@Image3) in disbelief, and says in English {Have you watched too many short dramas?} Character 4 keeps her mouth naturally closed while listening. Hold on Character 4's offended, confused reaction for the final comedic beat, then cut to black.\n\nconstraints: Spoken words are audio only. All on-screen characters keep their mouths naturally closed while another character speaks. Use exactly five characters only; maintain each character's identity and wardrobe consistently without swapping faces or adding extra family members. No generated subtitles, captions, social-media UI, promotional text, logos, or watermarks.",
  },
  {
    id: 'case-22',
    resolution: '1080p',
    operation: 'reference-to-video',
    durationSec: 30,
    heroDurationSec: 10,
    inputRole: '2 references (@Image1–@Image2)',
    inputCount: 2,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'alibaba/wan-3.0',
    shortPrompt:
      'Stylized 3D rom-com from @Image1–@Image2 — a first kiss triggers a shockwave launching him across the ocean.',
    fullPrompt:
      'subjects: @Image1 role=Character: Character 1, a slender, light-skinned male with curly blond hair, blue eyes, stubble, dark blue sweater with a white collar, beige cargo pants, and sneakers.\n@Image2 role=Character: Character 2, a slender, fair-skinned female with shoulder-length blonde hair and bangs, white corset, pink-and-blue knit shrug, plaid skirt, leg warmers, and blue sneakers.\n\nstyle: Stylized 3D animated romantic comedy, expressive character facial animation, detailed fabrics, warm sunset lighting, cinematic depth of field, and exaggerated cartoon physics.\n\nbrief: A romantic-comedy sequence where a first kiss between Character 1@Image1 and Character 2@Image2 triggers an absurd city-shattering shockwave that sends Character 1 launching across the ocean into a distant island cliff.\n\nshots: Clip 1 (0.0–1.8s): Low ground-level tracking shot beginning on the shoes of Character 1@Image1 and Character 2@Image2 as they walk side by side out of a restaurant, slowly tilting upward into a low-angle medium two-shot as they stop beside each other, visibly nervous and avoiding prolonged eye contact. Hard cut.\nClip 2 (1.8–3.6s): Over-the-shoulder close-up from behind Character 1@Image1 using a 70mm portrait lens, with Character 2@Image2 occupying approximately 70% of the frame and sunset lanterns softly blurred behind her. From 1.95–2.80s, Character 2@Image2 says in English {Thanks for the dinner.} casually and warmly with a light, shy tone. From 2.80–3.05s, she pauses briefly with a small shy smile. From 3.05–3.55s, Character 2@Image2 says in English {It was cool!} and holds his gaze smiling affectionately. Hard cut.\nClip 3 (3.6–4.8s): Reverse over-the-shoulder close-up from behind Character 2@Image2. Character 1@Image1 remains silent, smiles nervously, blushes deeply, briefly looks aside, then looks back at her with eyes widening as he notices her moving closer. Hard cut.\nClip 4 (4.8–6.2s): Wide full-body street-level shot. Character 2@Image2 steps closer and kisses Character 1@Image1 gently on the lips; he freezes in surprise for a moment, then softly leans into the kiss. Hard cut.\nClip 5 (6.2–6.9s): Direct overhead shot. Character 1@Image1 and Character 2@Image2 remain kissing while thin cracks spread outward through the asphalt beneath them like branching lightning. Hard cut.\nClip 6 (6.9–7.8s): Extreme ground-level close-up of their shoes. The pavement shakes, cracks widen, and small stones bounce into the air while their feet remain planted close together. Hard cut.\nClip 7 (7.8–9.3s): Wide street-level shot. Character 1@Image1 and Character 2@Image2 continue kissing as pavement slabs rise, manhole covers float, signs shake, dust fills the street, and their blond hair and clothing blow outward from pressure. Hard cut.\nClip 8 (9.3–9.9s): Extreme overhead shot. The kissing couple appears tiny at the center of a large circular network of widening street cracks. Hard cut.\nClip 9 (9.9–11.4s): Extreme low angle from inside the newly opened crack looking upward between dark rock walls toward the kissing couple above as dust and pebbles fall past the camera. Flash transition.\nClip 10 (11.4–11.8s): Black-and-white graphic impact frame with kissing silhouettes inside a bright heart-shaped burst surrounded by sharp radial speed lines. Hard cut.\nClip 11 (11.8–13.3s): Extreme aerial establishing shot showing a circular dust shockwave expanding outward from the kissing point and racing through surrounding streets and buildings. Hard cut.\nClip 12 (13.3–14.0s): Tight frontal close-up of Character 2@Image2 with eyes still closed and lips softly puckered, unaware Character 1@Image1 has been launched away, her loose blond hair streaming sideways in the wind. Hard cut.\nClip 13 (14.0–15.4s): Front-facing aerial tracking close-up of Character 1@Image1 flying horizontally through the city with arms swept behind him, eyes glowing pink heart shapes, and an enormous lovestruck grin as buildings streak past. Hard cut.\nClip 14 (15.4–16.3s): Medium frontal shot of Character 2@Image2 standing alone in the damaged street with closed eyes and lips still puckered, dust rolling behind her as her blond hair and knit shrug flutter in the wind. Hard cut.\nClip 15 (16.3–16.9s): Wide exterior shot of a glass skyscraper at sunset as Character 1@Image1 approaches as a tiny, fast-moving airborne streak. Hard cut at impact.\nClip 16 (16.9–18.2s): Wide interior office shot facing panoramic windows. Character 1@Image1 smashes through the glass wall, flies horizontally across the empty office, and exits through the opposite window as glass bursts outward at both ends. Hard cut.\nClip 17 (18.2–18.7s): Low water-level shot beneath a suspension bridge as Character 1@Image1 streaks across the water surface, generating a huge curling wave. Hard cut.\nClip 18 (18.7–20.2s): Extreme aerial shot above the bay and bridge showing a long white wake racing across the water as Character 1@Image1 travels toward the distant coastline. Hard cut.\nClip 19 (20.2–21.8s): Front-facing aerial tracking close-up above the ocean of Character 1@Image1 flying with glowing pink heart eyes, flushed cheeks, a delighted grin, and small animated pink hearts floating beside his face. Hard cut.\nClip 20 (21.8–24.2s): Wide static shot of a rocky green island at sunset as a bright streak crashes into the cliff face, triggering a turquoise-blue energy explosion mixed with grey dust, smoke, and shattered rock. Hard cut.\nClip 21 (24.2–25.3s): High rear angle looking down at Character 1@Image1 embedded up to his head and shoulders in a circular indentation within the cracked cliff as dust settles around his blond curls and navy sweater. Hard cut.\nClip 22 (25.3–26.8s): Tight three-quarter close-up of Character 1@Image1 slowly turning toward the camera, glowing pink heart-shaped eyes intact, holding an enormous lovestruck smile while stuck in the rock until the end. End state holds this expression.',
  },
  {
    id: 'case-07',
    resolution: '720p',
    operation: 'reference-to-video',
    durationSec: 10,
    heroDurationSec: 10,
    inputRole: '2 references (@Image1–@Image2)',
    inputCount: 2,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'bytedance/seedance-2.0',
    shortPrompt:
      'Two friends (@Image1–@Image2) attempt apartment selfies in a series of photobomb and synchronized sneeze mishaps.',
    fullPrompt:
      "subjects: @Image1 role=Character: Man A, a confident, stylish adult man with light-tan skin, short middle-parted dark hair, black-framed glasses, and small dark stud earrings, wearing a black crew-neck T-shirt and casual jeans.\n@Image2 role=Character: Man B, Man A's playful adult male friend with straight dark hair, wearing a casual colorful shirt.\n\nstyle: Ultra-realistic comedy video, spontaneous social media comedy skit aesthetic with bright natural daylight.\n\nbrief: Two close friends attempt to take selfies in a bright, modern apartment living room, resulting in a series of comedic photo mishaps.\n\nshots: 0–2 seconds: (Playful upbeat music plays throughout) Man A (@Image1) holds a smartphone out for a selfie, striking an exaggerated handsome model pose with chin raised and lips slightly pursed. Within the first second, Man B (@Image2) suddenly squeezes into the frame beside him, flashing an absurdly wide smile and giving two thumbs up right next to Man A's face. Man A slowly turns and gives Man B an offended, disbelieving side-eye without lowering the smartphone.\n2–4 seconds: Quick cut to Man A gently pushing Man B's face out of the frame and resetting his pose. Just as the phone takes the photo <camera shutter click>, Man B pops back into the background, crossing his eyes and pulling exaggerated fish lips. Man A checks the screen, sees the ridiculous photo, and silently gasps in disbelief.\n4–6 seconds: Cut to Man A handing the smartphone to Man B and posing like a luxury magazine cover model. Man B pretends to meticulously frame the shot, then suddenly drops into a crouch and snaps the photo from an absurdly low angle <camera shutter click>. Man A looks down at the resulting photo on the phone, visibly horrified by his unflattering double chin.\n6–8 seconds: Cut to both men squeezing their faces together into the frame for a joint selfie. They rapidly adjust their hair, shoulders, and smiles, looking intently at the phone screen and counting down with their fingers to lock in a synchronized cool expression as the phone timer counts down <subtle timer beep>.\n8–10 seconds: The phone timer flashes. At the exact instant the photo captures <camera shutter click>, both men sneeze simultaneously <two perfectly synchronized sneezes>, their faces scrunching up in identical ridiculous expressions. They slowly examine the captured photo on the screen, exchange a glance, hold one beat of silence, and burst into uncontrollable natural laughter <natural loud laughter>. The shot ends focusing on the phone screen displaying the hilariously terrible sneeze selfie while both men laugh in the background.\n\nconstraints: Strictly feature exactly two adult men with no additional people, extra background figures, or reflective duplicates. The smartphone must remain visually consistent and physically held throughout. No spoken dialogue or subtitles. Facial features must remain natural and anatomically stable, with distortion limited solely to the intentional comedic sneeze and goofy photo faces. Observable traits of @Image1 and @Image2 must remain distinct without cross-transfer.",
  },
  {
    id: 'case-05',
    resolution: '720p',
    operation: 'reference-to-video',
    durationSec: 15,
    heroDurationSec: 10,
    inputRole: 'Reference (@Image1)',
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'bytedance/seedance-2.0',
    shortPrompt:
      'Chaotic messy-kitchen cooking vlog from @Image1 — smoking frying pan turning into an upbeat sauce product hook.',
    fullPrompt:
      'subjects: @Image1 role=Character: creator with fair skin, light grey eyes, and chin-length pastel pink bob hair, wearing an apron over a light blue denim jacket\n\nstyle: Raw TikTok vlog style, dramatic indoor lighting, hyper-realistic facial acting\n\nbrief: Messy kitchen setting. Chaotic lifestyle cooking vlog turning into product hook.\n\nshots: Shot 1 (0-4s): Fast camera pan across the messy kitchen. @Image1 panics over a smoking frying pan, coughing with funny, expressive facial chaos.\nShot 2 (4-10s): Sudden comedic tone shift. Handheld camera framing @Image1 as she grabs a sauce bottle, thrusts it close to the lens with a triumphant grin, and points at the label with sauce splatters visible on her apron.\nShot 3 (10-15s): Sauce is drizzled onto the food. @Image1 tastes directly off a wooden spoon, her face lighting up in pure culinary ecstasy, and gives a thumbs up directly to the camera.',
  },
  {
    id: 'case-27',
    resolution: '720p',
    operation: 'image-to-video',
    durationSec: 30,
    heroDurationSec: 10,
    inputRole: 'First frame (@Image1)',
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'bytedance/seedance-2.5-flash',
    shortPrompt:
      'Multi-level mall survival chase from @Image1 — stopped escalator slide, balcony drop to mattresses, red drape climb.',
    fullPrompt:
      "Use @Image1 as the first frame. subjects: @Image1 role=FirstFrame: June running forward down the brightly lit mall corridor toward the descending escalator, pursued by four figures in the distant background.\nJune: adult woman with a ponytail, navy jacket with white piping, white shirt, black ribbon tie, plaid skirt with opaque fitted shorts, white knee socks, and black lace-up shoes.\nFour pursuers: four distinct adult zombie-like pursuers in chase.\n\nstyle: Fast-paced photorealistic survival thriller with readable indoor mall lighting, natural skin texture and sweat, grounded physical weight, coherent shadows, and recognizable faces during rapid action at normal playback speed without slow motion.\n\nbrief: Multi-level shopping complex featuring an upper corridor with a climbing wall, descending stopped escalator, lower balcony, ground-floor mattress pile, and a wide suspended red fabric hanging through the central atrium. Urgent, breathless survival escape with shrinking distance and near misses. (Original escalating percussion score, pulling back briefly before close near-miss moments to emphasize physical impact).\n\nshots: 0–4 SECONDS — ALREADY TOO CLOSE: Continuing from @Image1, June accelerates toward the escalator as the nearest pursuer gains on her. A close tracking shot frames beside her face catching her rapid breath and a quick backward glance <June's heavy breathing, rapid footsteps on polished tile>. Cut immediately to a wider view: an outstretched hand misses the back of her jacket as she turns into the escalator entrance, keeping in continuous motion without stopping to look back.\n4–9 SECONDS — RAPID DESCENT: June drops into a feet-first slide along the stopped escalator’s inner surface, her hands briefly stabilizing her as she gathers speed. A wide side view reveals the complete slope <escalator friction, scraping hands and clothing>. Cut to a low frontal view near the bottom as the pursuers scramble down behind her; June reaches the landing, plants both feet, and rises directly into a run while one pursuer lands right behind her.\n9–13 SECONDS — CORNERED: The camera tracks with June as she races across the lower balcony <rushing footsteps, approaching hands striking railings>. A second pursuer cuts across the corridor ahead, forcing her toward the atrium glass railing. She brakes, looks down, and sees the white mattress pile below in a short over-the-shoulder insert establishing the landing area, then turns back to find the nearest pursuer only a step away.\n13–17 SECONDS — THE DROP: In a wide shot, June vaults over the railing just before the pursuer reaches her, showing the missed grab and her vertical plunge in a single frame. Follow with a ground-level three-quarter view of her landing on the mattress pile as the padding compresses sharply <heavy mattress impact>. A loose mattress tips outward, blocking part of the pursuers' route, while June rolls to one side, braces with her hands, and pushes herself up in continuous motion.\n17–21 SECONDS — NO TIME TO RECOVER: June runs from the mattresses toward the suspended red fabric. Behind her, the pursuers drop to the ground level, one stumbling over the displaced padding while the others flank around it. A low tracking view follows June's shoes and the pursuing feet, then widens as June leaps and catches the hanging red fabric with both hands, the fabric snapping taut under her weight <fabric pulling taut, rustling cloth>.\n21–26 SECONDS — THE NEAR CATCH: In a medium-wide shot, June pulls herself upward with believable physical strain, her ponytail and jacket shifting with each lift. A pursuer lunges upward and reaches for her trailing shoe, brushing the sole; June kicks that leg upward to pull out of reach while the shoe remains securely on her foot. Below, the four distinct pursuers cluster and reach upward without merging.\n26–30 SECONDS — CLIFFHANGER: June climbs another body length higher, turning toward the lower balcony to spot her next path. A wide shot reveals the full vertical expanse, framing June suspended on the red fabric above four reaching pursuers, with the mattress pile and escalator visible below. Cut to a tight framing on June's determined face as she looks up, takes a sharp breath, and pulls forcefully upward, cutting to black on the next forceful movement.\n\nconstraints: Maintain continuous forward action and consistent travel direction at normal speed with no slow motion or repeated action angles. Preserve all five distinct character identities, costumes, proportions, and footwear throughout. Maintain architectural layout, mattress displacement post-impact, and fabric attachment. No teleporting bodies, duplicated pursuers, impossible jumps, detached hands, fabric passing through fingers, unstable architecture, excessive blur, graphic injury, captions, logos, or watermarks.",
  },
  {
    id: 'case-34',
    resolution: '720p',
    operation: 'image-to-video',
    durationSec: 30,
    heroDurationSec: 10,
    inputRole: 'First frame (@Image1)',
    inputCount: 1,
    leftModelId: 'bytedance/seedance-2.5',
    rightModelId: 'bytedance/seedance-2.5-flash',
    shortPrompt:
      'Five-member retro K-pop group from @Image1 — vintage bus aisle choreography wiping through red doors to a sunny lot.',
    fullPrompt:
      'Use @Image1 as the first frame. subjects: @Image1 role=FirstFrame\nArin: center member of DAYGLOW, styled initially in a navy cropped t-shirt and pink skirt, who later dons a cobalt-blue windbreaker\nMina: member of DAYGLOW performing in summer choreography attire\nSohee: member of DAYGLOW performing in summer choreography attire\nYuna: member of DAYGLOW performing in summer choreography attire\nHaeji: member of DAYGLOW performing in summer choreography attire\nVintage sedan: stationary cream-colored early-1970s sedan with chrome grille and round headlights\n\nstyle: Photorealistic retro-summer K-pop music video cinematography in real-time movement, featuring natural daylight, vibrant but realistic palette, crisp fabric and physical textures, and smooth gimbal camera operation.\n\nbrief: Five-member girl group DAYGLOW performs choreography inside a vintage bus before transitioning via a red door wipe to an outdoor sunny grocery-store parking lot around a stationary cream-colored sedan. (Original upbeat retro-pop K-pop track with bright bass line, crisp percussion, handclaps, light brass-inspired synth accents, playful chorus melody, and original non-lyrical vocal ad-libs).\n\nshots: 0.0–3.0 SECONDS — OPENING GROOVE: Continuing directly from @Image1, Arin releases the yellow handrail and begins the choreography with a right shoulder hit, left shoulder hit, right hand sweeping beneath her chin, small hip shift, and two grounded steps toward the camera. Mina, Sohee, Yuna, and Haeji begin half a beat later in a layered ripple. The camera tracks backward slightly to maintain full-body framing. <Bus interior vibration, squeak of shoes on the bus floor>.\n3.0–6.0 SECONDS — ARIN CENTER MOMENT: The camera pushes in to a waist-up view keeping hands visible as Arin performs a killing-part sequence: left hand on hip, right index finger circling near her cheek, quick head tilt, chest accent, controlled half-turn, and direct eye contact. Behind her, Mina and Haeji perform shoulder grooves, while Sohee and Yuna frame her with diagonal arm lines along the poles without hanging or spinning.\n6.0–9.0 SECONDS — MINA TAKES THE AISLE: Arin steps smoothly camera-right beside a red seat while Mina advances from camera-left into the center aisle without crossing through another member. Mina executes two rhythmic forward steps, wrist flick beside her face, elbow pull, small body wave, and a playful point to the lens. The other four maintain wider spacing with synchronized hand accents. Camera tracks laterally less than one meter to recenter Mina.\n9.0–12.0 SECONDS — POLE AND SEAT CHOREOGRAPHY: The group reforms into a staggered aisle formation. Arin and Mina hold separate yellow poles naturally with one hand, Sohee raises one arm to an overhead rail, Yuna performs two grounded heel pivots near the doorway, and Haeji turns into the aisle from a red seat. All five execute a synchronized hip accent, alternating arm sweep, quick head turn, two-count shoulder bounce, and stable wide landing.\n12.0–15.0 SECONDS — MOVING TOWARD THE EXIT: In a single-file-to-wide movement toward the red exit door, Arin leads while picking up a cobalt-blue windbreaker from a seat edge and draping it over her shoulders; Mina and Sohee follow on opposite diagonals, and Yuna and Haeji follow one step behind. The camera tracks smoothly forward behind them. At 14.5 seconds, the red folding door panels close across the lens, completely filling the frame. <Mechanical sound of bus folding doors closing>.\n15.0–16.0 SECONDS — BUS-DOOR TRANSITION: Using the red folding bus door as a physical wipe completely covering the lens, the scene transitions from the bus interior to the outdoor parking lot. Arin finishes putting on the cobalt-blue windbreaker while concealed, preserving all performer identities, hair, and base wardrobe.\n16.0–19.0 SECONDS — EXTERIOR REVEAL: The red doors reopen outward to reveal a bright retro suburban parking lot under afternoon sunlight, fronting a pastel peach grocery-store façade with cream trim, large unlettered graphic windows, and the stationary cream-colored 1970s sedan on pale asphalt. Arin stands center-front before the car grille in her open cobalt windbreaker; Mina and Sohee flank near the front fenders; Yuna and Haeji take outer diagonals. Camera pulls back into a complete group shot. <Subtle outdoor breeze>.\n19.0–22.0 SECONDS — OUTDOOR CHORUS: Around the stationary sedan, all five perform the energetic grounded chorus choreography: wide step to camera-left, double arm push, shoulder rebound, cross-body point, alternating knee lift, quick quarter-turn, and return to front. Hair and clothing respond naturally to outdoor breeze and dynamic movement. <Sneakers rhythmically contacting asphalt>.\n22.0–25.0 SECONDS — MEMBER HIGHLIGHTS: In a smooth left-to-right lateral camera track, Arin points directly forward with a windbreaker sleeve swing and confident head tilt; Sohee extends a long diagonal arm line with a controlled hip turn; Yuna performs a quick wrist cross, grounded two-step, and sharp camera glance, with Mina and Haeji dancing in clear supporting positions.\n25.0–28.0 SECONDS — FORMATION CHANGE: The shallow V widens into a broad horizontal line as Mina takes two steps left, Sohee takes two steps right, Yuna extends farther left, Haeji extends farther right, and Arin holds center. They execute two synchronized bouncing steps, hands framing their faces, outward elbow hit, small controlled jump, soft landing, and an upward arm sweep. Camera pulls back smoothly to preserve full head-to-shoe framing.\n28.0–30.0 SECONDS — FINAL POSE: Arin takes one step forward and pulls open her cobalt windbreaker with both hands, revealing the original navy cropped top. Mina points diagonally upward, Sohee sets one hand at her waist, Yuna extends one arm toward the camera, and Haeji arches both arms in a curved shape. Arin settles in an offset stance with one knee bent, chin slightly lowered, bright confident half-smile, and direct eye contact. The complete five-member formation holds locked for the final half-second in front of the vintage sedan and peach storefront.\n\nconstraints: Maintain exactly five female performers (Arin, Mina, Sohee, Yuna, Haeji) throughout with constant facial identity, hair, and baseline outfits; only Arin adds the cobalt-blue windbreaker during the door transition. No additional dancers or background performers joining choreography. The vintage sedan remains strictly stationary. No spoken dialogue or narration; spoken words are audio only. No CGI effects, transitions other than the physical door wipe, speed ramping, or floating camera artifacts.',
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
    version = process.env.OPENGEN_HERO_MEDIA_VERSION ?? 'v3',
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
  const cleanVersion = version.replace(/^\/+|\/+$/g, '') || 'v3';

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
  version = process.env.OPENGEN_HERO_MEDIA_VERSION ?? 'v3',
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
