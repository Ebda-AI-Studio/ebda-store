'use client';

import { useT } from '@/i18n/useT';
import type { CashflowPoint } from './types';
import { formatCurrency } from './types';

interface CashflowChartProps {
  data: CashflowPoint[];
  /** Label of the selected period (the chart follows the page's picker). */
  periodLabel: string;
}

/**
 * Minimal inline SVG bar chart showing daily net cash movement (DR - CR on
 * cash accounts 1000/1010/1020/1030) over the selected period.
 * Bars above baseline = net inflow; below = net outflow.
 */
export function CashflowChart({ data, periodLabel }: CashflowChartProps) {
  const t = useT('analytics.cashflow');

  if (data.length === 0) {
    return (
      <div className="bg-card rounded-md border p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-1">{t('title')}</h2>
        <p className="text-sm text-muted-foreground mb-4">{periodLabel}</p>
        <p className="text-sm text-muted-foreground text-center py-8">—</p>
      </div>
    );
  }

  const W = 520;
  const H = 120;
  // Layout from the data: N bars always span exactly the viewBox. A fixed
  // `max(2, floor(W/N) - 2)` bar with a 2px gap stopped shrinking past ~130
  // points, so on "This year" every bar from day ~130 landed at x >= W and was
  // clipped while the legend still claimed the full range (#2258). The gap
  // collapses on dense ranges so each bar keeps its whole step.
  const step = W / data.length;
  const gap = step > 4 ? 2 : 0;
  const barW = Math.max(step - gap, 0.5);
  const maxAbs = Math.max(...data.map(d => Math.abs(d.net)), 1);
  const midY = H / 2;

  return (
    <div className="bg-card rounded-md border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-1">{t('title')}</h2>
      <p className="text-sm text-muted-foreground mb-4">{periodLabel}</p>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label={t('netDaily')} role="img">
        {/* Zero line */}
        <line
          x1={0}
          y1={midY}
          x2={W}
          y2={midY}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={1}
        />

        {data.map((point, i) => {
          const ratio = point.net / maxAbs;
          const barH = Math.max(1, Math.abs(ratio) * (midY - 4));
          const positive = point.net >= 0;
          const x = i * step;
          const y = positive ? midY - barH : midY;

          return (
            <rect
              key={`${point.day}-${i}`}
              x={x}
              y={y}
              width={barW}
              height={barH}
              rx={1}
              className={positive ? 'fill-success' : 'fill-destructive'}
              opacity={0.85}
            >
              <title>{`${point.day}: ${formatCurrency(point.net)}`}</title>
            </rect>
          );
        })}
      </svg>

      {/* Min/Max legend */}
      <div className="flex justify-between mt-1 text-xs text-muted-foreground tabular-nums">
        <span>{data[0]?.day?.toString().slice(0, 10) ?? ''}</span>
        <span>{data[data.length - 1]?.day?.toString().slice(0, 10) ?? ''}</span>
      </div>
    </div>
  );
}
