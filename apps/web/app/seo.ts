import { createElement } from 'react';
import type { Metadata } from 'next';
import {
  catalog,
  companies,
  getCompanySeries,
  getSeriesDetail,
  modelSeries,
  seriesHref,
} from '@media-router/catalog';
import type { Company, ModelSeries } from '@media-router/contracts';
import { agentClients } from './agents/clients';

export const SITE_NAME = 'OpenGen';
export const SITE_DESCRIPTION =
  'Compare image and video generation APIs, exact model variants and regional providers. OpenGen is an open-source catalog and gateway with source-linked pricing.';

/** This is public deployment configuration. Never derive public URLs from request headers or secrets. */
export function siteOrigin(): string {
  const configured =
    process.env.OPENGEN_PUBLIC_URL ?? process.env.MEDIA_ROUTER_PUBLIC_URL ?? 'https://opengen.dev';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('The public site URL must be an HTTP(S) origin without credentials.');
  return url.origin;
}

export function canonicalUrl(path = '/'): string {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Canonical paths must be internal absolute paths.');
  const url = new URL(path, siteOrigin());
  url.search = '';
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function publicIndexingEnabled(): boolean {
  return process.env.VERCEL_ENV !== 'preview' && process.env.OPENGEN_NOINDEX !== 'true';
}

export function pageMetadata({
  title,
  description,
  path,
  noindex = false,
}: {
  title: string;
  description: string;
  path: string;
  noindex?: boolean;
}): Metadata {
  const url = canonicalUrl(path);
  const index = publicIndexingEnabled() && !noindex;
  const image = {
    url: canonicalUrl('/opengraph-image.png'),
    width: 1200,
    height: 630,
    alt: 'OpenGen — image and video model APIs',
  };
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: {
      index,
      follow: true,
      googleBot: { index, follow: true, 'max-image-preview': 'large' },
    },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url,
      locale: 'en_US',
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image.url] },
  };
}

export function companyMetadata(company: Company): Metadata {
  const seriesCount = getCompanySeries(company.id).length;
  return pageMetadata({
    title: `${company.name} AI models & API providers | OpenGen`,
    description: `Explore ${seriesCount} ${company.name} model series on OpenGen. Compare exact variants, regional API providers, documented prices and original sources.`,
    path: `/${company.id}`,
  });
}

export function seriesMetadata(series: ModelSeries): Metadata {
  const detail = getSeriesDetail(series.id)!;
  return pageMetadata({
    title: `${series.name} API providers, variants & pricing | OpenGen`,
    description: `Compare ${series.name} API access: ${detail.models.length} exact ${detail.models.length === 1 ? 'variant' : 'variants'} and ${detail.routes.length} regional provider routes. Check documented pricing, capabilities and original sources.`,
    path: `/${series.id}`,
  });
}

type JsonLdValue = Record<string, unknown>;
export function serializeJsonLd(value: JsonLdValue): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
export function JsonLd({ data }: { data: JsonLdValue }) {
  return createElement('script', {
    type: 'application/ld+json',
    dangerouslySetInnerHTML: { __html: serializeJsonLd(data) },
  });
}

const organizationId = () => `${canonicalUrl('/')}#organization`;
const websiteId = () => `${canonicalUrl('/')}#website`;
const companyId = (id: string) => `${canonicalUrl(`/${id}`)}#publisher`;
const seriesId = (id: string) => `${canonicalUrl(`/${id}`)}#series`;
const variantId = (id: string) => `${canonicalUrl('/')}#model-${encodeURIComponent(id)}`;

function publisher(company: Company): JsonLdValue {
  return {
    '@type': 'Organization',
    '@id': companyId(company.id),
    name: company.name,
    url: company.website,
    sameAs: [company.website],
    ...(company.parentCompanyId
      ? { parentOrganization: { '@id': companyId(company.parentCompanyId) } }
      : {}),
  };
}

function breadcrumbs(items: { name: string; path: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: canonicalUrl(item.path),
    })),
  };
}

export function siteStructuredData(): JsonLdValue {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId(),
        name: SITE_NAME,
        url: canonicalUrl('/'),
        logo: {
          '@type': 'ImageObject',
          url: canonicalUrl('/brand/opengen-mark-on-light.png'),
          width: 512,
          height: 512,
        },
      },
      {
        '@type': 'WebSite',
        '@id': websiteId(),
        name: SITE_NAME,
        url: canonicalUrl('/'),
        description: SITE_DESCRIPTION,
        publisher: { '@id': organizationId() },
        inLanguage: 'en',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${canonicalUrl('/')}#software`,
        name: SITE_NAME,
        url: canonicalUrl('/'),
        applicationCategory: 'DeveloperApplication',
        description: 'Open-source catalog and gateway for image and video generation APIs.',
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        publisher: { '@id': organizationId() },
      },
    ],
  };
}

export function homeStructuredData(): JsonLdValue {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${canonicalUrl('/')}#page`,
    name: 'OpenGen image and video generation for agents and creators',
    url: canonicalUrl('/'),
    description: SITE_DESCRIPTION,
    isPartOf: { '@id': websiteId() },
    mainEntity: { '@id': `${canonicalUrl('/')}#software` },
    relatedLink: [canonicalUrl('/models'), canonicalUrl('/playground')],
  };
}

export function modelsStructuredData(): JsonLdValue {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${canonicalUrl('/models')}#page`,
    name: 'OpenGen image and video generation API catalog',
    url: canonicalUrl('/models'),
    description: SITE_DESCRIPTION,
    isPartOf: { '@id': websiteId() },
    breadcrumb: breadcrumbs([
      { name: 'OpenGen', path: '/' },
      { name: 'Models', path: '/models' },
    ]),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: catalog.models.length,
      itemListElement: catalog.models.map((model, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: model.name,
        url: new URL(seriesHref(model.id)!, siteOrigin()).href,
      })),
    },
  };
}

export function companyDirectoryStructuredData(): JsonLdValue {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${canonicalUrl('/companies')}#page`,
    name: 'AI model companies on OpenGen',
    url: canonicalUrl('/companies'),
    isPartOf: { '@id': websiteId() },
    breadcrumb: breadcrumbs([
      { name: 'OpenGen', path: '/' },
      { name: 'Companies', path: '/companies' },
    ]),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: companies.length,
      itemListElement: companies.map((company, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: company.name,
        url: canonicalUrl(`/${company.id}`),
      })),
    },
  };
}

export function companyStructuredData(company: Company): JsonLdValue {
  const series = getCompanySeries(company.id);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      publisher(company),
      {
        '@type': 'CollectionPage',
        '@id': `${canonicalUrl(`/${company.id}`)}#page`,
        name: `${company.name} AI model series`,
        description: company.description,
        url: canonicalUrl(`/${company.id}`),
        about: { '@id': companyId(company.id) },
        isPartOf: { '@id': websiteId() },
        breadcrumb: breadcrumbs([
          { name: 'OpenGen', path: '/' },
          { name: 'Models', path: '/models' },
          { name: company.name, path: `/${company.id}` },
        ]),
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: series.length,
          itemListElement: series.map((item, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: item.name,
            url: canonicalUrl(`/${item.id}`),
          })),
        },
      },
    ],
  };
}

export function seriesStructuredData(series: ModelSeries): JsonLdValue {
  const detail = getSeriesDetail(series.id)!;
  const pageUrl = canonicalUrl(`/${series.id}`);
  const reviewed = seriesReviewDate(series);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      publisher(detail.company),
      {
        '@type': 'CreativeWorkSeries',
        '@id': seriesId(series.id),
        name: series.name,
        description: series.description,
        creator: { '@id': companyId(series.companyId) },
        url: pageUrl,
      },
      {
        '@type': 'CollectionPage',
        '@id': `${pageUrl}#page`,
        name: `${series.name} API providers and variants`,
        url: pageUrl,
        description: series.description,
        isPartOf: { '@id': websiteId() },
        about: { '@id': seriesId(series.id) },
        ...(reviewed ? { lastReviewed: reviewed } : {}),
        breadcrumb: breadcrumbs([
          { name: 'OpenGen', path: '/' },
          { name: 'Models', path: '/models' },
          { name: detail.company.name, path: `/${detail.company.id}` },
          { name: series.name, path: `/${series.id}` },
        ]),
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: detail.models.length,
          itemListElement: detail.models.map((model, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            item: { '@id': variantId(model.id) },
          })),
        },
        mentions: detail.providers.map((provider) => ({
          '@type': 'Organization',
          name: provider.name,
          url: provider.website,
        })),
      },
      ...detail.models.map((model) => ({
        '@type': 'SoftwareApplication',
        '@id': variantId(model.id),
        name: model.name,
        identifier: model.id,
        description: model.description,
        applicationCategory: 'MultimediaApplication',
        applicationSubCategory: `${model.modality === 'video' ? 'Video' : 'Image'} generation model`,
        url: `${pageUrl}#variant-${model.id.replaceAll('/', '-')}`,
        creator: { '@type': 'Organization', name: model.creator },
        isPartOf: { '@id': seriesId(series.id) },
        conditionsOfAccess: model.license,
        sameAs: model.source.url,
      })),
    ],
  };
}

export function seriesReviewDate(series: ModelSeries): string | undefined {
  const detail = getSeriesDetail(series.id)!;
  return [
    ...detail.models.map((model) => model.source.checkedAt),
    ...detail.routes.map((route) => route.source.checkedAt),
  ]
    .sort()
    .at(-1);
}

/** Canonical public pages only: variants, aliases and operational playground URLs are not sitemap entries. */
export function sitemapPaths(): string[] {
  return [
    '/',
    '/models',
    '/companies',
    ...companies.map((company) => `/${company.id}`),
    ...modelSeries.map((series) => `/${series.id}`),
    '/docs',
    '/guides/image-to-video',
    '/agents',
    ...agentClients.map((client) => `/agents/${client.slug}`),
  ];
}

export function HomeOverview() {
  return createElement(
    'section',
    {
      className: 'page-width series-about',
      id: 'about-opengen',
      'aria-labelledby': 'about-opengen-title',
    },
    createElement('span', { className: 'eyebrow' }, 'ABOUT OPENGEN'),
    createElement('h2', { id: 'about-opengen-title' }, 'What is OpenGen?'),
    createElement(
      'p',
      null,
      `OpenGen is an open-source catalog and gateway for image and video generation APIs. This catalog includes ${modelSeries.length} model series, ${catalog.models.length} exact variants and ${catalog.routes.length} documented provider routes. Compare the exact model, regional endpoint, published pricing and original source before choosing a route.`,
    ),
    createElement('h3', null, 'How are models and providers compared?'),
    createElement(
      'p',
      null,
      'A model series groups related variants without making them interchangeable. Each serving provider and regional deployment has its own capabilities, price evidence and observations. An endpoint location does not establish where inference occurs. Unknown pricing, latency and success rates remain unknown.',
    ),
    createElement('h3', null, 'Can I generate through every listed provider?'),
    createElement(
      'p',
      null,
      'Catalogued offerings are documented, not live-verification claims. Generation requires an installed gateway, matching provider credentials and a supported executable route. Estimates are not guaranteed final charges; use a spending ceiling and retain the job ID.',
    ),
    createElement('h3', null, 'Explore the model series'),
    createElement(
      'ul',
      { className: 'operation-tags' },
      ...modelSeries.map((series) =>
        createElement(
          'li',
          { key: series.id },
          createElement('a', { href: `/${series.id}` }, series.name),
        ),
      ),
    ),
    createElement(
      'p',
      null,
      createElement('a', { href: '/models' }, 'Browse the model catalog'),
      ' · ',
      createElement('a', { href: '/docs' }, 'Read the API and self-hosting documentation'),
    ),
  );
}
