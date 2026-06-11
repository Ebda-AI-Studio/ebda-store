'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function InsightsDashboardLoading() {
  const t = useT('insights.dashboard');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage variants={['cards', 'chart', 'table']} cardCount={4} tableRows={5} />
    </AdminLayout>
  );
}
