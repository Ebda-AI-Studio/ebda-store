import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { API_URL } from '../lib/api';
import { getSiteUrl } from '../lib/structured-data';
import { hideTags } from '../lib/hide-from-search';
import { classifyResolve, type HostIndexing } from '../lib/store-indexing';

const PRIVATE_ROOTS = ['/account/', '/checkout/', '/cart/', '/auth/', '/affiliate/'];
/** Private routes are served under the language prefix too (LOCALE-PATHS-4): `/en/cart/` must stay out of the index as `/cart/` does. */
const DEMO_PRIVATE_PATHS = [
  ...PRIVATE_ROOTS,
  ...PRIVATE_ROOTS.map(p => `/ar${p}`),
  ...PRIVATE_ROOTS.map(p => `/en${p}`),
];

/**
 * What this store host may tell a crawler (see {@link classifyResolve}): asks the same `/public/store/resolve` the storefront
 * resolves with (plan amendment C14). A failure to ask answers `unknown`: robots.txt then stays what it was, and the page's
 * own `noindex` meta (root metadata) still covers the showroom. CACHE CLASS: BOUNDED-stale, <= 5 min after a store changes
 * status (the tags below purge it sooner when the API revalidates the host).
 */
async function hostIndexing(storeHost: string): Promise<HostIndexing> {
  if (!storeHost) return 'unknown';
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      // Tagged so the merchant's "hide from search engines" toggle (purge of `store-domain:<host>`) reaches it at once.
      next: { revalidate: 300, tags: hideTags(storeHost) },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': storeHost },
    });
    const data = res.ok ? await res.json() : null;
    return classifyResolve(res.status, data?.data?.store);
  } catch {
    return 'unknown';
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
 * A store host with no live storefront (inactive, suspended, deleted) answers `Disallow: /` and no sitemap (Ruling ROBOTS-CLOSED-1).
 * The demo showroom (`storedemo`) stays crawlable (so its `noindex` meta is read) and advertises no sitemap (B1-14).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const host = h.get('host')?.toLowerCase();
  const base = host ? `https://${host}` : getSiteUrl();

  const indexing = await hostIndexing(h.get('x-store-domain')?.toLowerCase() ?? '');

  // A host with no live storefront (inactive, suspended, deleted, unknown): nothing to crawl, no sitemap to advertise.
  if (indexing === 'closed') return { rules: [{ userAgent: '*', disallow: '/' }] };

  if (indexing === 'hidden') {
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
