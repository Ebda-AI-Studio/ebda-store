import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { ProductsPageBody } from './ProductsPageBody';

export const metadata: Metadata = {
  title: 'Products',
  description:
    'Browse our full catalog of products. Find the best deals with fast delivery in Kuwait.',
};

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await getStoreOrNotFound();
  const params = await searchParams;
  const rawCategory = params.category;
  const category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory;
  const draftToken = await getPreviewDraftToken();

  return <ProductsPageBody store={store} category={category} draftToken={draftToken} />;
}
