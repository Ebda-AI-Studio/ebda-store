import { getStoreByTenantParam } from '@/lib/store-resolver';
import { HowToGuidesPageBody } from '@/app/how-to-guides/HowToGuidesPageBody';

// Rule (f): the same page-language title as the legacy twin (metadata parity, issue 2418).
export { generateMetadata } from '@/app/how-to-guides/page';

export default async function StoreHowToGuidesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <HowToGuidesPageBody store={store} />;
}
