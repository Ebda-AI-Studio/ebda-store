import { getStoreOrNotFound } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import type { Product, Category } from '../lib/api';
import { resolveLayoutSettings, type StoreLayoutSettings } from '@force/shared';
import { HomePageContent } from './HomePageContent';
import { PlatformLanding } from '../components/PlatformLanding';

/**
 * Server-side data fetch for the homepage. Mirrors the pattern in
 * `app/products/page.tsx` — featured products + categories are fetched
 * with `next.revalidate` so the LCP path doesn't wait for a client-side
 * `useEffect → api.getProducts` round-trip.
 *
 * Falls back to the latest 8 active products when no featured products
 * exist (matches the old client-side behaviour).
 */
interface HomepageTestimonial {
  id: string;
  rating: number;
  title: string | null;
  comment: string;
  authorName: string;
  authorCity: string | null;
  createdAt: string;
}

async function fetchHomepageData(
  store: { id: string; domain?: string },
  layout: StoreLayoutSettings
): Promise<{
  featuredProducts: Product[];
  newArrivals: Product[];
  bestSellers: Product[];
  categories: Category[];
  testimonials: HomepageTestimonial[];
}> {
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Store-ID': store.id,
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };

  if (!store.id || store.id === 'demo') {
    return {
      featuredProducts: [],
      newArrivals: [],
      bestSellers: [],
      categories: [],
      testimonials: [],
    };
  }

  const newArrivalsLimit = layout.newArrivals.enabled ? layout.newArrivals.limit : 0;
  const bestSellersLimit = layout.bestSellers.enabled ? layout.bestSellers.limit : 0;

  const testimonialsQuery = layout.testimonials.enabled
    ? `?minRating=${layout.testimonials.minRating}&verifiedOnly=${layout.testimonials.verifiedOnly}&limit=6`
    : null;

  const [
    featuredResult,
    categoriesResult,
    newArrivalsResult,
    bestSellersResult,
    testimonialsResult,
  ] = await Promise.all([
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
    newArrivalsLimit > 0
      ? fetch(`${API_URL}/public/products?sort=newest&limit=${newArrivalsLimit}`, {
          next: { revalidate: 60 },
          headers: storeHeaders,
        })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
    bestSellersLimit > 0
      ? fetch(`${API_URL}/public/products?sort=best_seller&limit=${bestSellersLimit}`, {
          next: { revalidate: 60 },
          headers: storeHeaders,
        })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
    testimonialsQuery
      ? fetch(`${API_URL}/public/stores/${store.id}/testimonials${testimonialsQuery}`, {
          next: { revalidate: 300 },
        })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
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
  const newArrivals: Product[] = newArrivalsResult?.data?.products ?? [];
  const bestSellers: Product[] = bestSellersResult?.data?.products ?? [];
  const testimonials: HomepageTestimonial[] = testimonialsResult?.data?.testimonials ?? [];

  return { featuredProducts, newArrivals, bestSellers, categories, testimonials };
}

async function fetchLayoutSettings(storeId: string): Promise<StoreLayoutSettings> {
  if (!storeId || storeId === 'demo') return resolveLayoutSettings({});
  try {
    const res = await fetch(`${API_URL}/public/stores/${storeId}/layout`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return resolveLayoutSettings({});
    const json = await res.json();
    return resolveLayoutSettings(json?.data?.layout ?? {});
  } catch {
    return resolveLayoutSettings({});
  }
}

export default async function HomePage() {
  const store = await getStoreOrNotFound();

  // Bare-root on a platform domain (no slug, no custom domain) —
  // serve the Force Store Builder landing page instead of a merchant
  // homepage. Replaces the old "redirect to forcemediakw.com" flow
  // because the marketing site doesn't actually pitch the store-
  // builder service this URL belongs to.
  if (store.id === 'demo') {
    return <PlatformLanding />;
  }

  const layout = await fetchLayoutSettings(store.id);
  const { featuredProducts, newArrivals, bestSellers, categories, testimonials } =
    await fetchHomepageData(store, layout);

  return (
    <HomePageContent
      templateId={store.template}
      featuredProducts={featuredProducts}
      newArrivals={newArrivals}
      bestSellers={bestSellers}
      categories={categories}
      testimonials={testimonials}
      storeName={store.name}
      layout={layout}
    />
  );
}
