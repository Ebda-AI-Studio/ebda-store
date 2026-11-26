'use client';

import Link from 'next/link';
import { Badge } from '@ebda/ui';
import { formatPrice } from '../../lib/format';
import { useT } from '@/i18n/useT';
import type { RecentOrder } from './types';

const ORDER_STATUSES = new Set([
  'pending',
  'awaiting_payment_confirmation',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'paid',
  'unpaid',
]);

interface RecentOrdersProps {
  orders: RecentOrder[];
  isLoading: boolean;
  storeName: string | null;
}

export function RecentOrders({ orders, isLoading, storeName }: RecentOrdersProps) {
  const t = useT('dashboard.super');
  const tStatus = useT('orders.status');

  return (
    // Slimmer rows: half the vertical padding, smaller icon, status as
    // an inline pill rather than a stacked Badge below the price.
    // Saves ~40% vertical space across the Recent Orders list which
    // was dominating the dashboard.
    <div className="force-card animate-slide-up p-0" style={{ animationDelay: '0.3s' }}>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('recentOrdersTitle')}</h2>
          <p className="text-xs text-muted-foreground">{storeName || t('recentOrdersAll')}</p>
        </div>
        <Link
          href="/stores"
          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {t('viewAll')}
        </Link>
      </div>
      <div className="divide-y divide-border/50">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg force-skeleton" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-32 force-skeleton" />
                  <div className="h-3 w-48 force-skeleton" />
                </div>
              </div>
            ))}
          </div>
        ) : orders.length > 0 ? (
          orders.map(order => (
            <div
              key={order.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <svg
                    className="h-4 w-4 text-primary-ink"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                    />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {order.customer?.firstName} {order.customer?.lastName} • {order.store?.name}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge
                  variant={
                    order.status === 'paid' ||
                    order.status === 'completed' ||
                    order.status === 'delivered'
                      ? 'default'
                      : order.status === 'processing'
                        ? 'secondary'
                        : 'destructive'
                  }
                  className="text-xs px-2 py-0.5 capitalize"
                >
                  {ORDER_STATUSES.has(order.status) ? tStatus(order.status) : order.status}
                </Badge>
                <p className="text-sm font-semibold text-primary">{formatPrice(order.total)}</p>
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-muted">
              <svg
                className="h-8 w-8 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
            <p className="font-medium text-foreground">{t('noOrdersTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('noOrdersSubtitle')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
