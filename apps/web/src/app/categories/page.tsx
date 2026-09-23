import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { storeAbsoluteUrl } from '../../lib/structured-data';
import { CategoriesPageBody } from './CategoriesPageBody';

// This page had a static `metadata` export with no canonical at all (A3 in
// the 2026-09-22 AEO audit) — every other listing/detail page in this
// codebase sets one. A store-aware canonical needs the resolved store (for
// the platform-path `/<slug>` prefix, same as every other
// `storeAbsoluteUrl` call site), so this is now `generateMetadata`. Uses
// `getStore()` (never-throws, demo fallback), matching the product/bundle
// `generateMetadata` pattern — the page body below still uses
// `getStoreOrNotFound()` for the real 404 behavior.
export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  return {
    title: 'Categories',
    description: 'Explore product categories and find exactly what you are looking for.',
    alternates: { canonical: storeAbsoluteUrl(store, '/categories') },
  };
}

export default async function CategoriesPage() {
  const store = await getStoreOrNotFound();
  const draftToken = await getPreviewDraftToken();

  return <CategoriesPageBody store={store} draftToken={draftToken} />;
}
