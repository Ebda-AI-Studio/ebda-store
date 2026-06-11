'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function InsightsCohortsLoading() {
  const t = useT('insights.cohorts');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage variants={['chart', 'table']} tableRows={6} tableColumns={4} />
    </AdminLayout>
  );
}
