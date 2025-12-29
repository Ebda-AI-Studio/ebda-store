import { SkeletonDashboardStats, SkeletonTable } from '@force/ui';
import { AdminLayout } from '../components/AdminLayout';

export default function DashboardLoading() {
  return (
    <AdminLayout
      title="Dashboard"
      subtitle="Loading..."
    >
      {/* Stats Grid Skeleton */}
      <SkeletonDashboardStats count={4} className="mb-8" />

      {/* Charts Skeleton */}
      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-6">
          <div className="mb-4 h-6 w-32 animate-pulse rounded bg-gray-200" />
          <div className="h-64 animate-pulse rounded bg-gray-100" />
        </div>
        <div className="rounded-xl border bg-white p-6">
          <div className="mb-4 h-6 w-32 animate-pulse rounded bg-gray-200" />
          <div className="h-64 animate-pulse rounded bg-gray-100" />
        </div>
      </div>

      {/* Recent Orders Skeleton */}
      <div className="rounded-xl border bg-white">
        <div className="border-b p-4">
          <div className="h-6 w-32 animate-pulse rounded bg-gray-200" />
        </div>
        <SkeletonTable rows={5} columns={5} />
      </div>
    </AdminLayout>
  );
}
