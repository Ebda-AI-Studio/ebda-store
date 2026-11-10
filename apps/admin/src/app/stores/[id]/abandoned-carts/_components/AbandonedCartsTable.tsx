'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { CartIcon } from '@ebda/ui';
import { minorToMajor } from '@/lib/format';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { ABANDONED_CART_COLORS, CART_STATUS_KEYS } from './types';
import type { AbandonedCartRecord, ListMeta } from './types';
import { withNumerals } from '@ebda/shared';
import { Button } from '@/components/ui/Button';

const formatMajor = minorToMajor;

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
  const storeId = useParams().id as string;
  const t = useT('abandonedCarts.list');
  const tStatus = useT('abandonedCarts.status');
  const tMajor = useT('abandonedCarts.stats');
  const tEmail = useT('abandonedCarts.emailStatus');

  const columns: DataTableColumn<AbandonedCartRecord>[] = [
    {
      header: t('columns.customer'),
      primaryOnMobile: true,
      cell: record => <span className="text-sm text-foreground">{customerDisplay(record)}</span>,
    },
    {
      header: t('columns.total'),
      cell: record => (
        <span className="text-sm text-foreground whitespace-nowrap">
          {tMajor('baseValue', { amount: formatMajor(record.cartTotal) })}
        </span>
      ),
    },
    {
      header: t('columns.items'),
      cell: record => <span className="text-sm text-muted-foreground">{record.cartItemCount}</span>,
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: record => (
        <OrderStatusBadge
          status={record.status}
          namespace="abandonedCarts.status"
          colorMap={ABANDONED_CART_COLORS}
        />
      ),
    },
    {
      header: t('columns.email'),
      cell: record => (
        <span
          className="text-sm text-muted-foreground whitespace-nowrap"
          title={record.emailDetail ?? undefined}
        >
          {tEmail(record.emailStatus ?? 'none')}
        </span>
      ),
    },
    {
      header: t('columns.date'),
      cell: record => (
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {new Date(record.createdAt).toLocaleDateString(undefined, withNumerals())}
        </span>
      ),
    },
  ];

  const emptyState = (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="force-empty-state px-6">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
          <CartIcon className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <p className="font-semibold text-foreground">{t('empty')}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyDescription')}</p>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">{t('emptyOrdersHint')}</p>
        <Link
          href={`/stores/${storeId}/orders?status=pending`}
          className="mt-1 text-sm font-medium text-primary hover:underline"
        >
          {t('emptyOrdersLink')}
        </Link>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4">
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
      </div>

      <DataTable<AbandonedCartRecord>
        ariaLabel={t('ariaLabel')}
        columns={columns}
        rows={records}
        rowKey={record => record.id}
        emptyState={emptyState}
      />

      {records.length > 0 && meta.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-4 py-3 rounded-xl border border-border bg-card">
          <p className="text-sm text-muted-foreground">
            {t('pagination', {
              page: meta.page,
              totalPages: meta.totalPages,
              total: meta.total,
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page === 1}
            >
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => onPageChange(Math.min(meta.totalPages, page + 1))}
              disabled={page === meta.totalPages}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
