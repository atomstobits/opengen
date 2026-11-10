import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { OutputAsset } from '@media-router/contracts';
import {
  createInputKey,
  inputMediaExtension,
  maxInputBytes,
  validateInputMedia,
} from './input-media.js';
export { createInputKey } from './input-media.js';

export interface InputObjectFacts {
  bytes: Buffer;
  storageKey: string;
  mediaType: string;
  size: number;
  sha256: string;
}
/** Persist this server-issued session. Do not reconstruct it from caller-selected object keys. */
export interface MultipartInputSession {
  key: string;
  uploadId: string;
  mediaType: string;
  size: number;
  partSize: number;
  partCount: number;
}
export type MultipartUploadSession = MultipartInputSession;
export interface UploadedInputPart {
  partNumber: number;
  etag: string;
  size: number;
}
const inputOperationTimeoutMs = 30_000;
/** Keep private object work inside the lifecycle writer lease, including SDK retries. */
async function inputDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Private input storage operation timed out.'), {
        name: 'TimeoutError',
        statusCode: 503,
      });
      controller.abort(error);
      reject(error);
    }, inputOperationTimeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
const multipartPartSize = 5 * 1024 * 1024;
const googleStorageEndpoint = 'https://storage.googleapis.com';
const googleCreateOnlyHeader = 'x-goog-if-generation-match';
const googleSha256Header = 'x-goog-meta-sha256';
const inputKeyPattern =
  /^inputs\/[a-zA-Z0-9_-]+\/[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|flac|m4a|weba|bin)$/;
const outputKeyPattern =
  /^outputs\/[a-zA-Z0-9_-]+\/[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|flac|m4a|weba)$/;
function bad(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound() {
  return Object.assign(new Error('Asset not found.'), { statusCode: 404 });
}
function missing(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    ['NoSuchKey', 'NotFound'].includes(value?.name ?? '') ||
    value?.$metadata?.httpStatusCode === 404
  );
}
function precondition(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === 'PreconditionFailed' || value?.$metadata?.httpStatusCode === 412;
}
function validateWorkspaceId(workspaceId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) throw notFound();
}
function validateMediaSize(mediaType: string, size: number) {
  const extension = inputMediaExtension(mediaType);
  if (!extension || !Number.isSafeInteger(size) || size < 1 || size > maxInputBytes)
    throw bad('Upload must be a supported image, video or audio file up to 100 MiB.');
  return extension;
}
async function boundedBytes(body: unknown, signal: AbortSignal): Promise<Buffer> {
  if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function')
    throw bad('Stored input has no readable body.');
  const stream = body as AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };
  const abort = () => stream.destroy?.(signal.reason as Error);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) {
      abort();
      signal.throwIfAborted();
    }
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > maxInputBytes) throw bad('Stored input exceeds 100 MiB.');
      parts.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    return Buffer.concat(parts, size);
  } catch (error) {
    stream.destroy?.();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export class AssetStore {
  readonly client: S3Client;
  private readonly googleXml: boolean;
  constructor(
    readonly bucket: string,
    options: { endpoint?: string; region?: string } = {},
  ) {
    this.googleXml =
      options.endpoint === googleStorageEndpoint ||
      options.endpoint === `${googleStorageEndpoint}/`;
    this.client = new S3Client({
      region: options.region ?? 'auto',
      endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint),
      // A presigned browser PUT has no body here. Avoid signing an empty-body CRC32.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AssetStore | undefined {
    return env.S3_BUCKET
      ? new AssetStore(env.S3_BUCKET, { endpoint: env.S3_ENDPOINT, region: env.S3_REGION })
      : undefined;
  }
  private createOnlyPut(
    input: Omit<PutObjectCommandInput, 'Bucket' | 'IfNoneMatch' | 'Metadata'>,
    sha256?: string,
  ): PutObjectCommand {
    const command = new PutObjectCommand({
      ...input,
      Bucket: this.bucket,
      IfNoneMatch: this.googleXml ? undefined : '*',
      Metadata: !this.googleXml && sha256 !== undefined ? { sha256 } : undefined,
    });
    if (this.googleXml)
      command.middlewareStack.add(
        (next) => (args) => {
          const request = args.request as { headers: Record<string, string> };
          // Attach the XML generation condition before the presigner canonicalizes headers.
          request.headers[googleCreateOnlyHeader] = '0';
          if (sha256 !== undefined) request.headers[googleSha256Header] = sha256;
          return next(args);
        },
        { name: 'googleCreateOnlyHeader', step: 'build' },
      );
    return command;
  }
  async writeCreateOnly(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    signal: AbortSignal,
    sha256?: string,
  ): Promise<void> {
    const cacheControl = 'private, no-store';
    const input = {
      Key: key,
      ContentType: mediaType,
      ContentLength: bytes.byteLength,
      CacheControl: cacheControl,
    };
    if (!this.googleXml) {
      await this.client.send(this.createOnlyPut({ ...input, Body: bytes }, sha256), {
        abortSignal: signal,
      });
      return;
    }

    // Use the same query-signing path as browser uploads for the conditional GCS XML PUT.
    const uploadUrl = await getSignedUrl(this.client, this.createOnlyPut(input, sha256), {
      expiresIn: 60,
      signableHeaders: new Set(['cache-control', 'content-type']),
    });
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'cache-control': cacheControl,
          'content-length': String(bytes.byteLength),
          'content-type': mediaType,
          [googleCreateOnlyHeader]: '0',
          ...(sha256 === undefined ? {} : { [googleSha256Header]: sha256 }),
        },
        body:
          bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : Uint8Array.from(bytes),
        redirect: 'error',
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('Private object storage write failed.');
    }
    await response.body?.cancel();
    if (!response.ok)
      throw Object.assign(new Error('Private object storage rejected the write.'), {
        $metadata: { httpStatusCode: response.status },
      });
  }
  async sign(key: string, mediaType: string, expiresIn = 900): Promise<OutputAsset> {
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600)
      throw bad('Media read capability must expire within one hour.');
    return {
      storageKey: key,
      url: await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn },
      ),
      mediaType,
      fidelity: 'unverified',
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }
  /** Confirm the retained owned object still exists before issuing a customer capability. */
  async assertOutputAvailable(
    jobId: string,
    key: string,
    mediaType: string,
    expectedBytes?: number,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(jobId) ||
      !key.startsWith(`outputs/${jobId}/`) ||
      !/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|mp4)$/.test(key.slice(`outputs/${jobId}/`.length))
    )
      throw notFound();
    try {
      const value = await inputDeadline((signal) =>
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: signal,
        }),
      );
      const declared = value.ContentType?.split(';')[0]?.trim().toLowerCase();
      if (
        !Number.isSafeInteger(value.ContentLength) ||
        value.ContentLength! < 1 ||
        value.ContentLength! > maxInputBytes ||
        (expectedBytes !== undefined && value.ContentLength !== expectedBytes) ||
        declared !== mediaType
      )
        throw new Error('Owned object facts changed.');
    } catch {
      throw new Error('Owned output is unavailable.');
    }
  }
  async putOutput({
    jobId,
    bytes,
    mediaType,
  }: {
    jobId: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<OutputAsset> {
    const extension = inputMediaExtension(mediaType);
    if (!extension || bytes.byteLength > maxInputBytes || !bytes.byteLength)
      throw new Error('Unsupported or oversized output asset.');
    const key = `outputs/${jobId}/${randomUUID()}.${extension}`;
    await inputDeadline((signal) => this.writeCreateOnly(key, bytes, mediaType, signal));
    return this.sign(key, mediaType);
  }
  async prepareUpload(workspaceId: string, mediaType: string, size: number) {
    validateMediaSize(mediaType, size);
    const key = createInputKey(workspaceId, mediaType);
    return {
      key,
      uploadUrl: await getSignedUrl(
        this.client,
        this.createOnlyPut({
          Key: key,
          ContentType: mediaType,
          ContentLength: size,
        }),
        {
          expiresIn: 600,
          signableHeaders: this.googleXml ? new Set(['content-type']) : undefined,
        },
      ),
      headers: {
        'Content-Type': mediaType,
        ...(this.googleXml ? { [googleCreateOnlyHeader]: '0' } : { 'If-None-Match': '*' }),
      },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }
  private owned(workspaceId: string, key: string) {
    validateWorkspaceId(workspaceId);
    if (!key.startsWith(`inputs/${workspaceId}/`) || !inputKeyPattern.test(key)) throw notFound();
  }
  private async readObject(key: string): Promise<InputObjectFacts> {
    return inputDeadline(async (signal) => {
      const value = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
      if (signal.aborted) {
        (value.Body as { destroy?: () => void } | undefined)?.destroy?.();
        signal.throwIfAborted();
      }
      if (
        value.ContentLength === undefined ||
        !Number.isSafeInteger(value.ContentLength) ||
        value.ContentLength < 1 ||
        value.ContentLength > maxInputBytes
      ) {
        (value.Body as { destroy?: () => void } | undefined)?.destroy?.();
        throw bad('Stored input has an unsupported size.');
      }
      const bytes = await boundedBytes(value.Body, signal);
      if (bytes.length !== value.ContentLength)
        throw bad('Stored input length does not match its body.');
      const facts = validateInputMedia(bytes, value.ContentType ?? '');
      if (!key.endsWith('.bin') && !key.endsWith(`.${inputMediaExtension(facts.mediaType)}`))
        throw bad('Stored input type does not match its key.');
      signal.throwIfAborted();
      return { bytes, storageKey: key, ...facts };
    });
  }
  async readInput(workspaceId: string, key: string): Promise<InputObjectFacts> {
    this.owned(workspaceId, key);
    try {
      return await this.readObject(key);
    } catch (error) {
      if (missing(error)) throw notFound();
      throw error;
    }
  }
  async readInputIfExists(workspaceId: string, key: string): Promise<InputObjectFacts | null> {
    this.owned(workspaceId, key);
    try {
      return await this.readObject(key);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  /** Only call after authorizing the source job and selecting its persisted output slot. */
  async readOwnedOutput(jobId: string, key: string): Promise<InputObjectFacts> {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(jobId) ||
      !key.startsWith(`outputs/${jobId}/`) ||
      !outputKeyPattern.test(key)
    )
      throw notFound();
    try {
      return await this.readObject(key);
    } catch (error) {
      if (missing(error)) throw notFound();
      throw error;
    }
  }
  /** Conditional writes make crash recovery safe: an existing key must hold identical bytes. */
  async writeInput(
    workspaceId: string,
    key: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<InputObjectFacts> {
    this.owned(workspaceId, key);
    const frozen = Buffer.from(bytes);
    const facts = validateInputMedia(frozen, mediaType);
    if (!key.endsWith('.bin') && !key.endsWith(`.${inputMediaExtension(mediaType)}`))
      throw bad('Input media type does not match its key.');
    try {
      await inputDeadline(async (signal) => {
        await this.writeCreateOnly(key, frozen, mediaType, signal, facts.sha256);
        signal.throwIfAborted();
      });
    } catch (error) {
      if (!precondition(error)) throw error;
      const existing = await this.readInput(workspaceId, key);
      if (
        existing.sha256 !== facts.sha256 ||
        existing.mediaType !== facts.mediaType ||
        existing.size !== facts.size
      )
        throw Object.assign(new Error('Immutable input already contains different bytes.'), {
          statusCode: 409,
        });
      return existing;
    }
    return { bytes: frozen, storageKey: key, ...facts };
  }
  async inspectUpload(workspaceId: string, key: string) {
    const { storageKey, mediaType } = await this.readInput(workspaceId, key);
    return { storageKey, mediaType };
  }
  async completeUpload(workspaceId: string, key: string) {
    const asset = await this.inspectUpload(workspaceId, key);
    return this.sign(asset.storageKey, asset.mediaType);
  }
  async removeUpload(workspaceId: string, key: string) {
    this.owned(workspaceId, key);
    try {
      await inputDeadline((signal) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: signal,
        }),
      );
    } catch (error) {
      if (!this.googleXml || (error as { name?: string })?.name !== 'NoSuchKey') throw error;
    }
  }
  async initiateMultipart(
    workspaceId: string,
    mediaType: string,
    size: number,
  ): Promise<MultipartInputSession> {
    validateMediaSize(mediaType, size);
    const key = createInputKey(workspaceId, mediaType);
    const response = await inputDeadline((signal) =>
      this.client.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: mediaType }),
        { abortSignal: signal },
      ),
    );
    if (!response.UploadId) throw new Error('Storage did not issue a multipart upload ID.');
    return {
      key,
      uploadId: response.UploadId,
      mediaType,
      size,
      partSize: multipartPartSize,
      partCount: Math.ceil(size / multipartPartSize),
    };
  }
  private multipart(workspaceId: string, session: MultipartInputSession) {
    this.owned(workspaceId, session.key);
    validateMediaSize(session.mediaType, session.size);
    if (
      !session.key.endsWith(`.${inputMediaExtension(session.mediaType)}`) ||
      !session.uploadId ||
      session.uploadId.length > 2048 ||
      session.partSize !== multipartPartSize ||
      session.partCount !== Math.ceil(session.size / multipartPartSize)
    )
      throw bad('Invalid multipart session.');
  }
  private partLength(session: MultipartInputSession, partNumber: number) {
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > session.partCount)
      throw bad('Invalid multipart part number.');
    return partNumber === session.partCount
      ? session.size - (partNumber - 1) * session.partSize
      : session.partSize;
  }
  async signUploadPart(workspaceId: string, session: MultipartInputSession, partNumber: number) {
    this.multipart(workspaceId, session);
    const size = this.partLength(session, partNumber);
    return {
      partNumber,
      size,
      uploadUrl: await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: session.key,
          UploadId: session.uploadId,
          PartNumber: partNumber,
          ContentLength: size,
        }),
        { expiresIn: 600 },
      ),
      headers: {} as Record<string, string>,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }
  async resumeMultipart(
    workspaceId: string,
    session: MultipartInputSession,
  ): Promise<UploadedInputPart[]> {
    this.multipart(workspaceId, session);
    const parts: UploadedInputPart[] = [];
    let marker: string | undefined;
    do {
      const response = await inputDeadline((signal) =>
        this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: session.key,
            UploadId: session.uploadId,
            MaxParts: 20,
            PartNumberMarker: marker,
          }),
          { abortSignal: signal },
        ),
      );
      for (const part of response.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          !part.ETag ||
          part.Size === undefined ||
          part.Size !== this.partLength(session, part.PartNumber) ||
          parts.some((value) => value.partNumber === part.PartNumber)
        )
          throw bad('Uploaded multipart parts do not match the declared input.');
        parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size });
      }
      if (
        parts.length > session.partCount ||
        (response.IsTruncated &&
          (!response.NextPartNumberMarker || response.NextPartNumberMarker === marker))
      )
        throw bad('Invalid multipart part listing.');
      marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }
  async completeMultipart(
    workspaceId: string,
    session: MultipartInputSession,
    requestedParts: { partNumber: number; etag: string }[],
  ): Promise<InputObjectFacts> {
    this.multipart(workspaceId, session);
    const complete = await this.readInputIfExists(workspaceId, session.key);
    if (complete) return this.completedMultipart(session, complete);
    const parts = await this.resumeMultipart(workspaceId, session);
    if (
      parts.length !== session.partCount ||
      requestedParts.length !== parts.length ||
      parts.some(
        (part, index) =>
          part.partNumber !== index + 1 ||
          requestedParts[index]?.partNumber !== part.partNumber ||
          requestedParts[index]?.etag !== part.etag,
      )
    )
      throw bad('All multipart parts must be supplied once in their original order.');
    try {
      await inputDeadline((signal) =>
        this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: session.key,
            UploadId: session.uploadId,
            // GCS XML cannot condition this operation. The session targets staging only.
            IfNoneMatch: this.googleXml ? undefined : '*',
            MultipartUpload: {
              Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
            },
          }),
          { abortSignal: signal },
        ),
      );
    } catch (error) {
      // Another completion may already have succeeded, including a lost success response.
      const existing = await this.readInputIfExists(workspaceId, session.key);
      if (existing) return this.completedMultipart(session, existing);
      throw error;
    }
    return this.completedMultipart(session, await this.readInput(workspaceId, session.key));
  }
  private completedMultipart(session: MultipartInputSession, facts: InputObjectFacts) {
    if (facts.size !== session.size || facts.mediaType !== session.mediaType)
      throw bad('Completed multipart input does not match the declared file.');
    return facts;
  }
  async abortMultipart(workspaceId: string, session: MultipartInputSession): Promise<void> {
    this.multipart(workspaceId, session);
    try {
      await inputDeadline((signal) =>
        this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: session.key,
            UploadId: session.uploadId,
          }),
          { abortSignal: signal },
        ),
      );
    } catch (error) {
      if ((error as { name?: string })?.name !== 'NoSuchUpload' && !missing(error)) throw error;
    }
  }
}
