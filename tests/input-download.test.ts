import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: transport.request }));
import { readPublicInput } from '../packages/engine/src/input-download.js';
import { maxInputBytes } from '../packages/engine/src/input-media.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
function wave() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0);
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
  bytes.writeUInt32LE(2, 40);
  return bytes;
}
function webm(trackType: number) {
  const element = (id: number[], payload: Buffer) =>
    Buffer.concat([Buffer.from([...id, 0x80 + payload.length]), payload]);
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], Buffer.from('webm')));
  const track = element([0xae], element([0x83], Buffer.from([trackType])));
  const tracks = element([0x16, 0x54, 0xae, 0x6b], track);
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], element([0xa3], Buffer.from([0x81, 0, 0, 0])));
  return Buffer.concat([
    header,
    element([0x18, 0x53, 0x80, 0x67], Buffer.concat([tracks, cluster])),
  ]);
}
const publicDns = vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]);
const url = 'https://media.example.org/input.png?private-token=synthetic';

function reply(
  chunks: Buffer[] = [png],
  headers: Record<string, string> = { 'content-type': 'image/png' },
  statusCode = 200,
) {
  const response = Object.assign(Readable.from(chunks), { statusCode, headers });
  transport.request.mockImplementation((_url, _options, receive) => {
    const outgoing = new EventEmitter();
    return Object.assign(outgoing, {
      end: () => queueMicrotask(() => receive(response)),
    });
  });
  return response;
}

beforeEach(() => {
  transport.request.mockReset();
  publicDns.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('immutable public input download', () => {
  it('downloads exact bytes and hash using a pinned credential-free request', async () => {
    reply([png], {
      'content-type': 'image/png; charset=binary',
      'content-length': String(png.length),
    });
    const result = await readPublicInput(url, { resolve: publicDns });
    expect(result).toEqual({
      bytes: png,
      mediaType: 'image/png',
      byteLength: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    expect(publicDns).toHaveBeenCalledWith('media.example.org');
    const [calledUrl, options] = transport.request.mock.calls[0]!;
    expect(calledUrl.href).toBe(url);
    expect(options).toMatchObject({ method: 'GET', agent: false, family: 4 });
    expect(options.headers).toEqual({
      Accept: expect.stringContaining('audio/webm'),
      'Accept-Encoding': 'identity',
      'User-Agent': 'OpenGen-Inputs/0.1',
    });
    const lookupResult = vi.fn();
    options.lookup('media.example.org', {}, lookupResult);
    expect(lookupResult).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(options.signal.aborted).toBe(false);
  });

  it.each([
    ['audio/wav', wave()],
    ['audio/webm', webm(2)],
    ['video/webm', webm(1)],
  ])('imports owned-reference container %s without changing bytes', async (mediaType, bytes) => {
    reply([bytes], { 'content-type': mediaType });
    expect(await readPublicInput(url, { resolve: publicDns })).toEqual({
      bytes,
      mediaType,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('accepts absent/generic content type only when bytes have a supported signature', async () => {
    for (const headers of [{}, { 'content-type': 'application/octet-stream' }]) {
      reply([png], headers);
      expect(await readPublicInput(url, { resolve: publicDns })).toMatchObject({
        mediaType: 'image/png',
        byteLength: png.length,
      });
    }
    reply([Buffer.from('private text')], {});
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'invalid_input_media',
    });
  });

  it.each([
    'http://media.example.org/image',
    'https://user:password@media.example.org/image',
    'https://media.example.org:8443/image',
    'https://media.example.org/image#part',
    'https://127.0.0.1/image',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/image',
    'https://localhost/image',
    'https://service.internal/image',
    'invalid\nurl',
  ])(
    'rejects private or credential-bearing targets before any HTTP request: %s',
    async (target) => {
      await expect(readPublicInput(target, { resolve: publicDns })).rejects.toMatchObject({
        code: 'invalid_input_url',
        statusCode: 400,
      });
      expect(transport.request).not.toHaveBeenCalled();
    },
  );

  it('rejects mixed DNS answers and sanitizes resolver diagnostics', async () => {
    await expect(
      readPublicInput(url, {
        resolve: async () => [
          { address: '1.1.1.1', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input_url' });
    expect(transport.request).not.toHaveBeenCalled();
    await expect(
      readPublicInput(url, {
        resolve: async () => {
          throw new Error('private DNS account 123');
        },
      }),
    ).rejects.toThrow('Input media must resolve only to public HTTPS addresses.');
  });

  it('never follows redirects, including redirects to private targets', async () => {
    const response = reply([], { location: 'https://127.0.0.1/private' }, 302);
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'input_download_failed',
    });
    expect(response.destroyed).toBe(true);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(publicDns).toHaveBeenCalledTimes(1);
  });

  it('rejects declared oversize before reading, and streamed oversize without a declared length', async () => {
    const oversizedHeader = reply([png], { 'content-length': String(maxInputBytes + 1) });
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'input_too_large',
    });
    expect(oversizedHeader.destroyed).toBe(true);
    const oversizedStream = reply([png.subarray(0, 40), png.subarray(40)]);
    await expect(readPublicInput(url, { resolve: publicDns, maxBytes: 50 })).rejects.toMatchObject({
      code: 'input_too_large',
    });
    expect(oversizedStream.destroyed).toBe(true);
  });

  it.each(['Infinity', '-1', '1e3', '1.5', 'not-a-length'])(
    'rejects malformed byte length %s',
    async (length) => {
      reply([png], { 'content-length': length });
      await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
        code: 'input_download_incomplete',
      });
    },
  );

  it('rejects empty, truncated, wrong-type and compressed responses', async () => {
    reply([]);
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'invalid_input_media',
    });
    reply([png], { 'content-length': String(png.length + 1) });
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'input_download_incomplete',
    });
    reply([png], { 'content-type': 'image/jpeg' });
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'invalid_input_media',
    });
    reply([png], { 'content-type': 'text/html' });
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'invalid_input_media',
    });
    reply([png], { 'content-encoding': 'gzip' });
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toMatchObject({
      code: 'invalid_input_media',
    });
  });

  it.each([0, -1, 1.5, Infinity, maxInputBytes + 1])(
    'rejects invalid or expanded operator limit %s',
    async (maxBytes) => {
      await expect(readPublicInput(url, { resolve: publicDns, maxBytes })).rejects.toMatchObject({
        code: 'invalid_input_limit',
      });
      expect(transport.request).not.toHaveBeenCalled();
      expect(publicDns).not.toHaveBeenCalled();
    },
  );

  it('bounds network failures and does not echo signed URL or transport details', async () => {
    transport.request.mockImplementation(() => {
      const outgoing = new EventEmitter();
      return Object.assign(outgoing, {
        end: () =>
          queueMicrotask(() =>
            outgoing.emit('error', new Error(`failed ${url} secret diagnostic`)),
          ),
      });
    });
    await expect(readPublicInput(url, { resolve: publicDns })).rejects.toThrow(
      'Input media could not be downloaded.',
    );
  });

  it('passes a total request timeout and reports expiry without private request details', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    transport.request.mockImplementation((_url, options) => {
      const outgoing = new EventEmitter();
      options.signal.addEventListener(
        'abort',
        () => outgoing.emit('error', new Error('private timeout diagnostic')),
        { once: true },
      );
      return Object.assign(outgoing, { end: () => undefined });
    });
    const download = readPublicInput(url, { resolve: publicDns });
    const rejected = expect(download).rejects.toMatchObject({
      code: 'input_download_timeout',
      statusCode: 408,
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
  });
});
