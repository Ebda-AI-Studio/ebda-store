'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { groupOrderLinesForDisplay } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { EmptyOrdersState } from './EmptyOrdersState';
import { statusOptionsForRole, type Order, type OrderLineItem } from './types';

interface OrdersTableProps {
  orders: Order[];
  isLoading: boolean;
  hasActiveFilters: boolean;
  updatingId: string | null;
  selectedOrders: Set<string>;
  /** False for staff: the "Refunded" status needs orders:refund, so it is not offered. */
  canRefund: boolean;
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

import { formatDate, minorToMajor } from '@/lib/format';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
/**
 * Build a compact, single-line item summary for the orders list row, e.g.
 * "2x Mastic, 1x Caraway +2 more". Shows the first two DISPLAY ROWS with
 * their quantities and rolls the rest into a "+N more" suffix so the cell
 * stays scannable. Returns null when the API didn't return items for the
 * order.
 *
 * Grouped through `groupOrderLinesForDisplay` first, then summarized — the
 * same "group first, then limit" rule `ItemsCard.previewRows` documents
 * (commit `21e074bd`). Without it, a bundle box's components read as
 * unrelated products ("1x Dates, 1x Honey +2 more" for a single "Ramadan
 * Box"), and worse, the FIRST two components of the box could crowd out
 * every other line on the order. `price` is defaulted to 0 purely for the
 * grouping call — the raw `item.price` is never read by this function.
 */
export function summarizeItems(
  items: OrderLineItem[] | undefined,
  moreLabel: (count: number) => string,
  locale: string
): string | null {
  if (!items || items.length === 0) return null;
  const rows = groupOrderLinesForDisplay(items.map(it => ({ ...it, price: it.price ?? 0 })));
  const MAX_SHOWN = 2;
  const shown = rows.slice(0, MAX_SHOWN).map(row => {
    if (row.kind === 'bundle') {
      const name = locale === 'ar' && row.nameAr ? row.nameAr : row.name;
      return `${row.quantity}x ${name}`;
    }
    return `${row.item.quantity}x ${row.item.productName}`;
  });
  const remaining = rows.length - MAX_SHOWN;
  const summary = shown.join(', ');
  return remaining > 0 ? `${summary} ${moreLabel(remaining)}` : summary;
}

export function OrdersTable({
  orders,
  isLoading,
  hasActiveFilters,
  updatingId,
  selectedOrders,
  canRefund,
  onStatusChange,
  onMarkPaid,
  onOpenInvoice,
  onToggleSelected,
}: OrdersTableProps) {
  const t = useT('orders.list');
  const locale = useLocale();
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
        // QA-D5: the list shows the FULL order number (the merchant reads it to the customer; a "#…-DRHWY"
        // truncation matched nothing in the customer's message). It wraps rather than clips.
        const full = order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`;
        const compact = full;
        return (
          <Link
            href={`/stores/${storeId}/orders/${order.id}`}
            className="font-mono text-xs font-medium text-primary hover:underline break-all"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
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
        const itemSummary = summarizeItems(
          order.items,
          count => t('table.moreItems', { count }),
          locale
        );
        // Guest orders have no `customer` row — fall back to the name/email the
        // shopper entered in the shipping address so the cell is never blank.
        const addr = order.shippingAddress;
        const custName =
          `${order.customer?.firstName ?? ''} ${order.customer?.lastName ?? ''}`.trim();
        const guestName = `${addr?.firstName ?? ''} ${addr?.lastName ?? ''}`.trim();
        const displayName = custName || guestName || '—';
        const displayEmail = order.customer?.email || addr?.email || '';
        return (
          <div>
            <p className="font-medium text-foreground">{displayName}</p>
            <p className="text-sm text-muted-foreground">{displayEmail}</p>
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
          {t('table.totalValue', { amount: minorToMajor(order.total) })}
        </span>
      ),
    },
    {
      header: t('table.status'),
      mobileBadge: true,
      cell: order => {
        const transitions = statusOptionsForRole(order, canRefund);
        const isUpdating = updatingId === order.id;
        // Reuses OrderStatusBadge's colorMap override (same pattern the
        // returns/shipments/notifications surfaces use) instead of a new
        // chip style — every-data-needs-a-UI surface for Order.source.
        const agentBadge = order.source === 'agent' && (
          <OrderStatusBadge
            status="agent"
            label={t('agentBadge')}
            // Uses the `orders.list` namespace's own `agentBadge` key
            // (added alongside `orders.detail.agent`) so this list-row
            // badge doesn't depend on the detail page's translations.
            colorMap={{ agent: { className: 'bg-violet-50 text-violet-700' } }}
          />
        );
        if (transitions.length === 0) {
          return (
            <div className="flex items-center gap-2">
              <OrderStatusBadge status={order.status} />
              {agentBadge}
            </div>
          );
        }
        return (
          <div className="flex items-center gap-2">
            <OrderStatusBadge status={order.status} />
            {agentBadge}
            <select
              aria-label={t('actions.updateStatusLabel')}
              className={FIELD_CLASSES}
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
          order.paymentStatus === 'unpaid' &&
          !['cancelled', 'refunded'].includes(order.status) &&
          order.payments?.some(p => p.provider === 'cod');
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
                <Button
                  type="button"
                  onClick={() => onMarkPaid(order.id)}
                  disabled={isUpdating}
                  title={t('actions.markPaidTitle')}
                  variant="outline"
                  size="sm"
                  className="gap-1"
                >
                  {t('actions.markPaid')}
                </Button>
              </div>
            )}
            <Button
              type="button"
              onClick={() => onOpenInvoice(order.id)}
              title={t('actions.invoiceTitle')}
              variant="outline"
              size="sm"
              className="gap-1"
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
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <DataTable<Order>
      ariaLabel={t('table.label')}
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
