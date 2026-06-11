'use client';

import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonTable } from '../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function CustomersLoading() {
  const t = useT('customers.page');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <AdminSkeletonTable rows={8} columns={6} showToolbar />
    </AdminLayout>
  );
}
