import type { ResolvedStore } from '../../lib/store-resolver';
import { API_URL, type Category } from '@/lib/api';
import { publicLayoutUrl } from '../../lib/preview-draft';
import { resolveLayoutSettings, type CategoriesPageSettings } from '@ebda/shared';
import { breadcrumbJsonLd, itemList, storeAbsoluteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import CategoriesClient from './CategoriesClient';

/**
 * Categories page body — extracted 2026-07-12 (tenant-cacheable routing,
 * Phase 1) so the SAME rendering logic serves both
 * `app/categories/page.tsx` (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/categories/page.tsx` (new, params-based,
 * dark-launched). See docs/plans/done/2026-07-12-tenant-cacheable-routing.md
 * §3.6/§9.
 */

/** Fetch the categoriesPage layout settings for SSR so bgColor/colorScheme/
 *  density/textScale paint on the first server render without a layout-flash. */
async function fetchCategoriesPageSettings(
  store: { id: string },
  draftToken?: string
): Promise<CategoriesPageSettings | undefined> {
  if (!store.id || store.id === 'demo') return undefined;
  try {
    const res = await fetch(
      publicLayoutUrl(API_URL, store.id, draftToken),
      draftToken
        ? { cache: 'no-store' }
        : { next: { revalidate: 60, tags: [`layout:${store.id}`] } }
    );
    if (!res.ok) return undefined;
    const json = await res.json();
    const layout = resolveLayoutSettings(json?.data?.layout ?? {});
    return layout.categoriesPage ? { ...layout.categoriesPage } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch categories server-side so the page renders with data immediately,
 * eliminating the client-side loading spinner on first paint.
 */
async function fetchCategories(store: { id: string; domain?: string }): Promise<Category[]> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // For store-aware routing, pass the domain header so the public endpoint
    // returns categories scoped to this store.
    if (store.domain) {
      headers['x-store-domain'] = store.domain;
    }
    if (store.id && store.id !== 'demo') {
      headers['X-Store-ID'] = store.id;
    }

    const response = await fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 60, tags: [`categories:${store.id}`] },
      headers,
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (data.success && data.data?.categories) {
      return data.data.categories;
    }
    return [];
  } catch {
    return [];
  }
}

export async function CategoriesPageBody({
  store,
  draftToken,
}: {
  store: ResolvedStore;
  /** Always `undefined` from the new `tenant-store` tree — see HomePageBody's
   *  doc comment for why Track-A never carries a draft token. */
  draftToken?: string;
}) {
  const [categories, categoriesPage] = await Promise.all([
    fetchCategories(store),
    fetchCategoriesPageSettings(store, draftToken),
  ]);

  const categoriesBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: storeAbsoluteUrl(store, '') },
    { name: 'Categories', url: storeAbsoluteUrl(store, '/categories') },
  ]);

  // Represent each category as an ItemList entry so AI agents understand
  // the taxonomy without crawling each category page individually.
  const categoriesItemList =
    categories.length > 0
      ? itemList(
          categories.slice(0, 50).map((c: Category) => ({
            name: c.name,
            // `/categories/<slug>` is not a real route anywhere in this app
            // (see `fixCategoryLinks` in `app/llms.txt/route.ts` for the
            // full writeup — same A4-2 defect class) — the storefront's
            // actual category-browse URL is `/products?category=<slug>`.
            url: storeAbsoluteUrl(store, `/products?category=${c.slug}`),
            image: c.image ?? null,
            price: null,
          })),
          'Product Categories'
        )
      : null;

  return (
    <>
      {/* JSON-LD: Breadcrumb + optional ItemList of categories */}
      <JsonLd data={categoriesBreadcrumb} />
      {categoriesItemList && <JsonLd data={categoriesItemList} />}
      <CategoriesClient categories={categories} categoriesPage={categoriesPage} />
    </>
  );
}
