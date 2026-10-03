import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { ProductsPageBody } from '@/app/products/ProductsPageBody';

export const metadata: Metadata = {
  title: 'Products',
  description:
    'Browse our full catalog of products. Find the best deals with fast delivery in Egypt.',
};

export default async function StoreProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);
  const sp = (await searchParams) ?? {};
  const rawCategory = sp.category;
  const category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory;

  return <ProductsPageBody store={store} category={category} draftToken={undefined} />;
}
