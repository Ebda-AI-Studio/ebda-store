import { withLocaleAlternates } from '@/lib/seo/locale-alternates';
import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound } from '../../../lib/store-resolver';
import { API_URL } from '../../../lib/api';
import { decodeRouteParam } from '../../../lib/route-params';
import { getPreviewDraftToken } from '../../../lib/preview-draft';
import { resolveStorefrontLocale } from '../../../lib/seo/resolve-locale';
import { builderTokenFrom } from '../../../lib/page-document';
import { buildProductMetadata, ProductDetailBody } from './ProductDetailBody';

/**
 * Server-side metadata for product pages.
 * Fetches product data to populate title, description, and og:image
 * so that search engines and social previews get the correct content
 * without waiting for client-side hydration.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  // `decodeRouteParam` — Next hands the page component the RAW segment while
  // generateMetadata gets the decoded one; see lib/route-params.ts.
  const slug = decodeRouteParam((await params).slug);
  const store = await getStore();

  // Fetch product data server-side for meta tags
  try {
    const storeId = store.id !== 'demo' ? store.id : null;
    if (!storeId) {
      return { title: 'Product' };
    }

    // Storefront SSR carries no auth token, so the authenticated
    // /stores/:id/products/:slug endpoint always 401'd here (~4957x/day in
    // Sentry) before falling through to this public call. Hit the public
    // endpoint directly — it resolves the store from the X-Store-ID header.
    const response = await fetch(`${API_URL}/public/products/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60, tags: [`products:${store.id}`] },
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': store.id,
        ...(store.domain ? { 'x-store-domain': store.domain } : {}),
      },
    });

    if (!response.ok) {
      return { title: 'Product Not Found' };
    }

    const data = await response.json();
    const product = data?.data?.product;
    if (!product) {
      return { title: 'Product Not Found' };
    }

    const storeDefaultLanguage = (store.settings as Record<string, unknown> | undefined)
      ?.defaultLanguage as string | undefined;
    const locale = await resolveStorefrontLocale(storeDefaultLanguage);

    return withLocaleAlternates(
      buildProductMetadata(product, store, locale),
      store,
      `/products/${product.slug}`
    );
  } catch {
    // On any fetch error, return minimal metadata
    return { title: 'Product' };
  }
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, store, draftToken, query] = await Promise.all([
    params,
    getStoreOrNotFound(),
    getPreviewDraftToken(),
    searchParams ?? Promise.resolve({}),
  ]);
  // Same locale generateMetadata resolves, so the JSON-LD names agree with
  // the page's <title> (#2196).
  const locale = await resolveStorefrontLocale(
    (store.settings as Record<string, unknown> | undefined)?.defaultLanguage as string | undefined
  );

  return (
    <ProductDetailBody
      store={store}
      slug={decodeRouteParam(slug)}
      draftToken={draftToken}
      builderToken={builderTokenFrom(query)}
      locale={locale}
    />
  );
}
