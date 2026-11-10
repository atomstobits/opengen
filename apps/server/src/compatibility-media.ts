import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { collectOutputBytes, detectedMediaType, type AssetStore } from '@media-router/engine';
import type {
  OwnedOutputJob,
  OwnedOutputDescriptor,
} from '../../../packages/engine/src/owned-output-access.js';
export type { OwnedOutputJob } from '../../../packages/engine/src/owned-output-access.js';

// These are representation limits, independent of a model's inference limits.
export const compatibilityImageLimitBytes = 8 * 1024 * 1024;
export const compatibilityVideoLimitBytes = 100 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const unavailable = () =>
  Object.assign(new Error('Owned output bytes are unavailable. Retrieve the existing job.'), {
    statusCode: 409,
    code: 'output_unavailable',
  });
const oversized = () =>
  Object.assign(new Error('Output exceeds this response format limit; use URL delivery.'), {
    statusCode: 413,
    code: 'response_too_large',
  });

function ownedOutput(job: OwnedOutputJob, outputIndex: number): OwnedOutputDescriptor {
  const output = job.outputs[outputIndex];
  if (
    job.status !== 'succeeded' ||
    job.deliveryStatus !== 'available' ||
    !output?.storageKey ||
    !output.storageKey.startsWith(`outputs/${job.id}/`) ||
    !/^outputs\/[a-f0-9-]+\/[a-f0-9-]+\.(png|jpg|webp|mp4)$/.test(output.storageKey)
  )
    throw unavailable();
  return output;
}

/** Only call with a job returned by workspace-authorized engine access, never a client job body. */
export async function imageBase64(job: OwnedOutputJob, storage?: AssetStore) {
  if (!storage || job.outputs.length !== 1) throw unavailable();
  const output = ownedOutput(job, 0);
  if (!imageTypes.has(output.mediaType)) throw unavailable();
  if (output.byteLength !== undefined && output.byteLength > compatibilityImageLimitBytes)
    throw oversized();
  const object = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.bucket, Key: output.storageKey }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (object.ContentLength !== undefined && object.ContentLength > compatibilityImageLimitBytes) {
    (object.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw oversized();
  }
  if (!object.Body) throw unavailable();
  let bytes: Buffer;
  try {
    bytes = await collectOutputBytes(
      object.Body as AsyncIterable<Uint8Array>,
      compatibilityImageLimitBytes,
    );
  } catch {
    (object.Body as { destroy?: () => void }).destroy?.();
    throw unavailable();
  }
  if (
    detectedMediaType(bytes) !== output.mediaType ||
    (object.ContentLength !== undefined && object.ContentLength !== bytes.length)
  )
    throw unavailable();
  return { b64_json: bytes.toString('base64') };
}

export type ByteRange = { start: number; end: number };
/** A single bytes range only. Multi-ranges/invalid/unsatisfiable ranges consistently produce 416. */
export function parseVideoRange(range: string | undefined, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size < 1) throw unavailable();
  if (range === undefined) return null;
  const fail = () => {
    throw Object.assign(new Error('Requested byte range is not satisfiable.'), {
      statusCode: 416,
      code: 'range_not_satisfiable',
      contentRange: `bytes */${size}`,
    });
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return fail();
  const left = match[1] ? Number(match[1]) : null;
  const right = match[2] ? Number(match[2]) : null;
  if (
    (left !== null && !Number.isSafeInteger(left)) ||
    (right !== null && !Number.isSafeInteger(right))
  )
    return fail();
  if (left === null) {
    if (!right) return fail();
    return { start: Math.max(0, size - right), end: size - 1 };
  }
  if (left >= size || (right !== null && right < left)) return fail();
  return { start: left, end: Math.min(right ?? size - 1, size - 1) };
}

/** Reads only the authorized owned object. No URL target or caller headers enter storage requests. */
export async function ownedVideoContent(
  job: OwnedOutputJob,
  range: string | undefined,
  storage?: AssetStore,
  ifRange?: string,
) {
  if (!storage || job.outputs.length !== 1) throw unavailable();
  const output = ownedOutput(job, 0);
  if (output.mediaType !== 'video/mp4') throw unavailable();
  const head = await storage.client.send(
    new HeadObjectCommand({ Bucket: storage.bucket, Key: output.storageKey }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  const size = head.ContentLength;
  if (!Number.isSafeInteger(size) || !size || size < 1 || head.ContentType !== 'video/mp4')
    throw unavailable();
  if (size > compatibilityVideoLimitBytes) throw oversized();
  // Changed/weak validators request a full representation, never a splice of
  // bytes into the client's previously cached version of a different object.
  const matchesValidator =
    ifRange === undefined ||
    (ifRange.startsWith('"') && ifRange === head.ETag) ||
    (head.LastModified !== undefined && ifRange === head.LastModified.toUTCString());
  const selected = parseVideoRange(matchesValidator ? range : undefined, size);
  const length = selected ? selected.end - selected.start + 1 : size;
  const contentRange = selected ? `bytes ${selected.start}-${selected.end}/${size}` : undefined;
  const object = await storage.client.send(
    new GetObjectCommand({
      Bucket: storage.bucket,
      Key: output.storageKey,
      ...(selected ? { Range: `bytes=${selected.start}-${selected.end}` } : {}),
      // If replaced during a concurrent retention/recovery operation, fail closed.
      ...(head.ETag ? { IfMatch: head.ETag } : {}),
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (
    !object.Body ||
    object.ContentLength !== length ||
    (selected && object.ContentRange !== contentRange) ||
    (!selected && object.ContentRange !== undefined)
  ) {
    (object.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw unavailable();
  }
  let bytes: Buffer;
  try {
    bytes = await collectOutputBytes(object.Body as AsyncIterable<Uint8Array>, length);
  } catch {
    (object.Body as { destroy?: () => void }).destroy?.();
    throw unavailable();
  }
  if (bytes.length !== length || (!selected && detectedMediaType(bytes) !== 'video/mp4'))
    throw unavailable();
  return {
    statusCode: selected ? 206 : 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'Content-Length': String(length),
      'Cache-Control': 'private, no-store',
      ...(contentRange ? { 'Content-Range': contentRange } : {}),
    },
    bytes,
  };
}
