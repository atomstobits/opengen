import type { MetadataRoute } from 'next';
import { canonicalUrl, sitemapPaths } from './seo';

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [...new Set([...sitemapPaths(), '/pricing'])];
  return paths.map((path) => ({ url: canonicalUrl(path) }));
}
