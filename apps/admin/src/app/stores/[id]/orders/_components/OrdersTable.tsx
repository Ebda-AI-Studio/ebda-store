'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { EmptyOrdersState } from './EmptyOrdersState';
import { VALID_TRANSITIONS, type Order, type OrderLineItem } from './types';

interface OrdersTableProps {
  orders: Order[];
  isLoading: boolean;
  hasActiveFilters: boolean;
  updatingId: string | null;
  selectedOrders: Set<string>;
  onStatusChange: (order: Order, newStatus: string) => void;
  onMarkPaid: (orderId: string) => void;
  onOpenInvoice: (orderId: string) => void;
  onToggleSelected: (orderId: string, checked: boolean) => void;
}

// Buttons / selects / checkboxes inside a row should not also trigger
// the row-level navigation — clicks on these elements are swallowed.
function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('button, a, select, input, [role="button"], [data-row-stop]');
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Build a compact, single-line item summary for the orders list row, e.g.
 * "2x Mastic, 1x Caraway +2 more". Shows the first two line items with their
 * quantities and rolls the rest into a "+N more" suffix so the cell stays
 * scannable. Returns null when the API didn't return items for the order.
 */
function summarizeItems(
  items: OrderLineItem[] | undefined,
  moreLabel: (count: number) => string
): string | null {
  if (!items || items.length === 0) return null;
  const MAX_SHOWN = 2;
  const shown = items.slice(0, MAX_SHOWN).map(it => `${it.quantity}x ${it.productName}`);
  const remaining = items.length - MAX_SHOWN;
  const summary = shown.join(', ');
  return remaining > 0 ? `${summary} ${moreLabel(remaining)}` : summary;
}

export function OrdersTable({
  orders,
  isLoading,
  hasActiveFilters,
  updatingId,
  selectedOrders,
  onStatusChange,
  onMarkPaid,
  onOpenInvoice,
  onToggleSelected,
}: OrdersTableProps) {
  const t = useT('orders.list');
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="space-y-2">
              <div className="h-4 w-32 force-skeleton" />
              <div className="h-3 w-48 force-skeleton" />
              <div className="h-3 w-24 force-skeleton" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (orders.length === 0) {
    return <EmptyOrdersState hasActiveFilters={hasActiveFilters} />;
  }

  const columns: DataTableColumn<Order>[] = [
    {
      header: t('table.order'),
      primaryOnMobile: true,
      cell: order => {
        // Show a compact order number on the list row: last 6 chars of the
        // full number prefixed with "#…" so it's de-emphasised. The full
        // number lives on the order detail page and is unchanged there.
        const full = order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`;
        const compact = full.length > 7 ? `#…${full.slice(-6)}` : full;
        return (
          <Link
            href={`/stores/${storeId}/orders/${order.id}`}
            className="font-mono text-xs font-medium text-primary hover:underline"
            onClick={e => e.stopPropagation()}
            title={full}
          >
            {compact}
          </Link>
        );
      },
    },
    {
      header: t('table.customer'),
      cell: order => {
        const itemSummary = summarizeItems(order.items, count => t('table.moreItems', { count }));
        return (
          <div>
            <p className="font-medium text-foreground">
              {order.customer?.firstName} {order.customer?.lastName}
            </p>
            <p className="text-sm text-muted-foreground">{order.customer?.email}</p>
            {itemSummary && (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1" title={itemSummary}>
                {itemSummary}
              </p>
            )}
          </div>
        );
      },
    },
    {
      header: t('table.total'),
      cell: order => (
        <span className="font-bold text-foreground">
          {t('table.totalValue', { amount: (order.total / 1000).toFixed(3) })}
        </span>
      ),
    },
    {
      header: t('table.status'),
      mobileBadge: true,
      cell: order => {
        const transitions = VALID_TRANSITIONS[order.status] ?? [];
        const isUpdating = updatingId === order.id;
        if (transitions.length === 0) return <OrderStatusBadge status={order.status} />;
        return (
          <div className="flex items-center gap-2">
            <OrderStatusBadge status={order.status} />
            <select
              aria-label={t('actions.updateStatusLabel')}
              className="rounded-lg border border-border px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={isUpdating}
              defaultValue=""
              onChange={e => {
                if (e.target.value) {
                  onStatusChange(order, e.target.value);
                  e.target.value = '';
                }
              }}
              data-row-stop
            >
              <option value="" disabled>
                {t('actions.updatePlaceholder')}
              </option>
              {transitions.map(s => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
            {isUpdating && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </div>
        );
      },
    },
    {
      header: t('table.date'),
      hideOnMobile: true,
      cell: order => (
        <span className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</span>
      ),
    },
    {
      header: t('table.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: order => {
        const isUpdating = updatingId === order.id;
        const isCodUnpaid =
          order.paymentStatus === 'unpaid' && order.payments?.some(p => p.provider === 'cod');
        return (
          <div className="flex items-center gap-2 md:justify-end md:flex-wrap">
            {isCodUnpaid && (
              <div className="flex items-center gap-2" data-row-stop>
                <input
                  type="checkbox"
                  aria-label={t('actions.selectOrderLabel', {
                    order: order.orderNumber || order.id,
                  })}
                  checked={selectedOrders.has(order.id)}
                  onChange={e => onToggleSelected(order.id, e.target.checked)}
                  className="h-5 w-5 rounded border-border text-primary focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => onMarkPaid(order.id)}
                  disabled={isUpdating}
                  className="inline-flex items-center gap-1 px-3 py-2 min-h-9 text-xs font-medium text-[hsl(var(--success))] border border-[hsl(var(--success))]/30 rounded-lg hover:bg-[hsl(var(--success))]/10 transition-colors disabled:opacity-50"
                  title={t('actions.markPaidTitle')}
                >
                  {t('actions.markPaid')}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => onOpenInvoice(order.id)}
              className="inline-flex items-center gap-1 px-3 py-2 min-h-9 text-xs font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
              title={t('actions.invoiceTitle')}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                />
              </svg>
              {t('actions.invoice')}
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <DataTable<Order>
      columns={columns}
      rows={orders}
      rowKey={o => o.id}
      onRowClick={(order, _) => {
        // The desktop table cells already capture clicks on interactive
        // children; on mobile cards, swallow taps that started on a
        // button/select/etc the same way before navigating.
        const active = document.activeElement;
        if (isInteractive(active)) return;
        router.push(`/stores/${storeId}/orders/${order.id}`);
      }}
    />
  );
}
