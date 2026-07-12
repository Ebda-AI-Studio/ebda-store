import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { CategoriesPageBody } from './CategoriesPageBody';

export const metadata: Metadata = {
  title: 'Categories',
  description: 'Explore product categories and find exactly what you are looking for.',
};

export default async function CategoriesPage() {
  const store = await getStoreOrNotFound();
  const draftToken = await getPreviewDraftToken();

  return <CategoriesPageBody store={store} draftToken={draftToken} />;
}
