'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import type {
  DashboardStats,
  LowStockProduct,
  Period,
  RecentOrder,
  SalesData,
  TopProduct,
} from '../_components/types';

interface UseAnalyticsArgs {
  storeId: string;
  period: Period;
}

/**
 * Fans out the five analytics endpoints in parallel and exposes the combined
 * loading state. We refetch on `period` change because the sales endpoint is
 * the only one that actually depends on it — the others are fetched again for
 * simplicity and to keep the skeleton UX consistent.
 */
export function useAnalytics({ storeId, period }: UseAnalyticsArgs) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [salesData, setSalesData] = useState<SalesData[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [lowStockProducts, setLowStockProducts] = useState<LowStockProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAnalytics = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);

    try {
      const basePath = `/api/v1/stores/${storeId}/analytics`;

      const [dashboardResult, salesResult, productsResult, ordersResult, stockResult] =
        await Promise.all([
          apiGet<{ stats: DashboardStats }>(`${basePath}/dashboard`),
          apiGet<{ sales: SalesData[] }>(`${basePath}/sales?period=${period}`),
          apiGet<{ products: TopProduct[] }>(`${basePath}/top-products?limit=5`),
          apiGet<{ orders: RecentOrder[] }>(`${basePath}/recent-orders?limit=5`),
          apiGet<{ products: LowStockProduct[] }>(`${basePath}/low-stock?threshold=10`),
        ]);

      if (dashboardResult.data) {
        setStats(dashboardResult.data.stats);
      }
      if (salesResult.data) {
        setSalesData(salesResult.data.sales);
      }
      if (productsResult.data) {
        setTopProducts(productsResult.data.products);
      }
      if (ordersResult.data) {
        setRecentOrders(ordersResult.data.orders);
      }
      if (stockResult.data) {
        setLowStockProducts(stockResult.data.products);
      }
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, period]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  return {
    stats,
    salesData,
    topProducts,
    recentOrders,
    lowStockProducts,
    isLoading,
  };
}
