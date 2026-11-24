'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { CartIcon } from '@ebda/ui';
import { formatPrice, formatDate } from '@/lib/format';
import { OrderStatusBadge } from '../../../../../components/OrderStatusBadge';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { CART_STATUS_KEYS } from './types';
import type { AbandonedCartRecord, ListMeta } from './types';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
import { EmptyState } from '@/components/EmptyState';

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
          {formatPrice(record.cartTotal)}
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
      cell: record => <OrderStatusBadge status={record.status} family="abandonedCart" />,
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
          {formatDate(record.createdAt)}
        </span>
      ),
    },
  ];

  const emptyState = (
    <EmptyState
      card
      icon={<CartIcon className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />}
      title={t('empty')}
      description={t('emptyDescription')}
      hint={t('emptyOrdersHint')}
      action={{
        label: t('emptyOrdersLink'),
        href: `/stores/${storeId}/orders?status=pending`,
      }}
    />
  );

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-md border border-border overflow-hidden">
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
            className={FIELD_CLASSES}
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
        <div className="flex items-center justify-between mt-4 px-4 py-3 rounded-md border border-border bg-card">
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
