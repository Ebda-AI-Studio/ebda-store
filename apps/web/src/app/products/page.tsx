import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { builderTokenFrom } from '../../lib/page-document';
import { ProductsPageBody } from './ProductsPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Products', 'المنتجات'],
    description: [
      'Browse our full catalog of products. Find the best deals with fast delivery in Egypt.',
      'تصفح كل منتجاتنا، مع توصيل سريع في مصر.',
    ],
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
