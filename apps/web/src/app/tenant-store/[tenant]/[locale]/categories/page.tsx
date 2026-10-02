import type { Metadata } from 'next';
import { getStoreByTenantParam, isResolvedStore } from '@/lib/store-resolver';
import { storeAbsoluteUrl } from '@/lib/structured-data';
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
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);
  return {
    title: 'Categories',
    description: 'Explore product categories and find exactly what you are looking for.',
    ...(isResolvedStore(store)
      ? { alternates: { canonical: storeAbsoluteUrl(store, '/categories') } }
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
