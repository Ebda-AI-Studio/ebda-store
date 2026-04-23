'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';

export function ProductsLoadingSkeleton() {
  const t = useT('products.list');

  return (
    <AdminLayout title={t('title')} subtitle={t('loading')}>
      <div className="space-y-6">
        {/* Skeleton filters */}
        <div className="flex items-center justify-between">
          <div className="h-9 w-64 force-skeleton rounded-lg" />
          <div className="h-9 w-32 force-skeleton rounded-lg" />
        </div>
        {/* Skeleton table */}
        <div className="rounded-xl border bg-card overflow-hidden overflow-x-auto">
          <table className="w-full" aria-label={t('table.loadingLabel')}>
            <thead className="bg-muted border-b">
              <tr>
                {[
                  t('table.product'),
                  t('table.sku'),
                  t('table.price'),
                  t('table.inventory'),
                  t('table.status'),
                  t('table.actions'),
                ].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-start text-sm font-medium text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg force-skeleton" />
                      <div className="h-4 w-36 force-skeleton" />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 w-20 force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 w-16 force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 w-10 force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-6 w-16 rounded-full force-skeleton" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <div className="h-8 w-14 rounded-lg force-skeleton" />
                      <div className="h-8 w-14 rounded-lg force-skeleton" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
