'use client';

import { formatPrice, formatNumber } from '../../lib/format';
import { useT } from '@/i18n/useT';
import type { PlatformStats } from './types';

interface StatsGridProps {
  stats: PlatformStats | null;
  isLoading: boolean;
}

export function StatsGrid({ stats, isLoading }: StatsGridProps) {
  const t = useT('dashboard.super');

  const statCards = [
    {
      name: t('statTotalStores'),
      value: stats?.stores || 0,
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
      iconBg: 'bg-info',
    },
    {
      name: t('statTotalUsers'),
      value: stats?.users || 0,
      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
      iconBg: 'bg-success',
    },
    {
      name: t('statTotalOrders'),
      value: stats?.orders || 0,
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
      iconBg: 'bg-primary',
    },
    {
      name: t('statTotalRevenue'),
      value: formatPrice(stats?.revenue || 0),
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
      iconBg: 'bg-primary',
      isRevenue: true,
    },
  ];

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="force-stat-card">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 space-y-2">
                <div className="h-3 w-20 force-skeleton" />
                <div className="h-7 w-24 force-skeleton" />
              </div>
              <div className="h-9 w-9 rounded-lg force-skeleton" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    // Tighter grid (gap-3 vs gap-6) + slimmer cards via the updated
    // `.force-stat-card` padding — kills the empty white band that
    // dominated the platform dashboard.
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 stagger-animation">
      {statCards.map((stat, index) => (
        <div
          key={stat.name}
          className="force-stat-card"
          style={{ animationDelay: `${index * 0.1}s` }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {stat.name}
              </p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">
                {stat.isRevenue ? stat.value : formatNumber(stat.value as number)}
              </p>
            </div>
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${stat.iconBg} text-white`}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
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
