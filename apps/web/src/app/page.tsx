import { getStoreOrNotFound } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import type { Product, Category } from '../lib/api';
import { resolveLayoutSettings, type StoreLayoutSettings } from '@force/shared';
import { storeJsonLd, breadcrumbJsonLd, itemList, getSiteUrl } from '../lib/structured-data';
import { JsonLd } from '../components/JsonLd';
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
  /** Products fetched specifically for layout.extracarousels entries with
   *  `productSource === 'category'` or `'manual'`. Keyed for de-dup before
   *  the storefront filter pass; HomePageContent merges them into the
   *  product union for source resolution. */
  extraProducts: Product[];
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
      extraProducts: [],
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

  // Extra carousels (page-builder section duplication) — fetch products for
  // any entries with `productSource === 'category'` or `'manual'`. Otherwise
  // the storefront filter only sees the union of newArrivals/bestSellers/
  // featured, which misses products in unrelated categories or manually-
  // chosen products not in any of those lists.
  const extras = layout.extraCarousels ?? [];
  // For each unique category slug, pick the MAX requested fetch limit
  // across all extras using that slug (default 50). One slug used by 2
  // carousels with limits 100 + 80 → fetch 100 once, both carousels share.
  const categoryFetchMap = new Map<string, number>();
  for (const e of extras) {
    if (e.enabled === false) continue;
    if (e.productSource !== 'category') continue;
    if (!e.categorySlug) continue;
    const cap = Math.max(1, Math.min(200, e.categoryFetchLimit ?? 50));
    const existing = categoryFetchMap.get(e.categorySlug) ?? 0;
    if (cap > existing) categoryFetchMap.set(e.categorySlug, cap);
  }
  const categoryFetches = Array.from(categoryFetchMap.entries());
  const manualIds = Array.from(
    new Set(
      extras
        .filter(e => e.enabled !== false && e.productSource === 'manual')
        .flatMap(e => e.manualProductIds ?? [])
    )
  );
  const extraResults = await Promise.all([
    ...categoryFetches.map(([slug, fetchLimit]) =>
      fetch(`${API_URL}/public/products?category=${encodeURIComponent(slug)}&limit=${fetchLimit}`, {
        next: { revalidate: 60 },
        headers: storeHeaders,
      })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
    ),
    manualIds.length > 0
      ? fetch(
          `${API_URL}/public/products?ids=${encodeURIComponent(manualIds.join(','))}&limit=50`,
          {
            next: { revalidate: 60 },
            headers: storeHeaders,
          }
        )
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const extraProductsMap = new Map<string, Product>();
  for (const result of extraResults) {
    const list: Product[] = result?.data?.products ?? [];
    for (const p of list) {
      if (p?.id) extraProductsMap.set(p.id, p);
    }
  }
  const extraProducts: Product[] = Array.from(extraProductsMap.values());

  return { featuredProducts, newArrivals, bestSellers, categories, testimonials, extraProducts };
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
  const { featuredProducts, newArrivals, bestSellers, categories, testimonials, extraProducts } =
    await fetchHomepageData(store, layout);

  const siteUrl = getSiteUrl(store);
  const socialUrls = store.socialLinks
    ? (Object.values(store.socialLinks).filter(Boolean) as string[])
    : undefined;

  const homeStoreJsonLd = storeJsonLd({
    name: store.name,
    url: siteUrl,
    logo: store.logo,
    email: store.email,
    phone: store.phone,
    address: store.address,
    description: store.description,
    social: socialUrls,
    inLanguage: (store.settings as Record<string, unknown>)?.defaultLanguage === 'ar' ? 'ar' : 'en',
  });

  const homeBreadcrumbJsonLd = breadcrumbJsonLd([{ name: 'Home', url: siteUrl }]);

  // Emit featured products in an ItemList so AI/search agents see the
  // product catalogue without following individual product URLs.
  const homeItemListJsonLd =
    featuredProducts.length > 0
      ? itemList(
          featuredProducts.slice(0, 50).map(p => ({
            name: p.name,
            url: `${siteUrl}/products/${p.slug}`,
            image: p.images?.[0]?.url ?? null,
            price: p.price,
            currency: store.currency,
            inStock: p.inventory === undefined || p.inventory > 0,
          })),
          'Featured Products'
        )
      : null;

  return (
    <>
      {/* JSON-LD: Store + Breadcrumb + optional ItemList */}
      <JsonLd data={homeStoreJsonLd} />
      <JsonLd data={homeBreadcrumbJsonLd} />
      {homeItemListJsonLd && <JsonLd data={homeItemListJsonLd} />}
      <HomePageContent
        templateId={store.template}
        featuredProducts={featuredProducts}
        newArrivals={newArrivals}
        bestSellers={bestSellers}
        categories={categories}
        testimonials={testimonials}
        extraProducts={extraProducts}
        storeName={store.name}
        layout={layout}
      />
    </>
  );
}
