'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { DateRangePicker } from '../../../../components/DateRangePicker';
import { AnalyticsSkeleton } from './_components/AnalyticsSkeleton';
import { AnalyticsStatsGrid } from './_components/AnalyticsStatsGrid';
import { CashflowChart } from './_components/CashflowChart';
import { GlKpiCards } from './_components/GlKpiCards';
import { InventorySnapshotCard } from './_components/InventorySnapshotCard';
import { LowStockAlertsCard } from './_components/LowStockAlertsCard';
import { RecentOrdersCard } from './_components/RecentOrdersCard';
import { RevenueChart } from './_components/RevenueChart';
import { TopProductsTable } from './_components/TopProductsTable';
import type { ChartType, Period, ResolvedDateRange } from './_components/types';
import { useAnalytics } from './_hooks/useAnalytics';

export default function AnalyticsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const tPage = useT('analytics.page');

  const [period, setPeriod] = useState<Period>('this_month');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);
  const [chartType, setChartType] = useState<ChartType>('revenue');

  const {
    stats,
    gl,
    stockSnapshot,
    cashflow,
    salesData,
    topProducts,
    recentOrders,
    lowStockProducts,
    isLoading,
  } = useAnalytics({ storeId, period, customRange });

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
          <AnalyticsStatsGrid stats={stats} />

          {/* GL KPI cards — sourced from journal_lines, refund-aware */}
          {gl && (
            <div className="mt-6">
              <GlKpiCards gl={gl} />
            </div>
          )}

          <RevenueChart
            salesData={salesData}
            period={period}
            chartType={chartType}
            onChartTypeChange={setChartType}
          />

          {/* Inventory snapshot + Cashflow trend side by side */}
          {(stockSnapshot || cashflow.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              {stockSnapshot && <InventorySnapshotCard snapshot={stockSnapshot} />}
              <CashflowChart data={cashflow} />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <TopProductsTable products={topProducts} />
            <RecentOrdersCard orders={recentOrders} />
            <LowStockAlertsCard products={lowStockProducts} />
          </div>
        </>
      )}
    </AdminLayout>
  );
}
