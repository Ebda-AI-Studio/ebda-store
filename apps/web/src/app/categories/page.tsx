import { storefrontAlternates } from '@/lib/seo/locale-alternates';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound, isResolvedStore } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
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
  // STORE-QA-42: the document title follows the page language, like every other static route.
  const localized = await localizedMetadata({
    title: ['Categories', 'الفئات'],
    description: [
      'Explore product categories and find exactly what you are looking for.',
      'تصفح فئات المنتجات وهات اللي بتدوّر عليه.',
    ],
  });
  return {
    title: localized.title,
    description: localized.description,
    // No canonical for an unresolved store (#1855) — it would name the demo store.
    ...(isResolvedStore(store)
      ? { alternates: await storefrontAlternates(store, '/categories', true) }
      : {}),
  };
}

export default async function CategoriesPage() {
  const store = await getStoreOrNotFound();
  const draftToken = await getPreviewDraftToken();

  return <CategoriesPageBody store={store} draftToken={draftToken} />;
}
