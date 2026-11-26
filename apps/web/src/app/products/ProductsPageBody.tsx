import { Suspense } from 'react';
import { permanentRedirect } from 'next/navigation';
import type { ResolvedStore } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import { publicLayoutUrl } from '../../lib/preview-draft';
import { fetchSlugRedirect, localizedRedirectUrl } from '../../lib/slug-redirect';
import {
  resolveLayoutSettings,
  type ProductCardDefaults,
  type FilterSidebarSettings,
  type ProductsPageSettings,
} from '@ebda/shared';
import { breadcrumbJsonLd, itemList, storeAbsoluteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import ProductsClient from './ProductsClient';
import { defaultPageDocument } from '@ebda/shared';
import { fetchPageDocument } from '../../lib/page-document';
import { PageDocumentProvider } from '../../builder/render/PageDocument';
import { allowedParentOrigins } from '../../builder/preview/allowed-parent-origins';
import { canBuyNow, inStockNow } from '../../lib/can-buy-now';

/**
 * Products (PLP) page body — extracted 2026-07-12 (tenant-cacheable
 * routing, Phase 1) so the SAME rendering logic serves both
 * `app/products/page.tsx` (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/products/page.tsx` (new, params-based,
 * dark-launched). See docs/plans/done/2026-07-12-tenant-cacheable-routing.md
 * §3.6/§9.
 */

interface PlpLayoutSettings {
  productCardDefaults?: ProductCardDefaults;
  filterSidebar?: FilterSidebarSettings;
  productsPage?: ProductsPageSettings;
}

/** Fetch the store's layout settings to read `productCardDefaults` and `filterSidebar`. */
async function fetchPlpLayoutSettings(
  store: { id: string },
  draftToken?: string
): Promise<PlpLayoutSettings> {
  if (!store.id || store.id === 'demo') return {};
  try {
    const res = await fetch(
      publicLayoutUrl(API_URL, store.id, draftToken),
      draftToken
        ? { cache: 'no-store' }
        : { next: { revalidate: 60, tags: [`layout:${store.id}`] } }
    );
    if (!res.ok) return {};
    const json = await res.json();
    const layout = resolveLayoutSettings(json?.data?.layout ?? {});
    return {
      productCardDefaults: layout.productCardDefaults
        ? { ...layout.productCardDefaults }
        : undefined,
      filterSidebar: layout.filterSidebar ? { ...layout.filterSidebar } : undefined,
      productsPage: layout.productsPage ? { ...layout.productsPage } : undefined,
    };
  } catch {
    return {};
  }
}

async function fetchInitialData(
  store: { id: string; domain?: string },
  filters: { category?: string; tag?: string }
) {
  // Always send X-Store-ID so the API doesn't fall back to some other store.
  // x-store-domain is kept as a backup for logging/debugging.
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Store-ID': store.id,
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };

  // No valid store id — bail with empty data rather than 400-ing the SSR pass.
  if (!store.id || store.id === 'demo') {
    return { categories: [], products: [], meta: null };
  }

  // Honour the `category` query param on the SSR fetch. Without this the
  // initial paint shows ALL products before the client-side refetch swaps
  // them out — which the merchant reads as "the filter is broken". Slugs
  // can be Arabic strings (e.g. "أدوات") so encode each value individually
  // via URLSearchParams.
  // No `sort` param → the API uses the merchant's curated per-category order
  // (ProductCategory.position) and returns the WHOLE category. Sending
  // `sort=newest` here filtered the SSR paint to the new-arrivals collection
  // (isNew=true), so a category landed showing only a handful of products.
  const productsQuery = new URLSearchParams({
    page: '1',
    limit: '96',
    // The price filter sizes its slider from `meta.priceMax`, which the API only sends on request.
    withPriceMax: '1',
  });
  if (filters.category) productsQuery.set('category', filters.category);
  if (filters.tag) productsQuery.set('tag', filters.tag);

  // Fetch categories and first page of products in parallel
  const [categoriesResult, productsResult] = await Promise.all([
    fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 60, tags: [`categories:${store.id}`] },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${API_URL}/public/products?${productsQuery.toString()}`, {
      next: { revalidate: 60, tags: [`products:${store.id}`] },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  return {
    categories: categoriesResult?.data?.categories ?? [],
    products: productsResult?.data?.products ?? [],
    meta: productsResult?.data?.meta ?? null,
  };
}

export async function ProductsPageBody({
  store,
  category,
  tag,
  draftToken,
  builderToken,
}: {
  store: ResolvedStore;
  category?: string;
  /** Store tag NAME to filter by (the skin-type / concern chips). */
  tag?: string;
  /** Always `undefined` from the new `tenant-store` tree — see HomePageBody's
   *  doc comment for why Track-A never carries a draft token. */
  draftToken?: string;
  /** Visual builder canvas token (`?_builder=` inside the `?_preview` iframe): renders the page's DRAFT document. */
  builderToken?: string;
}) {
  // Fetch layout in parallel with product data so PLP cards respect the
  // merchant's global productCardDefaults (size, frame color, etc.) and the
  // filterSidebar.enabled / filterSidebar.defaultOpen merchant preferences.
  const [initialData, plpLayout, pageDocument] = await Promise.all([
    fetchInitialData(store, { category, tag }),
    fetchPlpLayoutSettings(store, draftToken),
    // The collection page's section document (published, or the draft for the editor canvas).
    fetchPageDocument(store.id, 'collection', builderToken),
  ]);
  const { productCardDefaults, filterSidebar, productsPage } = plpLayout;

  // Genuine miss on a real store: an unknown `?category=` filter may be a
  // renamed category slug — try to resolve a 308 before falling through.
  // Unlike product/blog, an unknown category is NOT a 404 for this page (the
  // PLP itself is still valid with an empty/ignored filter) — so we only
  // redirect when a real CATEGORY redirect exists; otherwise do nothing.
  if (
    category &&
    store.id !== 'demo' &&
    !(initialData.categories ?? []).some((c: { slug: string }) => c.slug === category)
  ) {
    const toSlug = await fetchSlugRedirect(store, 'category', category);
    if (toSlug && toSlug !== category) {
      permanentRedirect(
        await localizedRedirectUrl(store, `/products?category=${encodeURIComponent(toSlug)}`)
      );
    }
  }

  const productsBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: storeAbsoluteUrl(store, '') },
    { name: 'Products', url: storeAbsoluteUrl(store, '/products') },
  ]);

  // Cap at 50 — remaining products are discoverable via pagination links.
  const productsItemList =
    initialData.products.length > 0
      ? itemList(
          (
            initialData.products as Array<{
              name: string;
              slug: string;
              images: Array<{ url: string }>;
              price: number;
              inventory?: number;
              inStock?: boolean;
              acceptsBackorder?: boolean;
            }>
          )
            .slice(0, 50)
            .map(p => ({
              name: p.name,
              url: storeAbsoluteUrl(store, `/products/${p.slug}`),
              image: p.images?.[0]?.url ?? null,
              price: p.price,
              currency: store.currency,
              inStock: inStockNow(p),
              acceptsBackorder: canBuyNow(p) && !inStockNow(p),
            })),
          'All Products'
        )
      : null;

  return (
    <>
      {/* JSON-LD: Breadcrumb + optional ItemList */}
      <JsonLd data={productsBreadcrumb} />
      {productsItemList && <JsonLd data={productsItemList} />}
      <Suspense
        fallback={
          <main className="flex min-h-screen items-center justify-center bg-background">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </main>
        }
      >
        <PageDocumentProvider
          kind="collection"
          initialDefinition={pageDocument?.definition ?? defaultPageDocument('collection')}
          editorMode={pageDocument?.editorMode === true}
          allowedOrigins={allowedParentOrigins()}
        >
          <ProductsClient
            initialCategories={initialData.categories}
            initialProducts={initialData.products}
            initialMeta={initialData.meta}
            productCardDefaults={productCardDefaults}
            filterSidebar={filterSidebar}
            productsPage={productsPage}
          />
        </PageDocumentProvider>
      </Suspense>
    </>
  );
}
