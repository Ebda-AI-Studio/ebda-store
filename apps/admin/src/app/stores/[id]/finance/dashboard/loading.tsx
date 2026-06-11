'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function FinanceDashboardLoading() {
  const t = useT('finance.dashboard');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage variants={['cards', 'chart', 'table']} cardCount={4} tableRows={5} />
    </AdminLayout>
  );
}
