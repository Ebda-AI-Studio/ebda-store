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
    stores.push(...batch.map(s => ({ id: s.id, slug: s.slug })));
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

async function fetchProducts(storeId: string): Promise<ProductEntry[]> {
  const res = await fetch(
    `${API_URL}/public/products?limit=1000&status=published&storeId=${storeId}`,
    {
      next: { revalidate: 3600 },
      headers: { 'Content-Type': 'application/json', 'X-Store-ID': storeId },
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data?.data?.products ?? [];
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
    const products = await fetchProducts(tenant.id).catch(() => [] as ProductEntry[]);
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
  // only (they still get indexed; they just don't contribute product URLs to
  // this render). Chunked rather than one Promise.all so we also stop opening
  // 200 sockets at once against the API.
  const MAX_STORES_WITH_PRODUCTS = 200;
  const FANOUT_CHUNK = 20;

  const withProducts = stores.slice(0, MAX_STORES_WITH_PRODUCTS);
  const withoutProducts = stores.slice(MAX_STORES_WITH_PRODUCTS);

  const productResults: Array<{ store: StoreListEntry; products: ProductEntry[] }> = [];
  for (let i = 0; i < withProducts.length; i += FANOUT_CHUNK) {
    const chunk = withProducts.slice(i, i + FANOUT_CHUNK);
    productResults.push(
      ...(await Promise.all(
        chunk.map(store =>
          fetchProducts(store.id)
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

  return [...apex, ...perTenant];
}
