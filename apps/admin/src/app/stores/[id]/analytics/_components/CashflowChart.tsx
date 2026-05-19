'use client';

import { useT } from '@/i18n/useT';
import type { CashflowPoint } from './types';
import { formatCurrency } from './types';

interface CashflowChartProps {
  data: CashflowPoint[];
}

/**
 * Minimal inline SVG bar chart showing daily net cash movement (DR - CR on
 * cash accounts 1000/1010/1020/1030) over the last 30 days.
 * Bars above baseline = net inflow; below = net outflow.
 */
export function CashflowChart({ data }: CashflowChartProps) {
  const t = useT('analytics.cashflow');

  if (data.length === 0) {
    return (
      <div className="bg-card rounded-xl border p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-1">{t('title')}</h2>
        <p className="text-sm text-muted-foreground mb-4">{t('last30')}</p>
        <p className="text-sm text-muted-foreground text-center py-8">—</p>
      </div>
    );
  }

  const W = 520;
  const H = 120;
  const BAR_GAP = 2;
  const barW = Math.max(2, Math.floor(W / data.length) - BAR_GAP);
  const maxAbs = Math.max(...data.map(d => Math.abs(d.net)), 1);
  const midY = H / 2;

  return (
    <div className="bg-card rounded-xl border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-1">{t('title')}</h2>
      <p className="text-sm text-muted-foreground mb-4">{t('last30')}</p>

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
          const x = i * (barW + BAR_GAP);
          const y = positive ? midY - barH : midY;

          return (
            <rect
              key={`${point.day}-${i}`}
              x={x}
              y={y}
              width={barW}
              height={barH}
              rx={1}
              className={positive ? 'fill-emerald-500 dark:fill-emerald-400' : 'fill-destructive'}
              opacity={0.85}
            >
              <title>{`${point.day}: ${formatCurrency(point.net)}`}</title>
            </rect>
          );
        })}
      </svg>

      {/* Min/Max legend */}
      <div className="flex justify-between mt-1 text-[10px] text-muted-foreground tabular-nums">
        <span>{data[0]?.day?.toString().slice(0, 10) ?? ''}</span>
        <span>{data[data.length - 1]?.day?.toString().slice(0, 10) ?? ''}</span>
      </div>
    </div>
  );
}
