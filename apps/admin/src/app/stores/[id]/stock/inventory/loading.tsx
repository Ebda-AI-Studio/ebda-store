'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonTable } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function StockInventoryLoading() {
  const t = useT('stock.inventory');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonTable rows={8} columns={5} showToolbar />
    </AdminLayout>
  );
}
