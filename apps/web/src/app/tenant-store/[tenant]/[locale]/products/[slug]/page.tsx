import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { API_URL } from '@/lib/api';
import { decodeRouteParam } from '@/lib/route-params';
import { localeFromRouteParam } from '@/lib/seo/resolve-locale';
import { buildProductMetadata, ProductDetailBody } from '@/app/products/[slug]/ProductDetailBody';

// NOTE: no `generateStaticParams` here — see the parent layout's
// `dynamicParams` comment and plan §3.4 (explicit ban).

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; slug: string }>;
}): Promise<Metadata> {
  // `decodeRouteParam` — Next hands the page component the RAW segment while
  // generateMetadata gets the decoded one; see lib/route-params.ts.
  // (`tenant` is decoded inside `getStoreByTenantParam`.)
  const { tenant, locale: localeParam, slug: rawSlug } = await params;
  const slug = decodeRouteParam(rawSlug);
  const store = await getStoreByTenantParam(tenant);
  // The `[locale]` segment is already resolved by `middleware.ts` from the
  // `force-language` cookie before the rewrite (see the parent layout's doc
  // comment) — read it from the route param, never `cookies()`, or this
  // route loses the whole point of the tenant-cacheable tree.
  const locale = localeFromRouteParam(localeParam);

  try {
    const storeId = store.id !== 'demo' ? store.id : null;
    if (!storeId) return { title: 'Product' };

    const response = await fetch(`${API_URL}/public/products/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60, tags: [`products:${storeId}`] },
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': store.id,
        ...(store.domain ? { 'x-store-domain': store.domain } : {}),
      },
    });

    if (!response.ok) return { title: 'Product Not Found' };

    const data = await response.json();
    const product = data?.data?.product;
    if (!product) return { title: 'Product Not Found' };

    return buildProductMetadata(product, store, locale);
  } catch {
    return { title: 'Product' };
  }
}

export default async function StoreProductDetailPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; slug: string }>;
}) {
  const { tenant, locale: localeParam, slug: rawSlug } = await params;
  const slug = decodeRouteParam(rawSlug);
  const store = await getStoreByTenantParam(tenant);

  return (
    <ProductDetailBody
      store={store}
      slug={slug}
      draftToken={undefined}
      locale={localeFromRouteParam(localeParam)}
    />
  );
}
