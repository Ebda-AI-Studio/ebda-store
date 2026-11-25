'use client';

import { AdminLayout } from '../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';

/**
 * Loading placeholder for `ProductsTable`, which renders through the shared
 * `DataTable` (real `<table>` at md+, stacked cards below md — see
 * `components/mobile/DataTable.tsx`). This skeleton mirrors that exact
 * breakpoint + shape so the loading state never shows a desktop table on a
 * viewport where the loaded table would already be cards.
 */
export function ProductsLoadingSkeleton() {
  const t = useT('products.list');

  const headers = [
    t('table.product'),
    t('table.sku'),
    t('table.price'),
    t('table.profit'),
    t('table.inventory'),
    t('table.status'),
    t('table.actions'),
  ];

  return (
    <AdminLayout title={t('title', { storeName: t('fallbackThisStore') })} subtitle={t('loading')}>
      <div className="space-y-6">
        {/* Skeleton filters */}
        <div className="flex items-center justify-between">
          <div className="h-9 w-64 force-skeleton rounded-lg" />
          <div className="h-9 w-32 force-skeleton rounded-lg" />
        </div>

        {/* Desktop table — hidden below md, matches DataTable's breakpoint */}
        <div className="hidden md:block rounded-md border bg-card overflow-hidden overflow-x-auto">
          <table className="w-full" aria-label={t('table.loadingLabel')}>
            <thead className="bg-muted border-b">
              <tr>
                <th className="w-10 px-4 py-3" aria-hidden="true" />
                {headers.map(h => (
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
                    <div className="h-4 w-4 force-skeleton rounded-md" />
                  </td>
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
                    <div className="h-4 w-14 force-skeleton" />
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

        {/* Mobile stacked cards — visible only below md, mirrors DataTable's
            card shape: title+badge row, label/value rows, action toolbar. */}
        <div className="space-y-3 md:hidden" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-md border border-border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-lg force-skeleton" />
                  <div className="h-4 w-2/5 force-skeleton" />
                </div>
                <div className="h-6 w-16 shrink-0 rounded-full force-skeleton" />
              </div>
              <div className="mt-3 space-y-2">
                <div className="h-3 w-3/5 force-skeleton" />
                <div className="h-3 w-2/5 force-skeleton" />
                <div className="h-3 w-1/2 force-skeleton" />
              </div>
              <div className="mt-3 flex gap-2 border-t border-border/40 pt-2">
                <div className="h-8 w-14 rounded-lg force-skeleton" />
                <div className="h-8 w-14 rounded-lg force-skeleton" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </AdminLayout>
  );
}
