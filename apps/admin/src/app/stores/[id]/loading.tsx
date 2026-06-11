'use client';

import { AdminLayout } from '../../../components/AdminLayout';
import { AdminSkeletonPage } from '../../../components/AdminSkeleton';
import { useT } from '@/i18n/useT';

export default function StoreLoading() {
  const t = useT('stores.dashboard');
  return (
    <AdminLayout title={t('loadingTitle')} subtitle={t('loadingSubtitle')}>
      <AdminSkeletonPage variants={['cards', 'chart', 'table']} cardCount={4} tableRows={5} />
    </AdminLayout>
  );
}
