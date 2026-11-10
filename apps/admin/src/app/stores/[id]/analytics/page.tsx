'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { reportRangeQueryString } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { DateRangePicker } from '../../../../components/DateRangePicker';
import { Alert } from '../../../../components/Alert';
import { AnalyticsSkeleton } from './_components/AnalyticsSkeleton';
import { AnalyticsStatsGrid } from './_components/AnalyticsStatsGrid';
import { CashflowChart } from './_components/CashflowChart';
import { GlKpiCards } from './_components/GlKpiCards';
import { InventorySnapshotCard } from './_components/InventorySnapshotCard';
import { LowStockAlertsCard } from './_components/LowStockAlertsCard';
import { PriceSourceCard } from './_components/PriceSourceCard';
import { RecentOrdersCard } from './_components/RecentOrdersCard';
import { RevenueChart } from './_components/RevenueChart';
import { TopProductsTable } from './_components/TopProductsTable';
import { ZeroResultSearchesCard } from './_components/ZeroResultSearchesCard';
import { resolveDateRange } from './_components/types';
import type { ChartType, Period, ResolvedDateRange } from './_components/types';
import { useAnalytics } from './_hooks/useAnalytics';
import { Button } from '@/components/ui/Button';

export default function AnalyticsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const tPage = useT('analytics.page');
  const tPeriods = useT('analytics.periodsSubtitle');
  const tErrors = useT('analytics.errors');

  const [period, setPeriod] = useState<Period>('this_month');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);
  const [chartType, setChartType] = useState<ChartType>('revenue');

  const {
    stats,
    gl,
    stockSnapshot,
    cashflow,
    salesData,
    salesGranularity,
    topProducts,
    recentOrders,
    lowStockProducts,
    isLoading,
    error,
    cashflowLocked,
    refetch,
  } = useAnalytics({ storeId, period, customRange });
  const periodLabel = tPeriods(period);
  // The same startDate/endDate the other range-aware cards use.
  const rangeQs = useMemo(
    () =>
      reportRangeQueryString(
        period === 'custom' && customRange ? customRange : resolveDateRange(period)
      ),
    [period, customRange]
  );

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <DateRangePicker
        period={period}
        custom={customRange}
        onChange={(p, c) => {
          setPeriod(p);
          if (c) setCustomRange(c);
        }}
      />

      {isLoading ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          {/* A failed call is surfaced, never rendered as an empty widget. */}
          {error !== null && (
            <Alert
              variant="destructive"
              compact
              className="mb-6"
              title={tErrors('loadFailedTitle')}
              description={error || tErrors('loadFailedBody')}
              action={
                <Button variant="link" size="sm" type="button" onClick={refetch}>
                  {tErrors('retry')}
                </Button>
              }
            />
          )}

          <AnalyticsStatsGrid stats={stats} />

          {/* GL KPI cards — sourced from journal_lines, refund-aware */}
          {gl && (
            <div className="mt-6">
              <GlKpiCards gl={gl} periodLabel={periodLabel} />
            </div>
          )}

          <RevenueChart
            salesData={salesData}
            granularity={salesGranularity}
            period={period}
            chartType={chartType}
            onChartTypeChange={setChartType}
          />

          {/* Inventory snapshot + Cashflow trend side by side */}
          {(stockSnapshot || cashflow.length > 0 || cashflowLocked) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              {stockSnapshot && <InventorySnapshotCard snapshot={stockSnapshot} />}
              {cashflowLocked ? (
                <div
                  className="rounded-xl border bg-card p-6 shadow-sm"
                  role="status"
                  data-testid="cashflow-locked"
                >
                  <h3 className="text-base font-semibold text-foreground">
                    {tErrors('cashflowLockedTitle')}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {tErrors('cashflowLockedBody')}
                  </p>
                  <Link
                    href={`/stores/${storeId}/billing`}
                    className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-primary-ink underline underline-offset-2"
                  >
                    {tErrors('cashflowLockedCta')}
                  </Link>
                </div>
              ) : (
                <CashflowChart data={cashflow} periodLabel={periodLabel} />
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <TopProductsTable products={topProducts} />
            <RecentOrdersCard orders={recentOrders} />
            <LowStockAlertsCard products={lowStockProducts} />
          </div>

          <PriceSourceCard storeId={storeId} rangeQs={rangeQs} />

          <ZeroResultSearchesCard storeId={storeId} />
        </>
      )}
    </AdminLayout>
  );
}
