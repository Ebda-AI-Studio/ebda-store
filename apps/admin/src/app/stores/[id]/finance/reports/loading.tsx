'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function FinanceReportsLoading() {
  const t = useT('finance.reports');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage
        variants={['cards', 'table']}
        cardCount={3}
        tableRows={8}
        tableColumns={4}
      />
    </AdminLayout>
  );
}
