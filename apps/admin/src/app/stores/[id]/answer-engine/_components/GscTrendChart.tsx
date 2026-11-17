'use client';

import { useT } from '@/i18n/useT';
import { formatPercent, formatPosition, type GscTrendPoint } from './types';
import { withNumerals } from '@ebda/shared';

interface GscTrendChartProps {
  trend: GscTrendPoint[];
}

/**
 * Minimal pure-CSS bar chart, no chart library — clones `TrendChart`'s
 * zero-dep approach exactly (native `title` tooltip, SSR-safe). Bars are
 * scaled to impressions (the larger-magnitude metric); clicks render as an
 * overlaid inner bar so both are visible at a glance, tooltip carries the
 * full day's numbers including CTR and position.
 */
export function GscTrendChart({ trend }: GscTrendChartProps) {
  const t = useT('answerEngine.gsc');

  if (trend.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noTrend')}</p>;
  }

  const maxImpressions = Math.max(...trend.map(p => p.impressions), 1);

  return (
    <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('trendTitle')}</h2>
      <div className="flex items-end gap-2 h-32">
        {trend.map(point => {
          const impressionsHeight = (point.impressions / maxImpressions) * 100;
          const clicksHeight = point.impressions > 0 ? (point.clicks / maxImpressions) * 100 : 0;
          return (
            <div
              key={point.date}
              data-chart-column
              className="flex-1 h-full flex flex-col justify-end items-center gap-1 group"
            >
              <div
                data-chart-bar
                className="relative w-full bg-primary/20 rounded-t transition-all"
                style={{ height: `${Math.max(impressionsHeight, 2)}%` }}
                title={`${point.date}: ${point.impressions.toLocaleString(undefined, withNumerals())} ${t('impressions')}, ${point.clicks.toLocaleString(undefined, withNumerals())} ${t('clicks')}, ${formatPercent(point.impressions > 0 ? point.ctr : null)} ${t('ctr')}, ${t('avgPosition')} ${formatPosition(point.impressions > 0 ? point.position : null)}`}
              >
                <div
                  className="absolute bottom-0 w-full bg-primary rounded-t group-hover:bg-primary/90"
                  style={{ height: `${Math.max(clicksHeight, clicksHeight > 0 ? 2 : 0)}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground -rotate-45 origin-top-left rtl:origin-top-right whitespace-nowrap">
                {point.date.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary/20" /> {t('impressions')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary" /> {t('clicks')}
        </span>
      </div>
    </div>
  );
}
