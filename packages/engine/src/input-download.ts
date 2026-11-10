import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { resolvePublicTarget, type PublicResolver } from './public-network.js';
import { inspectInputBytes, inputMediaExtension, maxInputBytes } from './input-media.js';

export class InputImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'InputImportError';
  }
}

export interface ImportedInputBytes {
  bytes: Buffer;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface InputDownloadOptions {
  /** An operator limit may narrow the shared input cap, never expand it. */
  maxBytes?: number;
  resolve?: PublicResolver;
}

const genericTypes = new Set(['application/octet-stream', 'binary/octet-stream']);
const accept = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
].join(',');

function failure(code: string, message: string): InputImportError {
  return new InputImportError(code, message);
}

/**
 * Read one external input into bounded immutable bytes. This is deliberately a
 * credential-free, no-redirect GET; it is not a general authenticated proxy.
 * DNS is checked on every import, then pinned for this exact TLS request.
 */
export async function readPublicInput(
  url: string,
  options: InputDownloadOptions = {},
): Promise<ImportedInputBytes> {
  const maxBytes = options.maxBytes ?? maxInputBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxInputBytes)
    throw failure('invalid_input_limit', 'The input byte limit is invalid.');
  if (typeof url !== 'string' || !url.length || url.length > 8192)
    throw failure('invalid_input_url', 'Input media requires a bounded public HTTPS URL.');
  const signal = AbortSignal.timeout(30_000);
  let target: Awaited<ReturnType<typeof resolvePublicTarget>>;
  try {
    target = await resolvePublicTarget(url, options.resolve);
    signal.throwIfAborted();
  } catch {
    // DNS/parser diagnostics may contain private hostnames or signed URL details.
    throw failure('invalid_input_url', 'Input media must resolve only to public HTTPS addresses.');
  }
  try {
    const result = await new Promise<{ bytes: Buffer; mediaType?: string }>((resolve, reject) => {
      let responseInFlight: IncomingMessage | undefined;
      const incoming = request(
        target.url,
        {
          method: 'GET',
          agent: false,
          signal,
          family: target.address.family,
          maxHeaderSize: 16_384,
          lookup: (_hostname, _options, callback) =>
            callback(null, target.address.address, target.address.family),
          headers: {
            Accept: accept,
            'Accept-Encoding': 'identity',
            'User-Agent': 'OpenGen-Inputs/0.1',
          },
        },
        async (response) => {
          responseInFlight = response;
          try {
            if (response.statusCode !== 200)
              throw failure('input_download_failed', 'Input media could not be downloaded.');
            const encoding = response.headers['content-encoding'];
            if (encoding && encoding.toLowerCase() !== 'identity')
              throw failure('invalid_input_media', 'Compressed input responses are unsupported.');
            const length = response.headers['content-length'];
            let expectedLength: number | undefined;
            if (length !== undefined) {
              if (!/^\d+$/.test(length))
                throw failure('input_download_incomplete', 'The input byte length is invalid.');
              expectedLength = Number(length);
              if (!Number.isSafeInteger(expectedLength) || expectedLength > maxBytes)
                throw failure('input_too_large', 'Input media exceeds the configured byte limit.');
              if (expectedLength < 1) throw failure('invalid_input_media', 'Input media is empty.');
            }
            const declaredType = response.headers['content-type']
              ?.split(';')[0]
              ?.trim()
              .toLowerCase();
            if (
              declaredType &&
              !genericTypes.has(declaredType) &&
              !inputMediaExtension(declaredType)
            )
              throw failure('invalid_input_media', 'The input media type is unsupported.');
            const chunks: Buffer[] = [];
            let received = 0;
            for await (const chunk of response) {
              received += chunk.byteLength;
              if (received > maxBytes)
                throw failure('input_too_large', 'Input media exceeds the configured byte limit.');
              chunks.push(Buffer.from(chunk));
            }
            if (!received) throw failure('invalid_input_media', 'Input media is empty.');
            if (expectedLength !== undefined && received !== expectedLength)
              throw failure(
                'input_download_incomplete',
                'Input media ended at a different byte length.',
              );
            resolve({
              bytes: Buffer.concat(chunks, received),
              mediaType: declaredType && !genericTypes.has(declaredType) ? declaredType : undefined,
            });
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      incoming.once('error', (error) => {
        responseInFlight?.destroy();
        reject(error);
      });
      incoming.end();
    });
    try {
      return { bytes: result.bytes, ...inspectInputBytes(result.bytes, result.mediaType) };
    } catch {
      throw failure(
        'invalid_input_media',
        'Input media does not match a supported file signature.',
      );
    }
  } catch (error) {
    if (error instanceof InputImportError) throw error;
    if (signal.aborted)
      throw new InputImportError('input_download_timeout', 'Input media download timed out.', 408);
    throw failure('input_download_failed', 'Input media could not be downloaded.');
  }
}

/** Stable internal alias used by the immutable preparation service. */
export const downloadInput = readPublicInput;
