import { redirect } from 'next/navigation';
import { PLATFORM_MARKETING_URL } from '../lib/platform';
import type { ResolvedStore } from '../lib/store-resolver';
import { API_URL } from '../lib/api';
import { idChunks, MANUAL_IDS_PER_FETCH } from '../builder/sections/section-products';
import type { Product, Category, PublicTag } from '../lib/api';
import {
  resolveLayoutSettings,
  type StoreLayoutSettings,
  resolveDefaultLanguage,
  pageDefinitionSchema,
  definitionToLayout,
  applyTypographyPatch,
  applyThemePatch,
  hasTypographyPatch,
  type PageDefinition,
} from '@ebda/shared';
import { storeJsonLd, breadcrumbJsonLd, itemList, storeAbsoluteUrl } from '../lib/structured-data';
import { JsonLd } from '../components/JsonLd';
import { HomePageContent } from './HomePageContent';
import { BuilderPreviewShell } from '../builder/preview/BuilderPreviewShell';
import { allowedParentOrigins } from '../builder/preview/allowed-parent-origins';
import { emitZoneCss } from '../lib/emit-zone-css';
import { buildThemeStyleTag } from '../lib/theme-css';
import { canBuyNow, inStockNow } from '../lib/can-buy-now';
import { demoHomeDefinition } from '../lib/demo-home';

/**
 * Homepage body — extracted 2026-07-12 (tenant-cacheable routing, Phase 1)
 * so the SAME rendering logic serves both:
 *  - `app/page.tsx` (legacy, header-based `getStoreOrNotFound()` resolver,
 *    always dynamic, unchanged behavior), and
 *  - `app/tenant-store/[tenant]/[locale]/page.tsx` (new, params-based
 *    `getStoreByTenantParam()` resolver, dark-launched behind
 *    `STOREFRONT_TENANT_ROUTING` — see
 *    docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6/§9).
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
  authorName: string | null;
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

/** Refs of the document-only product sections (category slug → fetch cap, product ids),
 *  including every shop-the-look `look` block's pieces (loaded into `extraProducts`). */
function documentSectionRefs(def: PageDefinition | undefined): {
  categories: Array<[string, number]>;
  productIds: string[];
  newest: number;
  bestSellers: number;
  /** A document section reads the `on_sale` source (Phase B2): load the deals row. */
  onSale: boolean;
} {
  const categories: Array<[string, number]> = [];
  const productIds: string[] = [];
  let newest = 0;
  let bestSellers = 0;
  let onSale = false;
  for (const n of def?.sections ?? []) {
    if (n.hidden === true) continue;
    // Shop-the-look pieces and routine-step products (Phase B3) are product refs held in blocks.
    if (n.type === 'shop-the-look' || n.type === 'steps') {
      for (const b of n.blocks ?? []) {
        const ids = (b.settings as { productIds?: unknown }).productIds;
        if (b.hidden !== true && Array.isArray(ids))
          for (const id of ids) if (typeof id === 'string') productIds.push(id);
      }
      continue;
    }
    if (n.type !== 'featured-collection' && n.type !== 'product-spotlight') continue;
    const s = n.settings as {
      productSource?: string;
      categorySlug?: unknown;
      manualProductIds?: unknown;
    };
    if (s.productSource === 'category' && typeof s.categorySlug === 'string' && s.categorySlug)
      categories.push([s.categorySlug, 24]);
    if (s.productSource === 'manual' && Array.isArray(s.manualProductIds))
      for (const id of s.manualProductIds) if (typeof id === 'string') productIds.push(id);
    const limit = Math.min(24, Number((n.settings as { limit?: unknown }).limit) || 8);
    // newest is also every section's empty-match fallback, so it is always loaded.
    newest = Math.max(newest, limit);
    if (s.productSource === 'best_seller') bestSellers = Math.max(bestSellers, limit);
    if (s.productSource === 'on_sale') onSale = true;
  }
  return { categories, productIds, newest, bestSellers, onSale };
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
  },
  /** Catalogue refs held by document-only product sections
   *  (featured-collection / product-spotlight), fetched alongside the
   *  extra-carousel refs so a hand-picked or category grid has its products. */
  docRefs: {
    categories: Array<[string, number]>;
    productIds: string[];
    newest: number;
    bestSellers: number;
    onSale: boolean;
  } = {
    categories: [],
    productIds: [],
    newest: 0,
    bestSellers: 0,
    onSale: false,
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
  /** The `sort=on_sale` response in the API's order (biggest drop first, disabled variants and
   *  other stores' products already excluded in SQL). `undefined` = no deals row on this page. The
   *  deals row reads THIS, never a client re-derivation: the listing payload does not carry
   *  `isActive`, so a disabled variant's compare-at would count as a sale (STOP-2 final review). */
  onSalePool?: Product[];
  /** The skin-type / concern chips, fetched only when the category row is tag-sourced. */
  tags?: PublicTag[];
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

  const newArrivalsLimit = Math.max(
    layout.newArrivals.enabled ? layout.newArrivals.limit : 0,
    docRefs.newest
  );
  const bestSellersLimit = Math.max(
    layout.bestSellers.enabled ? layout.bestSellers.limit : 0,
    docRefs.bestSellers
  );

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
  for (const [slug, cap] of docRefs.categories) {
    if (cap > (categoryFetchMap.get(slug) ?? 0)) categoryFetchMap.set(slug, cap);
  }
  const categoryFetches = Array.from(categoryFetchMap.entries());
  const manualIds = Array.from(
    new Set([
      ...extras
        .filter(e => e.enabled !== false && e.productSource === 'manual')
        .flatMap(e => e.manualProductIds ?? []),
      ...docRefs.productIds,
    ])
  );

  // The deals row (Phase B2): one capped request, only when a section or an extra carousel asks.
  // CACHE CLASS: BOUNDED-stale, the same `products:<storeId>` storefront tag as every list here.
  const wantsOnSale =
    docRefs.onSale || extras.some(e => e.enabled !== false && e.productSource === 'on_sale');

  const [
    featuredResult,
    categoriesResult,
    newArrivalsResult,
    bestSellersResult,
    testimonialsResult,
    categoryResults,
    manualResults,
    onSaleResult,
    tagsResult,
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
    // Chunked so every referenced id is fetched (two shop-the-look sections alone can name 48
    // pieces, plus carousel/spotlight picks); the public route caps one page at 50.
    Promise.all(
      idChunks(manualIds).map(chunk =>
        fetch(
          `${API_URL}/public/products?ids=${encodeURIComponent(chunk.join(','))}&limit=${MANUAL_IDS_PER_FETCH}`,
          {
            next: { revalidate: 60, tags: [`products:${store.id}`] },
            headers: storeHeaders,
          }
        )
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    ),
    wantsOnSale
      ? fetch(`${API_URL}/public/products?sort=on_sale&limit=12`, {
          next: { revalidate: 60, tags: [`products:${store.id}`] },
          headers: storeHeaders,
        })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
    // The chips row (Phase B3, Ruling B3-5): one capped request, only when the category row lists
    // tags. CACHE CLASS: BOUNDED-stale, the same `products:<storeId>` storefront tag as every list.
    layout.categories.enabled && layout.categories.source === 'tags'
      ? fetch(`${API_URL}/public/tags`, {
          next: { revalidate: 60, tags: [`products:${store.id}`] },
          headers: storeHeaders,
        })
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
  for (const result of [...categoryResults, ...manualResults, onSaleResult]) {
    const list: Product[] = result?.data?.products ?? [];
    for (const p of list) {
      if (p?.id) extraProductsMap.set(p.id, p);
    }
  }
  const extraProducts: Product[] = Array.from(extraProductsMap.values());

  const onSalePool: Product[] | undefined = wantsOnSale
    ? ((onSaleResult?.data?.products as Product[] | undefined) ?? [])
    : undefined;

  return {
    featuredProducts,
    newArrivals,
    bestSellers,
    categories,
    testimonials,
    extraProducts,
    onSalePool,
    tags: (tagsResult?.data?.tags as PublicTag[] | undefined) ?? undefined,
  };
}

interface DraftBundle {
  layout: StoreLayoutSettings;
  typography?: unknown;
  theme?: unknown;
  /** Published builder document (committed path only). Structurally
   *  validated here; an invalid one is ignored and the page renders from
   *  `layout` via the adapter, which is what it rendered before. */
  definition?: PageDefinition;
}

function parseDefinition(raw: unknown): PageDefinition | undefined {
  if (!raw) return undefined;
  const parsed = pageDefinitionSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Builder canvas: the working DRAFT for a preview token (never cached). Null
 * on any failure, and the page then renders exactly like a normal visit.
 */
async function fetchBuilderPreview(
  storeId: string,
  token: string
): Promise<PageDefinition | undefined> {
  try {
    const res = await fetch(
      `${API_URL}/public/stores/${storeId}/builder-preview?token=${encodeURIComponent(token)}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return undefined;
    const json = await res.json();
    return parseDefinition(json?.data?.definition);
  } catch {
    return undefined;
  }
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
    const res = await fetch(
      url,
      draftToken
        ? { cache: 'no-store' }
        : // Tagged so a layout save can purge it (api `bustStoreCaches` -> /api/revalidate).
          { next: { revalidate: 60, tags: [`layout:${storeId}`] } }
    );
    if (!res.ok) return { layout: resolveLayoutSettings({}) };
    const json = await res.json();
    return {
      layout: resolveLayoutSettings(json?.data?.layout ?? {}),
      // Bundle keys are only populated by the API when a draft is being
      // served — the committed-layout path returns just `layout`.
      typography: json?.data?.typography,
      theme: json?.data?.theme,
      definition: draftToken ? undefined : parseDefinition(json?.data?.definition),
    };
  } catch {
    return { layout: resolveLayoutSettings({}) };
  }
}

export async function HomePageBody({
  store,
  draftToken,
  builderToken,
}: {
  store: ResolvedStore;
  /** Admin page-builder "preview unsaved changes" token. Always `undefined`
   *  from the new `tenant-store` tree — preview traffic bypasses that tree
   *  entirely (middleware's `!isPreviewIframe` gate), so there's no draft
   *  concept to thread through there. */
  draftToken?: string;
  /** Visual builder canvas token (`?_builder=` inside the `?_preview` iframe). */
  builderToken?: string;
}) {
  // Bare-root on a platform domain (no slug, no custom domain) — send the
  // visitor to the marketing site rather than rendering a second one here.
  //
  // This URL used to serve its own `EditorialLanding`, because at the time
  // ebda.app did not pitch the store-builder service. It does now, and
  // covers the whole product range, so a separate pitch on the platform host
  // only competed with it for the same search terms under a worse title
  // ("Force - Online Shopping in Egypt").
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

  const [draftBundle, builderDefinition] = await Promise.all([
    fetchLayoutSettings(store.id, draftToken),
    builderToken ? fetchBuilderPreview(store.id, builderToken) : Promise.resolve(undefined),
  ]);
  // Demo showroom (Ruling B1-8): the published superset document rendered through the current
  // look's section mix. The SAME object for every non-demo store, so this is a no-op there.
  const homeDefinition = builderDefinition
    ? undefined
    : demoHomeDefinition(store, draftBundle.definition);
  const demoMixed = !builderDefinition && homeDefinition !== draftBundle.definition;
  // Builder canvas: the DRAFT drives everything the page fetches and the
  // chrome reads (a draft carousel must load its own products), projected
  // onto the legacy shape the fetchers understand. The demo mix is projected the same way.
  const layout = builderDefinition
    ? definitionToLayout(builderDefinition)
    : demoMixed && homeDefinition
      ? definitionToLayout(homeDefinition)
      : draftBundle.layout;
  // Draft typography + theme override CSS — emitted in body so source order
  // beats the head-emitted committed-store typography. Only present when the
  // admin live-preview iframe passes ?_layoutDraft=<token> AND the draft
  // bundle includes typography. The CSS string mirrors layout.tsx's emitter.
  const draftStyleCss =
    draftToken && draftBundle.typography
      ? emitZoneCss(draftBundle.typography as Parameters<typeof emitZoneCss>[0], store.theme)
      : '';
  const {
    featuredProducts,
    newArrivals,
    bestSellers,
    categories,
    testimonials,
    extraProducts,
    onSalePool,
    tags,
  } = await fetchHomepageData(
    store,
    layout,
    {
      featured: featuredPromise,
      categories: categoriesPromise,
    },
    documentSectionRefs(builderDefinition ?? homeDefinition)
  );

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
    inLanguage: resolveDefaultLanguage(
      (store.settings as Record<string, unknown>)?.defaultLanguage
    ),
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
            inStock: inStockNow(p),
            acceptsBackorder: canBuyNow(p) && !inStockNow(p),
          })),
          'Featured Products'
        )
      : null;

  // CSS string is sanitized by emitZoneCss (sanitizeFontValue strips CSS
  // injection vectors). Same pattern + same sanitization as the existing
  // typography emitter in apps/web/src/app/layout.tsx.
  const draftStyleProp = draftStyleCss ? { __html: draftStyleCss } : null;
  // Builder canvas: the draft's pending theme patch, as a body-level :root rule
  // so the server-rendered first paint already shows it (it follows the head's
  // committed-theme tag in source order). The client override in
  // BuilderPreviewShell takes over after hydration.
  const builderThemeCss = builderDefinition?.theme
    ? buildThemeStyleTag(applyThemePatch(store.theme ?? {}, builderDefinition.theme), store.look)
    : '';
  // Same for the draft's pending fonts + typography zones (Ruling VE-4): the live typography with the
  // patch on top, through the one zone-CSS emitter the draft preview already uses.
  const builderTypographyCss =
    builderDefinition && hasTypographyPatch(builderDefinition.typography)
      ? emitZoneCss(
          applyTypographyPatch(store.typography, builderDefinition.typography),
          store.theme
        )
      : '';
  return (
    <>
      {builderThemeCss && <style dangerouslySetInnerHTML={{ __html: builderThemeCss }} />}
      {builderTypographyCss && <style dangerouslySetInnerHTML={{ __html: builderTypographyCss }} />}
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
      {builderDefinition ? (
        <BuilderPreviewShell
          templateId={store.template}
          featuredProducts={featuredProducts}
          newArrivals={newArrivals}
          bestSellers={bestSellers}
          categories={categories}
          testimonials={testimonials}
          extraProducts={extraProducts}
          onSalePool={onSalePool}
          tags={tags}
          storeName={store.name}
          layout={layout}
          initialDefinition={builderDefinition}
          liveTypography={store.typography}
          allowedOrigins={allowedParentOrigins()}
        />
      ) : (
        <HomePageContent
          templateId={store.template}
          featuredProducts={featuredProducts}
          newArrivals={newArrivals}
          bestSellers={bestSellers}
          categories={categories}
          testimonials={testimonials}
          extraProducts={extraProducts}
          onSalePool={onSalePool}
          tags={tags}
          storeName={store.name}
          layout={layout}
          definition={homeDefinition}
        />
      )}
    </>
  );
}
