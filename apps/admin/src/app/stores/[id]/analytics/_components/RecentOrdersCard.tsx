'use client';

import { useT } from '@/i18n/useT';
import { formatCurrency, type RecentOrder } from './types';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink',
  confirmed: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
  processing: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
  shipped: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
  delivered: 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink',
  cancelled:
    'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink',
  refunded: 'bg-muted text-foreground',
};

const KNOWN_STATUSES = new Set(Object.keys(STATUS_COLORS));

interface RecentOrdersCardProps {
  orders: RecentOrder[];
}

/**
 * Latest 5 orders with customer name, order number, total, and status chip.
 * Status labels fall back to the raw value for any status not in the known set,
 * matching the pattern used by `AbandonedCartStatusBadge`.
 */
export function RecentOrdersCard({ orders }: RecentOrdersCardProps) {
  const t = useT('analytics.recentOrders');
  const tStatus = useT('analytics.orderStatus');

  return (
    <div className="bg-card rounded-md border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      {orders.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="space-y-4">
          {orders.map(order => (
            <div key={order.id} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {order.customer
                    ? `${order.customer.firstName} ${order.customer.lastName}`
                    : t('guest')}
                </p>
                <p className="text-xs text-muted-foreground">#{order.orderNumber}</p>
              </div>
              <div className="text-end">
                <p className="text-sm font-semibold text-foreground">
                  {formatCurrency(order.total)}
                </p>
                <span
                  className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                    STATUS_COLORS[order.status] || 'bg-muted text-foreground'
                  }`}
                >
                  {KNOWN_STATUSES.has(order.status) ? tStatus(order.status) : order.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
