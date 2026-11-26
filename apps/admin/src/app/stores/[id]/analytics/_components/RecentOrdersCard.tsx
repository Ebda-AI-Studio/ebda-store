'use client';

import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { formatCurrency, type RecentOrder } from './types';

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
                <OrderStatusBadge status={order.status} namespace="analytics.orderStatus" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
