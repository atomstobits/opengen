import { describe, expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import {
  initialPlaygroundRequest,
  isPlaygroundDraft,
  validatePlaygroundRequest,
} from '../apps/web/app/playground-request';

const model = catalog.models.find((item) => item.id === 'alibaba/wan-3.0')!;
const routes = catalog.routes.filter((route) => route.modelId === model.id);
describe('canonical playground requests', () => {
  it('validates prompt-free source operations and preserves the exact regional pin', () => {
    const value = initialPlaygroundRequest(model, routes, 'alibaba/ap-southeast-1/wan-3.0');
    const next = validatePlaygroundRequest(
      {
        ...value,
        operation: 'image-to-video',
        input: {
          resolution: '720p',
          duration: 5,
          firstFrame: { url: 'https://assets.example.test/frame.png' },
        },
      },
      catalog,
      model.id,
    );
    expect(next.input.prompt).toBeUndefined();
    expect(next.routeId).toBe('alibaba/ap-southeast-1/wan-3.0');
  });
  it('rejects unsupported regional configurations without changing the source object', () => {
    const value = {
      ...initialPlaygroundRequest(model, routes),
      routeId: 'alibaba/ap-southeast-1/wan-3.0',
      input: { prompt: 'Fixture', resolution: 'unsupported' },
    };
    const before = JSON.stringify(value);
    expect(() => validatePlaygroundRequest(value, catalog, model.id)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });
  it('rejects unknown fields, cross-model JSON and pinned fallback', () => {
    const value = { ...initialPlaygroundRequest(model, routes), input: { prompt: 'Fixture' } };
    expect(() =>
      validatePlaygroundRequest(
        { ...value, input: { ...value.input, imaginary: true } },
        catalog,
        model.id,
      ),
    ).toThrow();
    expect(() => validatePlaygroundRequest(value, catalog, 'minimax/h3-max')).toThrow();
    expect(() =>
      validatePlaygroundRequest(
        { ...value, routeId: routes[0]!.id, routing: { fallback: true } },
        catalog,
        model.id,
      ),
    ).toThrow(/pinned/);
  });
  it('requires a managed cap but permits explicitly uncapped BYOK', () => {
    const value = {
      ...initialPlaygroundRequest(model, routes),
      input: { prompt: 'Fixture' },
      maxCostMicros: undefined,
    };
    expect(() => validatePlaygroundRequest(value, catalog, model.id)).toThrow(/spending limit/);
    expect(
      validatePlaygroundRequest({ ...value, billing: 'byok' }, catalog, model.id).maxCostMicros,
    ).toBeUndefined();
  });
  it('ignores malformed stored draft shapes without requiring completed model inputs', () => {
    const value = initialPlaygroundRequest(model, routes);
    expect(isPlaygroundDraft(value)).toBe(true);
    expect(isPlaygroundDraft({ ...value, input: { references: {} } })).toBe(false);
    expect(isPlaygroundDraft({ ...value, input: { duration: Infinity } })).toBe(false);
    expect(isPlaygroundDraft({ ...value, routing: { fallback: 'yes' } })).toBe(false);
  });
});
