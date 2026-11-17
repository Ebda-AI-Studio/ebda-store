import type { AnalyticsPeriod, SalesGranularity } from '@ebda/shared';
import { formatPrice, intlLocaleForUi } from '@/lib/format';

export type { SalesGranularity };

export interface DashboardStats {
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  averageOrderValue: number;
  revenueChange: number;
  ordersChange: number;
  customersChange: number;
  /**
   * Sum of (price - costPrice) * qty over the window's order lines that have a
   * cost. `null` = lines were sold but none has a cost (profit unknown).
   */
  totalProfit: number | null;
  /** Sold lines with no cost price — excluded from totalProfit. */
  profitItemsMissingCost?: number;
  /** Revenue (piastres) of those lines. */
  profitRevenueMissingCost?: number;
  profitChange: number | null;
}

export interface SalesData {
  date: string;
  revenue: number;
  orders: number;
}

export interface TopProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  revenue: number;
  quantity: number;
  image?: string;
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  createdAt: string;
  customer?: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

export interface LowStockProduct {
  id: string;
  name: string;
  sku: string;
  inventory: number;
  images?: { url: string }[];
  /** Open (unfulfilled) backorder lines for this product */
  openBackorderCount?: number;
  /** Whether the product allows backorder purchases */
  acceptsBackorder?: boolean;
  /** Active reorder rule, if any */
  reorderRule?: {
    minQty: number;
    reorderQty: number;
    leadTimeDays: number;
    preferredSupplier?: { name: string } | null;
  } | null;
}

export interface GlWindow {
  /** False when the period has revenue but no cost of goods was booked: gross profit and net income are unknown. */
  costsKnown?: boolean;
  revenue: number;
  cogs: number;
  grossProfit: number;
  netIncome: number;
}

export interface StockSnapshot {
  stockValue: number;
  /** Products holding on-hand units, and how many of those have no cost price (the value skips them). */
  stockedProducts?: number;
  uncostedProducts?: number;
  openBackorderCount: number;
  backorderedDemandValue: number;
  reorderRulesCount: number;
}

export interface CashflowPoint {
  day: string;
  net: number;
}

/**
 * 9-preset date period union (+ 3 legacy values kept for back-compat with
 * saved URL params / state). Expanded 2026-05-21 (Ahmad: "add this every
 * date part in the code to give me the freedom of choosing"). The single
 * definition lives in `@ebda/shared` (`ANALYTICS_PERIODS`) so the API's
 * Zod enum and the `analytics.periodsSubtitle.*` i18n keys are checked
 * against the same list. Backend accepts startDate/endDate explicitly, so
 * the frontend resolves the preset to concrete dates before calling the API.
 */
export type Period = AnalyticsPeriod;

export interface ResolvedDateRange {
  startDate: Date;
  endDate: Date;
}

/**
 * Resolves a Period preset to a concrete {startDate, endDate} range.
 * Custom periods require the optional dateRange argument; if missing,
 * falls back to 'this_month'.
 *
 * Day boundaries use 00:00:00 / 23:59:59 in the user's local timezone
 * (the admin runs in the merchant's browser). Server-side analytics
 * queries accept any timezone — the comparison is `created_at >= start
 * AND created_at <= end`.
 */
export function resolveDateRange(period: Period, custom?: ResolvedDateRange): ResolvedDateRange {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (period) {
    case 'today':
      return { startDate: startOfDay(now), endDate: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { startDate: startOfDay(y), endDate: endOfDay(y) };
    }
    case 'last_7':
    case 'week': {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { startDate: startOfDay(start), endDate: endOfDay(now) };
    }
    case 'last_30': {
      const start = new Date(now);
      start.setDate(start.getDate() - 29);
      return { startDate: startOfDay(start), endDate: endOfDay(now) };
    }
    case 'last_90': {
      const start = new Date(now);
      start.setDate(start.getDate() - 89);
      return { startDate: startOfDay(start), endDate: endOfDay(now) };
    }
    case 'this_month':
    case 'month':
      return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        endDate: endOfDay(now),
      };
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { startDate: start, endDate: end };
    }
    case 'this_year':
    case 'year':
      return {
        startDate: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
        endDate: endOfDay(now),
      };
    case 'custom':
      return custom ?? resolveDateRange('this_month');
  }
}

export type ChartType = 'revenue' | 'orders';

/**
 * Formats minor units (integer piastres) to an EGP-denominated currency string.
 * Amounts are stored as piastres (1 EGP = 100 piastres); `formatMoney` scales.
 */
export function formatCurrency(amount: number): string {
  return formatPrice(amount);
}

/** Shortens large integers with K/M suffixes for compact stat display. */
export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * Chart axis label for a sales bucket key. Keys are already the viewer's
 * calendar day/month (`YYYY-MM-DD` / `YYYY-MM`), so they are formatted in UTC —
 * formatting them in the local zone shifted every label back a day west of UTC.
 */
export function formatDate(date: string, granularity: SalesGranularity = 'day'): string {
  return new Date(date).toLocaleDateString(
    intlLocaleForUi(),
    granularity === 'month'
      ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' }
  );
}
