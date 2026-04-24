'use client';

import Link from 'next/link';
import { Badge } from '@force/ui';
import { formatPrice } from '../../lib/format';
import { useT } from '@/i18n/useT';
import type { RecentOrder } from './types';

interface RecentOrdersProps {
  orders: RecentOrder[];
  isLoading: boolean;
  storeName: string | null;
}

export function RecentOrders({ orders, isLoading, storeName }: RecentOrdersProps) {
  const t = useT('dashboard.super');

  return (
    <div className="force-card animate-slide-up p-0" style={{ animationDelay: '0.3s' }}>
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="font-semibold text-foreground">{t('recentOrdersTitle')}</h2>
          <p className="text-xs text-muted-foreground">{storeName || t('recentOrdersAll')}</p>
        </div>
        <Link
          href="/stores"
          className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {t('viewAll')}
        </Link>
      </div>
      <div className="divide-y divide-border/50">
        {isLoading ? (
          <div className="space-y-4 p-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-xl force-skeleton" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 force-skeleton" />
                  <div className="h-3 w-48 force-skeleton" />
                </div>
              </div>
            ))}
          </div>
        ) : orders.length > 0 ? (
          orders.map(order => (
            <div
              key={order.id}
              className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/30"
            >
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-500/10">
                  <svg
                    className="h-5 w-5 text-violet-600"
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
                <div>
                  <p className="font-medium text-foreground">
                    {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {order.customer?.firstName} {order.customer?.lastName} • {order.store?.name}
                  </p>
                </div>
              </div>
              <div className="text-end">
                <p className="font-semibold text-primary">{formatPrice(order.total)}</p>
                <Badge
                  variant={
                    order.status === 'paid' || order.status === 'completed'
                      ? 'default'
                      : order.status === 'processing'
                        ? 'secondary'
                        : 'destructive'
                  }
                  className="mt-1 capitalize"
                >
                  {order.status}
                </Badge>
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
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
