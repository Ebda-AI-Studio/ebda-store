import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import {
  resolveLayoutSettings,
  type ProductCardDefaults,
  type FilterSidebarSettings,
  type ProductsPageSettings,
} from '@force/shared';
import { breadcrumbJsonLd, itemList, getSiteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import ProductsClient from './ProductsClient';

export const metadata: Metadata = {
  title: 'Products',
  description:
    'Browse our full catalog of products. Find the best deals with fast delivery in Kuwait.',
};

interface PlpLayoutSettings {
  productCardDefaults?: ProductCardDefaults;
  filterSidebar?: FilterSidebarSettings;
  productsPage?: ProductsPageSettings;
}

/** Fetch the store's layout settings to read `productCardDefaults` and `filterSidebar`. */
async function fetchPlpLayoutSettings(store: { id: string }): Promise<PlpLayoutSettings> {
  if (!store.id || store.id === 'demo') return {};
  try {
    const res = await fetch(`${API_URL}/public/stores/${store.id}/layout`, {
      next: { revalidate: 60 },
    });
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
  filters: { category?: string }
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
  const productsQuery = new URLSearchParams({
    page: '1',
    limit: '12',
    sort: 'newest',
  });
  if (filters.category) productsQuery.set('category', filters.category);

  // Fetch categories and first page of products in parallel
  const [categoriesResult, productsResult] = await Promise.all([
    fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 60 },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${API_URL}/public/products?${productsQuery.toString()}`, {
      next: { revalidate: 60 },
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

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await getStoreOrNotFound();
  const params = await searchParams;
  const rawCategory = params.category;
  const category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory;
  // Fetch layout in parallel with product data so PLP cards respect the
  // merchant's global productCardDefaults (size, frame color, etc.) and the
  // filterSidebar.enabled / filterSidebar.defaultOpen merchant preferences.
  const [initialData, plpLayout] = await Promise.all([
    fetchInitialData(store, { category }),
    fetchPlpLayoutSettings(store),
  ]);
  const { productCardDefaults, filterSidebar, productsPage } = plpLayout;

  const siteUrl = getSiteUrl(store);

  const productsBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'Products', url: `${siteUrl}/products` },
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
            }>
          )
            .slice(0, 50)
            .map(p => ({
              name: p.name,
              url: `${siteUrl}/products/${p.slug}`,
              image: p.images?.[0]?.url ?? null,
              price: p.price,
              currency: store.currency,
              inStock: p.inventory === undefined || p.inventory > 0,
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
        <ProductsClient
          initialCategories={initialData.categories}
          initialProducts={initialData.products}
          initialMeta={initialData.meta}
          productCardDefaults={productCardDefaults}
          filterSidebar={filterSidebar}
          productsPage={productsPage}
        />
      </Suspense>
    </>
  );
}
