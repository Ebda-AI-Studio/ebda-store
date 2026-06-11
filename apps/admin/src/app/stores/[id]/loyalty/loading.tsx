'use client';

import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function LoyaltyLoading() {
  const t = useT('loyalty.page');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <AdminSkeletonPage
        variants={['cards', 'detail', 'table']}
        cardCount={3}
        tableRows={6}
        tableColumns={5}
      />
    </AdminLayout>
  );
}
