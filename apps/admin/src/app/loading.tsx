'use client';

import { SkeletonDashboardStats, SkeletonTable } from '@ebda/ui';
import { AdminLayout } from '../components/AdminLayout';
import { useT } from '@/i18n/useT';

export default function DashboardLoading() {
  const t = useT('common');
  return (
    <AdminLayout title={t('dashboard')} subtitle={t('loading')}>
      {/* Stats Grid Skeleton */}
      <SkeletonDashboardStats count={4} className="mb-8" />

      {/* Charts Skeleton */}
      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-md border bg-card p-6">
          <div className="mb-4 h-6 w-32 animate-pulse rounded-md bg-muted" />
          <div className="h-64 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="rounded-md border bg-card p-6">
          <div className="mb-4 h-6 w-32 animate-pulse rounded-md bg-muted" />
          <div className="h-64 animate-pulse rounded-md bg-muted" />
        </div>
      </div>

      {/* Recent Orders Skeleton */}
      <div className="rounded-md border bg-card">
        <div className="border-b p-4">
          <div className="h-6 w-32 animate-pulse rounded-md bg-muted" />
        </div>
        <SkeletonTable rows={5} columns={5} />
      </div>
    </AdminLayout>
  );
}
