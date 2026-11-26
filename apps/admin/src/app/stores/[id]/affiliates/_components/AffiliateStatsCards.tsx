'use client';

import { useT } from '@/i18n/useT';
import { formatFils, type AffiliateStats } from './types';

interface AffiliateStatsCardsProps {
  stats: AffiliateStats;
}

/**
 * Summary cards row at the top of the affiliates page: total affiliates,
 * referrals, conversion rate, total paid, and conversions.
 */
export function AffiliateStatsCards({ stats }: AffiliateStatsCardsProps) {
  const t = useT('affiliates.stats');

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      <div className="bg-card rounded-md border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('totalAffiliates')}</p>
        <p className="text-2xl font-bold text-foreground">{stats.totalAffiliates}</p>
      </div>
      <div className="bg-card rounded-md border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('activeReferrals')}</p>
        <p className="text-2xl font-bold text-success-ink">{stats.totalReferrals}</p>
      </div>
      <div className="bg-card rounded-md border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('conversionRate')}</p>
        <p className="text-2xl font-bold text-info-ink">{stats.conversionRate}%</p>
      </div>
      <div className="bg-card rounded-md border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('totalPaid')}</p>
        <p className="text-2xl font-bold text-primary">{formatFils(stats.commissionPaid)}</p>
      </div>
      <div className="bg-card rounded-md border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('conversions')}</p>
        <p className="text-2xl font-bold text-info-ink">{stats.conversions}</p>
      </div>
    </div>
  );
}
