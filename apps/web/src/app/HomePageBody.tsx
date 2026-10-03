import { redirect } from 'next/navigation';
import { PLATFORM_MARKETING_URL } from '../lib/platform';
import type { ResolvedStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import type { Product, Category } from '../lib/api';
import { resolveLayoutSettings, type StoreLayoutSettings } from '@force/shared';
import { storeJsonLd, breadcrumbJsonLd, itemList, storeAbsoluteUrl } from '../lib/structured-data';
import { JsonLd } from '../components/JsonLd';
import { HomePageContent } from './HomePageContent';
import { emitZoneCss } from '../lib/emit-zone-css';

/**
 * Homepage body — extracted 2026-07-12 (tenant-cacheable routing, Phase 1)
 * so the SAME rendering logic serves both:
 *  - `app/page.tsx` (legacy, header-based `getStoreOrNotFound()` resolver,
 *    always dynamic, unchanged behavior), and
 *  - `app/tenant-store/[tenant]/[locale]/page.tsx` (new, params-based
 *    `getStoreByTenantParam()` resolver, dark-launched behind
 *    `STOREFRONT_TENANT_ROUTING` — see
 *    docs/plans/2026-07-12-tenant-cacheable-routing.md §3.6/§9).
 *
 * Takes the already-resolved `store` (and, for the legacy caller only, the
 * already-resolved admin preview-draft token) as props instead of resolving
 * either itself — this component has ZERO Dynamic-API calls of its own.
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

interface ProductsApiResult {
  data?: { products?: Product[] };
}

interface CategoriesApiResult {
  data?: { categories?: Category[] };
}

/** Layout-independent homepage fetches — kicked off by the page component
 *  concurrently with `fetchLayoutSettings` instead of waiting for layout
 *  first (Lens M streaming fallback — see the HomePageBody() call site). */
function fetchFeaturedProducts(
  storeHeaders: Record<string, string>,
  storeId: string
): Promise<ProductsApiResult | null> {
  return fetch(`${API_URL}/public/products?featured=true&limit=8`, {
    next: { revalidate: 60, tags: [`products:${storeId}`] },
    headers: storeHeaders,
  })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
}

function fetchHomeCategories(
  storeHeaders: Record<string, string>,
  storeId: string
): Promise<CategoriesApiResult | null> {
  return fetch(`${API_URL}/public/categories`, {
    next: { revalidate: 60, tags: [`categories:${storeId}`] },
    headers: storeHeaders,
  })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
}

async function fetchHomepageData(
  store: { id: string; domain?: string },
  layout: StoreLayoutSettings,
  /** Optional promises for the two layout-independent requests, already
   *  started by the caller (in parallel with the layout fetch) — avoids
   *  re-issuing them here. */
  prefetched?: {
    featured?: Promise<ProductsApiResult | null>;
    categories?: Promise<CategoriesApiResult | null>;
  }
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

  // Extra carousels (page-builder section duplication) — fetch products for
  // any entries with `productSource === 'category'` or `'manual'`. Otherwise
  // the storefront filter only sees the union of newArrivals/bestSellers/
  // featured, which misses products in unrelated categories or manually-
  // chosen products not in any of those lists. These depend only on
  // `layout` (already resolved), NOT on the other homepage results below —
  // so they're folded into the SAME Promise.all instead of a second
  // sequential round-trip (Lens M streaming fallback).
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

  const [
    featuredResult,
    categoriesResult,
    newArrivalsResult,
    bestSellersResult,
    testimonialsResult,
    categoryResults,
    manualResult,
  ] = await Promise.all([
    prefetched?.featured ?? fetchFeaturedProducts(storeHeaders, store.id),
    prefetched?.categories ?? fetchHomeCategories(storeHeaders, store.id),
    newArrivalsLimit > 0
      ? fetch(`${API_URL}/public/products?sort=newest&limit=${newArrivalsLimit}`, {
          next: { revalidate: 60, tags: [`products:${store.id}`] },
          headers: storeHeaders,
        })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
    bestSellersLimit > 0
      ? fetch(`${API_URL}/public/products?sort=best_seller&limit=${bestSellersLimit}`, {
          next: { revalidate: 60, tags: [`products:${store.id}`] },
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
    Promise.all(
      categoryFetches.map(([slug, fetchLimit]) =>
        fetch(
          `${API_URL}/public/products?category=${encodeURIComponent(slug)}&limit=${fetchLimit}`,
          { next: { revalidate: 60, tags: [`products:${store.id}`] }, headers: storeHeaders }
        )
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    ),
    manualIds.length > 0
      ? fetch(
          `${API_URL}/public/products?ids=${encodeURIComponent(manualIds.join(','))}&limit=50`,
          {
            next: { revalidate: 60, tags: [`products:${store.id}`] },
            headers: storeHeaders,
          }
        )
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  let featuredProducts: Product[] = featuredResult?.data?.products ?? [];

  // Fallback: latest 8 active products if there are no featured ones. This
  // genuinely depends on the featured-fetch outcome, so it stays sequential.
  if (featuredProducts.length === 0) {
    const fallbackResult = await fetch(`${API_URL}/public/products?limit=8`, {
      next: { revalidate: 60, tags: [`products:${store.id}`] },
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

  const extraProductsMap = new Map<string, Product>();
  for (const result of [...categoryResults, manualResult]) {
    const list: Product[] = result?.data?.products ?? [];
    for (const p of list) {
      if (p?.id) extraProductsMap.set(p.id, p);
    }
  }
  const extraProducts: Product[] = Array.from(extraProductsMap.values());

  return { featuredProducts, newArrivals, bestSellers, categories, testimonials, extraProducts };
}

interface DraftBundle {
  layout: StoreLayoutSettings;
  typography?: unknown;
  theme?: unknown;
}

async function fetchLayoutSettings(storeId: string, draftToken?: string): Promise<DraftBundle> {
  if (!storeId || storeId === 'demo') {
    return { layout: resolveLayoutSettings({}) };
  }
  try {
    const url = draftToken
      ? `${API_URL}/public/stores/${storeId}/layout?_layoutDraft=${encodeURIComponent(draftToken)}`
      : `${API_URL}/public/stores/${storeId}/layout`;
    // Drafts bypass cache (per-iteration unique). Committed layouts cache 60s.
    const res = await fetch(url, draftToken ? { cache: 'no-store' } : { next: { revalidate: 60 } });
    if (!res.ok) return { layout: resolveLayoutSettings({}) };
    const json = await res.json();
    return {
      layout: resolveLayoutSettings(json?.data?.layout ?? {}),
      // Bundle keys are only populated by the API when a draft is being
      // served — the committed-layout path returns just `layout`.
      typography: json?.data?.typography,
      theme: json?.data?.theme,
    };
  } catch {
    return { layout: resolveLayoutSettings({}) };
  }
}

export async function HomePageBody({
  store,
  draftToken,
}: {
  store: ResolvedStore;
  /** Admin page-builder "preview unsaved changes" token. Always `undefined`
   *  from the new `tenant-store` tree — preview traffic bypasses that tree
   *  entirely (middleware's `!isPreviewIframe` gate), so there's no draft
   *  concept to thread through there. */
  draftToken?: string;
}) {
  // Bare-root on a platform domain (no slug, no custom domain) — send the
  // visitor to the marketing site rather than rendering a second one here.
  //
  // This URL used to serve its own `EditorialLanding`, because at the time
  // ebda.app did not pitch the store-builder service. It does now, and
  // covers the whole product range, so a separate pitch on the platform host
  // only competed with it for the same search terms under a worse title
  // ("Force - Online Shopping in Kuwait").
  //
  // 307, not 308: a permanent redirect is cached by browsers indefinitely and
  // would be painful to undo if this host ever needs its own root again.
  if (store.id === 'demo') {
    redirect(PLATFORM_MARKETING_URL);
  }

  // Kick off the two layout-independent homepage fetches (featured products
  // + categories) concurrently with the layout fetch below, instead of
  // waiting for layout first — layout is only needed to size the
  // newArrivals/bestSellers/testimonials/extraCarousels requests inside
  // fetchHomepageData (Lens M streaming fallback: full section-level
  // Suspense streaming would require splitting the monolithic
  // HomePageContent client component, whose section dividers/ordering
  // read sibling sections' bgColor — too invasive for this pass; this is
  // the safer parallelization-only fallback).
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Store-ID': store.id,
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };
  const featuredPromise = fetchFeaturedProducts(storeHeaders, store.id);
  const categoriesPromise = fetchHomeCategories(storeHeaders, store.id);

  const draftBundle = await fetchLayoutSettings(store.id, draftToken);
  const layout = draftBundle.layout;
  // Draft typography + theme override CSS — emitted in body so source order
  // beats the head-emitted committed-store typography. Only present when the
  // admin live-preview iframe passes ?_layoutDraft=<token> AND the draft
  // bundle includes typography. The CSS string mirrors layout.tsx's emitter.
  const draftStyleCss =
    draftToken && draftBundle.typography
      ? emitZoneCss(draftBundle.typography as Parameters<typeof emitZoneCss>[0], store.theme)
      : '';
  const { featuredProducts, newArrivals, bestSellers, categories, testimonials, extraProducts } =
    await fetchHomepageData(store, layout, {
      featured: featuredPromise,
      categories: categoriesPromise,
    });

  const siteUrl = storeAbsoluteUrl(store, '');
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
            url: storeAbsoluteUrl(store, `/products/${p.slug}`),
            image: p.images?.[0]?.url ?? null,
            price: p.price,
            currency: store.currency,
            inStock: p.inventory === undefined || p.inventory > 0,
          })),
          'Featured Products'
        )
      : null;

  // CSS string is sanitized by emitZoneCss (sanitizeFontValue strips CSS
  // injection vectors). Same pattern + same sanitization as the existing
  // typography emitter in apps/web/src/app/layout.tsx.
  const draftStyleProp = draftStyleCss ? { __html: draftStyleCss } : null;
  return (
    <>
      {/* Draft typography override — emitted when ?_layoutDraft=token is
          present AND the draft bundle includes typography. Source order
          puts this AFTER the head's committed-typography style tag, so
          the draft rules win at equal specificity. Powers the page-builder
          "Preview unsaved" iteration loop. */}
      {draftStyleProp && <style dangerouslySetInnerHTML={draftStyleProp} />}
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
