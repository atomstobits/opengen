import { request } from 'node:https';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { OutputAsset } from '@media-router/contracts';
import type { AssetStore } from './storage.js';
import { resolvePublicTarget, type PublicResolver } from './public-network.js';
import { verifyC2pa, type C2paVerification, type ProvenanceOptions } from './provenance.js';

export const outputLimitBytes = 100 * 1024 * 1024;
export interface ArchivedOutput extends OutputAsset {
  sha256: string;
  byteLength: number;
  c2pa: C2paVerification;
}
export interface OutputDelivery {
  outputs: OutputAsset[];
  deliveryStatus: 'available' | 'partial' | 'failed' | 'unverified';
  deliveryErrors: { index: number; code: string }[];
}

export async function collectOutputBytes(
  stream: AsyncIterable<Uint8Array>,
  maxBytes = outputLimitBytes,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    received += chunk.byteLength;
    if (received > maxBytes) throw new Error('Output exceeds size limit.');
    chunks.push(Buffer.from(chunk));
  }
  if (!received) throw new Error('Output is empty.');
  return Buffer.concat(chunks, received);
}
export function detectedMediaType(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  return null;
}

export interface ReadAssetOptions {
  headers?: Record<string, string>;
  credentialHosts?: string[];
  maxBytes?: number;
  resolve?: PublicResolver;
}

export async function readPublicAsset(
  url: string,
  options: ReadAssetOptions = {},
): Promise<{ bytes: Buffer; mediaType: string }> {
  const maxBytes = options.maxBytes ?? outputLimitBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > outputLimitBytes)
    throw new Error('Invalid asset size limit.');
  const headers = options.headers ?? {};
  if (
    Object.keys(headers).some(
      (name) => !['authorization', 'x-goog-api-key'].includes(name.toLowerCase()),
    )
  )
    throw new Error('Unsupported asset credential header.');
  const hostname = new URL(url).hostname.toLowerCase();
  if (
    Object.keys(headers).length &&
    !options.credentialHosts?.some((pattern) => {
      const host = pattern.toLowerCase();
      return (
        /^[a-z0-9.-]+$/.test(host) &&
        (host.startsWith('.')
          ? hostname === host.slice(1) || hostname.endsWith(host)
          : hostname === host)
      );
    })
  )
    throw new Error('Asset credentials are not permitted for this host.');
  const signal = AbortSignal.timeout(30_000);
  const target = await resolvePublicTarget(url, options.resolve);
  signal.throwIfAborted();
  const result = await new Promise<{ bytes: Buffer; declaredType?: string }>((resolve, reject) => {
    const incoming = request(
      target.url,
      {
        method: 'GET',
        agent: false,
        signal,
        family: target.address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, target.address.address, target.address.family),
        headers: {
          ...headers,
          Accept: 'image/png,image/jpeg,image/webp,video/mp4',
          'User-Agent': 'OpenGen-Outputs/0.1',
        },
      },
      async (response) => {
        try {
          if (response.statusCode !== 200) throw new Error('Asset download failed.');
          const length = Number(response.headers['content-length']);
          if (Number.isFinite(length) && length > maxBytes)
            throw new Error('Asset exceeds size limit.');
          const declaredType = response.headers['content-type']
            ?.split(';')[0]
            ?.trim()
            .toLowerCase()
            .replace('image/jpg', 'image/jpeg');
          if (
            declaredType &&
            ![
              'image/png',
              'image/jpeg',
              'image/webp',
              'video/mp4',
              'application/octet-stream',
              'binary/octet-stream',
            ].includes(declaredType)
          )
            throw new Error('Unsupported asset media type.');
          const bytes = await collectOutputBytes(response, maxBytes);
          resolve({ bytes, declaredType });
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    incoming.once('error', reject);
    incoming.end();
  });
  const mediaType = detectedMediaType(result.bytes);
  if (
    !mediaType ||
    (result.declaredType &&
      ![mediaType, 'application/octet-stream', 'binary/octet-stream'].includes(result.declaredType))
  )
    throw new Error('Asset signature does not match its media type.');
  return { bytes: result.bytes, mediaType };
}

export async function downloadOutput(
  url: string,
  mediaType: string,
  resolver?: PublicResolver,
): Promise<Buffer> {
  const result = await readPublicAsset(url, { resolve: resolver });
  if (result.mediaType !== mediaType)
    throw new Error('Output signature does not match its declared media type.');
  return result.bytes;
}

interface ArchiveOptions {
  download?: (url: string, mediaType: string) => Promise<Buffer>;
  provenance?: ProvenanceOptions;
}
/** Delivery failure never changes provider success or establishes a refund. */
export async function archiveOutputs(
  jobId: string,
  outputs: OutputAsset[],
  storage?: AssetStore,
  options: ArchiveOptions = {},
): Promise<OutputDelivery> {
  if (!storage)
    return {
      outputs: [],
      deliveryStatus: 'failed',
      deliveryErrors: [{ index: -1, code: 'storage_not_configured' }],
    };
  const archived: ArchivedOutput[] = [],
    errors: OutputDelivery['deliveryErrors'] = [];
  for (const [index, output] of outputs.entries()) {
    try {
      let bytes: Buffer;
      let asset: OutputAsset;
      if (output.storageKey) {
        if (
          !output.storageKey.startsWith(`outputs/${jobId}/`) ||
          !/^outputs\/[a-f0-9-]+\/[a-f0-9-]+\.(png|jpg|webp|mp4)$/.test(output.storageKey)
        )
          throw new Error('Output key does not belong to the job.');
        const object = await storage.client.send(
          new GetObjectCommand({ Bucket: storage.bucket, Key: output.storageKey }),
          { abortSignal: AbortSignal.timeout(30_000) },
        );
        if (
          !object.Body ||
          (object.ContentLength !== undefined && object.ContentLength > outputLimitBytes)
        )
          throw new Error('Stored output is absent or oversized.');
        bytes = await collectOutputBytes(object.Body as AsyncIterable<Uint8Array>);
        if (detectedMediaType(bytes) !== output.mediaType)
          throw new Error('Stored output media type mismatch.');
        asset = await storage.sign(output.storageKey, output.mediaType);
      } else {
        bytes = await (options.download ?? downloadOutput)(output.url, output.mediaType);
        if (bytes.byteLength > outputLimitBytes || detectedMediaType(bytes) !== output.mediaType)
          throw new Error('Invalid provider output.');
        asset = await storage.putOutput({ jobId, bytes, mediaType: output.mediaType });
      }
      const c2pa = await verifyC2pa(bytes, output.mediaType, options.provenance);
      archived.push({
        ...asset,
        fidelity: 'unverified',
        sha256: c2pa.sha256,
        byteLength: bytes.length,
        c2pa,
      });
    } catch {
      errors.push({ index, code: 'output_delivery_failed' });
    }
  }
  return {
    outputs: archived,
    deliveryStatus:
      !errors.length && archived.length ? 'available' : archived.length ? 'partial' : 'failed',
    deliveryErrors: errors,
  };
}
