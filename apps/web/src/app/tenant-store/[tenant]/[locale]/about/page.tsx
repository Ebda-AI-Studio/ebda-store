import { getStoreByTenantParam } from '@/lib/store-resolver';
import { AboutPageBody } from '@/app/about/AboutPageBody';

// Rule (f): the same page-language title as the legacy twin (metadata parity, issue 2418).
export { generateMetadata } from '@/app/about/page';

export default async function StoreAboutPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <AboutPageBody store={store} />;
}
