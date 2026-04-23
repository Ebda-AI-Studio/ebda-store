'use client';

import { useT } from '@/i18n/useT';
import { AbandonedCartStatusBadge } from './AbandonedCartStatusBadge';
import { CART_STATUS_KEYS } from './types';
import type { AbandonedCartRecord, ListMeta } from './types';

/** Formats fils to a KWD string with 3 decimals. */
function formatKwd(fils: number): string {
  return (fils / 1000).toFixed(3);
}

/** Best-effort display string for the customer column. */
function customerDisplay(record: AbandonedCartRecord): string {
  if (record.customer) {
    const name = `${record.customer.firstName} ${record.customer.lastName}`.trim();
    return record.customer.email || record.customer.phone || name;
  }
  return record.customerEmail || record.customerPhone || '—';
}

interface AbandonedCartsTableProps {
  records: AbandonedCartRecord[];
  meta: ListMeta;
  statusFilter: string;
  page: number;
  onStatusFilterChange: (status: string) => void;
  onPageChange: (page: number) => void;
}

/**
 * Paginated table of abandoned carts with a status filter in the header.
 * The caller owns `page` and `statusFilter` state so it can coordinate the
 * re-fetch side effects via `useAbandonedCarts`.
 */
export function AbandonedCartsTable({
  records,
  meta,
  statusFilter,
  page,
  onStatusFilterChange,
  onPageChange,
}: AbandonedCartsTableProps) {
  const t = useT('abandonedCarts.list');
  const tStatus = useT('abandonedCarts.status');
  const tKwd = useT('abandonedCarts.stats');

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('totalRecords', { count: meta.total })}
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={e => onStatusFilterChange(e.target.value)}
          aria-label={t('filterAriaLabel')}
          className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
        >
          <option value="all">{t('allStatuses')}</option>
          {CART_STATUS_KEYS.map(key => (
            <option key={key} value={key}>
              {tStatus(key)}
            </option>
          ))}
        </select>
      </div>

      {records.length === 0 ? (
        <div className="p-12 text-center">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
            <svg
              className="w-6 h-6 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          </div>
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full" aria-label={t('ariaLabel')}>
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.customer')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.total')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.items')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.status')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.date')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.map(record => (
                  <tr key={record.id} className="hover:bg-muted">
                    <td className="px-6 py-3 text-sm text-foreground">{customerDisplay(record)}</td>
                    <td className="px-6 py-3 text-sm text-foreground whitespace-nowrap">
                      {tKwd('kwdValue', { amount: formatKwd(record.cartTotal) })}
                    </td>
                    <td className="px-6 py-3 text-sm text-muted-foreground">
                      {record.cartItemCount}
                    </td>
                    <td className="px-6 py-3">
                      <AbandonedCartStatusBadge status={record.status} />
                    </td>
                    <td className="px-6 py-3 text-sm text-muted-foreground whitespace-nowrap">
                      {new Date(record.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-border">
              <p className="text-sm text-muted-foreground">
                {t('pagination', {
                  page: meta.page,
                  totalPages: meta.totalPages,
                  total: meta.total,
                })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onPageChange(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('previous')}
                </button>
                <button
                  type="button"
                  onClick={() => onPageChange(Math.min(meta.totalPages, page + 1))}
                  disabled={page === meta.totalPages}
                  className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('next')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
