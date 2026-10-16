import { getStoreByTenantParam } from '@/lib/store-resolver';
import { ContactPageBody } from '@/app/contact/ContactPageBody';

// Rule (f): the same page-language title as the legacy twin (metadata parity, issue 2418).
export { generateMetadata } from '@/app/contact/page';

export default async function StoreContactPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <ContactPageBody store={store} />;
}
