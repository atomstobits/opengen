import { z } from 'zod';
import type { GenerateInput } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';

/** Broker transport limits; exact model/route limits can be lower. */
export const compatibilityEditMultipartLimit = 256 * 1024;
export const compatibilityEditMaximumReferences = 10;
const maximumMultipartParts = 24;
const ownedImage = z.object({ assetKey: z.string().min(1).max(300) }).strict();
const imageSize = z.enum(['1024x1024', '2048x2048', '4096x4096']);
const fields = {
  model: z.string().min(1).max(160),
  prompt: z.string().min(1).max(100_000),
  n: z.literal(1).optional(),
  response_format: z.enum(['url', 'b64_json']).default('url'),
  quality: z.string().min(1).max(30).optional(),
  output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
  background: z.enum(['auto', 'opaque', 'transparent']).optional(),
  billing: z.enum(['managed', 'byok']).optional(),
  route_id: z.string().min(1).max(200).optional(),
  max_cost_micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};

export const compatibilityImageGenerationSchema = z
  .object({ ...fields, size: imageSize.default('1024x1024') })
  .strict();
export const compatibilityImageEditSchema = z
  .object({
    ...fields,
    // Omission must preserve the canonical edit geometry; do not force a square crop.
    size: imageSize.optional(),
    image: z.union([
      ownedImage,
      z.array(ownedImage).min(1).max(compatibilityEditMaximumReferences),
    ]),
  })
  .strict();

export interface CompatibilityImageRequest {
  input: GenerateInput;
  responseFormat: 'url' | 'b64_json';
}
type CanonicalParser = (value: unknown) => GenerateInput;
type ImageBody = z.infer<typeof compatibilityImageGenerationSchema>;

function canonicalImage(
  body: Omit<ImageBody, 'size'> & { size?: ImageBody['size'] },
  operation: 'text-to-image' | 'image-edit',
  parseInput: CanonicalParser,
  images?: z.infer<typeof ownedImage>[],
): CompatibilityImageRequest {
  const resolution = {
    '1024x1024': '1K',
    '2048x2048': '2K',
    '4096x4096': '4K',
  } as const;
  return {
    responseFormat: body.response_format,
    input: parseInput({
      modelId: body.model,
      operation,
      input: {
        prompt: body.prompt,
        ...(body.size ? { resolution: resolution[body.size], aspectRatio: '1:1' } : {}),
        ...(body.n === undefined ? {} : { count: body.n }),
        ...(body.quality === undefined ? {} : { quality: body.quality }),
        ...(body.output_format === undefined ? {} : { outputFormat: body.output_format }),
        ...(body.background === undefined ? {} : { background: body.background }),
        ...(images ? { references: images.map((asset) => ({ type: 'image', asset })) } : {}),
      },
      ...(body.billing === undefined ? {} : { billing: body.billing }),
      ...(body.route_id === undefined ? {} : { routeId: body.route_id }),
      ...(body.max_cost_micros === undefined ? {} : { maxCostMicros: body.max_cost_micros }),
    }),
  };
}

export function parseCompatibilityImageGeneration(
  value: unknown,
  parseInput: CanonicalParser = parseGenerationRequest,
): CompatibilityImageRequest {
  return canonicalImage(
    compatibilityImageGenerationSchema.parse(value),
    'text-to-image',
    parseInput,
  );
}

export function parseCompatibilityImageEdit(
  value: unknown,
  parseInput: CanonicalParser = parseGenerationRequest,
): CompatibilityImageRequest {
  const body = compatibilityImageEditSchema.parse(value);
  return canonicalImage(
    body,
    'image-edit',
    parseInput,
    Array.isArray(body.image) ? body.image : [body.image],
  );
}

function multipartError(message: string, statusCode = 400) {
  return Object.assign(new Error(message), {
    statusCode,
    code: 'invalid_compatibility_multipart',
  });
}

/**
 * Selected multipart compatibility: text fields and ordered JSON owned references.
 * Raw binary parts require the durable C2 preparation/ownership path and are rejected.
 * Buffering is bounded before MIME decoding; this never fetches URLs or stores files.
 */
export async function parseCompatibilityEditMultipart(
  body: Buffer,
  contentType: string,
  parseInput: CanonicalParser = parseGenerationRequest,
): Promise<CompatibilityImageRequest> {
  if (body.byteLength > compatibilityEditMultipartLimit)
    throw multipartError('Multipart references exceed the 256 KiB request limit.', 413);
  if (!/^multipart\/form-data\s*;/i.test(contentType))
    throw multipartError('Image edits require JSON or multipart/form-data.');
  let form: FormData;
  try {
    // The platform MIME parser handles quoted boundaries and CRLF correctly.
    // Constructing a Request only parses local bytes; it makes no HTTP request.
    form = await new Request('https://multipart.invalid', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw multipartError('Malformed multipart/form-data body or boundary.');
  }
  const parsed: Record<string, unknown> = Object.create(null);
  const imageParts: unknown[] = [];
  let parts = 0;
  for (const [name, value] of form) {
    if (++parts > maximumMultipartParts)
      throw multipartError('Multipart requests accept at most 24 text parts.');
    if (typeof value !== 'string')
      throw multipartError('Binary image parts are unsupported; upload owned assets first.');
    if (name === 'image[]') {
      if ('image' in parsed) throw multipartError('Use image or image[] references, not both.');
      if (imageParts.length >= compatibilityEditMaximumReferences)
        throw multipartError('image[] accepts at most 10 owned image references.');
      try {
        imageParts.push(JSON.parse(value));
      } catch {
        throw multipartError('Each image[] field must contain one JSON assetKey reference.');
      }
    } else {
      if (Object.hasOwn(parsed, name))
        throw multipartError('Repeated scalar fields are unsupported; use image[] for references.');
      if (name === 'image' && imageParts.length)
        throw multipartError('Use image or image[] references, not both.');
      if (name === 'image') {
        try {
          parsed.image = JSON.parse(value);
        } catch {
          throw multipartError('image must contain JSON owned assetKey references.');
        }
      } else if (name === 'n' || name === 'max_cost_micros') {
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw multipartError('n and max_cost_micros require safe decimal integers.');
        parsed[name] = Number(value);
      } else parsed[name] = value;
    }
  }
  if (imageParts.length) parsed.image = imageParts;
  return parseCompatibilityImageEdit(parsed, parseInput);
}
