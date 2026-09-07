import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound } from '../../../lib/store-resolver';
import { decodeRouteParam } from '../../../lib/route-params';
import { BundleDetailBody, buildBundleMetadata, fetchInitialBundle } from './BundleDetailBody';

/**
 * Server-side metadata for bundle pages — mirrors
 * `products/[slug]/page.tsx`'s `generateMetadata` exactly (same
 * decodeRouteParam-vs-raw-param split; see that helper's doc comment for
 * why generateMetadata and the page component receive different forms of
 * the same dynamic segment).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const slug = decodeRouteParam((await params).slug);
  const store = await getStore();

  if (store.id === 'demo') {
    return { title: 'Bundle' };
  }

  try {
    const bundle = await fetchInitialBundle(slug, store);
    if (!bundle) {
      return { title: 'Bundle Not Found' };
    }
    return buildBundleMetadata(bundle, store);
  } catch {
    return { title: 'Bundle' };
  }
}

export default async function BundleDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, store] = await Promise.all([params, getStoreOrNotFound()]);

  return <BundleDetailBody store={store} slug={decodeRouteParam(slug)} />;
}
