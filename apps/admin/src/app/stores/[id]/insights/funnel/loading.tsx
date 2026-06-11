'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function InsightsFunnelLoading() {
  const t = useT('insights.funnel');
  return (
    <AdminLayout title={t('title')}>
      <AdminSkeletonPage variants={['cards', 'chart']} cardCount={4} />
    </AdminLayout>
  );
}
