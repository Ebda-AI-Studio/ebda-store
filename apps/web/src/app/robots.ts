import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { API_URL } from '../lib/api';
import { getSiteUrl } from '../lib/structured-data';
import { hideTags, hidesFromSearch } from '../lib/hide-from-search';

const PRIVATE_ROOTS = ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'];
/** Private routes are served under the language prefix too (LOCALE-PATHS-4): `/en/cart/` must stay out of the index as `/cart/` does. */
const DEMO_PRIVATE_PATHS = [
  ...PRIVATE_ROOTS,
  ...PRIVATE_ROOTS.map(p => `/ar${p}`),
  ...PRIVATE_ROOTS.map(p => `/en${p}`),
];

/**
 * Whether the store that owns this host must stay out of search: the demo showroom (`isDemo`, Ruling B1-14) or a store whose merchant switched on "hide from search engines". Asks the
 * same `/public/store/resolve` the storefront resolves with (plan amendment C14). Any failure to
 * ask answers "no": robots.txt then stays what it was, and the page's own `noindex` meta (root
 * metadata) still covers the showroom.
 */
async function isHiddenHost(storeHost: string): Promise<boolean> {
  if (!storeHost) return false;
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      // Tagged so the merchant's "hide from search engines" toggle (purge of `store-domain:<host>`) reaches it at once.
      next: { revalidate: 3600, tags: hideTags(storeHost) },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': storeHost },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const store = data?.data?.store;
    return store?.isDemo === true || hidesFromSearch(store);
  } catch {
    return false;
  }
}

/**
 * Host-aware robots.txt. The `sitemap:` directive must point at the
 * sitemap rooted in the SAME host the visitor is currently on:
 *
 *   - on `demo-shop.example` → https://demo-shop.example/sitemap.xml
 *   - on `ebda.app` → https://ebda.app/sitemap.xml
 *
 * Without this, robots.txt on the custom domain would advertise
 * the platform sitemap, telling Google to index platform URLs even
 * for merchants who only want their own domain indexed.
 *
 * The demo showroom (`storedemo`) stays crawlable (so its `noindex` meta is read) and advertises no sitemap (B1-14).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const host = h.get('host')?.toLowerCase();
  const base = host ? `https://${host}` : getSiteUrl();

  if (await isHiddenHost(h.get('x-store-domain')?.toLowerCase() ?? '')) {
    // Crawlable on purpose: a `Disallow: /` would stop crawlers reading the page's own `noindex`
    // meta, so an externally linked URL could still be indexed URL-only. No sitemap is advertised.
    return { rules: [{ userAgent: '*', allow: '/', disallow: DEMO_PRIVATE_PATHS }] };
  }

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: DEMO_PRIVATE_PATHS,
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
