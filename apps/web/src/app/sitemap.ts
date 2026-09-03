import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { getSiteUrl } from '../lib/structured-data';
import { API_URL } from '../lib/api';

// Static page slugs that exist for every store (per-tenant rewrite).
const STORE_STATIC_PAGES: Array<{ path: string; priority: number; freq: 'monthly' | 'weekly' }> = [
  { path: '', priority: 1.0, freq: 'weekly' }, // store home
  { path: '/products', priority: 0.9, freq: 'weekly' },
  { path: '/categories', priority: 0.8, freq: 'weekly' },
  { path: '/about', priority: 0.5, freq: 'monthly' },
  { path: '/contact', priority: 0.5, freq: 'monthly' },
  { path: '/faq', priority: 0.4, freq: 'monthly' },
  { path: '/how-to-guides', priority: 0.5, freq: 'monthly' },
  { path: '/shipping', priority: 0.4, freq: 'monthly' },
  { path: '/returns', priority: 0.4, freq: 'monthly' },
  { path: '/privacy', priority: 0.3, freq: 'monthly' },
  { path: '/terms', priority: 0.3, freq: 'monthly' },
];

type StoreListEntry = {
  id: string;
  slug: string;
  /** ISO timestamp from /public/stores — used to pick which stores get
   *  product fan-out (oldest first) when the store count exceeds the cap. */
  createdAt?: string;
};

type ProductEntry = {
  slug: string;
  updatedAt?: string;
  createdAt?: string;
};

async function fetchStores(): Promise<StoreListEntry[]> {
  const stores: StoreListEntry[] = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const res = await fetch(`${API_URL}/public/stores?page=${page}&limit=${limit}`, {
      next: { revalidate: 3600 },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) break;
    const data = await res.json();
    const batch: StoreListEntry[] = data?.data ?? [];
    stores.push(...batch.map(s => ({ id: s.id, slug: s.slug, createdAt: s.createdAt })));
    const totalPages = data?.pagination?.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
    // Hard cap so a runaway DB can't blow the sitemap timeout.
    if (page > 50) break;
  }
  return stores;
}

/**
 * Resolve a custom-domain host (e.g. `wadyaljuz.com`) to its owning
 * store via the dedicated /public/store/resolve endpoint. Returns null
 * when the host isn't a known custom domain (e.g. platform path,
 * preview deploy host, direct IP hit).
 */
async function resolveStoreByHost(host: string): Promise<StoreListEntry | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: { revalidate: 3600 },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': host },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const store = data?.data?.store;
    if (!store?.id || !store?.slug) return null;
    return { id: store.id, slug: store.slug };
  } catch {
    return null;
  }
}

/**
 * Fetch a store's published products, paginated. The API hard-clamps
 * `limit` at 100 (`ProductService.listPublic`: `Math.min(100, ...)`) — the
 * old single `?limit=1000` request silently got page 1 of 100, so any
 * catalog past 100 products was absent from the sitemap (audit-followup
 * #1147/#1163; live-verified: pecannbee returned 100 of 160). Loop pages at
 * the real clamp until `meta.totalPages` is exhausted, bounded by
 * `maxPages` so the master branch's fan-out can't blow the Worker's
 * 1000-subrequest ceiling. Truncation past the bound is logged, never
 * silent.
 */
async function fetchProducts(storeId: string, maxPages: number): Promise<ProductEntry[]> {
  const products: ProductEntry[] = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await fetch(
      `${API_URL}/public/products?page=${page}&limit=100&status=published&storeId=${storeId}`,
      {
        // The 1-hour TTL is the floor, not the control: the tag lets a product
        // save refresh the sitemap immediately instead of up to an hour later.
        // Kept from main — the pagination rewrite on this branch dropped it,
        // and taking either side of the conflict whole would have lost one of
        // the two fixes.
        next: { revalidate: 3600, tags: [`products:${storeId}`] },
        headers: { 'Content-Type': 'application/json', 'X-Store-ID': storeId },
      }
    );
    if (!res.ok) break;
    const data = await res.json();
    products.push(...(data?.data?.products ?? []));
    const totalPages = data?.data?.meta?.totalPages ?? 1;
    if (page >= totalPages) break;
    if (page === maxPages && totalPages > maxPages) {
      console.warn('sitemap: product pagination capped for store', {
        storeId,
        fetchedPages: maxPages,
        totalPages,
      });
    }
    page += 1;
  }
  return products;
}

/**
 * Sitemap with host-aware tenant fan-out.
 *
 * The same Next.js sitemap route serves three different audiences
 * depending on the host header:
 *
 *   - `wadyaljuz.com` (custom domain)
 *     → ONLY Wady Aljuz's URLs, rooted at https://wadyaljuz.com
 *     → submitted to Google Search Console for that merchant's property
 *   - `store.forcemediakw.com` (platform path)
 *     → master sitemap covering every store under /<slug>/, rooted
 *       at https://store.forcemediakw.com
 *     → submitted to the platform's GSC property
 *   - any other host (preview deploys, IP-direct hits)
 *     → falls through to the master sitemap shape with whatever
 *       `getSiteUrl()` decides
 *
 * Without the host branch, the sitemap at wadyaljuz.com/sitemap.xml
 * would list `https://store.forcemediakw.com/wady-aljuz/...` URLs,
 * which causes Google to index the wrong domain when the merchant
 * submits their own GSC property. Caught on wadyaljuz.com 2026-05-14.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const requestHost = (await headers()).get('host')?.toLowerCase() ?? '';

  // Tenant branch: ask the API whether this host is a known custom
  // domain. Avoids exposing the domain list via /public/stores. Falls
  // through to the master sitemap on a non-match (platform path,
  // preview deploys, etc.).
  const tenant = await resolveStoreByHost(requestHost);
  if (tenant) {
    const base = `https://${requestHost}`;
    // Single store, own domain: up to 10 pages x 100 = 1000 product URLs
    // (11 subrequests worst case — nowhere near any Worker limit).
    const products = await fetchProducts(tenant.id, 10).catch(() => [] as ProductEntry[]);
    const entries: MetadataRoute.Sitemap = [];
    for (const page of STORE_STATIC_PAGES) {
      entries.push({
        url: `${base}${page.path || '/'}`,
        lastModified: now,
        changeFrequency: page.freq,
        priority: page.priority,
      });
    }
    for (const product of products) {
      entries.push({
        url: `${base}/products/${product.slug}`,
        lastModified: product.updatedAt
          ? new Date(product.updatedAt)
          : product.createdAt
            ? new Date(product.createdAt)
            : now,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
    return entries;
  }

  // Master sitemap: platform path. Covers every store under /<slug>/...
  const siteUrl = getSiteUrl();
  const apex: MetadataRoute.Sitemap = [
    {
      url: `${siteUrl}/`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.5,
    },
  ];

  let stores: StoreListEntry[] = [];
  try {
    stores = await fetchStores();
  } catch (error) {
    console.error('sitemap: failed to fetch stores', error);
    return apex;
  }

  // Bounded fan-out. `fetchStores()` pages up to 50x100 = 5000 stores, and one
  // subrequest per store in a single Worker invocation would blow Cloudflare's
  // 1000-subrequest ceiling as the platform grows — the render would throw past
  // it and the `apex` fallback below is declared too late to save it. Cap the
  // per-render fan-out and emit the remaining stores with their static pages
  // only (their 11 static pages still get indexed; their catalogs don't
  // contribute product URLs to this render). Chunked rather than one
  // Promise.all so we also stop opening 200 sockets at once against the API.
  //
  // Subrequest budget (worst case): 50 store-list pages + 1 host resolve +
  // 200 stores x 3 product pages = 651, under the 1000 ceiling with headroom.
  const MAX_STORES_WITH_PRODUCTS = 200;
  const PRODUCT_PAGES_PER_STORE = 3; // x100 = up to 300 product URLs per store
  const FANOUT_CHUNK = 20;

  // /public/stores returns newest-first (`orderBy createdAt desc`), so a
  // positional slice used to keep the 200 NEWEST stores and silently drop
  // product URLs for every older one — the longest-tenured, largest-catalog
  // anchor tenants lost their catalogs first while brand-new (possibly
  // empty) stores kept theirs (audit-followup #1146/#1162). Select
  // oldest-first for the product fan-out instead: deterministic, and
  // priority-correct for accumulated SEO equity.
  const byOldestFirst = [...stores].sort((a, b) =>
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  );
  const withProducts = byOldestFirst.slice(0, MAX_STORES_WITH_PRODUCTS);
  const withoutProducts = byOldestFirst.slice(MAX_STORES_WITH_PRODUCTS);
  if (withoutProducts.length > 0) {
    // No-silent-caps rule: the drop must be observable in Worker logs.
    console.warn('sitemap: product fan-out capped', {
      total: stores.length,
      withProducts: withProducts.length,
      dropped: withoutProducts.length,
    });
  }

  const productResults: Array<{ store: StoreListEntry; products: ProductEntry[] }> = [];
  for (let i = 0; i < withProducts.length; i += FANOUT_CHUNK) {
    const chunk = withProducts.slice(i, i + FANOUT_CHUNK);
    productResults.push(
      ...(await Promise.all(
        chunk.map(store =>
          fetchProducts(store.id, PRODUCT_PAGES_PER_STORE)
            .then(products => ({ store, products }))
            .catch(() => ({ store, products: [] as ProductEntry[] }))
        )
      ))
    );
  }
  for (const store of withoutProducts) {
    productResults.push({ store, products: [] });
  }

  const perTenant: MetadataRoute.Sitemap = [];
  for (const { store, products } of productResults) {
    for (const page of STORE_STATIC_PAGES) {
      perTenant.push({
        url: `${siteUrl}/${store.slug}${page.path}`,
        lastModified: now,
        changeFrequency: page.freq,
        priority: page.priority,
      });
    }
    for (const product of products) {
      perTenant.push({
        url: `${siteUrl}/${store.slug}/products/${product.slug}`,
        lastModified: product.updatedAt
          ? new Date(product.updatedAt)
          : product.createdAt
            ? new Date(product.createdAt)
            : now,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
  }

  // Sitemap protocol hard limit: 50,000 URLs per file (sitemaps.org) —
  // past it Google reports an error and processes at most the first 50k.
  // With 11 static pages per store, a full 5000-store fetch alone would
  // emit 55,001 URLs, so clamp and log rather than ship an invalid
  // document (audit-followup #1148/#1164). Product-bearing (oldest/anchor)
  // stores are emitted first, so the clamp drops the newest stores' static
  // pages last. The real fix past ~4,500 stores is sharding — but NOT via
  // Next's `generateSitemaps()`, which remaps the route to
  // `/sitemap/[id].xml` and 404s the bare `/sitemap.xml` every merchant
  // has already submitted to GSC (verified against next@16.2.6's
  // metadata-route loader; Next generates no sitemap index file).
  const SITEMAP_URL_LIMIT = 50_000;
  const entries = [...apex, ...perTenant];
  if (entries.length > SITEMAP_URL_LIMIT) {
    console.error('sitemap: master sitemap exceeds the 50k-URL protocol limit — truncating', {
      total: entries.length,
      emitted: SITEMAP_URL_LIMIT,
      stores: stores.length,
    });
    return entries.slice(0, SITEMAP_URL_LIMIT);
  }
  return entries;
}
