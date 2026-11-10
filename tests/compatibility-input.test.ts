import { describe, expect, it, vi } from 'vitest';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import {
  compatibilityEditMultipartLimit,
  parseCompatibilityEditMultipart,
  parseCompatibilityImageEdit,
  parseCompatibilityImageGeneration,
} from '../apps/server/src/compatibility-input';

const model = 'openai/gpt-image-2.5-sunburst';
const prompt = 'Give a synthetic geometric paper bird an orange wing.';
const first = { assetKey: 'inputs/synthetic/one.png' };
const second = { assetKey: 'inputs/synthetic/two.webp' };

async function multipart(fields: [string, string | Blob][]) {
  const form = new FormData();
  for (const [key, value] of fields) form.append(key, value);
  const request = new Request('https://multipart.invalid', { method: 'POST', body: form });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type')!,
  };
}

describe('selected image compatibility conversion', () => {
  it('uses canonical defaults and keeps broker representation outside model input', () => {
    const value = parseCompatibilityImageGeneration({ model, prompt });
    expect(value).toEqual({
      responseFormat: 'url',
      input: parseGenerationRequest({
        modelId: model,
        operation: 'text-to-image',
        input: { prompt, resolution: '1K', aspectRatio: '1:1' },
      }),
    });
    const base64 = parseCompatibilityImageGeneration({
      model,
      prompt,
      response_format: 'b64_json',
    });
    expect(base64.responseFormat).toBe('b64_json');
    expect(base64.input).toEqual(value.input);
  });

  it('preserves exact variant, regional route, cap and explicit controls', () => {
    expect(
      parseCompatibilityImageGeneration({
        model,
        prompt,
        size: '2048x2048',
        n: 1,
        quality: 'high',
        output_format: 'webp',
        background: 'transparent',
        billing: 'byok',
        route_id: 'openai-eu/gpt-image-2.5-sunburst',
        max_cost_micros: 123_456,
      }).input,
    ).toEqual({
      modelId: model,
      operation: 'text-to-image',
      input: {
        prompt,
        resolution: '2K',
        aspectRatio: '1:1',
        count: 1,
        quality: 'high',
        outputFormat: 'webp',
        background: 'transparent',
      },
      billing: 'byok',
      routeId: 'openai-eu/gpt-image-2.5-sunburst',
      maxCostMicros: 123_456,
    });
  });

  it('preserves ordered owned edit references and does not inject square geometry', () => {
    const { input } = parseCompatibilityImageEdit({ model, prompt, image: [second, first] });
    expect(input.operation).toBe('image-edit');
    expect(input.input.references).toEqual([
      { type: 'image', asset: second },
      { type: 'image', asset: first },
    ]);
    expect(input.input).not.toHaveProperty('aspectRatio');
    expect(input.input).not.toHaveProperty('size');
    expect(
      parseCompatibilityImageEdit({ model, prompt, image: first }).input.input.references,
    ).toEqual([{ type: 'image', asset: first }]);
  });

  it('passes the one canonical request through the supplied application validator', () => {
    const parse = vi.fn(parseGenerationRequest);
    const { input } = parseCompatibilityImageEdit({ model, prompt, image: first }, parse);
    expect(parse).toHaveBeenCalledExactlyOnceWith({
      modelId: model,
      operation: 'image-edit',
      input: { prompt, references: [{ type: 'image', asset: first }] },
    });
    expect(input.input.quality).toBe('medium');
  });

  it.each([
    { n: 2 },
    { size: '1024x1536' },
    { response_format: 'data_url' },
    { style: 'vivid' },
    { user: 'caller-identity' },
    { metadata: { public: true } },
    { prompt: '  ' },
    { model: 'kling/kling-4.0' },
    { max_cost_micros: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects unsupported/invalid generation inputs %j', (patch) => {
    expect(() => parseCompatibilityImageGeneration({ model, prompt, ...patch })).toThrow();
  });

  it.each([
    { mask: first },
    { image: { url: 'https://example.com/input.png' } },
    { image: { assetKey: first.assetKey, url: 'https://example.com/input.png' } },
    { image: 'data:image/png;base64,fixture' },
    { image: [] },
    { image: Array.from({ length: 11 }, () => first) },
    { image: undefined },
  ])('rejects unsupported reference conversion %j', (patch) => {
    expect(() => parseCompatibilityImageEdit({ model, prompt, image: first, ...patch })).toThrow();
  });

  it('honors narrower canonical quality/reference/format constraints', () => {
    expect(() =>
      parseCompatibilityImageEdit({
        model: 'xai/grok-imagine-image-2.0',
        prompt,
        image: first,
        quality: 'high',
      }),
    ).toThrow(/quality/);
    expect(() =>
      parseCompatibilityImageEdit({
        model: 'alibaba/qwen-image-3.0-pro',
        prompt,
        image: [first, first, first, first],
      }),
    ).toThrow(/references/);
    expect(() =>
      parseCompatibilityImageGeneration({
        model,
        prompt,
        output_format: 'jpeg',
        background: 'transparent',
      }),
    ).toThrow();
    expect(() =>
      parseCompatibilityImageGeneration({
        model: 'bytedance/seedream-5.0-pro',
        prompt,
        size: '4096x4096',
      }),
    ).toThrow(/resolution/);
  });
});

describe('bounded multipart owned references', () => {
  it('matches the JSON edit request and keeps repeated reference order', async () => {
    const { body, contentType } = await multipart([
      ['model', model],
      ['prompt', prompt],
      ['image[]', JSON.stringify(second)],
      ['image[]', JSON.stringify(first)],
      ['n', '1'],
      ['max_cost_micros', '1234'],
      ['response_format', 'b64_json'],
    ]);
    expect(await parseCompatibilityEditMultipart(body, contentType)).toEqual(
      parseCompatibilityImageEdit({
        model,
        prompt,
        image: [second, first],
        n: 1,
        max_cost_micros: 1234,
        response_format: 'b64_json',
      }),
    );
  });

  it('supports a single JSON image field', async () => {
    const { body, contentType } = await multipart([
      ['model', model],
      ['prompt', prompt],
      ['image', JSON.stringify(first)],
    ]);
    expect(await parseCompatibilityEditMultipart(body, contentType)).toEqual(
      parseCompatibilityImageEdit({ model, prompt, image: first }),
    );
  });

  it('rejects files before any canonical callback, storage or generation', async () => {
    const parse = vi.fn(parseGenerationRequest);
    const { body, contentType } = await multipart([
      ['model', model],
      ['prompt', prompt],
      ['image', new Blob(['fixture'], { type: 'image/png' })],
    ]);
    await expect(parseCompatibilityEditMultipart(body, contentType, parse)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('upload owned assets'),
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(
    [
      [
        ['model', model],
        ['model', model],
      ],
      [
        ['image', JSON.stringify(first)],
        ['image[]', JSON.stringify(second)],
      ],
      [
        ['image[]', JSON.stringify(second)],
        ['image', JSON.stringify(first)],
      ],
      [['image[]', '{not-json']],
      [['image', 'https://example.com/input.png']],
      [['n', '1.0']],
      [['max_cost_micros', '9007199254740992']],
      [['max_cost_micros', '-1']],
    ].map((entries) => ({ entries: entries as [string, string][] })),
  )('rejects ambiguous or malformed fields %j', async ({ entries }) => {
    const { body, contentType } = await multipart(entries);
    await expect(parseCompatibilityEditMultipart(body, contentType)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('enforces decoded reference count, request bytes and valid MIME boundary', async () => {
    const tooMany = await multipart(
      Array.from({ length: 11 }, () => ['image[]', JSON.stringify(first)] as [string, string]),
    );
    await expect(
      parseCompatibilityEditMultipart(tooMany.body, tooMany.contentType),
    ).rejects.toThrow(/at most 10/);
    await expect(
      parseCompatibilityEditMultipart(
        Buffer.alloc(compatibilityEditMultipartLimit + 1),
        'multipart/form-data; boundary=x',
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      parseCompatibilityEditMultipart(Buffer.from('fixture'), 'multipart/form-data'),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      parseCompatibilityEditMultipart(Buffer.from('fixture'), 'multipart/form-data; boundary=x'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
