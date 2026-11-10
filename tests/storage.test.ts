import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  AssetStore,
  createInputKey,
  type MultipartInputSession,
} from '../packages/engine/src/storage.js';
import {
  detectInputMediaType,
  inspectInputBytes,
  maxInputBytes,
  validateInputMedia,
} from '../packages/engine/src/input-media.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
function wav(dataLength = 4) {
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}
function box(type: string, body: Buffer) {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.writeUInt32BE(bytes.length);
  bytes.write(type, 4);
  body.copy(bytes, 8);
  return bytes;
}
function mp4(track: 'vide' | 'soun') {
  const hdlr = Buffer.alloc(12);
  hdlr.write(track, 8);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0')),
    box('moov', box('trak', box('mdia', box('hdlr', hdlr)))),
    box('mdat', Buffer.from([1, 2, 3])),
  ]);
}
function ebml(id: number[], body: Buffer) {
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
}
function webm(track: number) {
  return Buffer.concat([
    ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], Buffer.from('webm'))),
    ebml(
      [0x18, 0x53, 0x80, 0x67],
      Buffer.concat([
        ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], ebml([0x83], Buffer.from([track])))),
        ebml([0x1f, 0x43, 0xb6, 0x75], Buffer.from([0, 0])),
      ]),
    ),
  ]);
}
function object(bytes: Buffer, mediaType: string) {
  return { ContentLength: bytes.length, ContentType: mediaType, Body: Readable.from([bytes]) };
}
const noObject = () => Object.assign(new Error('missing'), { name: 'NoSuchKey' });
const googleEndpoint = 'https://storage.googleapis.com';
function fixtureStore(endpoint?: string) {
  return new AssetStore('fixture-bucket', { region: 'us-east-1', endpoint });
}

beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('owned input container validation', () => {
  it('recognizes audio and video containers separately without claiming decoding', () => {
    expect(detectInputMediaType(png)).toBe('image/png');
    expect(inspectInputBytes(wav(), 'audio/wav')).toMatchObject({
      mediaType: 'audio/wav',
      byteLength: 48,
    });
    expect(detectInputMediaType(mp4('vide'))).toBe('video/mp4');
    expect(detectInputMediaType(mp4('soun'))).toBe('audio/mp4');
    expect(detectInputMediaType(webm(1))).toBe('video/webm');
    expect(detectInputMediaType(webm(2))).toBe('audio/webm');
    expect(() => validateInputMedia(webm(1), 'audio/webm')).toThrow(/container/);
    expect(() => validateInputMedia(mp4('vide'), 'audio/mp4')).toThrow(/container/);
  });
  it('rejects truncation, deceptive MIME, empty data and unsupported active content', () => {
    for (const bytes of [
      Buffer.alloc(0),
      png.subarray(0, 8),
      wav().subarray(0, 44),
      mp4('vide').subarray(0, -1),
      webm(1).subarray(0, -1),
      Buffer.from('<svg onload="alert(1)">'),
    ]) {
      expect(() => inspectInputBytes(bytes)).toThrow();
    }
    expect(() => inspectInputBytes(png, 'audio/wav')).toThrow(/container/);
    expect(() => inspectInputBytes(png, 'image/svg+xml')).toThrow(/container/);
    const wave = wav();
    wave.writeUInt32LE(0xffffffff, 40);
    expect(detectInputMediaType(wave)).toBeNull();
  });
  it('accepts bounded MPEG, Ogg and FLAC signatures and rejects truncated frame/header claims', () => {
    const mpeg = Buffer.alloc(417);
    mpeg.set([0xff, 0xfb, 0x90, 0x64]);
    expect(detectInputMediaType(mpeg)).toBe('audio/mpeg');
    expect(detectInputMediaType(mpeg.subarray(0, 4))).toBeNull();
    const opus = Buffer.alloc(47);
    opus.write('OggS');
    opus[26] = 1;
    opus[27] = 19;
    opus.write('OpusHead', 28);
    expect(detectInputMediaType(opus)).toBe('audio/ogg');
    expect(detectInputMediaType(opus.subarray(0, -1))).toBeNull();
    const flac = Buffer.alloc(48);
    flac.write('fLaC');
    flac[4] = 0x80;
    flac.writeUIntBE(34, 5, 3);
    flac[42] = 0xff;
    flac[43] = 0xf8;
    expect(detectInputMediaType(flac)).toBe('audio/flac');
    expect(detectInputMediaType(flac.subarray(0, 42))).toBeNull();
    expect(() =>
      detectInputMediaType(
        Buffer.from([
          0xff, 0xd8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xda, 0xff, 0xd9,
        ]),
      ),
    ).not.toThrow();
  });
  it('hashes exact bytes and supports server-managed import keys before MIME is known', () => {
    expect(inspectInputBytes(png).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(createInputKey('workspace-a')).toMatch(/^inputs\/workspace-a\/[a-f0-9-]+\.bin$/);
    expect(createInputKey('workspace-a', 'audio/webm')).toMatch(/\.weba$/);
    expect(() => createInputKey('../foreign', 'image/png')).toThrow(/not found/);
  });
});

describe('private immutable S3 inputs', () => {
  it('presigns declared length and immutable writes without an empty-body checksum', async () => {
    const store = fixtureStore();
    try {
      const upload = await store.prepareUpload('workspace-a', 'image/png', 1024);
      const url = new URL(upload.uploadUrl);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('if-none-match');
      expect(upload.headers).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' });
      expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
      expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
      await expect(store.completeUpload('workspace-b', upload.key)).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      store.client.destroy();
    }
  });
  it('signs the GCS generation condition on both browser and frozen-object PUTs', async () => {
    const store = fixtureStore(googleEndpoint);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetch);
    try {
      const upload = await store.prepareUpload('workspace-a', 'image/png', png.length);
      const url = new URL(upload.uploadUrl);
      expect(url.origin).toBe(googleEndpoint);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host;x-goog-if-generation-match',
      );
      expect(url.searchParams.has('x-goog-if-generation-match')).toBe(false);
      expect(upload.headers).toEqual({
        'Content-Type': 'image/png',
        'x-goog-if-generation-match': '0',
      });

      await store.writeInput('workspace-a', createInputKey('workspace-a'), png, 'image/png');
      expect(fetch).toHaveBeenCalledOnce();
      const [urlArg, request] = fetch.mock.calls[0]!;
      const writeUrl = new URL(String(urlArg));
      expect(writeUrl.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'cache-control;content-length;content-type;host;x-goog-if-generation-match;x-goog-meta-sha256',
      );
      expect(writeUrl.searchParams.has('x-goog-meta-sha256')).toBe(false);
      expect(request).toMatchObject({
        method: 'PUT',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        body: Uint8Array.from(png),
      });
      expect(request?.headers).toEqual({
        'x-goog-if-generation-match': '0',
        'cache-control': 'private, no-store',
        'content-length': String(png.length),
        'content-type': 'image/png',
        'x-goog-meta-sha256': inspectInputBytes(png).sha256,
      });
    } finally {
      store.client.destroy();
    }
  });
  it.each([
    `${googleEndpoint}.example`,
    `${googleEndpoint}/proxy`,
    'http://storage.googleapis.com',
  ])('keeps S3 preconditions on a different endpoint (%s)', async (endpoint) => {
    const store = fixtureStore(endpoint);
    try {
      const upload = await store.prepareUpload('workspace-a', 'image/png', png.length);
      expect(upload.headers).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' });
    } finally {
      store.client.destroy();
    }
  });
  it('treats only an explicit missing GCS object as an idempotent cleanup', async () => {
    const store = fixtureStore(googleEndpoint);
    const key = createInputKey('workspace-a');
    const send = vi.spyOn(store.client, 'send');
    try {
      send.mockRejectedValueOnce(noObject());
      await expect(store.removeUpload('workspace-a', key)).resolves.toBeUndefined();
      for (const error of [
        { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
        { $metadata: { httpStatusCode: 404 } },
        { name: 'Forbidden', $metadata: { httpStatusCode: 403 } },
      ]) {
        send.mockRejectedValueOnce(error);
        await expect(store.removeUpload('workspace-a', key)).rejects.toBe(error);
      }
    } finally {
      store.client.destroy();
    }
  });
  it('accepts owned audio/WebM and rejects foreign or output keys before any storage access', async () => {
    const store = fixtureStore();
    const send = vi
      .spyOn(store.client, 'send')
      .mockImplementation(async () => object(webm(2), 'audio/webm') as never);
    try {
      const key = createInputKey('workspace-a', 'audio/webm');
      await expect(store.inspectUpload('workspace-a', key)).resolves.toEqual({
        storageKey: key,
        mediaType: 'audio/webm',
      });
      expect(send).toHaveBeenCalledTimes(1);
      await expect(store.readInput('workspace-b', key)).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        store.readInput('workspace-a', 'outputs/job/aaaaaaaa.png'),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        store.readOwnedOutput('other', 'outputs/job/aaaaaaaa.png'),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      store.client.destroy();
    }
  });
  it('validates actual object bytes and length instead of trusting uploaded metadata', async () => {
    const store = fixtureStore();
    const send = vi.spyOn(store.client, 'send');
    const key = createInputKey('workspace-a', 'image/png');
    try {
      send.mockResolvedValueOnce(object(Buffer.from('<svg/>'), 'image/png') as never);
      await expect(store.readInput('workspace-a', key)).rejects.toMatchObject({ statusCode: 400 });
      send.mockResolvedValueOnce({
        ...object(png, 'image/png'),
        ContentLength: png.length + 1,
      } as never);
      await expect(store.readInput('workspace-a', key)).rejects.toThrow(/length/);
      const destroy = vi.fn();
      send.mockResolvedValueOnce({
        ContentLength: maxInputBytes + 1,
        ContentType: 'image/png',
        Body: { destroy },
      } as never);
      await expect(store.readInput('workspace-a', key)).rejects.toThrow(/size/);
      expect(destroy).toHaveBeenCalledOnce();
      send.mockRejectedValueOnce(noObject());
      await expect(store.readInputIfExists('workspace-a', key)).resolves.toBeNull();
      send.mockRejectedValueOnce(
        Object.assign(new Error('storage down'), { name: 'ServiceUnavailable' }),
      );
      await expect(store.readInputIfExists('workspace-a', key)).rejects.toThrow(/storage down/);
    } finally {
      store.client.destroy();
    }
  });
  it('recovers identical conditional writes but never overwrites different bytes', async () => {
    const store = fixtureStore();
    const bytes = wav();
    const key = createInputKey('workspace-a');
    let saved: Buffer | undefined;
    const send = vi.spyOn(store.client, 'send').mockImplementation(async (command: any) => {
      if (command instanceof PutObjectCommand) {
        expect(command.input.IfNoneMatch).toBe('*');
        if (saved) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
        saved = Buffer.from(command.input.Body as Uint8Array);
        return {} as never;
      }
      if (command instanceof GetObjectCommand && saved) return object(saved, 'audio/wav') as never;
      throw new Error('unexpected command');
    });
    try {
      const first = await store.writeInput('workspace-a', key, bytes, 'audio/wav');
      expect(first.size).toBe(bytes.length);
      expect(first.sha256).toBe(inspectInputBytes(bytes).sha256);
      expect((await store.writeInput('workspace-a', key, bytes, 'audio/wav')).sha256).toBe(
        first.sha256,
      );
      const changed = Buffer.from(bytes);
      changed[44] = 1;
      await expect(
        store.writeInput('workspace-a', key, changed, 'audio/wav'),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(saved).toEqual(bytes);
      expect(send).toHaveBeenCalledTimes(5);
    } finally {
      store.client.destroy();
    }
  });
  it('reads only a server-selected source job output for authorized reuse', async () => {
    const store = fixtureStore();
    vi.spyOn(store.client, 'send').mockResolvedValue(object(png, 'image/png') as never);
    try {
      const facts = await store.readOwnedOutput('job-a', 'outputs/job-a/aaaaaaaa.png');
      expect(facts.bytes).toEqual(png);
      expect(facts.sha256).toBe(inspectInputBytes(png).sha256);
      await expect(store.sign('inputs/workspace/key.png', 'image/png', 3601)).rejects.toMatchObject(
        { statusCode: 400 },
      );
    } finally {
      store.client.destroy();
    }
  });
});

describe('multipart input transport', () => {
  it.each([undefined, googleEndpoint])('resumes multipart input at %s', async (endpoint) => {
    const store = fixtureStore(endpoint);
    const bytes = wav(5 * 1024 * 1024 + 4);
    let saved = false;
    let completions = 0;
    const send = vi.spyOn(store.client, 'send').mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: 'session-a' } as never;
      if (command instanceof GetObjectCommand) {
        if (!saved) throw noObject();
        return object(bytes, 'audio/wav') as never;
      }
      if (command instanceof ListPartsCommand)
        return {
          Parts: [
            { PartNumber: 1, ETag: 'part-one', Size: 5 * 1024 * 1024 },
            { PartNumber: 2, ETag: 'part-two', Size: 48 },
          ],
        } as never;
      if (command instanceof CompleteMultipartUploadCommand) {
        completions++;
        expect(command.input.IfNoneMatch).toBe(endpoint === googleEndpoint ? undefined : '*');
        saved = true;
        return {} as never;
      }
      throw new Error('unexpected command');
    });
    try {
      const session = await store.initiateMultipart('workspace-a', 'audio/wav', bytes.length);
      expect(session).toMatchObject({ partCount: 2, partSize: 5 * 1024 * 1024 });
      const part = await store.signUploadPart('workspace-a', session, 2);
      expect(part.size).toBe(48);
      expect(new URL(part.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain(
        'content-length',
      );
      await expect(store.signUploadPart('workspace-a', session, 3)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(await store.resumeMultipart('workspace-a', session)).toHaveLength(2);
      const parts = [
        { partNumber: 1, etag: 'part-one' },
        { partNumber: 2, etag: 'part-two' },
      ];
      await expect(
        store.completeMultipart('workspace-a', session, [...parts].reverse()),
      ).rejects.toMatchObject({ statusCode: 400 });
      const complete = await store.completeMultipart('workspace-a', session, parts);
      expect(complete.sha256).toBe(inspectInputBytes(bytes).sha256);
      await expect(store.completeMultipart('workspace-a', session, parts)).resolves.toMatchObject({
        sha256: complete.sha256,
      });
      expect(completions).toBe(1);
      expect(send).toHaveBeenCalled();
    } finally {
      store.client.destroy();
    }
  });
  it('does not complete an incomplete upload and aborts idempotently without deleting completed objects', async () => {
    const store = fixtureStore();
    const bytes = wav();
    const session: MultipartInputSession = {
      key: createInputKey('workspace-a', 'audio/wav'),
      uploadId: 'session',
      size: bytes.length,
      mediaType: 'audio/wav',
      partSize: 5 * 1024 * 1024,
      partCount: 1,
    };
    const send = vi.spyOn(store.client, 'send').mockImplementation(async (command: any) => {
      if (command instanceof GetObjectCommand) throw noObject();
      if (command instanceof ListPartsCommand) return { Parts: [] } as never;
      if (command instanceof AbortMultipartUploadCommand)
        throw Object.assign(new Error('absent'), { name: 'NoSuchUpload' });
      throw new Error('unexpected command');
    });
    try {
      await expect(store.completeMultipart('workspace-a', session, [])).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(store.abortMultipart('workspace-a', session)).resolves.toBeUndefined();
      const calls = send.mock.calls.length;
      await expect(store.abortMultipart('workspace-b', session)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(send).toHaveBeenCalledTimes(calls);
      expect(
        send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand),
      ).toBe(false);
    } finally {
      store.client.destroy();
    }
  });
  it('recovers a lost completion response and rejects misleading final MIME', async () => {
    const store = fixtureStore();
    const bytes = wav();
    let saved = false;
    const session: MultipartInputSession = {
      key: createInputKey('workspace-a'),
      uploadId: 'session',
      size: bytes.length,
      mediaType: 'image/png',
      partSize: 5 * 1024 * 1024,
      partCount: 1,
    };
    vi.spyOn(store.client, 'send').mockImplementation(async (command: any) => {
      if (command instanceof GetObjectCommand) {
        if (!saved) throw noObject();
        return object(bytes, 'audio/wav') as never;
      }
      if (command instanceof ListPartsCommand)
        return { Parts: [{ PartNumber: 1, ETag: 'one', Size: bytes.length }] } as never;
      if (command instanceof CompleteMultipartUploadCommand) {
        saved = true;
        throw new Error('connection lost');
      }
      throw new Error('unexpected command');
    });
    try {
      // Multipart sessions require a concrete type-bound key, never the server-import namespace.
      await expect(
        store.completeMultipart('workspace-a', session, [{ partNumber: 1, etag: 'one' }]),
      ).rejects.toMatchObject({ statusCode: 400 });
      session.key = createInputKey('workspace-a', 'audio/wav');
      session.mediaType = 'audio/wav';
      await expect(
        store.completeMultipart('workspace-a', session, [{ partNumber: 1, etag: 'one' }]),
      ).resolves.toMatchObject({ size: bytes.length });
    } finally {
      store.client.destroy();
    }
  });
});

describe('bounded private storage work', () => {
  afterEach(() => vi.useRealTimers());

  it('aborts a stalled input GET before the lifecycle writer lease can expire', async () => {
    vi.useFakeTimers();
    const store = fixtureStore();
    let signal: AbortSignal | undefined;
    vi.spyOn(store.client, 'send').mockImplementation((_command: any, options: any) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    });
    try {
      const outcome = store
        .readInput('workspace-a', createInputKey('workspace-a'))
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError', statusCode: 503 });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.client.destroy();
    }
  });

  it('destroys a stalled response body and removes its abort listener', async () => {
    vi.useFakeTimers();
    const store = fixtureStore();
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, 'destroy');
    let removeListener: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(store.client, 'send').mockImplementation(async (_command: any, options: any) => {
      removeListener = vi.spyOn(options.abortSignal, 'removeEventListener');
      return { ContentLength: png.length, ContentType: 'image/png', Body: body } as never;
    });
    try {
      const outcome = store
        .readInput('workspace-a', createInputKey('workspace-a', 'image/png'))
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
      expect(body.destroyed).toBe(true);
      expect(destroy).toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.destroy();
      store.client.destroy();
    }
  });

  it('cleans deadlines and body listeners after a successful read', async () => {
    vi.useFakeTimers();
    const store = fixtureStore();
    let signal: AbortSignal | undefined;
    let removeListener: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(store.client, 'send').mockImplementation(async (_command: any, options: any) => {
      signal = options.abortSignal;
      removeListener = vi.spyOn(options.abortSignal, 'removeEventListener');
      return object(png, 'image/png') as never;
    });
    try {
      await expect(
        store.readInput('workspace-a', createInputKey('workspace-a', 'image/png')),
      ).resolves.toMatchObject({ size: png.length });
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(signal?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.client.destroy();
    }
  });

  it('aborts stalled immutable PUT and multipart requests without accepting readiness', async () => {
    vi.useFakeTimers();
    const store = fixtureStore();
    const signals: AbortSignal[] = [];
    vi.spyOn(store.client, 'send').mockImplementation((_command: any, options: any) => {
      signals.push(options.abortSignal);
      return new Promise(() => {});
    });
    try {
      const put = store
        .writeInput('workspace-a', createInputKey('workspace-a'), png, 'image/png')
        .catch((error) => error);
      const multipart = store
        .initiateMultipart('workspace-a', 'image/png', png.length)
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(put).resolves.toMatchObject({ name: 'TimeoutError' });
      await expect(multipart).resolves.toMatchObject({ name: 'TimeoutError' });
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.client.destroy();
    }
  });
});

it('binds private no-store response policy into each owned read capability', async () => {
  const store = fixtureStore();
  const signed = await store.sign(
    'outputs/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.png',
    'image/png',
  );
  expect(new URL(signed.url).searchParams.get('response-cache-control')).toBe('private, no-store');
});

it('refuses capabilities for missing or changed retained output facts', async () => {
  const store = fixtureStore();
  const key =
    'outputs/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.png';
  const send = vi
    .spyOn(store.client, 'send')
    .mockResolvedValue({ ContentLength: png.length, ContentType: 'image/png' } as never);
  await expect(
    store.assertOutputAvailable(
      '00000000-0000-4000-8000-000000000001',
      key,
      'image/png',
      png.length,
    ),
  ).resolves.toBeUndefined();
  send.mockRejectedValueOnce(noObject());
  await expect(
    store.assertOutputAvailable('00000000-0000-4000-8000-000000000001', key, 'image/png'),
  ).rejects.toThrow('Owned output is unavailable');
  send.mockResolvedValueOnce({ ContentLength: 0, ContentType: 'image/png' } as never);
  await expect(
    store.assertOutputAvailable('00000000-0000-4000-8000-000000000001', key, 'image/png'),
  ).rejects.toThrow('Owned output is unavailable');
});
