import { describe, expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import {
  generationModelIds,
  getGenerationDefinition,
  getGenerationSchema,
} from '@media-router/contracts/generation';
import type { Operation } from '@media-router/contracts';
import { getPlaygroundFields, parseStructuredArgument } from '../apps/web/app/playground-fields';

const operations: Operation[] = [
  'text-to-image',
  'image-edit',
  'text-to-video',
  'image-to-video',
  'reference-to-video',
  'video-edit',
  'video-extend',
];

describe('canonical playground fields', () => {
  it('covers every property of all effective model/operation schemas without adding unsupported fields', () => {
    let checked = 0;
    for (const modelId of generationModelIds) {
      for (const operation of operations) {
        const schema = getGenerationSchema(modelId, operation);
        if (!schema) continue;
        const fields = getPlaygroundFields(modelId, operation);
        expect(fields.map((field) => field.name).sort()).toEqual(
          Object.keys(schema.properties as object).sort(),
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('retains optional prompts for source-based operations and exact required prompts for text operations', () => {
    expect(
      getPlaygroundFields('alibaba/wan-3.0', 'image-to-video').find(
        (field) => field.name === 'prompt',
      )?.required,
    ).toBe(false);
    expect(
      getPlaygroundFields('alibaba/wan-3.0', 'text-to-video').find(
        (field) => field.name === 'prompt',
      )?.required,
    ).toBe(true);
    expect(
      getPlaygroundFields('openai/gpt-image-2', 'image-edit').find(
        (field) => field.name === 'references',
      )?.required,
    ).toBe(true);
  });

  it('narrows resolution/duration choices to the exact pinned regional route', () => {
    const route = catalog.routes.find((entry) => entry.modelId === 'alibaba/wan-3.0')!;
    const fields = getPlaygroundFields(route.modelId, 'text-to-video', route);
    const caps = getGenerationDefinition(route.modelId, 'text-to-video')!.capabilities;
    expect(fields.find((field) => field.name === 'resolution')?.choices).toEqual(
      caps.resolutions.filter((value) => route.resolutions.includes(value)),
    );
    const durations = fields.find((field) => field.name === 'duration')?.choices!;
    expect(durations).toBeDefined();
    expect(
      durations.every(
        (duration) => duration === 'auto' || route.durations.includes(duration as number),
      ),
    ).toBe(true);
    expect(fields.find((field) => field.name === 'count')?.maximum).toBe(caps.countMaximum);
  });

  it('does not confuse boolean prompt expansion with string tiers', () => {
    const field = getPlaygroundFields('minimax/h3-max', 'text-to-video').find(
      (field) => field.name === 'promptExpansion',
    );
    expect(field?.choices).toContain(false);
    expect(field?.choices).toContain('quality');
    expect(field?.choices).not.toContain('false');
  });

  it('keeps fal Max continuous duration range instead of using its non-exhaustive route list', () => {
    const route = catalog.routes.find(
      (entry) => entry.modelId === 'minimax/h3-max' && entry.adapter === 'fal',
    )!;
    const field = getPlaygroundFields('minimax/h3-max', 'reference-to-video', route).find(
      (entry) => entry.name === 'duration',
    );
    expect(field?.choices).toBeUndefined();
    expect(field?.minimum).toBe(0.92);
    expect(field?.maximum).toBe(15);
  });
});

describe('atomic compound field edits', () => {
  it('parses ordered typed assets and preserves each union branch and order', () => {
    const text = JSON.stringify([
      { type: 'audio', asset: { assetKey: 'owned-input' } },
      { type: 'video', asset: { url: 'https://example.com/source.webm' } },
    ]);
    expect(parseStructuredArgument('references', text)).toEqual(JSON.parse(text));
  });

  it('rejects malformed JSON, conflicting asset branches, unknown nested fields and wrong shapes', () => {
    expect(() => parseStructuredArgument('size', '{')).toThrow('valid JSON');
    expect(() => parseStructuredArgument('size', '{"width":1024,"height":0}')).toThrow();
    expect(() =>
      parseStructuredArgument(
        'keyframes',
        '[{"image":{"assetKey":"owned","url":"https://example.com/a.png"}}]',
      ),
    ).toThrow();
    expect(() =>
      parseStructuredArgument('shots', '[{"prompt":"move","duration":5,"providerFlag":true}]'),
    ).toThrow();
    expect(() => parseStructuredArgument('elements', 'null')).toThrow();
  });

  it('commits complete valid model-specific arrays and clears only on explicit empty edit', () => {
    const shots = [
      { prompt: 'Walk into frame', duration: 5 },
      { prompt: 'Look at camera', duration: 4 },
    ];
    expect(parseStructuredArgument('shots', JSON.stringify(shots))).toEqual(shots);
    expect(parseStructuredArgument('size', '')).toBeUndefined();
  });
});
