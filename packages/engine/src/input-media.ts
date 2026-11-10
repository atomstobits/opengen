import { createHash, randomUUID } from 'node:crypto';

/** Storage acceptance is deliberately independent of any model's media capabilities. */
export const maxInputBytes = 100 * 1024 * 1024;
const extensions = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/flac', 'flac'],
  ['audio/mp4', 'm4a'],
  ['audio/webm', 'weba'],
]);
export function inputMediaExtension(mediaType: string): string | undefined {
  return extensions.get(mediaType);
}
/** Omit mediaType only for server-managed imports whose type has not yet been inspected. */
export function createInputKey(workspaceId: string, mediaType?: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId))
    throw Object.assign(new Error('Asset not found.'), { statusCode: 404 });
  const extension = mediaType === undefined ? 'bin' : inputMediaExtension(mediaType);
  if (!extension) throw invalid('Unsupported input media type.');
  return `inputs/${workspaceId}/${randomUUID()}.${extension}`;
}
function invalid(message = 'Input bytes do not match a supported media container.') {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function ascii(bytes: Buffer, start: number, length: number) {
  return bytes.toString('ascii', start, start + length);
}

// These are bounded container checks, not a decoder, malware scanner, or track-quality claim.
function png(bytes: Buffer): boolean {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return false;
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (offset + 12 + size > bytes.length) return false;
    const type = ascii(bytes, offset + 4, 4);
    if (
      offset === 8 &&
      (type !== 'IHDR' ||
        size !== 13 ||
        !bytes.readUInt32BE(offset + 8) ||
        !bytes.readUInt32BE(offset + 12))
    )
      return false;
    if (type === 'IDAT') imageData = true;
    if (type === 'IEND') return size === 0 && imageData && offset + 12 === bytes.length;
    offset += size + 12;
  }
  return false;
}
function jpeg(bytes: Buffer): boolean {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  )
    return false;
  let offset = 2;
  let frame = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || offset + 2 > bytes.length) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (size < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5))
        return false;
      frame = true;
    }
    if (marker === 0xda) return frame && offset + size < bytes.length - 2;
    offset += size;
  }
  return false;
}
function riff(bytes: Buffer, kind: 'WEBP' | 'WAVE'): boolean {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== kind ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false;
  let offset = 12;
  let format = false;
  let data = false;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) return false;
    const type = ascii(bytes, offset, 4);
    if (
      kind === 'WEBP' &&
      ((type === 'VP8 ' &&
        size >= 10 &&
        bytes.subarray(offset + 11, offset + 14).equals(Buffer.from([0x9d, 0x01, 0x2a]))) ||
        (type === 'VP8L' && size >= 5 && bytes[offset + 8] === 0x2f))
    )
      data = true;
    if (kind === 'WAVE' && type === 'fmt ' && size >= 16) {
      format =
        bytes.readUInt16LE(offset + 10) > 0 &&
        bytes.readUInt32LE(offset + 12) > 0 &&
        bytes.readUInt16LE(offset + 20) > 0;
    }
    if (kind === 'WAVE' && type === 'data' && size > 0) data = true;
    offset += 8 + size + (size % 2);
  }
  return offset === bytes.length && data && (kind === 'WEBP' || format);
}
function mp4(bytes: Buffer): string | null {
  let ftyp = false;
  let data = false;
  const tracks = new Set<string>();
  let boxes = 0;
  function walk(start: number, end: number, depth: number): boolean {
    let offset = start;
    while (offset < end) {
      if (++boxes > 100_000 || offset + 8 > end) return false;
      let size = bytes.readUInt32BE(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return false;
        const extended = bytes.readBigUInt64BE(offset + 8);
        if (extended > BigInt(maxInputBytes)) return false;
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) return false;
      const type = ascii(bytes, offset + 4, 4);
      if (depth === 0 && offset === 0 && type === 'ftyp' && size >= header + 8) ftyp = true;
      if (depth === 0 && type === 'mdat' && size > header) data = true;
      if (type === 'hdlr' && depth === 3 && size >= header + 12)
        tracks.add(ascii(bytes, offset + header + 8, 4));
      if (['moov', 'trak', 'mdia'].includes(type)) {
        if (depth >= 3 || !walk(offset + header, offset + size, depth + 1)) return false;
      }
      offset += size;
    }
    return offset === end;
  }
  if (!walk(0, bytes.length, 0) || !ftyp || !data) return null;
  return tracks.has('vide') ? 'video/mp4' : tracks.has('soun') ? 'audio/mp4' : null;
}
function webm(bytes: Buffer): string | null {
  // EBML lengths use bounded vints; reject unknown-length metadata, allow streaming Segment/Cluster.
  function vint(
    offset: number,
    id: boolean,
  ): { value: number; length: number; unknown: boolean } | null {
    const first = bytes[offset];
    if (!first) return null;
    let length = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      length++;
      mask >>= 1;
    }
    if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
    let value = BigInt(id ? first : first & (mask - 1));
    for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]!);
    const unknown = !id && value === (1n << BigInt(7 * length)) - 1n;
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { value: unknown ? 0 : Number(value), length, unknown };
  }
  const tracks = new Set<number>();
  let docType = false;
  let cluster = false;
  let count = 0;
  function walk(start: number, end: number, depth: number): boolean {
    let offset = start;
    while (offset < end) {
      if (++count > 100_000) return false;
      const id = vint(offset, true);
      if (!id) return false;
      const size = vint(offset + id.length, false);
      if (!size) return false;
      const content = offset + id.length + size.length;
      const next = size.unknown ? end : content + size.value;
      if (next > end || (size.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675))
        return false;
      if (id.value === 0x4282 && depth === 1 && ascii(bytes, content, next - content) === 'webm')
        docType = true;
      if (id.value === 0x83 && depth === 3 && next - content === 1) tracks.add(bytes[content]!);
      if (id.value === 0x1f43b675 && depth === 1 && next > content) cluster = true;
      if ([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae].includes(id.value)) {
        if (depth >= 4 || !walk(content, next, depth + 1)) return false;
      }
      offset = next;
    }
    return offset === end;
  }
  if (
    bytes.length < 16 ||
    bytes.readUInt32BE(0) !== 0x1a45dfa3 ||
    !walk(0, bytes.length, 0) ||
    !docType ||
    !cluster
  )
    return null;
  return tracks.has(1) ? 'video/webm' : tracks.has(2) ? 'audio/webm' : null;
}
function mpeg(bytes: Buffer): boolean {
  let offset = 0;
  if (ascii(bytes, 0, 3) === 'ID3') {
    if (
      bytes.length < 10 ||
      [bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => value === undefined || value > 127)
    )
      return false;
    offset = 10 + (bytes[6]! << 21) + (bytes[7]! << 14) + (bytes[8]! << 7) + bytes[9]!;
    if (bytes[5]! & 0x10) offset += 10;
  }
  if (offset + 4 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1]! & 0xe0) !== 0xe0)
    return false;
  const version = (bytes[offset + 1]! >> 3) & 3;
  const layer = (bytes[offset + 1]! >> 1) & 3;
  const rate = (bytes[offset + 2]! >> 2) & 3;
  const bitrateIndex = bytes[offset + 2]! >> 4;
  if (version === 1 || layer !== 1 || rate === 3 || bitrateIndex === 0 || bitrateIndex === 15)
    return false;
  const bitrates =
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = [44100, 48000, 32000][rate]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameSize =
    Math.floor(((version === 3 ? 144_000 : 72_000) * bitrates[bitrateIndex]!) / sampleRate) +
    ((bytes[offset + 2]! >> 1) & 1);
  return frameSize >= 4 && offset + frameSize <= bytes.length;
}
function ogg(bytes: Buffer): boolean {
  let offset = 0;
  let audio = false;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || ascii(bytes, offset, 4) !== 'OggS' || bytes[offset + 4] !== 0)
      return false;
    const segments = bytes[offset + 26]!;
    if (offset + 27 + segments > bytes.length) return false;
    let payloadLength = 0;
    for (let i = 0; i < segments; i++) payloadLength += bytes[offset + 27 + i]!;
    const content = offset + 27 + segments;
    if (content + payloadLength > bytes.length) return false;
    if (offset === 0)
      audio =
        ascii(bytes, content, 8) === 'OpusHead' ||
        (bytes[content] === 1 && ascii(bytes, content + 1, 6) === 'vorbis');
    offset = content + payloadLength;
  }
  return audio;
}
function flac(bytes: Buffer): boolean {
  if (bytes.length < 43 || ascii(bytes, 0, 4) !== 'fLaC') return false;
  let offset = 4;
  let first = true;
  while (offset + 4 <= bytes.length) {
    const type = bytes[offset]!;
    const size = bytes.readUIntBE(offset + 1, 3);
    if (first && ((type & 0x7f) !== 0 || size !== 34)) return false;
    first = false;
    offset += 4 + size;
    if (offset >= bytes.length) return false;
    if (type & 0x80) return bytes[offset] === 255 && (bytes[offset + 1]! & 0xfc) === 0xf8;
  }
  return false;
}
export function detectInputMediaType(value: Uint8Array): string | null {
  if (!value.byteLength || value.byteLength > maxInputBytes) return null;
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (png(bytes)) return 'image/png';
  if (jpeg(bytes)) return 'image/jpeg';
  if (riff(bytes, 'WEBP')) return 'image/webp';
  if (riff(bytes, 'WAVE')) return 'audio/wav';
  if (mpeg(bytes)) return 'audio/mpeg';
  if (ogg(bytes)) return 'audio/ogg';
  if (flac(bytes)) return 'audio/flac';
  return mp4(bytes) ?? webm(bytes);
}
export function inspectInputBytes(
  bytes: Uint8Array,
  declaredType?: string,
): { mediaType: string; byteLength: number; sha256: string } {
  if (!bytes.byteLength || bytes.byteLength > maxInputBytes)
    throw invalid('Input must contain 1 byte to 100 MiB.');
  const mediaType = detectInputMediaType(bytes);
  if (!mediaType || (declaredType !== undefined && declaredType !== mediaType)) throw invalid();
  return {
    mediaType,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
export function validateInputMedia(bytes: Uint8Array, mediaType: string) {
  const facts = inspectInputBytes(bytes, mediaType);
  return { mediaType: facts.mediaType, size: facts.byteLength, sha256: facts.sha256 };
}
