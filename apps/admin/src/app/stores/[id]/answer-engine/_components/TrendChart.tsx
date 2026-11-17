'use client';

import { useT } from '@/i18n/useT';
import { formatPercent, type AnswerEngineTrendPoint } from './types';

interface TrendChartProps {
  trend: AnswerEngineTrendPoint[];
}

/**
 * Minimal pure-CSS bar chart, no chart library — mirrors the
 * `SimpleBarChart` in `stores/[id]/analytics/_components/RevenueChart.tsx`
 * exactly (zero-dep, native `title` tooltip, SSR-safe), including its layout
 * contract: the bar column needs `h-full justify-end` or every bar is 0px.
 */
export function TrendChart({ trend }: TrendChartProps) {
  const t = useT('answerEngine.page');

  // The page shows ONE empty state for the whole citations area, not one per panel.
  if (trend.length === 0) return null;

  const maxRate = Math.max(...trend.map(p => p.citedRate ?? 0), 0.01);

  return (
    <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('trendTitle')}</h2>
      <div className="flex items-end gap-2 h-32">
        {trend.map(point => {
          const height = maxRate > 0 ? ((point.citedRate ?? 0) / maxRate) * 100 : 0;
          return (
            <div
              key={point.weekStart}
              data-chart-column
              className="flex-1 h-full flex flex-col justify-end items-center gap-1 group"
            >
              <div
                data-chart-bar
                className="w-full bg-primary rounded-t transition-all group-hover:bg-primary/90"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${point.weekStart}: ${formatPercent(point.totalChecks > 0 ? point.citedRate : null)} (${point.citedCount}/${point.totalChecks})`}
              />
              <span className="text-xs text-muted-foreground -rotate-45 origin-top-left rtl:origin-top-right whitespace-nowrap">
                {point.weekStart.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
