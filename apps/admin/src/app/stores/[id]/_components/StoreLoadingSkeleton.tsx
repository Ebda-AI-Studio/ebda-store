import { AdminLayout } from '../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';

export function StoreLoadingSkeleton() {
  const t = useT('stores.dashboard');
  return (
    <AdminLayout title={t('loadingTitle')} subtitle={t('loadingSubtitle')}>
      <div className="space-y-6">
        {/* Skeleton: sales hero + four KPI tiles, same shape as the loaded page */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-3">
          <div className="h-4 w-28 force-skeleton" />
          <div className="h-10 w-48 force-skeleton" />
          <div className="h-4 w-64 max-w-full force-skeleton" />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl force-skeleton" />
          ))}
        </div>
        {/* Skeleton content */}
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 rounded-xl border bg-card p-6 shadow-sm space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-24 force-skeleton" />
                <div className="h-5 w-48 force-skeleton" />
              </div>
            ))}
          </div>
          <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-full force-skeleton" />
              <div className="space-y-2">
                <div className="h-4 w-32 force-skeleton" />
                <div className="h-3 w-40 force-skeleton" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
