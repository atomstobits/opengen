import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  catalog,
  companies,
  getCompany,
  getRoute,
  getSeries,
  modelSeries,
} from '@media-router/catalog';
import {
  HomeOverview,
  JsonLd,
  canonicalUrl,
  companyMetadata,
  companyStructuredData,
  homeStructuredData,
  modelsStructuredData,
  pageMetadata,
  publicIndexingEnabled,
  serializeJsonLd,
  seriesMetadata,
  seriesStructuredData,
  siteOrigin,
  sitemapPaths,
} from '../apps/web/app/seo';
import sitemap from '../apps/web/app/sitemap';
import robots from '../apps/web/app/robots';
import { GET as llms } from '../apps/web/app/llms.txt/route';
import { groupRoutesByProvider } from '../apps/web/app/provider-order';

beforeEach(() => vi.stubEnv('OPENGEN_PUBLIC_URL', 'https://opengen.dev'));
afterEach(() => vi.unstubAllEnvs());

describe('public canonical identity', () => {
  it('uses OpenGen and strips playground/query/fragment duplicates from canonical URLs', () => {
    vi.stubEnv('OPENGEN_PUBLIC_URL', 'https://opengen.dev');
    expect(siteOrigin()).toBe('https://opengen.dev');
    expect(canonicalUrl('/minimax/h3?variant=fal%2Fh3-max#providers')).toBe(
      'https://opengen.dev/minimax/h3',
    );
    expect(canonicalUrl('/bytedance/')).toBe('https://opengen.dev/bytedance');
    expect(() => canonicalUrl('//unrelated.example/path')).toThrow('internal');
    vi.stubEnv('OPENGEN_PUBLIC_URL', 'https://secret:token@opengen.dev');
    expect(() => siteOrigin()).toThrow('without credentials');
  });

  it('provides distinct titles and descriptions for every company and model series', () => {
    const metadata = [...companies.map(companyMetadata), ...modelSeries.map(seriesMetadata)];
    const titles = metadata.map((item) => String(item.title));
    const descriptions = metadata.map((item) => item.description);
    expect(new Set(titles).size).toBe(metadata.length);
    expect(new Set(descriptions).size).toBe(metadata.length);
    expect(titles.every((title) => title.includes('OpenGen'))).toBe(true);
    expect(metadata.every((item) => item.alternates?.canonical)).toBe(true);
  });

  it('keeps preview and operational pages non-indexable without blocking the canonical home', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('OPENGEN_NOINDEX', 'false');
    expect(publicIndexingEnabled()).toBe(true);
    const publicPage = pageMetadata({ title: 'OpenGen', description: 'Public catalog', path: '/' });
    const operationalPage = pageMetadata({
      title: 'OpenGen',
      description: 'Public catalog',
      path: '/playground?model=minimax%2Fh3',
      noindex: true,
    });
    expect(publicPage.robots).toMatchObject({ index: true });
    expect(operationalPage.robots).toMatchObject({ index: false, follow: true });
    expect(operationalPage.alternates?.canonical).toBe('https://opengen.dev/playground');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(publicIndexingEnabled()).toBe(false);
    expect(robots().rules).toEqual({ userAgent: '*', disallow: '/' });
  });
});

describe('truthful server-rendered evidence', () => {
  it('serializes JSON-LD without allowing catalog text to close its script', () => {
    const json = serializeJsonLd({ name: '</script><script>bad()</script>' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).name).toContain('</script>');
    const html = renderToStaticMarkup(createElement(JsonLd, { data: homeStructuredData() }));
    expect(html).toContain('application/ld+json');
    expect(html).toContain('WebPage');
    expect(html).not.toContain('ItemList');
    expect(homeStructuredData().relatedLink).toEqual([
      'https://opengen.dev/models',
      'https://opengen.dev/playground',
    ]);
  });

  it('describes every exact catalog variant at its selectable model-series URL', () => {
    const collection = modelsStructuredData();
    expect(collection).toMatchObject({
      '@type': 'CollectionPage',
      url: 'https://opengen.dev/models',
    });
    const list = collection.mainEntity as {
      numberOfItems: number;
      itemListElement: { name: string; url: string }[];
    };
    expect(list.numberOfItems).toBe(catalog.models.length);
    expect(list.itemListElement.map((item) => item.name)).toEqual(
      catalog.models.map((model) => model.name),
    );
    expect(new Set(list.itemListElement.map((item) => item.url)).size).toBe(catalog.models.length);
    expect(list.itemListElement.find((item) => item.name === 'MiniMax H3 Max')?.url).toBe(
      'https://opengen.dev/minimax/h3?variant=minimax%2Fh3-max',
    );
    expect(JSON.stringify(collection)).not.toMatch(
      /aggregateRating|ratingValue|priceCurrency|offers/,
    );
  });

  it('keeps series ownership separate from derivative authors and invents no prices or ratings', () => {
    const graph = seriesStructuredData(getSeries('minimax/h3')!)['@graph'] as Record<
      string,
      unknown
    >[];
    const family = graph.find((item) => item['@type'] === 'CreativeWorkSeries')!;
    expect(family.creator).toEqual({ '@id': 'https://opengen.dev/minimax#publisher' });
    const variants = graph.filter((item) => item['@type'] === 'SoftwareApplication');
    expect(variants).toHaveLength(6);
    expect(variants.some((item) => item.identifier === 'fal/h3-max')).toBe(false);
    expect(variants.find((item) => item.identifier === 'minimax/h3-max')?.creator).toEqual({
      '@type': 'Organization',
      name: 'MiniMax',
    });
    expect(variants.find((item) => item.identifier === 'pika/h3-flex')?.creator).toEqual({
      '@type': 'Organization',
      name: 'Pika',
    });
    expect(JSON.stringify(graph)).not.toMatch(/aggregateRating|ratingValue|priceCurrency|offers/);
    const companyGraph = companyStructuredData(getCompany('bytedance')!)['@graph'] as Record<
      string,
      unknown
    >[];
    const companyPage = companyGraph.find((item) => item['@type'] === 'CollectionPage')!;
    expect(companyPage.url).toBe('https://opengen.dev/bytedance');
    expect(companyPage.breadcrumb).toMatchObject({
      itemListElement: [
        { name: 'OpenGen', item: 'https://opengen.dev/' },
        { name: 'Models', item: 'https://opengen.dev/models' },
        { name: 'ByteDance', item: 'https://opengen.dev/bytedance' },
      ],
    });
  });

  it('renders factual overview answers and direct series links without client JavaScript', () => {
    const overview = renderToStaticMarkup(createElement(HomeOverview));
    expect(overview).toContain('What is OpenGen?');
    expect(overview).toContain('href="/minimax/h3"');
    expect(overview).toContain('documented provider routes');
  });

  it('groups interleaved deployments by serving provider and preserves their route IDs', () => {
    const first = getRoute('byteplus-undisclosed/bytedance-seedance-2.0')!;
    const middle = getRoute('fal-undisclosed/bytedance/seedance-2.0/text-to-video')!;
    const last = getRoute('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.0')!;
    const deployments = new Map(catalog.deployments.map((item) => [item.id, item]));
    expect(
      groupRoutesByProvider([first, middle, last], deployments).map((route) => route.id),
    ).toEqual([first.id, last.id, middle.id]);
  });
});

describe('crawler discovery', () => {
  it('lists canonical public paths once and excludes operational URLs', () => {
    const paths = sitemapPaths();
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(55);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/models',
        '/companies',
        '/bytedance',
        '/minimax/h3',
        '/docs',
        '/guides/image-to-video',
        '/agents',
        '/agents/cli',
      ]),
    );
    expect(
      paths.every((path) => !path.includes('?') && !path.includes('#') && !path.startsWith('/api')),
    ).toBe(true);
    expect(sitemap().every((item) => item.url.startsWith('https://opengen.dev/'))).toBe(true);
    expect(paths).not.toContain('/playground');
  });

  it('serves a public AI-readable index with canonical sources and no credentials', async () => {
    const response = llms();
    const text = await response.text();
    expect(text).toContain('# OpenGen');
    expect(text).toContain('https://opengen.dev/minimax/h3');
    expect(text).toContain('[Model catalog](https://opengen.dev/models)');
    expect(text).toContain('[Playground](https://opengen.dev/playground)');
    expect(text).toContain(
      '[Image-to-video walkthrough](https://opengen.dev/guides/image-to-video)',
    );
    expect(text).toContain('https://opengen.dev/guides/image-to-video.md');
    expect(text).toContain('Unknown prices and measurements remain unknown');
    expect(text).not.toContain('MR_API_TOKEN=');
    expect(text).not.toContain('Bearer ');
    expect(text).not.toContain('127.0.0.1');
  });
});
