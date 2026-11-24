'use client';

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

  // No impressions: CTR (0/0) and average position are undefined (the API sends null; an older payload that sent 0 is
  // treated the same). Say so instead of "0%" and "0.0".
  const noImpressions = totals.impressions === 0 || totals.ctr === null;
  const cards = [
    {
      label: t('impressions'),
      value: totals.impressions.toLocaleString(undefined, withNumerals()),
    },
    { label: t('clicks'), value: totals.clicks.toLocaleString(undefined, withNumerals()) },
    { label: t('ctr'), value: formatPercent(noImpressions ? null : totals.ctr) },
    {
      label: t('avgPosition'),
      value: formatPosition(noImpressions ? null : totals.avgPosition),
      hint: noImpressions ? t('noImpressionsHint') : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(card => (
        <div key={card.label} className="bg-card rounded-xl border border-border p-5">
          <p className="text-sm font-medium text-foreground">{card.label}</p>
          <p className="mt-2 text-2xl font-bold text-foreground">{card.value}</p>
          {card.hint && <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>}
        </div>
      ))}
    </div>
  );
}
