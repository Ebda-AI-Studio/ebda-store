'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function InsightsProductsLoading() {
  const t = useT('insights.products');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage
        variants={['cards', 'table']}
        cardCount={4}
        tableRows={6}
        tableColumns={5}
      />
    </AdminLayout>
  );
}
