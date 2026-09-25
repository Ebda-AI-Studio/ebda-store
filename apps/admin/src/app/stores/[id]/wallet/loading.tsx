'use client';

import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function WalletLoading() {
  const t = useT('wallet');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <AdminSkeletonPage
        variants={['cards', 'table']}
        cardCount={3}
        tableRows={6}
        tableColumns={4}
      />
    </AdminLayout>
  );
}
