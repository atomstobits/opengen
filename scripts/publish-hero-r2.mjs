#!/usr/bin/env node
/**
 * Provisions a dedicated public Cloudflare R2 bucket behind a custom domain (default: media.opengen.dev),
 * configures CORS for public Range streaming, and uploads the 3-tier hero comparison bundle with
 * immutable CDN Cache-Control headers.
 *
 * Defaults to --plan (read-only dry-run). Pass --apply to create resources and upload objects.
 *
 * Required environment variables for --apply:
 *   CLOUDFLARE_ACCOUNT_ID   Cloudflare account ID (32-char hex)
 *   CLOUDFLARE_API_TOKEN    Scoped token with:
 *                             - Account > Workers R2 Storage: Edit
 *                             - Zone > Zone: Read (for opengen.dev)
 *                             - Zone > DNS: Edit (for custom domain binding)
 *
 * Optional S3-compatible R2 credentials (recommended so Cache-Control headers are persisted on R2 objects):
 *   R2_ACCESS_KEY_ID        R2 S3 API token access key ID
 *   R2_SECRET_ACCESS_KEY    R2 S3 API token secret access key
 *   (When omitted, uploads via Cloudflare R2 REST API and prints a reminder to attach a Cloudflare
 *    Cache Rule / Transform Rule for immutable Cache-Control headers.)
 *
 * Usage:
 *   node scripts/publish-hero-r2.mjs --dist /path/to/hero-media-dist --plan
 *   node scripts/publish-hero-r2.mjs --dist /path/to/hero-media-dist --apply
 */

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const args = {
    dist: '',
    bucket: process.env.OPENGEN_HERO_R2_BUCKET || 'opengen-public-media',
    domain: process.env.OPENGEN_HERO_MEDIA_DOMAIN || 'media.opengen.dev',
    zoneName: 'opengen.dev',
    locationHint: 'wnam',
    apply: false,
    skipDns: false,
    uploadOnly: false,
    verifyOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--dist' && next) {
      args.dist = resolve(next);
      i += 1;
    } else if (flag === '--bucket' && next) {
      args.bucket = next;
      i += 1;
    } else if (flag === '--domain' && next) {
      args.domain = next;
      i += 1;
    } else if (flag === '--zone' && next) {
      args.zoneName = next;
      i += 1;
    } else if (flag === '--location-hint' && next) {
      args.locationHint = next;
      i += 1;
    } else if (flag === '--apply') {
      args.apply = true;
    } else if (flag === '--plan') {
      args.apply = false;
    } else if (flag === '--skip-dns') {
      args.skipDns = true;
    } else if (flag === '--upload-only') {
      args.uploadOnly = true;
    } else if (flag === '--verify-only') {
      args.verifyOnly = true;
    } else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: node scripts/publish-hero-r2.mjs --dist <dir> [--bucket opengen-public-media] [--domain media.opengen.dev] [--plan | --apply] [--upload-only] [--skip-dns] [--verify-only]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  if (!args.dist && !args.verifyOnly) {
    throw new Error('--dist <hero-media-dist> is required.');
  }
  return args;
}

function walkFiles(rootDir, current = rootDir, acc = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(rootDir, full, acc);
    else if (entry.isFile()) {
      const key = relative(rootDir, full).replaceAll('\\', '/');
      const ext = extname(entry.name).toLowerCase();
      const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
      const cacheControl =
        entry.name === 'manifest.json'
          ? 'public, max-age=300, stale-while-revalidate=86400'
          : 'public, max-age=31536000, immutable';
      acc.push({ full, key, bytes: statSync(full).size, contentType, cacheControl });
    }
  }
  return acc.sort((a, b) => a.key.localeCompare(b.key));
}

async function cfRequest(token, method, path, body, extraHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...extraHeaders,
  };
  let payload;
  if (body !== undefined) {
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(`${CF_API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || (json && json.success === false)) {
    const err = new Error(
      `Cloudflare API ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`,
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** Zero-dependency AWS SigV4 PUT to Cloudflare R2 S3 endpoint (preserves Cache-Control + Content-Type). */
async function r2S3Put({
  accountId,
  bucket,
  accessKeyId,
  secretAccessKey,
  key,
  body,
  contentType,
  cacheControl,
}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedKey = key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const canonicalUri = `/${bucket}/${encodedKey}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';
  const payloadHash = sha256Hex(body);

  const canonicalHeaders =
    `cache-control:${cacheControl}\n` +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'cache-control;content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Host: host,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`R2 S3 PUT ${key} failed (${res.status}): ${errText.slice(0, 300)}`);
  }
}

async function verifyPublicUrls(domain, files) {
  const sampleVideo = files.find((f) => f.key.endsWith('hero-split.h264.mp4'));
  const samplePoster = files.find((f) => f.key.endsWith('hero-poster.webp'));
  const manifestFile = files.find((f) => f.key.endsWith('manifest.json'));
  const checks = [manifestFile, samplePoster, sampleVideo].filter(Boolean);

  console.log(`\n=== Live Public CDN Verification (https://${domain}) ===`);
  for (const item of checks) {
    const url = `https://${domain}/${item.key}`;
    const isVideo = item.key.endsWith('.mp4');
    const res = await fetch(url, {
      method: isVideo ? 'GET' : 'HEAD',
      headers: isVideo ? { Range: 'bytes=0-1023' } : {},
    });
    console.log(
      `  ${res.status} ${url}\n` +
        `      content-type=${res.headers.get('content-type')} | cache-control=${res.headers.get('cache-control')} | cf-cache=${res.headers.get('cf-cache-status')} | content-range=${res.headers.get('content-range') ?? '-'}`,
    );
    if (isVideo && res.status !== 206) {
      throw new Error(
        `Expected HTTP 206 Partial Content for Range request on ${url}, got ${res.status}`,
      );
    }
    if (!isVideo && res.status !== 200) {
      throw new Error(`Expected HTTP 200 on ${url}, got ${res.status}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.dist && existsSync(args.dist) ? walkFiles(args.dist) : [];

  if (args.verifyOnly) {
    if (!files.length) throw new Error('--verify-only requires --dist with built assets.');
    await verifyPublicUrls(args.domain, files);
    return;
  }

  if (!files.length) {
    throw new Error(`No files found under ${args.dist}. Run scripts/build-hero-media.mjs first.`);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const useS3Upload = Boolean(r2AccessKeyId && r2SecretAccessKey);

  console.log('=== OpenGen Public Hero Media R2 Plan ===');
  console.log(`Mode:          ${args.apply ? 'APPLY (live mutations)' : 'PLAN (dry-run)'}`);
  console.log(`Bucket:        ${args.bucket} (locationHint=${args.locationHint})`);
  console.log(`Custom domain: https://${args.domain} (zone: ${args.zoneName})`);
  console.log(
    `Upload mode:   ${useS3Upload ? 'R2 S3 SigV4 (sets Cache-Control + Content-Type)' : 'Cloudflare REST API (Content-Type)'}`,
  );
  console.log(
    `Files:         ${files.length} objects (${(totalBytes / (1024 * 1024)).toFixed(2)} MB total)`,
  );
  for (const file of files) {
    console.log(
      `  - ${file.key} (${(file.bytes / 1024).toFixed(1)} KB, ${file.contentType}, ${file.cacheControl})`,
    );
  }

  if (!args.apply) {
    console.log(
      '\nDry-run complete. Re-run with --apply and CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN set.',
    );
    return;
  }

  if (!accountId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be set for --apply.');
  }

  if (args.uploadOnly) {
    if (!useS3Upload && !apiToken) {
      throw new Error(
        'For --upload-only, set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (recommended) or CLOUDFLARE_API_TOKEN.',
      );
    }
    console.log('\n[1-3/4] Skipping bucket/CORS/domain provisioning (--upload-only).');
  } else {
    if (!apiToken) {
      throw new Error(
        'CLOUDFLARE_API_TOKEN must be set for bucket/CORS/domain provisioning (or pass --upload-only with R2 S3 credentials).',
      );
    }

    // 1. Ensure public bucket exists (never touches private customer assets bucket)
    console.log(`\n[1/4] Ensuring R2 bucket "${args.bucket}" exists...`);
    try {
      await cfRequest(apiToken, 'GET', `/accounts/${accountId}/r2/buckets/${args.bucket}`);
      console.log('  Bucket already exists.');
    } catch (err) {
      if (err.status === 404) {
        await cfRequest(apiToken, 'POST', `/accounts/${accountId}/r2/buckets`, {
          name: args.bucket,
          locationHint: args.locationHint,
          storageClass: 'Standard',
        });
        console.log(`  Created R2 bucket "${args.bucket}".`);
      } else {
        throw err;
      }
    }

    // 2. Configure read-only CORS policy for Range video streaming and web fonts/images
    console.log('[2/4] Configuring read-only CORS policy...');
    await cfRequest(apiToken, 'PUT', `/accounts/${accountId}/r2/buckets/${args.bucket}/cors`, {
      rules: [
        {
          id: 'opengen-public-hero-read',
          allowed: {
            origins: [
              'https://opengen.dev',
              'https://www.opengen.dev',
              'http://localhost:3000',
              'http://localhost:4320',
              'http://127.0.0.1:4320',
            ],
            methods: ['GET', 'HEAD'],
            headers: ['Range', 'If-None-Match', 'If-Modified-Since'],
          },
          exposeHeaders: [
            'Content-Length',
            'Content-Range',
            'Accept-Ranges',
            'ETag',
            'Cache-Control',
          ],
          maxAgeSeconds: 86400,
        },
      ],
    });
    console.log('  CORS policy applied.');

    // 3. Attach custom domain media.opengen.dev (preserving all unrelated DNS records)
    if (!args.skipDns) {
      console.log(`[3/4] Attaching custom domain "${args.domain}" on zone "${args.zoneName}"...`);
      const zonesRes = await cfRequest(
        apiToken,
        'GET',
        `/zones?name=${encodeURIComponent(args.zoneName)}`,
      );
      const zone = zonesRes.result?.[0];
      if (!zone?.id) {
        throw new Error(`Could not find Cloudflare zone "${args.zoneName}".`);
      }
      const existingDomains = await cfRequest(
        apiToken,
        'GET',
        `/accounts/${accountId}/r2/buckets/${args.bucket}/domains/custom`,
      );
      const alreadyAttached = existingDomains.result?.domains?.some(
        (d) => d.domain === args.domain,
      );
      if (alreadyAttached) {
        console.log(`  Custom domain "${args.domain}" already attached.`);
      } else {
        await cfRequest(
          apiToken,
          'POST',
          `/accounts/${accountId}/r2/buckets/${args.bucket}/domains/custom`,
          {
            domain: args.domain,
            zoneId: zone.id,
            enabled: true,
            minTLS: '1.2',
          },
        );
        console.log(`  Attached "${args.domain}" -> bucket "${args.bucket}".`);
      }
    } else {
      console.log('[3/4] Skipping custom domain binding (--skip-dns).');
    }
  }

  // 4. Upload all encoded objects
  console.log(`[4/4] Uploading ${files.length} objects...`);
  for (const file of files) {
    const body = readFileSync(file.full);
    if (useS3Upload) {
      await r2S3Put({
        accountId,
        bucket: args.bucket,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        key: file.key,
        body,
        contentType: file.contentType,
        cacheControl: file.cacheControl,
      });
    } else {
      await cfRequest(
        apiToken,
        'PUT',
        `/accounts/${accountId}/r2/buckets/${args.bucket}/objects/${file.key}`,
        body,
        {
          'Content-Type': file.contentType,
          'Cache-Control': file.cacheControl,
        },
      );
    }
    console.log(`  Uploaded ${file.key} (${(file.bytes / 1024).toFixed(1)} KB)`);
  }

  if (!useS3Upload) {
    console.log(
      '\nNote: Objects were uploaded via Cloudflare REST API. Verify Cache-Control on https://' +
        args.domain +
        ' and set an R2 S3 token or Cloudflare Cache Rule if immutable Cache-Control is not echoed.',
    );
  }

  await verifyPublicUrls(args.domain, files);
  console.log('\nPublish complete.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
