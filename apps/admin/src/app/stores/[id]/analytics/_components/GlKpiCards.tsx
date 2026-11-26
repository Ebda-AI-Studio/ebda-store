'use client';

import { useT } from '@/i18n/useT';
import type { GlWindow } from './types';
import { formatCurrency } from './types';
import { ledgerCostsStatus } from '@/lib/money-truth';

interface GlKpiCardsProps {
  gl: GlWindow;
  /** Label of the selected period — the GL window follows the page's picker. */
  periodLabel: string;
}

/**
 * Three KPI cards sourced from the General Ledger:
 * Revenue / Gross Profit / Net Income.
 * Includes a "GL" badge and tooltip explaining the data source.
 *
 * Gross profit and net income follow the page's one unknown-state pattern (ruling AN-7, the
 * same as the analytics profit card): when the period has revenue but no cost
 * of goods was booked, "revenue − 0" is not a gross profit — the card says
 * "Unknown" and why, instead of repeating the revenue figure.
 */
export function glGrossProfitKnown(
  gl: Pick<GlWindow, 'revenue' | 'cogs' | 'costsStatus'>
): boolean {
  return ledgerCostsStatus(gl) !== 'unknown';
}

export function GlKpiCards({ gl, periodLabel }: GlKpiCardsProps) {
  const t = useT('analytics.gl');

  const status = ledgerCostsStatus(gl);
  const grossKnown = status !== 'unknown';
  // Unknown: no cost of goods at all. Partial: the figure is shown, with how many sold items lack a cost, because the
  // real profit is lower than stated (money review M1).
  const costNote =
    status === 'unknown'
      ? t('noCogsBooked')
      : status === 'partial'
        ? t('costsPartial', { missing: gl.costsMissing ?? 0, total: gl.costsTotal ?? 0 })
        : undefined;
  const cards: Array<{ label: string; value: number | null; note?: string }> = [
    { label: t('revenue'), value: gl.revenue },
    {
      label: t('grossProfit'),
      value: grossKnown ? gl.grossProfit : null,
      note: costNote,
    },
    // Net income is built on the same missing input as gross profit (QA 2026-11-17 N1).
    {
      label: t('netIncome'),
      value: grossKnown ? gl.netIncome : null,
      note: costNote,
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('window', { period: periodLabel })}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {cards.map(card => (
          <div
            key={card.label}
            className="bg-card rounded-md border p-5 shadow-sm flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{card.label}</span>
              <span
                className="px-1.5 py-0.5 text-xs font-bold rounded-md bg-success/10 text-success-ink cursor-help"
                title={t('tooltip')}
              >
                {t('badge')}
              </span>
            </div>
            <p
              className={`text-xl font-semibold tabular-nums ${
                card.value !== null && card.value < 0 ? 'text-destructive-ink' : 'text-foreground'
              }`}
            >
              {card.value === null ? t('grossProfitUnknown') : formatCurrency(card.value)}
            </p>
            {card.note && <p className="text-xs text-muted-foreground">{card.note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
