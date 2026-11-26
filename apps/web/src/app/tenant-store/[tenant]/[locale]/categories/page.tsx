import { storefrontAlternates } from '@/lib/seo/locale-alternates';
import type { Metadata } from 'next';
import { getStoreByTenantParam, isResolvedStore } from '@/lib/store-resolver';
import { CategoriesPageBody } from '@/app/categories/CategoriesPageBody';

// Same document metadata as the legacy `app/categories/page.tsx`, including its
// store-aware canonical (A3 in the 2026-09-22 AEO audit): a static `metadata`
// export here dropped the canonical for every store once routing flipped
// (issue 2418). Guarded by tests/unit/web-tenant-tree-page-metadata-parity.test.tsx.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}): Promise<Metadata> {
  const { tenant, locale } = await params;
  const store = await getStoreByTenantParam(tenant);
  // STORE-QA-42: title follows the locale segment of the URL.
  const ar = locale === 'ar';
  return {
    title: ar ? 'الفئات' : 'Categories',
    description: ar
      ? 'تصفح فئات المنتجات وهات اللي بتدوّر عليه.'
      : 'Explore product categories and find exactly what you are looking for.',
    ...(isResolvedStore(store)
      ? { alternates: await storefrontAlternates(store, '/categories', true) }
      : {}),
  };
}

export default async function StoreCategoriesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <CategoriesPageBody store={store} draftToken={undefined} />;
}
