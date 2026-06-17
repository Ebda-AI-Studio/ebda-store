'use client';

import { use } from 'react';
import { AdminLayout } from '../../../../components/AdminLayout';
import { LocationsTab } from '../branding/_components/LocationsTab';

export default function LocationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: storeId } = use(params);

  return (
    <AdminLayout
      title="Locations"
      subtitle="Manage your store's physical branches and locations shown on the storefront."
      storeId={storeId}
    >
      <LocationsTab storeId={storeId} />
    </AdminLayout>
  );
}
