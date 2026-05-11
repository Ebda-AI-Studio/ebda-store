import type { MetadataRoute } from 'next';
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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl();
  const now = new Date();

  // Apex sitemap entry — the platform landing page lives at the root and is
  // not per-tenant. Per-store URLs all sit under `/<slug>/...`, so that's the
  // only apex URL worth listing.
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

  const productResults = await Promise.all(
    stores.map(store =>
      fetchProducts(store.id)
        .then(products => ({ store, products }))
        .catch(() => ({ store, products: [] as ProductEntry[] }))
    )
  );

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
