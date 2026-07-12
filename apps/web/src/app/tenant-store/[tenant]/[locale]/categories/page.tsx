import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { CategoriesPageBody } from '@/app/categories/CategoriesPageBody';

export const metadata: Metadata = {
  title: 'Categories',
  description: 'Explore product categories and find exactly what you are looking for.',
};

export default async function StoreCategoriesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <CategoriesPageBody store={store} draftToken={undefined} />;
}
