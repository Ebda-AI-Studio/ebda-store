'use client';

import { useT } from '@/i18n/useT';
import { formatPercent, type AnswerEngineTrendPoint } from './types';

interface TrendChartProps {
  trend: AnswerEngineTrendPoint[];
}

/**
 * Minimal pure-CSS bar chart, no chart library — mirrors the
 * `SimpleBarChart` in `stores/[id]/analytics/_components/RevenueChart.tsx`
 * exactly (zero-dep, native `title` tooltip, SSR-safe).
 */
export function TrendChart({ trend }: TrendChartProps) {
  const t = useT('answerEngine.page');

  if (trend.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noData')}</p>;
  }

  const maxRate = Math.max(...trend.map(p => p.citedRate), 0.01);

  return (
    <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('trendTitle')}</h2>
      <div className="flex items-end gap-2 h-32">
        {trend.map(point => {
          const height = maxRate > 0 ? (point.citedRate / maxRate) * 100 : 0;
          return (
            <div key={point.weekStart} className="flex-1 flex flex-col items-center gap-1 group">
              <div
                className="w-full bg-primary rounded-t transition-all group-hover:bg-primary/90"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${point.weekStart}: ${formatPercent(point.citedRate)} (${point.citedCount}/${point.totalChecks})`}
              />
              <span className="text-[10px] text-muted-foreground -rotate-45 origin-top-left rtl:origin-top-right whitespace-nowrap">
                {point.weekStart.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
