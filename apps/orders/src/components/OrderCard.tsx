'use client';

import Link from 'next/link';
import type { Order } from '@/lib/orders';
import { StatusBadge } from './StatusBadge';
import { formatMoney, formatDateTime, customerName } from '@/lib/format';
import { useLanguage } from '@/contexts/LanguageContext';

export function OrderCard({ order, storeId }: { order: Order; storeId: string }) {
  const { t, locale } = useLanguage();
  const itemCount = order.items?.reduce((sum, i) => sum + (i.quantity ?? 0), 0) ?? 0;

  return (
    <Link
      href={`/orders/${order.id}?store=${storeId}`}
      className="block rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors active:bg-muted/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-foreground">
            {order.orderNumber ?? order.id.slice(0, 8)}
          </p>
          <p className="truncate text-sm text-muted-foreground">{customerName(order.customer)}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          <p>{formatDateTime(order.createdAt, locale)}</p>
          {itemCount > 0 && (
            <p className="mt-0.5">
              {itemCount} {t.orders.items}
            </p>
          )}
        </div>
        <div className="text-end">
          <p className="text-base font-bold text-foreground">
            {formatMoney(order.total, order.currency ?? 'KWD')}
          </p>
          {order.paymentStatus === 'paid' ? (
            <p className="text-xs font-semibold text-success">{t.filters.paid}</p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
