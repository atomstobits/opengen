import Fastify from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import { callSchema } from '../apps/server/src/operations';
import { openApiDocument } from '../apps/server/src/openapi';
import {
  parseCompatibilityEditMultipart,
  parseCompatibilityImageEdit,
} from '../apps/server/src/compatibility-input';
import {
  assetKeySchema,
  assetUploadSchema,
  registerOwnedAssetRoutes,
} from '../apps/server/src/owned-assets';

const inputKey = 'inputs/fixture/00000000-0000-4000-8000-000000000001.png';
const maxUploadBytes = 100 * 1024 * 1024;
const specification = openApiDocument();
type Schema = Record<string, unknown>;
type DocumentedOperation = {
  responses: Record<string, { content: Record<string, { schema: Schema }> }>;
  requestBody: {
    content: Record<string, { schema: Schema; encoding?: Record<string, { contentType: string }> }>;
  };
};

function documentedOperation(path: string, method: string): DocumentedOperation {
  return specification.paths[path]![method] as DocumentedOperation;
}

function compile(schema: Schema) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile({ ...schema, components: specification.components });
}

describe('published raw HTTP and MCP schemas', () => {
  const editContent = documentedOperation('/v1/images/edits', 'post').requestBody.content;
  const multipartEdit = editContent['multipart/form-data']!;
  const editModel = 'openai/gpt-image-2.5-sunburst';
  const editPrompt = 'A synthetic paper bird.';
  const firstImage = { assetKey: inputKey };
  const secondImage = { assetKey: 'inputs/fixture/second.webp' };

  it('keeps defaulted response_format optional for JSON and multipart image edits', async () => {
    const json = { model: editModel, prompt: editPrompt, image: firstImage };
    const wire = { ...json, image: JSON.stringify(firstImage) };
    expect(compile(editContent['application/json']!.schema)(json)).toBe(true);
    expect(compile(multipartEdit.schema)(wire)).toBe(true);
    const parsedJson = parseCompatibilityImageEdit(json);
    expect(parsedJson.responseFormat).toBe('url');
    const form = new FormData();
    for (const [name, value] of Object.entries(wire)) form.append(name, value);
    const request = new Request('https://multipart.invalid', { method: 'POST', body: form });
    expect(
      await parseCompatibilityEditMultipart(
        Buffer.from(await request.arrayBuffer()),
        request.headers.get('content-type')!,
      ),
    ).toEqual(parsedJson);
  });

  it.each([
    { name: 'one reference', image: firstImage },
    { name: 'an array in one field', image: [secondImage, firstImage] },
    { name: 'ordered repeated image[] fields', image: [secondImage, firstImage], repeated: true },
  ])('documents multipart edits with $name accepted by the parser', async (example) => {
    const json = {
      model: editModel,
      prompt: editPrompt,
      image: example.image,
      n: 1,
      max_cost_micros: 1234,
      response_format: 'b64_json',
    };
    const wire: Record<string, string | string[]> = {
      model: editModel,
      prompt: editPrompt,
      n: '1',
      max_cost_micros: '1234',
      response_format: 'b64_json',
      ...(example.repeated
        ? {
            'image[]': (example.image as (typeof firstImage)[]).map((image) =>
              JSON.stringify(image),
            ),
          }
        : { image: JSON.stringify(example.image) }),
    };
    const validateJson = compile(editContent['application/json']!.schema);
    const validateMultipart = compile(multipartEdit.schema);
    expect(validateJson(json), JSON.stringify(validateJson.errors)).toBe(true);
    expect(validateMultipart(wire), JSON.stringify(validateMultipart.errors)).toBe(true);
    const form = new FormData();
    for (const [name, value] of Object.entries(wire))
      for (const part of Array.isArray(value) ? value : [value]) form.append(name, part);
    const request = new Request('https://multipart.invalid', { method: 'POST', body: form });
    expect(
      await parseCompatibilityEditMultipart(
        Buffer.from(await request.arrayBuffer()),
        request.headers.get('content-type')!,
      ),
    ).toEqual(parseCompatibilityImageEdit(json));
  });

  it('documents JSON text references and mutually exclusive multipart field names', () => {
    const properties = multipartEdit.schema.properties as Record<string, Schema>;
    const jsonProperties = editContent['application/json']!.schema.properties as Record<
      string,
      Schema
    >;
    expect(properties.image).toMatchObject({
      type: 'string',
      contentMediaType: 'application/json',
      contentSchema: jsonProperties.image,
    });
    expect(properties['image[]']).toMatchObject({ type: 'array', minItems: 1, maxItems: 10 });
    expect(multipartEdit.encoding).toMatchObject({
      image: { contentType: 'text/plain' },
      'image[]': { contentType: 'text/plain' },
    });
    const validate = compile(multipartEdit.schema);
    const base = { model: editModel, prompt: editPrompt };
    const image = JSON.stringify(firstImage);
    expect(validate(base)).toBe(false);
    expect(validate({ ...base, image, 'image[]': [image] })).toBe(false);
    expect(validate({ ...base, image: firstImage })).toBe(false);
    expect(validate({ ...base, 'image[]': [] })).toBe(false);
    expect(validate({ ...base, 'image[]': Array.from({ length: 11 }, () => image) })).toBe(false);
    expect(validate({ ...base, image, n: '1.0' })).toBe(false);
    expect(validate({ ...base, image, max_cost_micros: '-1' })).toBe(false);
    expect(validate({ ...base, image, mask: image })).toBe(false);
  });

  it.each([
    ['minimum bytes', { mediaType: 'image/png', size: 1 }, true],
    ['maximum bytes', { mediaType: 'image/png', size: maxUploadBytes }, true],
    ['zero bytes', { mediaType: 'image/png', size: 0 }, false],
    ['oversized file', { mediaType: 'image/png', size: maxUploadBytes + 1 }, false],
    ['fractional bytes', { mediaType: 'image/png', size: 1.5 }, false],
    ['empty media type', { mediaType: '', size: 1 }, false],
    ['maximum media type length', { mediaType: 'a'.repeat(100), size: 1 }, true],
    ['oversized media type', { mediaType: 'a'.repeat(101), size: 1 }, false],
    ['unregistered field', { mediaType: 'image/png', size: 1, workspaceId: 'foreign' }, false],
  ])('gives assets.prepare the handler bounds for %s', (_name, input, valid) => {
    expect(assetUploadSchema.safeParse(input).success).toBe(valid);
    expect(callSchema.safeParse({ operationId: 'assets.prepare', input }).success).toBe(valid);
  });

  it.each(['assets.complete', 'assets.delete'] as const)(
    'gives %s the same nonempty key contract as its handler',
    (operationId) => {
      for (const [key, valid] of [
        ['', false],
        [inputKey, true],
        ['a'.repeat(300), true],
        ['a'.repeat(301), false],
      ] as const) {
        expect(assetKeySchema.safeParse({ key }).success, `handler: ${key.length}`).toBe(valid);
        expect(
          callSchema.safeParse({ operationId, input: { key } }).success,
          `MCP: ${key.length}`,
        ).toBe(valid);
      }
    },
  );

  const assetResponses = [
    {
      name: 'multipart prepare',
      path: '/v1/assets/multipart',
      method: 'post',
      url: '/v1/assets/multipart',
      payload: { mediaType: 'image/png', size: 1 },
      service: 'prepareMultipart',
      result: { key: inputKey, partSize: 5 * 1024 * 1024, partCount: 1 },
      missing: { key: inputKey, partSize: 5 * 1024 * 1024 },
      malformed: { key: inputKey, partSize: 5 * 1024 * 1024, partCount: '1' },
    },
    {
      name: 'multipart part',
      path: '/v1/assets/multipart/part',
      method: 'post',
      url: '/v1/assets/multipart/part',
      payload: { key: inputKey, partNumber: 1 },
      service: 'signMultipartPart',
      result: {
        partNumber: 1,
        size: 1,
        uploadUrl: 'https://owned.invalid/synthetic-upload',
        headers: {},
        expiresAt: '2026-11-04T00:10:00.000Z',
      },
      missing: { partNumber: 1, size: 1, headers: {}, expiresAt: '2026-11-04T00:10:00.000Z' },
      malformed: {
        partNumber: 1,
        size: '1',
        uploadUrl: 'https://owned.invalid/synthetic-upload',
        headers: {},
        expiresAt: '2026-11-04T00:10:00.000Z',
      },
    },
    {
      name: 'multipart resume',
      path: '/v1/assets/multipart',
      method: 'get',
      url: `/v1/assets/multipart?key=${encodeURIComponent(inputKey)}`,
      payload: undefined,
      service: 'resumeMultipart',
      result: [{ partNumber: 1, etag: 'synthetic-etag', size: 1 }],
      missing: [{ partNumber: 1, size: 1 }],
      malformed: [{ partNumber: 1, etag: 99, size: 1 }],
    },
    {
      name: 'multipart abort',
      path: '/v1/assets/multipart/abort',
      method: 'post',
      url: '/v1/assets/multipart/abort',
      payload: { key: inputKey },
      service: 'abortMultipart',
      result: { state: 'deleted', inUse: false },
      missing: { state: 'deleted' },
      malformed: { state: 'deleted', inUse: 'false' },
    },
    {
      name: 'asset delete',
      path: '/v1/assets',
      method: 'delete',
      url: '/v1/assets',
      payload: { key: inputKey },
      service: 'delete',
      result: { state: 'deleted', inUse: true },
      missing: { state: 'deleted' },
      malformed: { state: 'deleted', inUse: 'true' },
    },
  ] as const;

  it.each(assetResponses)(
    'describes the actual $name result and rejects incomplete or mistyped results',
    async (contract) => {
      const app = Fastify();
      const service = vi.fn(async () => contract.result);
      registerOwnedAssetRoutes(app, {
        assets: { [contract.service]: service } as never,
        authenticate: async () => ({ workspaceId: 'fixture', scopes: ['read', 'generate'] }),
      });
      try {
        const response = await app.inject({
          method: contract.method.toUpperCase() as 'GET' | 'POST' | 'DELETE',
          url: contract.url,
          ...(contract.payload === undefined ? {} : { payload: contract.payload }),
        });
        expect(response.statusCode).toBe(200);
        expect(service).toHaveBeenCalledOnce();
        const schema = documentedOperation(contract.path, contract.method).responses['200']!
          .content['application/json']!.schema;
        const validate = compile(schema);
        expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
        expect(validate(contract.missing), 'missing required response facts').toBe(false);
        expect(validate(contract.malformed), 'mistyped response facts').toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it('publishes nullable bounded progress on the full private Job response', () => {
    const properties = specification.components.schemas.Job.properties as Record<string, Schema>;
    expect(properties.progress).toBeDefined();
    const validate = compile(properties.progress!);
    const progress = {
      phase: 'running',
      percent: null,
      observedAt: '2026-11-04T00:00:00.000Z',
      source: 'provider',
    };
    expect(validate(null)).toBe(true);
    expect(validate(progress), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...progress, percent: 101 })).toBe(false);
    expect(validate({ ...progress, percent: -1 })).toBe(false);
    expect(validate({ ...progress, phase: 'invented' })).toBe(false);
  });

  it('publishes field-addressed recovery decisions on the full private Job response', () => {
    const properties = specification.components.schemas.Job.properties as Record<string, Schema>;
    expect(properties.structuredError).toBeDefined();
    const validate = compile(properties.structuredError!);
    const error = {
      code: 'provider_invalid_input',
      category: 'invalid_input',
      message: 'The provider reported an invalid input.',
      retryable: false,
      recovery: 'edit_request',
      field: 'input.duration',
    };
    expect(validate(null)).toBe(true);
    expect(validate(error), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...error, recovery: 'regenerate' })).toBe(false);
    expect(validate({ ...error, retryable: 'yes' })).toBe(false);
    expect(validate({ ...error, category: 'invented' })).toBe(false);
  });

  it('documents the status backpressure response using the common safe error envelope', () => {
    expect(
      documentedOperation('/v1/generations/{id}/status', 'get').responses['429'],
    ).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    });
  });
});
