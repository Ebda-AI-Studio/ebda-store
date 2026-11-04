'use client';

import { useCallback, useEffect, useState } from 'react';
import { reportRangeQueryString } from '@ebda/shared';
import { apiGet } from '../../../../../lib/api';
import { useLatestRequest } from '../../../../../hooks/useLatestRequest';
import { isPlanGateError } from '../../../../../lib/route-feature-gates';
import type {
  CashflowPoint,
  DashboardStats,
  GlWindow,
  LowStockProduct,
  Period,
  RecentOrder,
  ResolvedDateRange,
  SalesData,
  SalesGranularity,
  StockSnapshot,
  TopProduct,
} from '../_components/types';
import { resolveDateRange } from '../_components/types';

interface UseAnalyticsArgs {
  storeId: string;
  period: Period;
  customRange?: ResolvedDateRange;
}

interface DashboardResponseData {
  stats: DashboardStats | null;
  gl: GlWindow | null;
  stock: StockSnapshot | null;
  /** Sub-queries the API could not load (issue 2256) — a 200 can be partial. */
  failed?: string[];
}

/**
 * Fans out analytics endpoints in parallel and exposes the combined loading
 * state. Dashboard returns gl + stock alongside operational stats. Every
 * range-aware endpoint (dashboard incl. GL, sales, top products, cashflow)
 * gets the same `startDate`/`endDate` pair from the period picker.
 * Recent orders and low stock are deliberately NOT period-based (latest 5
 * orders; stock right now) — their cards say so in the title.
 *
 * `error` carries the first failed call's message. Before it existed a failed
 * call left its widget at the initial empty state, which read as "no sales
 * yet" instead of "this did not load" (2026-09-30 audit, finding 8).
 */
export function useAnalytics({ storeId, period, customRange }: UseAnalyticsArgs) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [gl, setGl] = useState<GlWindow | null>(null);
  const [stockSnapshot, setStockSnapshot] = useState<StockSnapshot | null>(null);
  const [cashflow, setCashflow] = useState<CashflowPoint[]>([]);
  const [salesData, setSalesData] = useState<SalesData[]>([]);
  const [salesGranularity, setSalesGranularity] = useState<SalesGranularity>('day');
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [lowStockProducts, setLowStockProducts] = useState<LowStockProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cashflowLocked, setCashflowLocked] = useState(false);
  // Latest-request-wins: switching period while a slower earlier request is
  // still in flight must not let that stale response overwrite the new one
  // (the page would show the OLD range under the NEW pill).
  const beginRequest = useLatestRequest();

  const fetchAnalytics = useCallback(async () => {
    if (!storeId) return;
    const isLatest = beginRequest();
    setIsLoading(true);
    setError(null);

    try {
      const basePath = `/api/v1/stores/${storeId}/analytics`;
      // Resolve the period preset to concrete startDate/endDate so the
      // backend gets explicit timestamps. Custom range overrides via
      // ResolvedDateRange passed from the picker.
      const range = period === 'custom' && customRange ? customRange : resolveDateRange(period);
      // The shared contract names the params, so admin and API cannot drift.
      const rangeQs = reportRangeQueryString(range);
      // Viewer's UTC offset (east-positive minutes) so the sales buckets are
      // the same calendar days the preset was resolved in.
      const tzOffset = -new Date().getTimezoneOffset();

      const [
        dashboardResult,
        salesResult,
        productsResult,
        ordersResult,
        stockResult,
        cashflowResult,
      ] = await Promise.all([
        apiGet<DashboardResponseData>(`${basePath}/dashboard?${rangeQs}`),
        apiGet<{ sales: SalesData[]; granularity?: SalesGranularity }>(
          `${basePath}/sales?period=${period}&${rangeQs}&tzOffset=${tzOffset}`
        ),
        apiGet<{ products: TopProduct[] }>(`${basePath}/top-products?limit=5&${rangeQs}`),
        apiGet<{ orders: RecentOrder[] }>(`${basePath}/recent-orders?limit=5`),
        apiGet<{ products: LowStockProduct[] }>(`${basePath}/low-stock?threshold=10`),
        apiGet<{ trend: Array<{ day: string; net: number }> }>(`${basePath}/cashflow?${rangeQs}`),
      ]);
      if (!isLatest()) return;

      if (dashboardResult.data) {
        setStats(dashboardResult.data.stats);
        setGl(dashboardResult.data.gl ?? null);
        setStockSnapshot(dashboardResult.data.stock ?? null);
      }
      if (salesResult.data) {
        setSalesData(salesResult.data.sales);
        setSalesGranularity(salesResult.data.granularity ?? 'day');
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

      // BE:S-4 - cashflow (and the stock snapshot) are owner + accounting.basic only. A plan or role refusal there is
      // a LOCKED section, not a failed page: it must never read as an error banner with raw API text.
      const refused = (e: { status?: number; code?: string } | null) =>
        !!e && (isPlanGateError(e) || e.status === 403);
      setCashflowLocked(refused(cashflowResult.error));

      const failed = [
        dashboardResult,
        salesResult,
        productsResult,
        ordersResult,
        stockResult,
        cashflowResult,
      ].find(r => r.error && !(r === cashflowResult && refused(r.error)));
      // `''` (a failure with no message) is still an error: the page renders its
      // own translated fallback. Only `null` means "everything loaded".
      if (failed?.error) setError(failed.error.message ?? '');
      // A 200 whose sub-queries failed is a load error too (issue 2256):
      // `''` renders the page's own translated "did not load" fallback.
      else if (dashboardResult.data?.failed?.length) setError('');
    } catch (err) {
      if (!isLatest()) return;
      console.error('Failed to fetch analytics:', err);
      setError(err instanceof Error ? err.message : '');
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [
    storeId,
    period,
    customRange?.startDate.getTime(),
    customRange?.endDate.getTime(),
    beginRequest,
  ]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  return {
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
    refetch: fetchAnalytics,
  };
}
