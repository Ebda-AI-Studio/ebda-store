'use client';

import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { EmptyOrdersState } from './EmptyOrdersState';
import { VALID_TRANSITIONS, type Order } from './types';

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

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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

  if (isLoading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full" aria-label={t('table.loadingLabel')}>
          <thead className="bg-muted border-b">
            <tr>
              {(['order', 'customer', 'total', 'status', 'date', 'actions'] as const).map(key => (
                <th
                  key={key}
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t(`table.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td className="px-6 py-4">
                  <div className="h-4 w-24 force-skeleton" />
                </td>
                <td className="px-6 py-4">
                  <div className="space-y-1.5">
                    <div className="h-4 w-32 force-skeleton" />
                    <div className="h-3 w-40 force-skeleton" />
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="h-4 w-20 force-skeleton" />
                </td>
                <td className="px-6 py-4">
                  <div className="h-6 w-24 rounded-full force-skeleton" />
                </td>
                <td className="px-6 py-4 hidden md:table-cell">
                  <div className="h-4 w-24 force-skeleton" />
                </td>
                <td className="px-6 py-4">
                  <div className="h-7 w-20 rounded-lg force-skeleton ms-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (orders.length === 0) {
    return <EmptyOrdersState hasActiveFilters={hasActiveFilters} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label={t('table.label')}>
        <thead className="bg-muted border-b">
          <tr>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('table.order')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('table.customer')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('table.total')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('table.status')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell"
            >
              {t('table.date')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('table.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {orders.map(order => {
            const transitions = VALID_TRANSITIONS[order.status] ?? [];
            const isUpdating = updatingId === order.id;
            const isCodUnpaid =
              order.paymentStatus === 'unpaid' && order.payments?.some(p => p.provider === 'cod');

            return (
              <tr
                key={order.id}
                className="hover:bg-muted/50 transition-colors duration-150 cursor-pointer"
              >
                <td className="px-6 py-4">
                  <p className="font-semibold text-primary">
                    {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                  </p>
                </td>
                <td className="px-6 py-4">
                  <p className="font-medium text-foreground">
                    {order.customer?.firstName} {order.customer?.lastName}
                  </p>
                  <p className="text-sm text-muted-foreground">{order.customer?.email}</p>
                </td>
                <td className="px-6 py-4">
                  <span className="font-bold text-foreground">
                    {t('table.totalValue', { amount: (order.total / 1000).toFixed(3) })}
                  </span>
                </td>
                <td className="px-6 py-4">
                  {transitions.length > 0 ? (
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
                  ) : (
                    <OrderStatusBadge status={order.status} />
                  )}
                </td>
                <td className="px-6 py-4 hidden md:table-cell text-sm text-muted-foreground">
                  {formatDate(order.createdAt)}
                </td>
                <td className="px-6 py-4 text-end">
                  <div className="flex items-center justify-end gap-2">
                    {/* COD Mark as Paid button — only for COD orders awaiting cash */}
                    {isCodUnpaid && (
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={t('actions.selectOrderLabel', {
                            order: order.orderNumber || order.id,
                          })}
                          checked={selectedOrders.has(order.id)}
                          onChange={e => onToggleSelected(order.id, e.target.checked)}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                        />
                        <button
                          onClick={() => onMarkPaid(order.id)}
                          disabled={isUpdating}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[hsl(var(--success))] border border-[hsl(var(--success))]/30 rounded-lg hover:bg-[hsl(var(--success))]/10 transition-colors disabled:opacity-50"
                          title={t('actions.markPaidTitle')}
                        >
                          {t('actions.markPaid')}
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => onOpenInvoice(order.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
                      title={t('actions.invoiceTitle')}
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
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
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
