import type { MetadataRoute } from 'next';
import { canonicalUrl, sitemapPaths } from './seo';

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapPaths().map((path) => ({ url: canonicalUrl(path) }));
}
