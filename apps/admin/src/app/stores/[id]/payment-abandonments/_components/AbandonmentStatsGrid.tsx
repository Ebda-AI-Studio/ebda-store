'use client';

import { useT } from '@/i18n/useT';
import type { AbandonmentStats } from '../_hooks/usePaymentAbandonments';

interface StatCardProps {
  label: string;
  value: string | number;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="bg-card rounded-md border border-border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
    </div>
  );
}

import { formatPrice } from '@/lib/format';

/** Converts piastres (integer) to an EGP display string (2 decimals). */
const formatMajor = formatPrice;

interface AbandonmentStatsGridProps {
  stats: AbandonmentStats | null;
}

export function AbandonmentStatsGrid({ stats }: AbandonmentStatsGridProps) {
  const t = useT('paymentAbandonments.page');

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label={t('statsTotal')} value={stats?.total ?? 0} />
      <StatCard label={t('statsLast7')} value={stats?.last7d ?? 0} />
      <StatCard label={t('statsLast30')} value={stats?.last30d ?? 0} />
      <StatCard label={t('statsValue')} value={formatMajor(stats?.totalValue ?? 0)} />
    </div>
  );
}
