import { getStoreByTenantParam } from '@/lib/store-resolver';
import { ProductsPageBody } from '@/app/products/ProductsPageBody';

// Rule (f): the same page-language title as the legacy twin (metadata parity, issue 2418).
export { generateMetadata } from '@/app/products/page';

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
