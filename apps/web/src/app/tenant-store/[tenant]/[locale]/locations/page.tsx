import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { LocationsPageBody } from '@/app/locations/LocationsPageBody';

export const metadata: Metadata = {
  title: 'Locations',
  description: 'Find our store branches — addresses, hours, and directions.',
};

export default async function StoreLocationsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  return <LocationsPageBody store={store} draftToken={undefined} />;
}
