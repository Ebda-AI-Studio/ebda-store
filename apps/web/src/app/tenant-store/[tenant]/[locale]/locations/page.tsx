import { getStoreByTenantParam } from '@/lib/store-resolver';
import { LocationsPageBody } from '@/app/locations/LocationsPageBody';

// Rule (f): the same page-language title as the legacy twin (metadata parity, issue 2418).
export { generateMetadata } from '@/app/locations/page';

export default async function StoreLocationsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <LocationsPageBody store={store} draftToken={undefined} />;
}
