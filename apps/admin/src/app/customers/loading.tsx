import { SkeletonTable } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';

export default function CustomersLoading() {
  return (
    <AdminLayout title="Customers" subtitle="Loading...">
      {/* Filters Skeleton */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-8 w-20 animate-pulse rounded-full bg-gray-200" />
          ))}
        </div>
        <div className="h-10 w-full animate-pulse rounded-md bg-gray-200 sm:w-64" />
      </div>

      {/* Table Skeleton */}
      <SkeletonTable rows={10} columns={5} />
    </AdminLayout>
  );
}
