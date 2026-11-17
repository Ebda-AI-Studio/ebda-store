'use client';

import { intlLocaleForUi } from '@/lib/format';
import { useT } from '@/i18n/useT';
import { TIER_COLORS, type LoyaltyStats } from './types';
import { withNumerals } from '@ebda/shared';

interface LoyaltyStatsCardsProps {
  stats: LoyaltyStats;
}

/**
 * Summary cards: total members, points issued/redeemed/outstanding, and a
 * tier-breakdown bar. Rendered above the tab navigation when the loyalty
 * program is enabled and stats are available.
 */
export function LoyaltyStatsCards({ stats }: LoyaltyStatsCardsProps) {
  const t = useT('loyalty.stats');

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('totalMembers')}</p>
        <p className="text-2xl font-bold text-foreground">{stats.totalMembers}</p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('pointsIssued')}</p>
        <p className="text-2xl font-bold text-success-ink">
          {stats.totalPointsIssued.toLocaleString(intlLocaleForUi(), withNumerals())}
        </p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('pointsRedeemed')}</p>
        <p className="text-2xl font-bold text-primary">
          {stats.totalPointsRedeemed.toLocaleString(intlLocaleForUi(), withNumerals())}
        </p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('outstanding')}</p>
        <p className="text-2xl font-bold text-info-ink">
          {stats.outstandingPoints.toLocaleString(intlLocaleForUi(), withNumerals())}
        </p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground mb-2">{t('tierBreakdown')}</p>
        <div className="flex gap-1">
          {Object.entries(stats.tierBreakdown).map(([tier, count]) => (
            <div
              key={tier}
              className={`flex-1 h-2 rounded ${TIER_COLORS[tier]?.icon || 'bg-muted-foreground'}`}
              style={{ flex: count || 0.1 }}
              title={`${tier}: ${count}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
