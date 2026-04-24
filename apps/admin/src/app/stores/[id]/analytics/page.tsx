'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { AnalyticsDateRange } from './_components/AnalyticsDateRange';
import { AnalyticsSkeleton } from './_components/AnalyticsSkeleton';
import { AnalyticsStatsGrid } from './_components/AnalyticsStatsGrid';
import { LowStockAlertsCard } from './_components/LowStockAlertsCard';
import { RecentOrdersCard } from './_components/RecentOrdersCard';
import { RevenueChart } from './_components/RevenueChart';
import { TopProductsTable } from './_components/TopProductsTable';
import type { ChartType, Period } from './_components/types';
import { useAnalytics } from './_hooks/useAnalytics';

export default function AnalyticsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const tPage = useT('analytics.page');

  const [period, setPeriod] = useState<Period>('month');
  const [chartType, setChartType] = useState<ChartType>('revenue');

  const { stats, salesData, topProducts, recentOrders, lowStockProducts, isLoading } = useAnalytics(
    { storeId, period }
  );

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <AnalyticsDateRange period={period} onPeriodChange={setPeriod} />

      {isLoading ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          <AnalyticsStatsGrid stats={stats} />
          <RevenueChart
            salesData={salesData}
            period={period}
            chartType={chartType}
            onChartTypeChange={setChartType}
          />
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
