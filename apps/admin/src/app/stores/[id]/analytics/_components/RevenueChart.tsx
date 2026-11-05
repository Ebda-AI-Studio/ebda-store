'use client';

import { useT } from '@/i18n/useT';
import {
  formatCurrency,
  formatDate,
  type ChartType,
  type Period,
  type SalesData,
  type SalesGranularity,
} from './types';

interface SimpleBarChartProps {
  data: SalesData[];
  dataKey: ChartType;
  granularity: SalesGranularity;
  label: string;
  maxLabel: string;
}

/**
 * Minimal pure-CSS bar chart.
 * We skip a chart lib on purpose — the data shape is tiny and the hover tooltip
 * is a native `title` attribute, so this stays zero-dep and SSR-safe.
 *
 * Layout contract (do not drop `h-full justify-end` from the bar column): the
 * row is `items-end h-40`, and `items-end` stops a flex item from stretching,
 * so without an explicit `h-full` the column's height is indefinite and each
 * bar's `height: N%` resolves to auto = 0px — the chart drew axis labels and
 * no bars on every store (2026-09-30 audit, measured 0/0/0 px in Chromium).
 * Pinned by tests/unit/analytics-bar-charts-render.test.tsx.
 */
export function SimpleBarChart({
  data,
  dataKey,
  granularity,
  label,
  maxLabel,
}: SimpleBarChartProps) {
  if (!data.length) return null;

  const maxValue = Math.max(...data.map(d => d[dataKey]));

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-muted-foreground mb-4">
        <span>{label}</span>
        <span>
          {maxLabel}: {dataKey === 'revenue' ? formatCurrency(maxValue) : maxValue}
        </span>
      </div>
      <div className="flex items-end gap-1 h-40">
        {data.map((item, i) => {
          const height = maxValue > 0 ? (item[dataKey] / maxValue) * 100 : 0;
          return (
            <div
              key={i}
              data-chart-column
              className="flex-1 h-full flex flex-col justify-end items-center gap-1 group"
            >
              <div
                data-chart-bar
                className="w-full bg-primary rounded-t transition-all group-hover:bg-primary/90"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${formatDate(item.date, granularity)}: ${dataKey === 'revenue' ? formatCurrency(item[dataKey]) : item[dataKey]}`}
              />
              {i % Math.ceil(data.length / 7) === 0 && (
                <span className="text-xs text-muted-foreground -rotate-45 origin-top-left rtl:origin-top-right whitespace-nowrap">
                  {formatDate(item.date, granularity)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RevenueChartProps {
  salesData: SalesData[];
  granularity: SalesGranularity;
  period: Period;
  chartType: ChartType;
  onChartTypeChange: (type: ChartType) => void;
}

/**
 * Sales overview card: period subtitle + revenue/orders toggle + bar chart.
 * The toggle mirrors the period selector above for visual consistency.
 */
export function RevenueChart({
  salesData,
  granularity,
  period,
  chartType,
  onChartTypeChange,
}: RevenueChartProps) {
  const t = useT('analytics.chart');
  const tPeriods = useT('analytics.periodsSubtitle');
  const hasSales = salesData.some(d => d.revenue > 0 || d.orders > 0);

  return (
    <div className="bg-card rounded-xl border p-6 shadow-sm mb-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {tPeriods(period)} · {t(`granularity.${granularity}`)}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => onChartTypeChange('revenue')}
            className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 ${
              chartType === 'revenue'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('revenue')}
          </button>
          <button
            type="button"
            onClick={() => onChartTypeChange('orders')}
            className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 ${
              chartType === 'orders'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('orders')}
          </button>
        </div>
      </div>
      {hasSales ? (
        <SimpleBarChart
          data={salesData}
          dataKey={chartType}
          granularity={granularity}
          label={chartType === 'revenue' ? t('revenue') : t('numberOfOrders')}
          maxLabel={t('max')}
        />
      ) : (
        <p className="text-sm text-muted-foreground text-center py-10">{t('noSales')}</p>
      )}
    </div>
  );
}
