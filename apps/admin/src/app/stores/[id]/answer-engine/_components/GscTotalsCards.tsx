'use client';

import { intlLocaleForUi } from '@/lib/format';
import { useT } from '@/i18n/useT';
import { formatPercent, formatPosition, type GscDashboardTotals } from './types';
import { withNumerals } from '@ebda/shared';

interface GscTotalsCardsProps {
  totals: GscDashboardTotals;
}

/** Impressions / clicks / CTR / avg position summary cards — mirrors
 * `EngineSummaryCards`'s card grid styling exactly. */
export function GscTotalsCards({ totals }: GscTotalsCardsProps) {
  const t = useT('answerEngine.gsc');

  const cards = [
    {
      label: t('impressions'),
      value: totals.impressions.toLocaleString(intlLocaleForUi(), withNumerals()),
    },
    { label: t('clicks'), value: totals.clicks.toLocaleString(intlLocaleForUi(), withNumerals()) },
    { label: t('ctr'), value: formatPercent(totals.ctr) },
    { label: t('avgPosition'), value: formatPosition(totals.avgPosition) },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(card => (
        <div key={card.label} className="bg-card rounded-xl border border-border p-5">
          <p className="text-sm font-medium text-foreground">{card.label}</p>
          <p className="mt-2 text-2xl font-bold text-foreground">{card.value}</p>
        </div>
      ))}
    </div>
  );
}
