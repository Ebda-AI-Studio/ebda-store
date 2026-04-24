import { getStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import type { Product, Category } from '../lib/api';
import { HomePageContent } from './HomePageContent';

/**
 * Server-side data fetch for the homepage. Mirrors the pattern in
 * `app/products/page.tsx` — featured products + categories are fetched
 * with `next.revalidate` so the LCP path doesn't wait for a client-side
 * `useEffect → api.getProducts` round-trip.
 *
 * Falls back to the latest 8 active products when no featured products
 * exist (matches the old client-side behaviour).
 */
async function fetchHomepageData(store: { id: string; domain?: string }): Promise<{
  featuredProducts: Product[];
  categories: Category[];
}> {
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Store-ID': store.id,
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };

  if (!store.id || store.id === 'demo') {
    return { featuredProducts: [], categories: [] };
  }

  const [featuredResult, categoriesResult] = await Promise.all([
    fetch(`${API_URL}/public/products?featured=true&limit=8`, {
      next: { revalidate: 60 },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 60 },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  let featuredProducts: Product[] = featuredResult?.data?.products ?? [];

  // Fallback: latest 8 active products if there are no featured ones.
  if (featuredProducts.length === 0) {
    const fallbackResult = await fetch(`${API_URL}/public/products?limit=8`, {
      next: { revalidate: 60 },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    featuredProducts = fallbackResult?.data?.products ?? [];
  }

  const categories: Category[] = categoriesResult?.data?.categories ?? [];

  return { featuredProducts, categories };
}

export default async function HomePage() {
  const store = await getStore();
  const { featuredProducts, categories } = await fetchHomepageData(store);

  return (
    <HomePageContent
      templateId={store.template}
      featuredProducts={featuredProducts}
      categories={categories}
      storeName={store.name}
    />
  );
}
