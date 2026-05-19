'use client';

import { useT } from '@/i18n/useT';
import type { GlWindow } from './types';
import { formatCurrency } from './types';

interface GlKpiCardsProps {
  gl: GlWindow;
}

/**
 * Three KPI cards sourced from the General Ledger:
 * Revenue / Gross Profit / Net Income.
 * Includes a "GL" badge and tooltip explaining the data source.
 */
export function GlKpiCards({ gl }: GlKpiCardsProps) {
  const t = useT('analytics.gl');

  const cards = [
    { label: t('revenue'), value: gl.revenue },
    { label: t('grossProfit'), value: gl.grossProfit },
    { label: t('netIncome'), value: gl.netIncome },
  ] as const;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {cards.map(card => (
        <div
          key={card.label}
          className="bg-card rounded-xl border p-5 shadow-sm flex flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{card.label}</span>
            <span
              className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 cursor-help"
              title={t('tooltip')}
            >
              {t('badge')}
            </span>
          </div>
          <p
            className={`text-xl font-semibold tabular-nums ${
              card.value < 0 ? 'text-destructive' : 'text-foreground'
            }`}
          >
            {formatCurrency(card.value)}
          </p>
        </div>
      ))}
    </div>
  );
}
