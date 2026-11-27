#!/usr/bin/env node
/**
 * Builds the 3-tier web-optimized OpenGen hero comparison media bundle:
 *   Tier 1: LCP split posters (1920x1080 AVIF + WebP from raw frames), modal posters, compact input thumbnails
 *   Tier 2: Muted single-stream 1920x1080 50/50 split hero background loops (AV1 + H.264 +faststart, <=10s)
 *   Tier 3: Lazy modal inspection clips (separate left/right up to 1440px H.264 + AAC, full duration)
 *
 * Usage:
 *   node scripts/build-hero-media.mjs \
 *     --input /path/to/hero-all-12-input \
 *     --out /path/to/hero-media-dist \
 *     --version v3 \
 *     --base-url https://media.opengen.dev
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_LEFT_MODEL_ID = 'bytedance/seedance-2.5';
const DEFAULT_RIGHT_MODEL_ID = 'kling/kling-4.0';
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

const DEFAULT_SUMMARIES = {
  'case-01':
    'Fantasy first-frame journey from @Image1 — shrinking inside a countertop popcorn machine kettle into a striped box.',
  'case-03':
    'Overhead ceiling-fan blade wipes across five streetwear outfits (@Image1–@Image5) in one continuous shot.',
  'case-05':
    'Chaotic messy-kitchen cooking vlog from @Image1 — smoking frying pan turning into an upbeat sauce product hook.',
  'case-07':
    'Two friends (@Image1–@Image2) attempt apartment selfies in a series of photobomb and synchronized sneeze mishaps.',
  'case-13':
    '1950s diner single take from @Image1 — a spilled tray freezes in mid-air and reverses behind a milkshake.',
  'case-17':
    'Hallway to luxury Miami villa match cut from @Image1 — casual sweatshirt to black mini dress and knee-high boots.',
  'case-18':
    'Christmas mansion payoff melodrama (@Image1–@Image4) revealed as a TV short drama watched on a living-room sofa.',
  'case-22':
    'Stylized 3D rom-com from @Image1–@Image2 — a first kiss triggers a shockwave launching him across the ocean.',
  'case-23':
    'Glamorous vintage vanity close-up from @Image1 — stirring a glass of rolled bills with a watching black cat.',
  'case-26':
    'Five street dancers from @Image1 perform synchronized night choreography in front of a warmly lit food stall.',
  'case-27':
    'Multi-level mall survival chase from @Image1 — stopped escalator slide, balcony drop to mattresses, red drape climb.',
  'case-34':
    'Five-member retro K-pop group from @Image1 — vintage bus aisle choreography wiping through red doors to a sunny lot.',
};

function modelFileSlug(modelId) {
  const raw = String(modelId ?? '').trim();
  const segment = raw.split('/').pop() ?? '';
  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') {
    throw new Error(`Invalid model ID for output filename: ${modelId}`);
  }
  return slug;
}

function assertSafeFilename(filename, label) {
  const value = String(filename ?? '').trim();
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${label} filename: ${filename}`);
  }
  return value;
}

function resolveCaseVideoFile(caseDir, candidates, sideLabel, caseKey) {
  const checked = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const safeName = assertSafeFilename(candidate, `${sideLabel} video`);
    if (checked.includes(safeName)) continue;
    checked.push(safeName);
    const fullPath = join(caseDir, safeName);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  throw new Error(
    `Missing required ${sideLabel} video for ${caseKey} (checked: ${checked.join(', ')})`,
  );
}

function discoverInputImages(caseDir, spec, caseKey) {
  const resolved = [];
  if (Array.isArray(spec.inputs) && spec.inputs.length > 0) {
    const ordered = [...spec.inputs].sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
    for (let pos = 0; pos < ordered.length; pos += 1) {
      const input = ordered[pos];
      const index = Number.isInteger(input?.index) && input.index > 0 ? input.index : pos + 1;
      const candidates = [];
      if (typeof input?.filename === 'string' && input.filename.trim()) {
        candidates.push(assertSafeFilename(input.filename, `input #${index}`));
      }
      for (const ext of IMAGE_EXTENSIONS) {
        candidates.push(`input-image-${index}.${ext}`);
      }
      const match = candidates.find((name) => existsSync(join(caseDir, name)));
      if (!match) {
        throw new Error(
          `Missing required input image #${index} for ${caseKey} (checked: ${candidates.join(', ')})`,
        );
      }
      resolved.push({
        index,
        kind: input?.kind ?? null,
        path: join(caseDir, match),
      });
    }
    return resolved;
  }

  const discovered = readdirSync(caseDir)
    .map((name) => {
      const match = name.match(/^input-image-(\d+)\.(jpe?g|png|webp)$/i);
      return match ? { index: Number(match[1]), kind: null, path: join(caseDir, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  if (!discovered.length) {
    throw new Error(
      `Missing required source file for ${caseKey}: ${join(caseDir, 'input-image-1.jpg')}`,
    );
  }
  return discovered;
}

function resolveInputRole(spec, inputCount) {
  const firstKind = String(spec.inputs?.[0]?.kind ?? '').toUpperCase();
  if (inputCount <= 1) {
    return firstKind === 'FIRST_FRAME' ? 'First frame (@Image1)' : 'Reference (@Image1)';
  }
  if (firstKind === 'FIRST_FRAME') {
    const refs = inputCount - 1;
    return `First frame + ${refs} ${refs === 1 ? 'reference' : 'references'} (@Image1–@Image${inputCount})`;
  }
  return `${inputCount} references (@Image1–@Image${inputCount})`;
}

function parseArgs(argv) {
  const args = {
    input: '',
    out: '',
    version: 'v3',
    baseUrl: 'https://media.opengen.dev',
    cases: null,
    heroMaxSec: 10,
    skipExisting: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--input' && next) {
      args.input = resolve(next);
      i += 1;
    } else if (flag === '--out' && next) {
      args.out = resolve(next);
      i += 1;
    } else if (flag === '--version' && next) {
      args.version = next.replace(/^\/+|\/+$/g, '');
      i += 1;
    } else if (flag === '--base-url' && next) {
      args.baseUrl = next.replace(/\/+$/, '');
      i += 1;
    } else if (flag === '--cases' && next) {
      args.cases = next
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (flag === '--hero-max-sec' && next) {
      args.heroMaxSec = Number(next);
      i += 1;
    } else if (flag === '--skip-existing') {
      args.skipExisting = true;
    } else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: node scripts/build-hero-media.mjs --input <dir> --out <dir> [--version v3] [--base-url https://media.opengen.dev] [--cases case-17,case-26] [--hero-max-sec 10] [--skip-existing]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  if (!args.input || !args.out) {
    throw new Error('Both --input and --out are required.');
  }
  if (!Number.isFinite(args.heroMaxSec) || args.heroMaxSec < 3 || args.heroMaxSec > 30) {
    throw new Error('--hero-max-sec must be between 3 and 30.');
  }
  return args;
}

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function probe(filePath) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out);
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
  return {
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    durationSec: Number(parsed.format?.duration ?? video?.duration ?? 0),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? 'unknown',
    bytes: statSync(filePath).size,
  };
}

function verifyVideoDecode(filePath) {
  execFileSync('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'null', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function encodeImageVariants(
  pngPath,
  webpPath,
  avifPath,
  { webpQuality = 82, avifMin = 24, avifMax = 38 } = {},
) {
  run('cwebp', ['-q', String(webpQuality), '-m', '6', pngPath, '-o', webpPath]);
  if (avifPath && hasBinary('avifenc')) {
    run('avifenc', [
      '--min',
      String(avifMin),
      '--max',
      String(avifMax),
      '--speed',
      '6',
      '--yuv',
      '420',
      pngPath,
      avifPath,
    ]);
  }
}

function resolveOperation(spec) {
  const ct = String(spec.contentType ?? '').toLowerCase();
  if (ct.includes('image2video') || spec.inputs?.some((i) => i.kind === 'FIRST_FRAME')) {
    return 'image-to-video';
  }
  if (spec.inputs?.length > 0) {
    return 'reference-to-video';
  }
  return 'text-to-video';
}

function resolveResolutionLabel(spec) {
  const raw = String(spec.resolution ?? '').toUpperCase();
  if (raw === 'FHD' || raw === '1080P') return '1080p';
  if (raw === 'HD' || raw === '720P') return '720p';
  if (raw === '480P') return '480p';
  const shortSide = Math.min(Number(spec.seedanceWidth ?? 0), Number(spec.seedanceHeight ?? 0));
  return shortSide >= 1000 ? '1080p' : shortSide >= 700 ? '720p' : '480p';
}

function summarizePrompt(caseKey, prompt) {
  if (DEFAULT_SUMMARIES[caseKey]) return DEFAULT_SUMMARIES[caseKey];
  const briefMatch = prompt.match(/brief:\s*([^\n]+)/i);
  if (briefMatch?.[1]) return briefMatch[1].trim().slice(0, 140);
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/**
 * Builds an ffmpeg filtergraph that frames each side into 960x1080 (total 1920x1080)
 * using upper-weighted vertical crop for portrait videos so faces stay visible.
 */
function splitFilterGraph(leftMeta, rightMeta) {
  const paneFilter = (meta, label) => {
    const isPortrait = meta.height > meta.width;
    // Portrait videos crop slightly toward upper third; landscape/4:3 center crop cleanly.
    const cropY = isPortrait ? '(ih-1080)*0.22' : '(ih-1080)/2';
    return `[${label}:v]scale=960:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=960:1080:(iw-960)/2:${cropY},fps=24,setsar=1[${label}p]`;
  };
  return `${paneFilter(leftMeta, '0')};${paneFilter(rightMeta, '1')};[0p][1p]hstack=inputs=2:shortest=1[v]`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const bin of ['ffmpeg', 'ffprobe', 'cwebp', 'avifenc']) {
    if (!hasBinary(bin)) {
      throw new Error(`Required binary not found on PATH: ${bin}`);
    }
  }

  const discovered = readdirSync(args.input)
    .filter((entry) => entry.startsWith('case-'))
    .sort();
  const caseKeys = args.cases ?? discovered;
  if (!caseKeys.length) {
    throw new Error(`No case-* directories found under ${args.input}`);
  }

  const versionRelPrefix = `hero/${args.version}`;
  const outVersionDir = join(args.out, versionRelPrefix);
  mkdirSync(outVersionDir, { recursive: true });

  const items = [];
  for (const caseKey of caseKeys) {
    const caseDir = join(args.input, caseKey);
    const specPath = join(caseDir, 'spec.json');
    if (!existsSync(specPath)) {
      throw new Error(`Missing required source file for ${caseKey}: ${specPath}`);
    }

    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const leftModelId = spec.leftModelId || DEFAULT_LEFT_MODEL_ID;
    const rightModelId = spec.rightModelId || DEFAULT_RIGHT_MODEL_ID;
    const leftSlug = modelFileSlug(leftModelId);
    const rightSlug = modelFileSlug(rightModelId);
    if (leftSlug === rightSlug) {
      throw new Error(
        `Left and right models resolve to the same output filename (${leftSlug}.mp4) for ${caseKey}`,
      );
    }

    const modalLeftFilename = `${leftSlug}.mp4`;
    const modalRightFilename = `${rightSlug}.mp4`;
    const leftRaw = resolveCaseVideoFile(
      caseDir,
      [spec.leftFilename, modalLeftFilename, 'left.mp4'],
      'left',
      caseKey,
    );
    const rightRaw = resolveCaseVideoFile(
      caseDir,
      [spec.rightFilename, modalRightFilename, 'right.mp4'],
      'right',
      caseKey,
    );
    const inputImages = discoverInputImages(caseDir, spec, caseKey);
    const inputRaw = inputImages[0].path;

    const leftMeta = probe(leftRaw);
    const rightMeta = probe(rightRaw);
    const minSourceDurSec = Math.min(leftMeta.durationSec, rightMeta.durationSec);
    if (!Number.isFinite(minSourceDurSec) || minSourceDurSec < 1) {
      throw new Error(
        `Invalid source video duration for ${caseKey}: left=${leftMeta.durationSec}s, right=${rightMeta.durationSec}s`,
      );
    }
    const heroDurSec = Math.max(1, Math.min(args.heroMaxSec, Math.floor(minSourceDurSec + 0.1)));

    const outCaseDir = join(outVersionDir, caseKey);
    mkdirSync(outCaseDir, { recursive: true });
    const rel = (filename) => `${versionRelPrefix}/${caseKey}/${filename}`;

    console.log(
      `\n=== Encoding ${caseKey} [${leftModelId} vs ${rightModelId}] (raw: ${formatBytes(leftMeta.bytes)} + ${formatBytes(rightMeta.bytes)}, inputs: ${inputImages.length}, hero loop: ${heroDurSec}s) ===`,
    );

    const heroAv1 = join(outCaseDir, 'hero-split.av1.mp4');
    const heroH264 = join(outCaseDir, 'hero-split.h264.mp4');
    const modalLeft = join(outCaseDir, modalLeftFilename);
    const modalRight = join(outCaseDir, modalRightFilename);
    const heroPosterWebp = join(outCaseDir, 'hero-poster.webp');
    const heroPosterAvif = join(outCaseDir, 'hero-poster.avif');
    const leftPosterWebp = join(outCaseDir, 'left-poster.webp');
    const rightPosterWebp = join(outCaseDir, 'right-poster.webp');
    const inputThumbWebp = join(outCaseDir, 'input-thumb.webp');
    const inputModalSpecs = inputImages.map((img, pos) => {
      const filename = pos === 0 ? 'input.webp' : `input-${pos + 1}.webp`;
      return {
        pos,
        src: img.path,
        filename,
        dst: join(outCaseDir, filename),
        tmpPng: join(outCaseDir, `.tmp-input-modal-${pos + 1}.png`),
      };
    });
    const inputModalWebp = inputModalSpecs[0].dst;

    const filterComplex = splitFilterGraph(leftMeta, rightMeta);

    // Tier 2a: Hero split H.264 (universal fallback, muted, +faststart, crisp 1080p VBV-capped streaming)
    if (!args.skipExisting || !existsSync(heroH264)) {
      console.log(`  [Tier 2] hero-split.h264.mp4 (${heroDurSec}s, 1920x1080, muted)...`);
      run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-t',
        String(heroDurSec),
        '-i',
        leftRaw,
        '-t',
        String(heroDurSec),
        '-i',
        rightRaw,
        '-filter_complex',
        filterComplex,
        '-map',
        '[v]',
        '-an',
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-level',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '22',
        '-maxrate',
        '3600k',
        '-bufsize',
        '7200k',
        '-preset',
        'medium',
        '-g',
        '48',
        '-movflags',
        '+faststart',
        heroH264,
      ]);
      verifyVideoDecode(heroH264);
    }

    // Tier 2b: Hero split AV1 (primary modern stream, muted, +faststart, crisp 1080p)
    if (!args.skipExisting || !existsSync(heroAv1)) {
      console.log(`  [Tier 2] hero-split.av1.mp4 (${heroDurSec}s, 1920x1080, muted, SVT-AV1)...`);
      run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-t',
        String(heroDurSec),
        '-i',
        leftRaw,
        '-t',
        String(heroDurSec),
        '-i',
        rightRaw,
        '-filter_complex',
        filterComplex,
        '-map',
        '[v]',
        '-an',
        '-c:v',
        'libsvtav1',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '30',
        '-preset',
        '6',
        '-g',
        '48',
        '-svtav1-params',
        'tune=0:enable-overlays=1:mbr=2800',
        '-movflags',
        '+faststart',
        heroAv1,
      ]);
      verifyVideoDecode(heroAv1);
    }

    // Tier 1: Static posters extracted directly from raw source first frames (t=0.05s) so LCP is sharp and video fade-in has zero jump
    const tier1Images = [
      heroPosterWebp,
      heroPosterAvif,
      leftPosterWebp,
      rightPosterWebp,
      inputThumbWebp,
      ...inputModalSpecs.map((item) => item.dst),
    ];
    if (!args.skipExisting || !tier1Images.every(existsSync)) {
      console.log(
        `  [Tier 1] hero-poster.webp + hero-poster.avif (1920x1080 raw) + modal posters + ${inputModalSpecs.length} input image(s)...`,
      );
      const tmpHeroPng = join(outCaseDir, '.tmp-hero-poster.png');
      const tmpLeftPng = join(outCaseDir, '.tmp-left-poster.png');
      const tmpRightPng = join(outCaseDir, '.tmp-right-poster.png');
      const tmpThumbPng = join(outCaseDir, '.tmp-input-thumb.png');
      const tmpFiles = [
        tmpHeroPng,
        tmpLeftPng,
        tmpRightPng,
        tmpThumbPng,
        ...inputModalSpecs.map((item) => item.tmpPng),
      ];
      try {
        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-ss',
          '0.05',
          '-i',
          leftRaw,
          '-ss',
          '0.05',
          '-i',
          rightRaw,
          '-filter_complex',
          filterComplex,
          '-map',
          '[v]',
          '-frames:v',
          '1',
          tmpHeroPng,
        ]);
        encodeImageVariants(tmpHeroPng, heroPosterWebp, heroPosterAvif, {
          webpQuality: 80,
          avifMin: 24,
          avifMax: 36,
        });

        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-ss',
          '0.05',
          '-i',
          leftRaw,
          '-vf',
          "scale='min(960,iw)':-2:flags=lanczos",
          '-frames:v',
          '1',
          tmpLeftPng,
        ]);
        encodeImageVariants(tmpLeftPng, leftPosterWebp, null, { webpQuality: 82 });

        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-ss',
          '0.05',
          '-i',
          rightRaw,
          '-vf',
          "scale='min(960,iw)':-2:flags=lanczos",
          '-frames:v',
          '1',
          tmpRightPng,
        ]);
        encodeImageVariants(tmpRightPng, rightPosterWebp, null, { webpQuality: 82 });

        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-i',
          inputRaw,
          '-vf',
          'scale=128:128:force_original_aspect_ratio=increase:flags=lanczos,crop=128:128',
          '-frames:v',
          '1',
          tmpThumbPng,
        ]);
        encodeImageVariants(tmpThumbPng, inputThumbWebp, null, { webpQuality: 78 });

        for (const item of inputModalSpecs) {
          run('ffmpeg', [
            '-y',
            '-v',
            'error',
            '-i',
            item.src,
            '-vf',
            "scale='min(960,iw)':-2:flags=lanczos",
            '-frames:v',
            '1',
            item.tmpPng,
          ]);
          encodeImageVariants(item.tmpPng, item.dst, null, { webpQuality: 85 });
        }
      } finally {
        for (const tmp of tmpFiles) {
          if (existsSync(tmp)) unlinkSync(tmp);
        }
      }
    }

    // Tier 3: Modal inspection clips (separate left/right, full duration, with audio, lazy-loaded on click)
    const encodeModal = (src, dst, label) => {
      if (args.skipExisting && existsSync(dst)) return;
      console.log(`  [Tier 3] ${label} (full duration, up to 1440px, H.264 + AAC)...`);
      run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-i',
        src,
        '-vf',
        "scale='if(gt(iw,ih),min(1440,iw),-2)':'if(gt(iw,ih),-2,min(1440,ih))':flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-level',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '22',
        '-maxrate',
        '2800k',
        '-bufsize',
        '5600k',
        '-preset',
        'medium',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        dst,
      ]);
      verifyVideoDecode(dst);
    };

    encodeModal(leftRaw, modalLeft, modalLeftFilename);
    encodeModal(rightRaw, modalRight, modalRightFilename);

    const av1Bytes = statSync(heroAv1).size;
    const h264Bytes = statSync(heroH264).size;
    const posterWebpBytes = statSync(heroPosterWebp).size;
    const posterAvifBytes = existsSync(heroPosterAvif) ? statSync(heroPosterAvif).size : 0;
    const modalLeftBytes = statSync(modalLeft).size;
    const modalRightBytes = statSync(modalRight).size;
    const thumbBytes = statSync(inputThumbWebp).size;
    const inputBytes = statSync(inputModalWebp).size;
    const inputImagesBytes = inputModalSpecs.map((item) => statSync(item.dst).size);

    console.log(
      `  Done: poster=${formatBytes(posterAvifBytes || posterWebpBytes)} (webp ${formatBytes(posterWebpBytes)}) | hero AV1=${formatBytes(av1Bytes)}, H.264=${formatBytes(h264Bytes)} | modal L=${formatBytes(modalLeftBytes)} (${modalLeftFilename}), R=${formatBytes(modalRightBytes)} (${modalRightFilename}) | thumb=${formatBytes(thumbBytes)} | inputs=${inputModalSpecs.length}`,
    );

    items.push({
      id: caseKey,
      resolution: resolveResolutionLabel(spec),
      operation: resolveOperation(spec),
      durationSec: Number(spec.durationSec ?? Math.round(leftMeta.durationSec)),
      heroDurationSec: heroDurSec,
      shortPrompt: summarizePrompt(caseKey, spec.prompt),
      fullPrompt: spec.prompt,
      inputCount: inputImages.length,
      inputRole: resolveInputRole(spec, inputImages.length),
      leftModelId,
      rightModelId,
      media: {
        heroPosterWebp: rel('hero-poster.webp'),
        ...(existsSync(heroPosterAvif) ? { heroPosterAvif: rel('hero-poster.avif') } : {}),
        heroVideoAv1: rel('hero-split.av1.mp4'),
        heroVideoH264: rel('hero-split.h264.mp4'),
        inputThumbWebp: rel('input-thumb.webp'),
        inputImageWebp: rel('input.webp'),
        inputImagesWebp: inputModalSpecs.map((item) => rel(item.filename)),
        modalLeftVideo: rel(modalLeftFilename),
        modalRightVideo: rel(modalRightFilename),
        modalLeftPoster: rel('left-poster.webp'),
        modalRightPoster: rel('right-poster.webp'),
      },
      bytes: {
        heroPosterWebp: posterWebpBytes,
        heroPosterAvif: posterAvifBytes,
        heroVideoAv1: av1Bytes,
        heroVideoH264: h264Bytes,
        inputThumbWebp: thumbBytes,
        inputImageWebp: inputBytes,
        inputImagesWebp: inputImagesBytes,
        modalLeftVideo: modalLeftBytes,
        modalRightVideo: modalRightBytes,
      },
    });
  }

  const manifest = {
    schemaVersion: 1,
    version: args.version,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    items,
  };
  const manifestPath = join(outVersionDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\nWrote manifest -> ${manifestPath} (${items.length} comparison clips)`);
}

main();
