import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Job } from '@media-router/contracts';
import type { AssetStore } from '@media-router/engine';
import {
  compatibilityImageLimitBytes,
  imageBase64,
  ownedVideoContent,
  parseVideoRange,
} from '../apps/server/src/compatibility-media';

const id = '0171cd13-c992-4ac0-87d2-4f59092bca9d';
const key = `outputs/${id}/0171cd13-c992-4ac0-87d2-4f59092bca9e.mp4`;
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const job = (mediaType = 'video/mp4'): Job => ({
  id,
  workspaceId: 'owner',
  status: 'succeeded',
  deliveryStatus: 'available',
  input: {
    modelId: 'bytedance/seedance-2.5',
    operation: 'text-to-video',
    input: { prompt: 'Fixture.' },
  },
  routeId: 'fixture',
  deploymentId: 'fixture',
  upstreamId: null,
  outputs: [
    {
      storageKey: mediaType === 'video/mp4' ? key : key.replace('.mp4', '.png'),
      url: 'https://untrusted.invalid/never-fetch',
      mediaType,
      fidelity: 'unverified',
    },
  ],
  error: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
  reservedMicros: 1,
  settledMicros: 1,
  attemptCount: 1,
});
function storage(send: ReturnType<typeof vi.fn>) {
  return { bucket: 'private-fixture', client: { send } } as unknown as AssetStore;
}

describe('owned image base64 bounds', () => {
  it('encodes only validated owned image bytes, never the projected URL', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Body: Readable.from([png]), ContentLength: png.length });
    expect(await imageBase64(job('image/png'), storage(send))).toEqual({
      b64_json: png.toString('base64'),
    });
    expect(send.mock.calls[0]![0].input).toEqual({
      Bucket: 'private-fixture',
      Key: key.replace('.mp4', '.png'),
    });
  });
  it.each(['failed', 'partial', 'unverified', undefined])(
    'rejects %s delivery before reading bytes',
    async (deliveryStatus) => {
      const send = vi.fn();
      const value = { ...job('image/png'), deliveryStatus } as Job;
      await expect(imageBase64(value, storage(send))).rejects.toMatchObject({
        code: 'output_unavailable',
      });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('rejects foreign keys and storage-free provider outputs before any read', async () => {
    const send = vi.fn();
    for (const storageKey of [undefined, key.replace(id, 'foreign'), 'inputs/owner/a.png']) {
      const value = job('image/png');
      value.outputs[0]!.storageKey = storageKey;
      await expect(imageBase64(value, storage(send))).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects declared oversized output before collecting the body', async () => {
    const destroy = vi.fn();
    const send = vi
      .fn()
      .mockResolvedValue({ Body: { destroy }, ContentLength: compatibilityImageLimitBytes + 1 });
    await expect(imageBase64(job('image/png'), storage(send))).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('bounds an undeclared stream and destroys it on overflow', async () => {
    const stream = Readable.from([Buffer.alloc(compatibilityImageLimitBytes), Buffer.from([1])]);
    const send = vi.fn().mockResolvedValue({ Body: stream });
    await expect(imageBase64(job('image/png'), storage(send))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(stream.destroyed).toBe(true);
  });
  it('rejects a media signature mismatch and short content', async () => {
    for (const object of [
      { Body: Readable.from([mp4]), ContentLength: mp4.length },
      { Body: Readable.from([png]), ContentLength: png.length + 1 },
    ]) {
      await expect(
        imageBase64(job('image/png'), storage(vi.fn().mockResolvedValue(object))),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
  });
});

describe('single video byte ranges', () => {
  it.each([
    ['bytes=0-3', { start: 0, end: 3 }],
    ['bytes=2-', { start: 2, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=-100', { start: 0, end: 9 }],
    ['bytes=0-100', { start: 0, end: 9 }],
    [undefined, null],
  ])('parses %s', (range, expected) => expect(parseVideoRange(range, 10)).toEqual(expected));
  it.each([
    'bytes=10-',
    'bytes=8-7',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,4-5',
    'items=0-2',
    'bytes=9007199254740993-',
    'bytes= 0-1',
  ])('rejects %s with complete unsatisfied Content-Range', (range) => {
    expect(() => parseVideoRange(range, 10)).toThrow(
      expect.objectContaining({ statusCode: 416, contentRange: 'bytes */10' }),
    );
  });
  it('retrieves exactly the selected bytes with ETag consistency', async () => {
    const bytes = mp4.subarray(2, 6);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ContentLength: mp4.length,
        ContentType: 'video/mp4',
        ETag: 'fixture-etag',
      })
      .mockResolvedValueOnce({
        Body: Readable.from([bytes]),
        ContentLength: 4,
        ContentRange: `bytes 2-5/${mp4.length}`,
      });
    const result = await ownedVideoContent(job(), 'bytes=2-5', storage(send));
    expect(result.statusCode).toBe(206);
    expect(result.bytes).toEqual(bytes);
    expect(result.headers['Content-Range']).toBe(`bytes 2-5/${mp4.length}`);
    expect(send.mock.calls[1]![0].input).toEqual({
      Bucket: 'private-fixture',
      Key: key,
      Range: 'bytes=2-5',
      IfMatch: 'fixture-etag',
    });
  });
  it.each(['"v1"', 'Wed, 04 Nov 2026 00:00:00 GMT'])(
    'honors matching If-Range %s',
    async (validator) => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({
          ContentLength: mp4.length,
          ContentType: 'video/mp4',
          ETag: '"v1"',
          LastModified: new Date('2026-11-04T00:00:00Z'),
        })
        .mockResolvedValueOnce({
          Body: Readable.from([mp4.subarray(0, 4)]),
          ContentLength: 4,
          ContentRange: `bytes 0-3/${mp4.length}`,
        });
      expect(
        (await ownedVideoContent(job(), 'bytes=0-3', storage(send), validator)).statusCode,
      ).toBe(206);
    },
  );
  it('returns 416 without downloading an unsatisfiable range', async () => {
    const send = vi.fn().mockResolvedValue({ ContentLength: mp4.length, ContentType: 'video/mp4' });
    await expect(ownedVideoContent(job(), 'bytes=1000-', storage(send))).rejects.toMatchObject({
      statusCode: 416,
      contentRange: `bytes */${mp4.length}`,
    });
    expect(send).toHaveBeenCalledOnce();
  });
  it('rejects storage that silently ignores Range', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ContentLength: mp4.length, ContentType: 'video/mp4' })
      .mockResolvedValueOnce({ Body: Readable.from([mp4]), ContentLength: mp4.length });
    await expect(ownedVideoContent(job(), 'bytes=0-3', storage(send))).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it('allows a complete validated video without a range', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ContentLength: mp4.length, ContentType: 'video/mp4' })
      .mockResolvedValueOnce({ Body: Readable.from([mp4]), ContentLength: mp4.length });
    const result = await ownedVideoContent(job(), undefined, storage(send));
    expect(result.statusCode).toBe(200);
    expect(result.headers['Accept-Ranges']).toBe('bytes');
    expect(result.bytes).toEqual(mp4);
  });
});
