import type { MetadataRoute } from 'next';
import { getStore } from '../lib/store-resolver';
import { getSiteUrl } from '../lib/structured-data';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const store = await getStore();
  const siteUrl = getSiteUrl(store);

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
