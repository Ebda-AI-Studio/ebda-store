import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStore, getStoreOrNotFound, isResolvedStore } from '../../lib/store-resolver';
import { storeAbsoluteUrl } from '../../lib/structured-data';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { builderTokenFrom } from '../../lib/page-document';
import { ProductsPageBody } from './ProductsPageBody';

/**
 * The listing's canonical (audit M-169): `/products` itself, or the one filter that makes it a different page
 * (`?category=` / `?tag=`). Sort, page and facet params never get their own canonical, so a crawled
 * `?sort=price` or `?page=3` points back at the page it re-orders. No canonical for an unresolved store (#1855).
 */
export function productsCanonicalPath(
  params: Record<string, string | string[] | undefined>
): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();
  const category = first(params.category);
  if (category) return `/products?category=${encodeURIComponent(category.slice(0, 120))}`;
  const tag = first(params.tag);
  if (tag) return `/products?tag=${encodeURIComponent(tag.slice(0, 120))}`;
  return '/products';
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const [store, params] = await Promise.all([getStore(), searchParams]);
  return localizedMetadata({
    title: ['Products', 'المنتجات'],
    description: [
      'Browse our full catalog of products. Find the best deals with fast delivery in Egypt.',
      'تصفح كل منتجات المتجر مع الأسعار والتفاصيل، واختار اللي يعجبك واطلبه من موبايلك في دقايق.',
    ],
    ...(isResolvedStore(store)
      ? { alternates: { canonical: storeAbsoluteUrl(store, productsCanonicalPath(params)) } }
      : {}),
  });
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
  // `?tag=<name>` (Phase B3, Ruling B3-5): the skin-type / concern chips land here.
  const rawTag = params.tag;
  const tag = (Array.isArray(rawTag) ? rawTag[0] : rawTag)?.trim().slice(0, 120) || undefined;
  const draftToken = await getPreviewDraftToken();

  return (
    <ProductsPageBody
      store={store}
      category={category}
      tag={tag}
      draftToken={draftToken}
      builderToken={builderTokenFrom(params)}
    />
  );
}
