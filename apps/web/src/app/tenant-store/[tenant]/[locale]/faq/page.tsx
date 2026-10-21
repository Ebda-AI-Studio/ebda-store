import { getStoreByTenantParam } from '@/lib/store-resolver';
import { FaqPageBody } from '@/app/faq/FaqPageBody';

// Rule (f): the same page-language title as the legacy twin (metadata parity, issue 2418).
export { generateMetadata } from '@/app/faq/page';

export default async function StoreFaqPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <FaqPageBody store={store} />;
}
