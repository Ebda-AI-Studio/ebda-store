'use client';

import { useT } from '@/i18n/useT';
import type { ReturnsStats } from './types';

interface StatsGridProps {
  stats: ReturnsStats | null;
}

/**
 * Four-column summary cards at the top of the returns page. Pure
 * presentational component — receives already-fetched stats from the hook.
 */
export function StatsGrid({ stats }: StatsGridProps) {
  const t = useT('returns.stats');

  if (!stats) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div className="bg-card rounded-md border p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{t('total')}</p>
        <p className="text-2xl font-bold text-foreground">{stats.total}</p>
      </div>
      <div className="bg-card rounded-md border p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{t('pending')}</p>
        <p className="text-2xl font-bold text-warning-ink">{stats.pending}</p>
      </div>
      <div className="bg-card rounded-md border p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{t('approved')}</p>
        <p className="text-2xl font-bold text-info-ink">{stats.approved}</p>
      </div>
      <div className="bg-card rounded-md border p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{t('completed')}</p>
        <p className="text-2xl font-bold text-success-ink">{stats.completed}</p>
      </div>
    </div>
  );
}
