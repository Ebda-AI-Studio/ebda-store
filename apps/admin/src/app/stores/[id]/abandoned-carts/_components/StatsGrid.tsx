'use client';

import { useT } from '@/i18n/useT';
import { filsToKwd } from '@/lib/format';
import type { AbandonedCartStats } from './types';

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
}

function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="bg-card rounded-xl border border-border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

interface StatsGridProps {
  stats: AbandonedCartStats | null;
}

const formatKwd = filsToKwd;

/**
 * Four-column summary cards at the top of the abandoned carts page.
 * Pure presentational component — receives already-fetched stats.
 */
export function StatsGrid({ stats }: StatsGridProps) {
  const t = useT('abandonedCarts.stats');

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label={t('totalAbandoned')} value={stats?.totalAbandoned ?? 0} />
      <StatCard label={t('recovered')} value={stats?.totalRecovered ?? 0} />
      <StatCard label={t('recoveryRate')} value={`${stats?.recoveryRate ?? 0}%`} />
      <StatCard
        label={t('recoveredRevenue')}
        value={t('kwdValue', { amount: formatKwd(stats?.recoveredRevenue ?? 0) })}
      />
    </div>
  );
}
