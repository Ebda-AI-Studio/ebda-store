'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function InsightsSearchesLoading() {
  const t = useT('insights.searches');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage
        variants={['cards', 'table']}
        cardCount={2}
        tableRows={6}
        tableColumns={3}
      />
    </AdminLayout>
  );
}
