'use client';

import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function AnalyticsLoading() {
  const t = useT('analytics.page');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <AdminSkeletonPage variants={['cards', 'chart', 'table']} cardCount={4} tableRows={5} />
    </AdminLayout>
  );
}
