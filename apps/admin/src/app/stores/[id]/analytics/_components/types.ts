export interface DashboardStats {
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  averageOrderValue: number;
  revenueChange: number;
  ordersChange: number;
  customersChange: number;
  /** Sum of (price - costPrice) * qty across order items in the window. */
  totalProfit: number;
  profitChange: number;
}

export interface SalesData {
  date: string;
  revenue: number;
  orders: number;
}

export interface TopProduct {
  id: string;
  name: string;
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
  revenue: number;
  cogs: number;
  grossProfit: number;
  netIncome: number;
}

export interface StockSnapshot {
  stockValue: number;
  openBackorderCount: number;
  backorderedDemandValue: number;
  reorderRulesCount: number;
}

export interface CashflowPoint {
  day: string;
  net: number;
}

/**
 * 9-preset date period union. Expanded 2026-05-21 (Ahmad: "add this every
 * date part in the code to give me the freedom of choosing"). Backend
 * accepts startDate/endDate explicitly, so frontend resolves the preset
 * to concrete dates before calling the API. Custom = caller-provided
 * date pair.
 */
export type Period =
  | 'today'
  | 'yesterday'
  | 'last_7'
  | 'last_30'
  | 'last_90'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'custom'
  // legacy values kept for back-compat with saved URL params / state
  | 'week'
  | 'month'
  | 'year';

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
 * Formats fils (integer) to a KWD-denominated localized currency string.
 * Amounts are stored as fils (1 KWD = 1000 fils) so we divide before formatting.
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(amount / 1000);
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

/** Short month+day format used on chart axis labels. */
export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
