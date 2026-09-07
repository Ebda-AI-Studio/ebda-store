import { notFound } from 'next/navigation';
import type { ResolvedStore } from '../../lib/store-resolver';
import { API_URL, type PublicBundle } from '../../lib/api';
import { breadcrumbJsonLd, itemList, storeAbsoluteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import BundlesClient from './BundlesClient';

/**
 * Bundles index (PLP-equivalent for fixed kits) page body — extracted the
 * same way `products/ProductsPageBody.tsx` / `categories/CategoriesPageBody.tsx`
 * are, so the same rendering logic can serve a future params-based
 * tenant-store route without duplication (see those files' own doc
 * comments for the tenant-cacheable-routing background).
 *
 * Unlike both of those, this fetches only ONE thing: `GET
 * /stores/public/:storeId/bundles` is already pre-filtered to
 * `isPurchasable` bundles only and has no pagination param (bundle.routes.ts:
 * "a merchant hand-curates a small set of bundles"), so there is no
 * page-builder layout config to fetch either — see
 * `bundles/[slug]/BundleDetailBody.tsx`'s doc comment on why a bundle page
 * has none.
 */

/**
 * Returns `null` (never `[]`) specifically when the store lacks the
 * `bundles` feature (403 `FEATURE_DISABLED`) — the caller turns that into a
 * real 404, matching this branch's central safety promise that a
 * feature-off store gets "no page" for `/bundles`, not an empty-but-live
 * one. An empty PURCHASABLE-bundle list on a feature-ON store is a
 * perfectly normal 200 (`[]`) and renders the client's own empty state
 * instead — the two cases must never be conflated.
 */
async function fetchBundles(store: {
  id: string;
  domain?: string;
}): Promise<PublicBundle[] | null> {
  if (!store.id || store.id === 'demo') return [];
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Store-ID': store.id,
      ...(store.domain ? { 'x-store-domain': store.domain } : {}),
    };
    const response = await fetch(
      `${API_URL}/stores/public/${encodeURIComponent(store.id)}/bundles`,
      {
        next: { revalidate: 60, tags: [`products:${store.id}`] },
        headers,
      }
    );
    if (response.status === 403) return null;
    if (!response.ok) return [];
    const data = await response.json();
    return data?.data?.bundles ?? [];
  } catch {
    return [];
  }
}

export async function BundlesPageBody({ store }: { store: ResolvedStore }) {
  const bundles = await fetchBundles(store);

  // Store without the `bundles` feature — no page, exactly like the
  // `/bundles` route never existing at all (mirrors
  // `BundleDetailBody.fetchInitialBundle`'s identical 403-means-404
  // treatment for the single-bundle page).
  if (bundles === null && store.id !== 'demo') {
    notFound();
  }
  const purchasableBundles = bundles ?? [];

  const bundlesBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: storeAbsoluteUrl(store, '') },
    { name: 'Bundles', url: storeAbsoluteUrl(store, '/bundles') },
  ]);

  const bundlesItemList =
    purchasableBundles.length > 0
      ? itemList(
          purchasableBundles.map(b => ({
            name: b.name,
            url: storeAbsoluteUrl(store, `/bundles/${b.slug}`),
            image: b.image,
            price: b.price,
            currency: store.currency,
            inStock: b.available === undefined || b.available > 0,
          })),
          'Bundles'
        )
      : null;

  return (
    <>
      {/* JSON-LD: Breadcrumb + optional ItemList of purchasable bundles */}
      <JsonLd data={bundlesBreadcrumb} />
      {bundlesItemList && <JsonLd data={bundlesItemList} />}
      <BundlesClient bundles={purchasableBundles} />
    </>
  );
}
