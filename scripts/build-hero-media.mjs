#!/usr/bin/env node
/**
 * Builds the 3-tier web-optimized OpenGen hero comparison media bundle:
 *   Tier 1: LCP split posters (AVIF + WebP), modal posters, compact input thumbnails
 *   Tier 2: Muted single-stream 50/50 split hero background loops (AV1 + H.264 +faststart, <=10s)
 *   Tier 3: Lazy modal inspection clips (separate left/right 720p H.264 + AAC, full duration)
 *
 * Usage:
 *   node scripts/build-hero-media.mjs \
 *     --input /path/to/kling4-sample \
 *     --out /path/to/hero-media-dist \
 *     --version v1 \
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

const DEFAULT_SUMMARIES = {
  'case-17':
    'Hallway to luxury Miami villa match cut from @Image1 — casual sweatshirt to black mini dress and knee-high boots.',
  'case-26':
    'Five street dancers from @Image1 perform synchronized night choreography in front of a warmly lit food stall.',
};

function parseArgs(argv) {
  const args = {
    input: '',
    out: '',
    version: 'v1',
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
        'Usage: node scripts/build-hero-media.mjs --input <dir> --out <dir> [--version v1] [--base-url https://media.opengen.dev] [--cases case-17,case-26] [--hero-max-sec 10] [--skip-existing]',
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
 * Builds an ffmpeg filtergraph that frames each side into 640x720 (total 1280x720)
 * using upper-weighted vertical crop for portrait videos so faces stay visible.
 */
function splitFilterGraph(leftMeta, rightMeta) {
  const paneFilter = (meta, label) => {
    const isPortrait = meta.height > meta.width;
    // Portrait videos crop slightly toward upper third; landscape/4:3 center crop cleanly.
    const cropY = isPortrait ? '(ih-720)*0.22' : '(ih-720)/2';
    return `[${label}:v]scale=640:720:force_original_aspect_ratio=increase:flags=lanczos,crop=640:720:(iw-640)/2:${cropY},fps=24,setsar=1[${label}p]`;
  };
  return `${paneFilter(leftMeta, '0')};${paneFilter(rightMeta, '1')};[0p][1p]hstack=inputs=2[v]`;
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
    const leftRaw = join(caseDir, 'seedance-2.5.mp4');
    const rightRaw = join(caseDir, 'kling-4.0.mp4');
    const inputRaw = join(caseDir, 'input-image-1.jpg');

    for (const required of [specPath, leftRaw, rightRaw, inputRaw]) {
      if (!existsSync(required)) {
        throw new Error(`Missing required source file for ${caseKey}: ${required}`);
      }
    }

    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const leftMeta = probe(leftRaw);
    const rightMeta = probe(rightRaw);
    const heroDurSec = Math.min(
      args.heroMaxSec,
      Math.floor(Math.min(leftMeta.durationSec, rightMeta.durationSec)),
    );

    const outCaseDir = join(outVersionDir, caseKey);
    mkdirSync(outCaseDir, { recursive: true });
    const rel = (filename) => `${versionRelPrefix}/${caseKey}/${filename}`;

    console.log(
      `\n=== Encoding ${caseKey} (raw: ${formatBytes(leftMeta.bytes)} + ${formatBytes(rightMeta.bytes)}, hero loop: ${heroDurSec}s) ===`,
    );

    const heroAv1 = join(outCaseDir, 'hero-split.av1.mp4');
    const heroH264 = join(outCaseDir, 'hero-split.h264.mp4');
    const modalLeft = join(outCaseDir, 'seedance-2.5.mp4');
    const modalRight = join(outCaseDir, 'kling-4.0.mp4');
    const heroPosterWebp = join(outCaseDir, 'hero-poster.webp');
    const heroPosterAvif = join(outCaseDir, 'hero-poster.avif');
    const leftPosterWebp = join(outCaseDir, 'left-poster.webp');
    const rightPosterWebp = join(outCaseDir, 'right-poster.webp');
    const inputThumbWebp = join(outCaseDir, 'input-thumb.webp');
    const inputModalWebp = join(outCaseDir, 'input.webp');

    const filterComplex = splitFilterGraph(leftMeta, rightMeta);

    // Tier 2a: Hero split H.264 (universal fallback, muted, +faststart, VBV-capped for fast streaming)
    if (!args.skipExisting || !existsSync(heroH264)) {
      console.log(`  [Tier 2] hero-split.h264.mp4 (${heroDurSec}s, 1280x720, muted)...`);
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
        'main',
        '-level',
        '4.0',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '28',
        '-maxrate',
        '1100k',
        '-bufsize',
        '2200k',
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

    // Tier 2b: Hero split AV1 (primary modern stream, muted, +faststart, ultra-compact)
    if (!args.skipExisting || !existsSync(heroAv1)) {
      console.log(`  [Tier 2] hero-split.av1.mp4 (${heroDurSec}s, 1280x720, muted, SVT-AV1)...`);
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
        '46',
        '-preset',
        '6',
        '-g',
        '48',
        '-svtav1-params',
        'tune=0:enable-overlays=1:mbr=900',
        '-movflags',
        '+faststart',
        heroAv1,
      ]);
      verifyVideoDecode(heroAv1);
    }

    // Tier 1: Static posters extracted from exact first frame (t=0.05s) so video fade-in has zero jump
    const tier1Images = [
      heroPosterWebp,
      heroPosterAvif,
      leftPosterWebp,
      rightPosterWebp,
      inputThumbWebp,
      inputModalWebp,
    ];
    if (!args.skipExisting || !tier1Images.every(existsSync)) {
      console.log(
        '  [Tier 1] hero-poster.webp + hero-poster.avif + modal posters + input thumbs...',
      );
      const tmpHeroPng = join(outCaseDir, '.tmp-hero-poster.png');
      const tmpLeftPng = join(outCaseDir, '.tmp-left-poster.png');
      const tmpRightPng = join(outCaseDir, '.tmp-right-poster.png');
      const tmpThumbPng = join(outCaseDir, '.tmp-input-thumb.png');
      const tmpInputPng = join(outCaseDir, '.tmp-input-modal.png');
      try {
        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-ss',
          '0.05',
          '-i',
          heroH264,
          '-frames:v',
          '1',
          tmpHeroPng,
        ]);
        encodeImageVariants(tmpHeroPng, heroPosterWebp, heroPosterAvif, {
          webpQuality: 80,
          avifMin: 26,
          avifMax: 40,
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
          "scale='min(640,iw)':-2:flags=lanczos",
          '-frames:v',
          '1',
          tmpLeftPng,
        ]);
        encodeImageVariants(tmpLeftPng, leftPosterWebp, null, { webpQuality: 80 });

        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-ss',
          '0.05',
          '-i',
          rightRaw,
          '-vf',
          "scale='min(640,iw)':-2:flags=lanczos",
          '-frames:v',
          '1',
          tmpRightPng,
        ]);
        encodeImageVariants(tmpRightPng, rightPosterWebp, null, { webpQuality: 80 });

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

        run('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-i',
          inputRaw,
          '-vf',
          "scale='min(640,iw)':-2:flags=lanczos",
          '-frames:v',
          '1',
          tmpInputPng,
        ]);
        encodeImageVariants(tmpInputPng, inputModalWebp, null, { webpQuality: 84 });
      } finally {
        for (const tmp of [tmpHeroPng, tmpLeftPng, tmpRightPng, tmpThumbPng, tmpInputPng]) {
          if (existsSync(tmp)) unlinkSync(tmp);
        }
      }
    }

    // Tier 3: Modal inspection clips (separate left/right, full duration, with audio, lazy-loaded on click)
    const encodeModal = (src, dst, label) => {
      if (args.skipExisting && existsSync(dst)) return;
      console.log(`  [Tier 3] ${label} (full duration, 720p max, H.264 + AAC)...`);
      run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-i',
        src,
        '-vf',
        "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))':flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v',
        'libx264',
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '26',
        '-maxrate',
        '1400k',
        '-bufsize',
        '2800k',
        '-preset',
        'medium',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        dst,
      ]);
      verifyVideoDecode(dst);
    };

    encodeModal(leftRaw, modalLeft, 'seedance-2.5.mp4');
    encodeModal(rightRaw, modalRight, 'kling-4.0.mp4');

    const av1Bytes = statSync(heroAv1).size;
    const h264Bytes = statSync(heroH264).size;
    const posterWebpBytes = statSync(heroPosterWebp).size;
    const posterAvifBytes = existsSync(heroPosterAvif) ? statSync(heroPosterAvif).size : 0;
    const modalLeftBytes = statSync(modalLeft).size;
    const modalRightBytes = statSync(modalRight).size;
    const thumbBytes = statSync(inputThumbWebp).size;
    const inputBytes = statSync(inputModalWebp).size;

    console.log(
      `  Done: poster=${formatBytes(posterAvifBytes || posterWebpBytes)} (webp ${formatBytes(posterWebpBytes)}) | hero AV1=${formatBytes(av1Bytes)}, H.264=${formatBytes(h264Bytes)} | modal L=${formatBytes(modalLeftBytes)}, R=${formatBytes(modalRightBytes)} | thumb=${formatBytes(thumbBytes)}`,
    );

    items.push({
      id: caseKey,
      resolution: resolveResolutionLabel(spec),
      operation: resolveOperation(spec),
      durationSec: Number(spec.durationSec ?? Math.round(leftMeta.durationSec)),
      heroDurationSec: heroDurSec,
      shortPrompt: summarizePrompt(caseKey, spec.prompt),
      fullPrompt: spec.prompt,
      inputRole:
        spec.inputs?.[0]?.kind === 'FIRST_FRAME' ? 'First frame (@Image1)' : 'Reference (@Image1)',
      leftModelId: 'bytedance/seedance-2.5',
      rightModelId: 'kling/kling-4.0',
      media: {
        heroPosterWebp: rel('hero-poster.webp'),
        ...(existsSync(heroPosterAvif) ? { heroPosterAvif: rel('hero-poster.avif') } : {}),
        heroVideoAv1: rel('hero-split.av1.mp4'),
        heroVideoH264: rel('hero-split.h264.mp4'),
        inputThumbWebp: rel('input-thumb.webp'),
        inputImageWebp: rel('input.webp'),
        modalLeftVideo: rel('seedance-2.5.mp4'),
        modalRightVideo: rel('kling-4.0.mp4'),
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
