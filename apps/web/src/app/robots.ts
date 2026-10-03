import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { getSiteUrl } from '../lib/structured-data';

/**
 * Host-aware robots.txt. The `sitemap:` directive must point at the
 * sitemap rooted in the SAME host the visitor is currently on:
 *
 *   - on `wadyaljuz.com` → https://wadyaljuz.com/sitemap.xml
 *   - on `ebda.app` → https://ebda.app/sitemap.xml
 *
 * Without this, robots.txt on the custom domain would advertise
 * the platform sitemap, telling Google to index platform URLs even
 * for merchants who only want their own domain indexed.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = (await headers()).get('host')?.toLowerCase();
  const base = host ? `https://${host}` : getSiteUrl();

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
