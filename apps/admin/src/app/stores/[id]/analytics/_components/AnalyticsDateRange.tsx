'use client';

import { useT } from '@/i18n/useT';
import type { Period } from './types';

interface AnalyticsDateRangeProps {
  period: Period;
  onPeriodChange: (period: Period) => void;
}

const PERIODS: Period[] = ['week', 'month', 'year'];

/**
 * Period (week/month/year) pill-style selector.
 * Stateless — parent owns the current selection.
 */
export function AnalyticsDateRange({ period, onPeriodChange }: AnalyticsDateRangeProps) {
  const t = useT('analytics.periods');

  return (
    <div className="mb-6 flex items-center gap-1 rounded-xl bg-muted p-1 w-fit">
      {PERIODS.map(p => (
        <button
          type="button"
          key={p}
          onClick={() => onPeriodChange(p)}
          className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
            period === p
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(p)}
        </button>
      ))}
    </div>
  );
}
