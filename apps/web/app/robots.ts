import type { MetadataRoute } from 'next';
import { canonicalUrl, publicIndexingEnabled, siteOrigin } from './seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: publicIndexingEnabled()
      ? {
          userAgent: '*',
          allow: '/',
          disallow: ['/api/', '/dashboard/', '/operator/', '/settings/', '/auth/'],
        }
      : { userAgent: '*', disallow: '/' },
    sitemap: canonicalUrl('/sitemap.xml'),
    host: siteOrigin(),
  };
}
