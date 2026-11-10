import { describe, expect, it } from 'vitest';
import {
  catalog,
  companies,
  modelSeries,
  getCompany,
  getSeries,
  getSeriesForModel,
  getCompanySeries,
  getCompanyModels,
  seriesHref,
  validateSeriesCatalog,
} from '@media-router/catalog';
import { playgroundHref } from '../apps/web/app/links';

describe('public company and model-series identity', () => {
  it('assigns every exact model once and validates canonical company paths', () => {
    expect(validateSeriesCatalog()).toEqual([]);
    const memberships = modelSeries.flatMap((series) => series.modelIds);
    expect(memberships).toHaveLength(catalog.models.length);
    expect(new Set(memberships)).toEqual(new Set(catalog.models.map((model) => model.id)));
    expect(companies).toHaveLength(8);
  });

  it('groups complete versions without merging different Seedance releases', () => {
    expect(getSeries('bytedance/seedance-2.5')?.modelIds).toEqual(['bytedance/seedance-2.5']);
    expect(getSeries('bytedance/seedance-2.0')?.modelIds).toEqual([
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
    ]);
    expect(getCompanyModels('bytedance')).toHaveLength(5);
  });

  it('combines the two H3 Max provider labels and preserves Turbo/Pika identities', () => {
    const h3 = getSeries('minimax/h3')!;
    expect(h3.companyId).toBe('minimax');
    expect(h3.modelIds).toHaveLength(6);
    expect(h3.modelIds).toContain('minimax/h3-max');
    expect(h3.modelIds).not.toContain('fal/h3-max');
    expect(h3.modelIds).toContain('fal/h3-max-turbo');
    expect(h3.modelIds).toContain('pika/h3-flex');
    expect(catalog.models.find((model) => model.id === 'minimax/h3-max')?.creator).toBe('MiniMax');
    expect(
      catalog.routes
        .filter((route) => route.modelId === 'minimax/h3-max')
        .map((route) => route.deploymentId)
        .sort(),
    ).toEqual(['fal-undisclosed', 'minimax-undisclosed']);
    expect(catalog.models.find((model) => model.id === 'pika/h3-flex')?.creator).toBe('Pika');
    for (const id of h3.modelIds)
      expect(catalog.routes.some((route) => route.modelId === id)).toBe(true);
    expect(getCompanyModels('minimax').map((model) => model.id)).toEqual(h3.modelIds);
  });

  it('includes Qwen brand models on Alibaba while retaining canonical Qwen pages', () => {
    expect(getCompany('qwen')?.parentCompanyId).toBe('alibaba');
    expect(getCompanySeries('qwen').map((series) => series.id)).toEqual([
      'qwen/image-2.1',
      'qwen/image-3.0-pro',
    ]);
    expect(getCompanySeries('alibaba').map((series) => series.id)).toEqual([
      'alibaba/wan-3.0',
      'qwen/image-2.1',
      'qwen/image-3.0-pro',
    ]);
    expect(getCompanyModels('alibaba')).toHaveLength(6);
    expect(seriesHref('alibaba/qwen-image-3.0-pro')).toBe('/qwen/image-3.0-pro');
  });

  it('preserves exact variant selection in canonical links', () => {
    expect(seriesHref('bytedance/seedance-2.5')).toBe('/bytedance/seedance-2.5');
    expect(seriesHref('fal/h3-max')).toBe('/minimax/h3?variant=minimax%2Fh3-max');
    expect(seriesHref('minimax/h3-max')).toBe('/minimax/h3?variant=minimax%2Fh3-max');
    expect(seriesHref('openai/gpt-image-2.5-flare')).toBe(
      '/openai/gpt-image-2.5?variant=openai%2Fgpt-image-2.5-flare',
    );
    expect(getSeriesForModel('minimax/h3-max')?.id).toBe('minimax/h3');
    expect(getSeriesForModel('fal/h3-max')?.id).toBe('minimax/h3');
  });

  it('hands exact variants and regional pins to the dedicated playground', () => {
    expect(playgroundHref()).toBe('/playground');
    expect(playgroundHref('fal/h3-max')).toBe('/playground?model=minimax%2Fh3-max');
    expect(playgroundHref('alibaba/wan-3.0-prime', 'alibaba/ap-southeast-1/wan-3.0-prime')).toBe(
      '/playground?model=alibaba%2Fwan-3.0-prime&route=alibaba%2Fap-southeast-1%2Fwan-3.0-prime',
    );
  });

  it('does not invent a company or series for an unknown URL', () => {
    expect(getCompany('missing')).toBeUndefined();
    expect(getSeries('minimax/missing')).toBeUndefined();
    expect(getSeries('minimax/h3/extra')).toBeUndefined();
    expect(getSeriesForModel('missing/model')).toBeUndefined();
    expect(seriesHref('missing/model')).toBeUndefined();
    expect(getCompanySeries('missing')).toEqual([]);
    expect(getCompanyModels('missing')).toEqual([]);
  });
});
