import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { deliveryStorage } from '../packages/engine/src/delivery.js';
import { outputLimitBytes } from '../packages/engine/src/output.js';
import { AssetStore } from '../packages/engine/src/storage.js';

const key = 'outputs/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.png';
const original = Buffer.from('89504e470d0a1a0a00000000', 'hex');
function adapter(send: (...args: unknown[]) => Promise<unknown>) {
  const storage = new AssetStore('private-fixture');
  vi.spyOn(storage.client, 'send').mockImplementation(send as never);
  return deliveryStorage(storage);
}

describe('private delivery storage boundary', () => {
  it('uses the fixed bucket/key and bounded GET/PUT abort signals without replacing retained bytes', async () => {
    const objects = new Map<string, Buffer>();
    const send = vi.fn(async (command: unknown, options: unknown) => {
      expect(options).toMatchObject({ abortSignal: expect.any(AbortSignal) });
      if (command instanceof GetObjectCommand) {
        expect(command.input).toEqual({ Bucket: 'private-fixture', Key: key });
        const bytes = objects.get(command.input.Key!);
        if (!bytes) throw { name: 'NoSuchKey', message: 'private signed URL must not be exposed' };
        return { Body: Readable.from([bytes]), ContentLength: bytes.length };
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      const input = (command as PutObjectCommand).input;
      expect(input).toMatchObject({
        Bucket: 'private-fixture',
        Key: key,
        ContentType: 'image/png',
        IfNoneMatch: '*',
      });
      if (objects.has(input.Key!))
        throw { $metadata: { httpStatusCode: 412 }, message: 'existing object' };
      objects.set(input.Key!, Buffer.from(input.Body as Uint8Array));
      return {};
    });
    const storage = adapter(send);
    expect(await storage.read(key)).toBeNull();
    await storage.putIfAbsent(key, original, 'image/png');
    await storage.putIfAbsent(key, Buffer.from('replacement'), 'image/png');
    expect(await storage.read(key)).toEqual(original);
    expect(objects.size).toBe(1);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('uses a signed create-only GCS PUT and accepts a 412 without replacing the object', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic');
    const store = new AssetStore('private-fixture', { endpoint: 'https://storage.googleapis.com' });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 412 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const storage = deliveryStorage(store);
      await storage.putIfAbsent(key, original, 'image/png');
      await storage.putIfAbsent(key, Buffer.from('replacement'), 'image/png');
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const [urlArg, request] of fetch.mock.calls) {
        const url = new URL(String(urlArg));
        expect(url.pathname).toBe(`/private-fixture/${key}`);
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
          'cache-control;content-length;content-type;host;x-goog-if-generation-match',
        );
        expect(request?.headers).toMatchObject({
          'cache-control': 'private, no-store',
          'x-goog-if-generation-match': '0',
        });
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      store.client.destroy();
    }
  });

  it.each([{ name: 'NoSuchKey' }, { $metadata: { httpStatusCode: 404 } }])(
    'treats only object-not-found as a recoverable missing object',
    async (error) => {
      const storage = adapter(async () => {
        throw error;
      });
      expect(await storage.read(key)).toBeNull();
    },
  );

  it('rejects an oversized declared object before reading its body', async () => {
    const consumed = vi.fn();
    const storage = adapter(async () => ({
      ContentLength: outputLimitBytes + 1,
      Body: {
        async *[Symbol.asyncIterator]() {
          consumed();
          yield original;
        },
      },
    }));
    await expect(storage.read(key)).rejects.toThrow('Private output storage unavailable.');
    expect(consumed).not.toHaveBeenCalled();
  });

  it.each([{}, { Body: Readable.from([]), ContentLength: 0 }])(
    'rejects absent or empty retained bytes without exposing storage details',
    async (response) => {
      await expect(adapter(async () => response).read(key)).rejects.toThrow(
        'Private output storage unavailable.',
      );
    },
  );

  it.each([403, 409, 429, 500])(
    'redacts non-412 storage write failures (%s) and does not retry',
    async (status) => {
      const send = vi.fn(async () => {
        throw {
          $metadata: { httpStatusCode: status },
          message: 'https://private-storage.example/token?secret=fixture',
        };
      });
      const storage = adapter(send);
      await expect(storage.putIfAbsent(key, original, 'image/png')).rejects.toThrow(
        'Private output storage unavailable.',
      );
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it('redacts object-read failures and rejects them instead of confusing them with absence', async () => {
    const send = vi.fn(async () => {
      throw new Error('https://private-storage.example/token?secret=fixture');
    });
    await expect(adapter(send).read(key)).rejects.toThrow('Private output storage unavailable.');
    expect(send).toHaveBeenCalledOnce();
  });
});
