'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function FinanceExpensesLoading() {
  const t = useT('finance.expenses');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage variants={['table']} tableRows={8} tableColumns={5} />
    </AdminLayout>
  );
}
