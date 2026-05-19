'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import type {
  CashflowPoint,
  DashboardStats,
  GlWindow,
  LowStockProduct,
  Period,
  RecentOrder,
  SalesData,
  StockSnapshot,
  TopProduct,
} from '../_components/types';

interface UseAnalyticsArgs {
  storeId: string;
  period: Period;
}

interface DashboardResponseData {
  stats: DashboardStats;
  gl: GlWindow;
  stock: StockSnapshot;
}

/**
 * Fans out analytics endpoints in parallel and exposes the combined loading
 * state. Dashboard now returns gl + stock alongside operational stats.
 * Cashflow is fetched separately (last 30 days, independent of period selector).
 */
export function useAnalytics({ storeId, period }: UseAnalyticsArgs) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [gl, setGl] = useState<GlWindow | null>(null);
  const [stockSnapshot, setStockSnapshot] = useState<StockSnapshot | null>(null);
  const [cashflow, setCashflow] = useState<CashflowPoint[]>([]);
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

      const [
        dashboardResult,
        salesResult,
        productsResult,
        ordersResult,
        stockResult,
        cashflowResult,
      ] = await Promise.all([
        apiGet<DashboardResponseData>(`${basePath}/dashboard`),
        apiGet<{ sales: SalesData[] }>(`${basePath}/sales?period=${period}`),
        apiGet<{ products: TopProduct[] }>(`${basePath}/top-products?limit=5`),
        apiGet<{ orders: RecentOrder[] }>(`${basePath}/recent-orders?limit=5`),
        apiGet<{ products: LowStockProduct[] }>(`${basePath}/low-stock?threshold=10`),
        apiGet<{ trend: Array<{ day: string; net: number }> }>(`${basePath}/cashflow`),
      ]);

      if (dashboardResult.data) {
        setStats(dashboardResult.data.stats);
        setGl(dashboardResult.data.gl ?? null);
        setStockSnapshot(dashboardResult.data.stock ?? null);
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
      if (cashflowResult.data) {
        setCashflow(cashflowResult.data.trend ?? []);
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
    gl,
    stockSnapshot,
    cashflow,
    salesData,
    topProducts,
    recentOrders,
    lowStockProducts,
    isLoading,
  };
}
