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
import {
  buildCatalogModelEntries,
  describeEndpointRegions,
  groupCatalogModels,
  variantGridColumns,
} from '../apps/web/app/model-groups';

describe('public company and model-series identity', () => {
  it('assigns every exact model once and validates canonical company paths', () => {
    expect(validateSeriesCatalog()).toEqual([]);
    const memberships = modelSeries.flatMap((series) => series.modelIds);
    expect(memberships).toHaveLength(catalog.models.length);
    expect(new Set(memberships)).toEqual(new Set(catalog.models.map((model) => model.id)));
    expect(companies).toHaveLength(9);
  });

  it('groups complete versions without merging different Seedance releases', () => {
    expect(getSeries('bytedance/seedance-2.5')?.modelIds).toEqual(['bytedance/seedance-2.5']);
    expect(getSeries('bytedance/seedance-2.0')?.modelIds).toEqual([
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
    ]);
    expect(getSeries('bytedance/seedance-1.0')?.modelIds).toEqual([
      'bytedance/seedance-1.0-pro',
      'bytedance/seedance-1.0-pro-fast',
    ]);
    expect(getCompanyModels('bytedance')).toHaveLength(12);
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
      Array.from(
        new Set(
          catalog.routes
            .filter((route) => route.modelId === 'minimax/h3-max')
            .map((route) => route.deploymentId),
        ),
      ).sort(),
    ).toEqual(['fal-undisclosed', 'minimax-undisclosed', 'runway-undisclosed']);
    expect(catalog.models.find((model) => model.id === 'pika/h3-flex')?.creator).toBe('Pika');
    for (const id of h3.modelIds)
      expect(catalog.routes.some((route) => route.modelId === id)).toBe(true);
    const h3Image = getSeries('minimax/h3-image')!;
    expect(getCompanyModels('minimax').map((model) => model.id)).toEqual([
      ...h3.modelIds,
      ...h3Image.modelIds,
    ]);
  });

  it('includes Qwen brand models on Alibaba while retaining canonical Qwen pages', () => {
    expect(getCompany('qwen')?.parentCompanyId).toBe('alibaba');
    expect(getCompanySeries('qwen').map((series) => series.id)).toEqual([
      'qwen/image-2.1',
      'qwen/image-3.0-pro',
    ]);
    expect(getCompanySeries('alibaba').map((series) => series.id)).toEqual([
      'alibaba/wan-3.0',
      'alibaba/happy-horse-1.1',
      'qwen/image-2.1',
      'qwen/image-3.0-pro',
    ]);
    expect(getCompanyModels('alibaba')).toHaveLength(8);
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

describe('models page variant grouping', () => {
  const regionLabels = {
    'cn-beijing': 'Beijing, China',
    'ap-southeast-1': 'Singapore',
    'ap-northeast-1': 'Tokyo, Japan',
    'eu-central-1': 'Frankfurt, Germany',
    'us-east-1': 'Virginia, US',
    'cn-hongkong': 'Hong Kong, China',
  };

  it('groups every exact variant under its canonical model series without merging distinct versions', () => {
    const entries = buildCatalogModelEntries(catalog, regionLabels);
    const groups = groupCatalogModels(entries, entries);
    expect(groups).toHaveLength(modelSeries.length);
    expect(new Set(groups.map((group) => group.id))).toEqual(
      new Set(modelSeries.map((series) => series.id)),
    );
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.model.id))).toHaveLength(
      catalog.models.length,
    );

    const seedance25 = groups.find((group) => group.id === 'bytedance/seedance-2.5')!;
    const seedance20 = groups.find((group) => group.id === 'bytedance/seedance-2.0')!;
    const seedance10 = groups.find((group) => group.id === 'bytedance/seedance-1.0')!;
    expect(seedance25.entries.map((entry) => entry.model.id)).toEqual(['bytedance/seedance-2.5']);
    expect(seedance20.entries.map((entry) => entry.model.id)).toEqual([
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
    ]);
    expect(seedance10.entries.map((entry) => entry.model.id)).toEqual([
      'bytedance/seedance-1.0-pro',
      'bytedance/seedance-1.0-pro-fast',
    ]);

    const h3 = groups.find((group) => group.id === 'minimax/h3')!;
    expect(h3.entries.map((entry) => entry.model.id)).toEqual([
      'minimax/h3',
      'minimax/h3-highspeed',
      'minimax/h3-lite',
      'minimax/h3-max',
      'fal/h3-max-turbo',
      'pika/h3-flex',
    ]);
  });

  it('pulls non-adjacent variants of the same model together in canonical series order', () => {
    const entries = buildCatalogModelEntries(catalog, regionLabels);
    const byId = new Map(entries.map((entry) => [entry.model.id, entry]));
    const interleaved = [
      byId.get('bytedance/seedance-2.0-mini')!,
      byId.get('kling/kling-4.0-flash')!,
      byId.get('bytedance/seedance-2.0')!,
      byId.get('fal/h3-max-turbo')!,
      byId.get('kling/kling-4.0')!,
      byId.get('bytedance/seedance-2.0-fast')!,
      byId.get('minimax/h3')!,
    ];
    const groups = groupCatalogModels(entries, interleaved);
    expect(groups.map((group) => group.id)).toEqual([
      'bytedance/seedance-2.0',
      'kling/kling-4.0',
      'minimax/h3',
    ]);
    expect(groups[0]!.entries.map((entry) => entry.model.id)).toEqual([
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
    ]);
    expect(groups[1]!.entries.map((entry) => entry.model.id)).toEqual([
      'kling/kling-4.0',
      'kling/kling-4.0-flash',
    ]);
    expect(groups[2]!.entries.map((entry) => entry.model.id)).toEqual([
      'minimax/h3',
      'fal/h3-max-turbo',
    ]);
  });

  it('matches derivative variants when searching by series name and tracks hidden siblings on narrow filters', () => {
    const entries = buildCatalogModelEntries(catalog, regionLabels);
    const fluxVideoMatches = entries.filter((entry) => entry.search.includes('flux 3 video'));
    const fluxVideoGroups = groupCatalogModels(entries, fluxVideoMatches);
    expect(fluxVideoGroups).toHaveLength(1);
    expect(fluxVideoGroups[0]!.entries.map((entry) => entry.model.id)).toEqual([
      'bfl/flux-3-video',
      'fal/flux-3-max-video',
    ]);

    const sunburstMatches = entries.filter((entry) => entry.search.includes('sunburst'));
    const sunburstGroups = groupCatalogModels(entries, sunburstMatches);
    expect(sunburstGroups.map((group) => group.id)).toEqual([
      'openai/gpt-image-2.6',
      'openai/gpt-image-2.5',
    ]);
    expect(sunburstGroups[0]!.hiddenSiblings.map((model) => model.id)).toEqual([
      'openai/gpt-image-2.6-flare',
    ]);
    expect(sunburstGroups[1]!.hiddenSiblings.map((model) => model.id)).toEqual([
      'openai/gpt-image-2.5-flare',
    ]);
  });

  it('describes regional coverage truthfully and selects balanced variant grid column counts', () => {
    const entries = buildCatalogModelEntries(catalog, regionLabels);
    const wan = entries.filter((entry) => entry.series?.id === 'alibaba/wan-3.0');
    expect(
      describeEndpointRegions(
        wan.reduce((sum, entry) => sum + entry.routes.length, 0),
        wan.flatMap((entry) => entry.deployments),
      ),
    ).toBe('6 disclosed endpoint regions');
    expect(describeEndpointRegions(0, [])).toBe('No hosted routes listed');
    expect(variantGridColumns(1)).toBe(1);
    expect(variantGridColumns(2)).toBe(2);
    expect(variantGridColumns(3)).toBe(3);
    expect(variantGridColumns(4)).toBe(2);
    expect(variantGridColumns(6)).toBe(3);
  });
});
