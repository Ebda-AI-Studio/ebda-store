'use client';

import { formatPrice } from '../../../../lib/format';
import { useT } from '@/i18n/useT';
import type { Store } from './types';

interface StatsGridProps {
  store: Store;
}

export function StatsGrid({ store }: StatsGridProps) {
  const t = useT('stores.dashboard.stats');

  const stats = [
    {
      label: t('products'),
      value: store._count?.products || 0,
      iconBg: 'bg-info',
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    },
    {
      // Orders use the semantic primary accent (previously an arbitrary
      // violet-500); revenue below also maps to primary, but these cards
      // never render side-by-side in the same icon — separated by a
      // success/info card. Swap to `bg-info` if revenue/orders ever
      // collide visually.
      label: t('orders'),
      value: store._count?.orders || 0,
      iconBg: 'bg-primary',
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    },
    {
      label: t('customers'),
      value: store._count?.customers || 0,
      iconBg: 'bg-success',
      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    },
    {
      label: t('revenue'),
      value: formatPrice(store.stats?.revenue || 0),
      iconBg: 'bg-primary',
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    },
  ];

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 stagger-animation">
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          className="force-stat-card group"
          style={{ animationDelay: `${index * 0.08}s` }}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
              <p className="mt-2 text-3xl font-bold tracking-tight text-foreground">{stat.value}</p>
            </div>
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-2xl ${stat.iconBg} text-white shadow-lg transition-transform duration-200 group-hover:scale-110`}
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d={stat.icon}
                />
              </svg>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
