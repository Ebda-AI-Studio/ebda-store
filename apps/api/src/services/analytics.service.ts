import { currentStoreId, prisma, Prisma } from '@ebda/database';
import { customerRows } from '../lib/customer-directory';
import { ON_HAND_SQL, storeStockValueFils } from '../lib/effective-inventory-sql';
import { storeDb, storeMoney, storeRepo } from '../lib/repo-factory';
import { countDistinctCustomersGrouped } from '../lib/buyer-counts';
import { redis } from './redis.service';
import { getCached } from '../lib/public-cache';
import { analyticsDashboardPrefix } from '../lib/revenue-cache';
import { netRevenue } from './revenue.service';
import { topCustomersNet } from '../lib/order-refunds';
import {
  netLinesInnerSql,
  netLinesWrapSql,
  NON_REVENUE_PAYMENT_STATUSES,
  orderNetRevenueSql,
  refundJoinsSql,
  revenueOrderPredicateSql,
} from '../lib/revenue-sql';
import { profitAndLoss } from './accounting/reports.service';
import {
  NON_REVENUE_ORDER_STATUSES,
  pickSalesGranularity,
  regionDayStart,
  regionMonthStart,
  regionYearMonth,
  type AnalyticsPeriod,
  type SalesGranularity,
} from '@ebda/shared';

/** Revenue-population filter, shared with the Postgres queries below (the DO ops take it as a parameter). */
const NON_REVENUE: string[] = [...NON_REVENUE_ORDER_STATUSES];

/**
 * "This month / this year / today" start in the REGION's zone (Africa/Cairo, DST-aware), not the runtime's.
 * Workers run in UTC, so `new Date(y, m, 1)` started the month at 00:00 UTC = 02:00 or 03:00 Cairo and orders in
 * the first hours of the 1st were counted in the previous month (finding M-124, Ruling P18-2). Egypt's offset
 * switches from +3 to +2 on 2026-10-30; the shared helpers know that.
 */
export function currentMonthStart(now: Date): Date {
  return regionMonthStart(regionYearMonth(now));
}
export function currentYearStart(now: Date): Date {
  return regionMonthStart(`${regionYearMonth(now).slice(0, 4)}-01`);
}

/**
 * Postgres twin of `analyticsItems`: order lines of revenue-population orders grouped by product or price source, each line net of
 * its pro-rata share of the order's partial refund (REVENUE-DEF-1, lib/revenue-sql.ts).
 */
async function pgLineRevenue(
  storeId: string,
  startDate: Date,
  endDate: Date,
  by: 'product' | 'priceSource',
  limit?: number
): Promise<
  Array<{
    productId: string;
    priceSource: string | null;
    priceGroupApplied: boolean | null;
    quantity: number;
    total: number;
  }>
> {
  const wrap = netLinesWrapSql('pg');
  const inner = Prisma.raw(netLinesInnerSql('pg'));
  const head = Prisma.raw(wrap.head);
  const tail = Prisma.raw(wrap.tail);
  const counts = Prisma.raw(revenueOrderPredicateSql('o', 'pg'));
  const rows =
    by === 'product'
      ? await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT l.product_id AS "productId", COALESCE(SUM(l.quantity), 0)::bigint AS quantity,
               COALESCE(SUM(l.net_total), 0)::bigint AS total
          FROM ${head}${inner}
         WHERE o.store_id = ${storeId} AND o.created_at >= ${startDate} AND o.created_at <= ${endDate} AND ${counts}${tail}
         GROUP BY l.product_id ORDER BY total DESC, l.product_id ASC LIMIT ${limit ?? 100000}`
      : await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT l.price_source AS "priceSource", l.price_group_applied AS "priceGroupApplied",
               COALESCE(SUM(l.quantity), 0)::bigint AS quantity, COALESCE(SUM(l.net_total), 0)::bigint AS total
          FROM ${head}${inner}
         WHERE o.store_id = ${storeId} AND o.created_at >= ${startDate} AND o.created_at <= ${endDate} AND ${counts}${tail}
         GROUP BY l.price_source, l.price_group_applied`;
  return rows.map(r => ({
    productId: String(r.productId ?? ''),
    priceSource: (r.priceSource as string | null) ?? null,
    priceGroupApplied: r.priceGroupApplied == null ? null : Boolean(r.priceGroupApplied),
    quantity: Number(r.quantity),
    total: Number(r.total),
  }));
}

/**
 * The named contact on an order's shipping address, shaped like the customer relation. An order whose account did not join (a
 * guest, an erased account, directory lag) still carries the name the buyer typed; the Customers page shows that name, so the
 * recent-orders card must not call the same buyer a visitor (STORE-QA-22). Null only when no name was given.
 */
function shippingContact(
  shipping: unknown
): { firstName: string; lastName: string; email: string } | null {
  const a = (shipping ?? null) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const firstName = str(a?.firstName);
  const lastName = str(a?.lastName);
  if (!firstName && !lastName) return null;
  return { firstName, lastName, email: str(a?.email) };
}

// ==========================================
// Simple cache-aside helper for analytics queries (60s TTL).
// Uses Redis when available, falls back to an in-memory Map.
// ==========================================

const analyticsMemCache = new Map<string, { data: unknown; expiresAt: number }>();
/**
 * Hard cap on the in-memory fallback (Ruling P18-1, finding M-127). Keys carry the store id and the date range,
 * and every value is a whole aggregation payload, so an isolate that never evicted grew until it was recycled at
 * the memory limit. An expired entry is deleted on read, and a write past the cap drops expired entries first,
 * then the oldest (Map keeps insertion order).
 */
export const ANALYTICS_MEM_CACHE_MAX = 500;

/** Test seam: the live entry count of the in-memory cache. */
export function analyticsMemCacheSize(): number {
  return analyticsMemCache.size;
}

function memCacheSet(key: string, data: unknown, ttlSeconds: number): void {
  const now = Date.now();
  analyticsMemCache.delete(key); // re-insert so the key becomes the newest
  analyticsMemCache.set(key, { data, expiresAt: now + ttlSeconds * 1000 });
  if (analyticsMemCache.size <= ANALYTICS_MEM_CACHE_MAX) return;
  for (const [k, v] of analyticsMemCache) {
    if (v.expiresAt <= now) analyticsMemCache.delete(k);
  }
  while (analyticsMemCache.size > ANALYTICS_MEM_CACHE_MAX) {
    const oldest = analyticsMemCache.keys().next().value;
    if (oldest === undefined) break;
    analyticsMemCache.delete(oldest);
  }
}

// Exported (2026-07-22, answer-engine dashboard) so other read-only,
// tenant-scoped aggregation services can reuse the same Redis-then-memory
// cache-aside helper instead of re-implementing it — see
// `services/answer-engine/dashboard.service.ts`.
export async function getCachedAnalytics<T>(
  key: string,
  ttl: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  // Try Redis
  try {
    const cached = await redis.get<string>(key);
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : (cached as T);
    }
  } catch {
    // Redis unavailable
  }

  // Try in-memory
  const memEntry = analyticsMemCache.get(key);
  if (memEntry && memEntry.expiresAt > Date.now()) {
    return memEntry.data as T;
  }
  if (memEntry) analyticsMemCache.delete(key); // expired: never keep it

  const data = await fetchFn();

  // Write to Redis (best-effort)
  try {
    await redis.set(key, JSON.stringify(data), ttl);
  } catch {
    // Redis unavailable
  }

  memCacheSet(key, data, ttl);
  return data;
}

/** Residual window of the all-time customer count (see getAllTimeCustomers). */
const ALL_TIME_CUSTOMERS_TTL_S = 900;

/** Last millisecond of the minute containing `d`. */
export function endOfMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000 + 59_999);
}

interface DateRange {
  startDate: Date;
  endDate: Date;
}

interface DashboardStats {
  totalRevenue: number;
  totalOrders: number;
  /**
   * Distinct customers who ordered within the selected period, keyed exactly
   * like the Customers page (registered user, else shipping email, else
   * shipping phone — `lib/customer-key.ts`), so guest buyers count.
   */
  totalCustomers: number;
  /** Cumulative distinct customers across all time (period-independent), same key. */
  allTimeCustomers: number;
  totalProducts: number;
  averageOrderValue: number;
  /**
   * Orders completed per product view over the period, as a percentage, from
   * the nightly `funnel_snapshots` rollup (`conversionRateBasis`). `null` when
   * the period has no snapshot rows or no recorded views — unknown, never 0.
   */
  conversionRate: number | null;
  conversionRateBasis: 'orders_per_product_view';
  revenueChange: number;
  ordersChange: number;
  customersChange: number;
  /**
   * Sum of (price - costPrice) * quantity over the period's order lines that
   * carry a cost snapshot (orders not cancelled/refunded). `null` when lines
   * were sold but NONE of them has a cost — profit is unknown, not 0. When
   * only some lines lack cost the figure covers the costed lines only and
   * `profitItemsMissingCost` > 0 says so.
   */
  totalProfit: number | null;
  /** Order lines in the period whose cost is missing (excluded from `totalProfit`). */
  profitItemsMissingCost: number;
  /** Revenue (piastres) of those lines — the sales `totalProfit` does not cover. */
  profitRevenueMissingCost: number;
  /** `null` when either period's profit is unknown or incomplete. */
  profitChange: number | null;
}

interface SalesData {
  date: string;
  revenue: number;
  orders: number;
}

/** First instant (UTC clock) of the bucket containing `d`. Monday-start weeks. */
export function salesBucketStart(d: Date, granularity: SalesGranularity): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (granularity === 'day') return day;
  if (granularity === 'week') {
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day;
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Chart key for a bucket start: `YYYY-MM-DD` (day/week) or `YYYY-MM` (month). */
export function salesBucketKey(d: Date, granularity: SalesGranularity): string {
  const iso = salesBucketStart(d, granularity).toISOString();
  return granularity === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

interface TopProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  revenue: number;
  quantity: number;
  image?: string;
}

interface TopCategory {
  id: string;
  name: string;
  slug: string;
  revenue: number;
  productCount: number;
}

interface OrdersByStatus {
  status: string;
  count: number;
  percentage: number;
}

interface CustomerStats {
  newCustomers: number;
  returningCustomers: number;
  topCustomers: {
    id: string;
    name: string;
    email: string;
    totalSpent: number;
    orderCount: number;
  }[];
}

/**
 * The DO twin of the two `user.count` statements in `getCustomerStats` (the `user.orders` relation is in another database):
 * the buyers with an order in the period are read flat, then split by whether they also ordered before it.
 */
async function doNewAndReturning(
  odb: Awaited<ReturnType<typeof storeDb>>,
  storeId: string,
  startDate: Date,
  endDate: Date
): Promise<{ newCustomers: number; returningCustomers: number }> {
  const inPeriod = await odb.order.groupBy({
    by: ['customerId'],
    where: {
      storeId,
      customerId: { not: null },
      createdAt: { gte: startDate, lte: endDate },
    },
  });
  const ids = inPeriod.map(g => g.customerId).filter((id): id is string => id != null);
  let returning = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const before = await odb.order.groupBy({
      by: ['customerId'],
      where: { storeId, customerId: { in: ids.slice(i, i + 500) }, createdAt: { lt: startDate } },
    });
    returning += before.length;
  }
  return { newCustomers: ids.length - returning, returningCustomers: returning };
}

export class AnalyticsService {
  /**
   * Get dashboard overview stats
   */
  static async getDashboardStats(storeId: string, dateRange?: DateRange): Promise<DashboardStats> {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    // The default window ends "now". Quantised to the END of the current
    // minute (issue 2247): a raw `now` made the key below unique per
    // millisecond, so a caller that omits the range never hit the 120s cache
    // and recomputed the whole dashboard on every request. Ending at the
    // minute's last millisecond still includes every order placed so far.
    const endDate = dateRange?.endDate || endOfMinute(now);

    // Build a cache key that includes the date range so different periods don't collide
    const cacheKey = `${analyticsDashboardPrefix(storeId)}${startDate.toISOString()}:${endDate.toISOString()}`;

    // STORE-QA-74: revenue is NEVER-stale. The generation-guarded cache (public-cache) so every order / payment / refund / return write
    // of the store drops this entry (`invalidateStoreRevenueCaches`, called from the money-op transport); the 120 s TTL is only the
    // backstop for a Redis outage.
    return getCached(cacheKey, 120, async () => {
      return this._computeDashboardStats(storeId, startDate, endDate);
    });
  }

  private static async _computeDashboardStats(
    storeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<DashboardStats> {
    // Calculate previous period for comparison
    const periodLength = endDate.getTime() - startDate.getTime();
    const prevStartDate = new Date(startDate.getTime() - periodLength);
    const prevEndDate = new Date(startDate.getTime() - 1);

    // Current period stats
    const [currentStats, prevStats, totalCustomers, totalProducts, conversionRate] =
      await Promise.all([
        this.getPeriodStats(storeId, startDate, endDate),
        this.getPeriodStats(storeId, prevStartDate, prevEndDate),
        this.getAllTimeCustomers(storeId),
        (await storeDb(storeId)).product.count({
          where: { storeId, status: 'active' },
        }),
        this.getViewsConversionRate(storeId, startDate, endDate),
      ]);
    // Same population on both sides of customersChange (it compared users of
    // ANY order status against order groups that excluded cancelled/refunded).
    const customerCount = currentStats.customers;

    // Calculate changes
    const revenueChange =
      prevStats.revenue > 0
        ? ((currentStats.revenue - prevStats.revenue) / prevStats.revenue) * 100
        : currentStats.revenue > 0
          ? 100
          : 0;

    const ordersChange =
      prevStats.orders > 0
        ? ((currentStats.orders - prevStats.orders) / prevStats.orders) * 100
        : currentStats.orders > 0
          ? 100
          : 0;

    const customersChange =
      prevStats.customers > 0
        ? ((customerCount - prevStats.customers) / prevStats.customers) * 100
        : customerCount > 0
          ? 100
          : 0;

    // A change is only meaningful between two COMPLETE profit figures — a
    // period whose lines lack cost would read as a fake drop or jump.
    const profitComparable =
      currentStats.profit !== null &&
      prevStats.profit !== null &&
      currentStats.itemsMissingCost === 0 &&
      prevStats.itemsMissingCost === 0;
    const profitChange = !profitComparable
      ? null
      : prevStats.profit! > 0
        ? ((currentStats.profit! - prevStats.profit!) / prevStats.profit!) * 100
        : currentStats.profit! > 0
          ? 100
          : 0;

    return {
      totalRevenue: currentStats.revenue,
      totalOrders: currentStats.orders,
      // Period-scoped distinct customers (customers who ordered within the
      // selected window) so this KPI moves with the date picker like
      // revenue/orders, instead of showing the misleading all-time count.
      // `totalCustomers` (all-time) remains available below as
      // `allTimeCustomers` for callers that want the cumulative figure.
      totalCustomers: customerCount,
      allTimeCustomers: totalCustomers,
      totalProducts,
      averageOrderValue: currentStats.orders > 0 ? currentStats.revenue / currentStats.orders : 0,
      conversionRate,
      conversionRateBasis: 'orders_per_product_view',
      revenueChange: Math.round(revenueChange * 10) / 10,
      ordersChange: Math.round(ordersChange * 10) / 10,
      customersChange: Math.round(customersChange * 10) / 10,
      totalProfit: currentStats.profit,
      profitItemsMissingCost: currentStats.itemsMissingCost,
      profitRevenueMissingCost: currentStats.revenueMissingCost,
      profitChange: profitChange === null ? null : Math.round(profitChange * 10) / 10,
    };
  }

  /**
   * All-time distinct customers for the dashboard, cached on its OWN key
   * (issues 2247 / 2269). The all-time `countDistinctCustomers` call has no
   * date bound, and its DISTINCT key is a computed expression no index can
   * serve, so it is a full scan of the store's orders. It used to ride the
   * dashboard's range-keyed 120s cache, i.e. it re-ran for every distinct
   * date range and every cache miss. It does not depend on the range at all.
   *
   * Staleness class: BOUNDED-stale (dashboard analytics, not money or
   * permissions). A new customer appears within ALL_TIME_CUSTOMERS_TTL_S;
   * no write path invalidates it on purpose — the period-scoped
   * `totalCustomers` KPI the dashboard actually shows is still live.
   */
  static async getAllTimeCustomers(storeId: string): Promise<number> {
    return getCachedAnalytics(
      `analytics:customers:all-time:${storeId}`,
      ALL_TIME_CUSTOMERS_TTL_S,
      () => this.countDistinctCustomers(storeId)
    );
  }

  /**
   * Distinct customers with a (non-deleted) order in the store — optionally
   * only orders created in [startDate, endDate] — keyed exactly like the
   * Customers page (`CustomerGroups`, Ruling QA98-ALIAS-1).
   * Every order status counts, as the list's rows do; the page's `buyers`
   * KPI (non-cancelled/refunded) and its zero-order registered rows are
   * intentionally different measures — docs/RULINGS.md.
   */
  static async countDistinctCustomers(
    storeId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    // QA98-ALIAS-1: both backends return identity rows and the ONE customer grouping folds them (lib/buyer-counts.ts).
    const windowed = !!(startDate && endDate);
    const start = windowed ? startDate! : new Date(0);
    const end = windowed ? endDate! : new Date(8_640_000_000_000_000);
    return countDistinctCustomersGrouped(storeId, start, end, async () => {
      // Postgres store: exact GROUP BY of the (customer id, email, phone) buckets, grouped in JS by the one customer grouping.
      // All-time has no window clause (an extreme Date does not serialise as a query parameter).
      const windowSql = windowed
        ? Prisma.sql`AND o.created_at >= ${start} AND o.created_at <= ${end}`
        : Prisma.empty;
      const rows = await prisma.$queryRaw<
        Array<{ customerId: string | null; email: string | null; phone: string | null; n: number }>
      >`
        SELECT NULLIF(o.customer_id::text, '') AS "customerId",
               LOWER(CASE WHEN jsonb_typeof(o.shipping_address -> 'email') = 'string' THEN o.shipping_address ->> 'email' END) AS email,
               CASE WHEN jsonb_typeof(o.shipping_address -> 'phone') = 'string' THEN o.shipping_address ->> 'phone' END AS phone,
               COUNT(*)::int AS n
        FROM public.orders o
        WHERE o.store_id = ${storeId} AND o.deleted_at IS NULL ${windowSql}
        GROUP BY 1, 2, 3`;
      return rows.map(r => ({ ...r, n: Number(r.n) }));
    });
  }

  /**
   * Views-based conversion for the period: SUM(orders_completed) /
   * SUM(product_views) × 100 from the nightly `funnel_snapshots` rollup,
   * rounded to 2 dp. `null` (unknown) when no snapshot rows fall in the
   * window or none recorded a view — never a fabricated 0.
   */
  static async getViewsConversionRate(
    storeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<number | null> {
    const agg = await (
      await storeDb(currentStoreId())
    ).funnelSnapshot.aggregate({
      where: { storeId, periodDate: { gte: startDate, lte: endDate } },
      _sum: { productViews: true, ordersCompleted: true },
    });
    const views = agg._sum.productViews ?? 0;
    if (views <= 0) return null;
    const orders = agg._sum.ordersCompleted ?? 0;
    return Math.round((orders / views) * 10000) / 100;
  }

  private static async getPeriodStats(storeId: string, startDate: Date, endDate: Date) {
    // deletedAt: null defends against soft-deleted orders inflating
    // analytics. Schema marks Order soft-deletable but no caller sets
    // deletedAt today; future archive-order workflows would otherwise
    // double-count revenue here.
    const money = await storeMoney(storeId);
    if (money) {
      const d = await money.analyticsPeriod({
        startMs: startDate.getTime(),
        endMs: endDate.getTime(),
        nonRevenue: NON_REVENUE,
      });
      return {
        revenue: d.revenue,
        orders: d.orders,
        customers: await AnalyticsService.countDistinctCustomers(storeId, startDate, endDate),
        profit: d.costedLines === 0 ? (d.missingLines > 0 ? null : 0) : (d.profit ?? 0),
        itemsMissingCost: d.missingLines,
        revenueMissingCost: d.missingRevenue,
      };
    }

    // Use aggregate for revenue and order count — avoids loading all rows into JS
    const [aggregate, customerCount, profitRows] = await Promise.all([
      // ONE revenue definition (lib/revenue-sql.ts): excludes refunded orders, nets partial refunds.
      netRevenue(storeId, { from: startDate, to: endDate }),
      // Distinct customers who ordered in the window, keyed like the
      // Customers page (guests included, every order status, as that page
      // counts them) — see lib/customer-key.ts.
      this.countDistinctCustomers(storeId, startDate, endDate),
      // Profit per item: (price - costPrice) * quantity, over the lines that
      // HAVE a cost snapshot — plus a count and the revenue of the lines that
      // do not, so a store with no cost prices reads "profit unknown" rather
      // than a false 0. Computed in the database for consistency with the
      // order-aggregate above and to avoid loading every line into memory.
      prisma.$queryRaw<
        Array<{
          profit: bigint | null;
          costed_lines: bigint;
          missing_lines: bigint;
          missing_revenue: bigint | null;
        }>
      >`
        SELECT
          SUM((oi.price - oi.cost_price) * oi.quantity)
            FILTER (WHERE oi.cost_price IS NOT NULL)::bigint AS profit,
          COUNT(*) FILTER (WHERE oi.cost_price IS NOT NULL)::bigint AS costed_lines,
          COUNT(*) FILTER (WHERE oi.cost_price IS NULL)::bigint AS missing_lines,
          SUM(oi.price * oi.quantity) FILTER (WHERE oi.cost_price IS NULL)::bigint AS missing_revenue
        FROM public.order_items oi
        JOIN public.orders o ON o.id = oi.order_id
        WHERE o.store_id = ${storeId}
          AND o.deleted_at IS NULL
          AND o.created_at >= ${startDate}
          AND o.created_at <= ${endDate}
          AND ${Prisma.raw(revenueOrderPredicateSql('o', 'pg'))}
      `,
    ]);

    const p = profitRows[0];
    const costedLines = Number(p?.costed_lines ?? 0);
    const itemsMissingCost = Number(p?.missing_lines ?? 0);
    // Unknown only when something was sold and none of it has a cost; a
    // period with no lines at all genuinely made 0 profit.
    const profit = costedLines === 0 ? (itemsMissingCost > 0 ? null : 0) : Number(p?.profit ?? 0);

    return {
      revenue: aggregate.revenue,
      orders: aggregate.orders,
      customers: customerCount,
      profit,
      itemsMissingCost,
      revenueMissingCost: Number(p?.missing_revenue ?? 0),
    };
  }

  /**
   * Sales chart buckets (revenue + order count) for a date range.
   *
   * The bucket size comes from the LENGTH of the range (`pickSalesGranularity`),
   * never from the preset name: a 9-preset picker made `period` a free-form
   * string, and every value outside the old day|week|month|year switch fell
   * through to daily grouping — `this_year` sent ~270 daily bars.
   *
   * `tzOffsetMinutes` is the viewer's UTC offset (east-positive, e.g. +180 for
   * Egypt). The admin resolves presets to local midnight, so bucketing by UTC
   * day put a phantom leading bucket for the previous UTC day in front of every
   * range. Buckets are computed on `created_at + offset`, so a key such as
   * `2026-09-01` is the viewer's calendar day. Weeks start on Monday (Postgres
   * `date_trunc('week')`). Keys: `YYYY-MM-DD` for day/week buckets (the bucket's
   * first day), `YYYY-MM` for month buckets.
   */
  static async getSalesChart(
    storeId: string,
    period: AnalyticsPeriod | 'day' | undefined,
    dateRange?: DateRange,
    tzOffsetMinutes = 0
  ): Promise<{ sales: SalesData[]; granularity: SalesGranularity }> {
    const now = new Date();
    let startDate: Date;
    let endDate: Date;

    if (dateRange) {
      startDate = dateRange.startDate;
      endDate = dateRange.endDate;
    } else {
      // Legacy callers that send only a period name (no explicit range).
      endDate = now;
      switch (period) {
        case 'day':
        case 'today':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'week':
        case 'last_7':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'year':
        case 'this_year':
          startDate = currentYearStart(now);
          break;
        default:
          startDate = currentMonthStart(now);
      }
    }

    const granularity = pickSalesGranularity(startDate, endDate);
    const offsetMs = tzOffsetMinutes * 60 * 1000;

    const salesMap = new Map<string, { revenue: number; orders: number }>();
    const money = await storeMoney(storeId);
    if (money) {
      for (const r of await money.analyticsSales({
        startMs: startDate.getTime(),
        endMs: endDate.getTime(),
        offsetMinutes: tzOffsetMinutes,
        granularity,
      }))
        salesMap.set(r.key, { revenue: r.revenue, orders: r.orders });
    }
    const aggregated = money
      ? []
      : await prisma.$queryRaw<Array<{ period: Date; revenue: number; orders: bigint }>>`
      SELECT
        date_trunc(${granularity}, "created_at" + (${tzOffsetMinutes}::int * interval '1 minute')) AS period,
        COALESCE(SUM(${Prisma.raw(orderNetRevenueSql('o', 'pg'))}), 0) AS revenue,
        COUNT(*)::bigint AS orders
      FROM public.orders o
      ${Prisma.raw(refundJoinsSql('o', 'pg'))}
      WHERE store_id = ${storeId}
        AND created_at >= ${startDate}
        AND created_at <= ${endDate}
        AND ${Prisma.raw(revenueOrderPredicateSql('o', 'pg'))}
      GROUP BY period
      ORDER BY period ASC
    `;

    for (const row of aggregated) {
      salesMap.set(salesBucketKey(new Date(row.period), granularity), {
        revenue: Number(row.revenue),
        orders: Number(row.orders),
      });
    }

    // Zero-fill every bucket the range touches, walking in the viewer's
    // shifted clock so the keys line up with the SQL buckets above.
    const result: SalesData[] = [];
    const shiftedEnd = new Date(endDate.getTime() + offsetMs);
    const cursor = salesBucketStart(new Date(startDate.getTime() + offsetMs), granularity);
    while (cursor <= shiftedEnd) {
      const key = salesBucketKey(cursor, granularity);
      const data = salesMap.get(key) ?? { revenue: 0, orders: 0 };
      result.push({ date: key, revenue: data.revenue, orders: data.orders });
      if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
      else if (granularity === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
      else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return { sales: result, granularity };
  }

  /**
   * Get top selling products
   *
   * Uses groupBy + _sum at the database level to avoid loading every order
   * item row into JavaScript memory.
   */
  /**
   * B2B: line revenue split by how the line was priced (read-only, additive). `retail` = plain price (including every line
   * sold before B2B, whose `price_source` is NULL), `tier` = a PUBLIC quantity break, `group` = the buyer's wholesale group
   * (the group percent, or a group tier: `price_group_applied`, final review minor 4);
   * `wholesale` = tier + group. Item-line revenue BEFORE order-level discounts, tax and shipping (so the shares add up to the
   * top-products figures, not to the order totals). Same revenue population as the rest of this service.
   */
  static async getRevenueByPriceSource(storeId: string, dateRange?: DateRange) {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    const endDate = dateRange?.endDate || now;
    const money = await storeMoney(storeId);
    const grouped = money
      ? (
          await money.analyticsItems({
            by: 'priceSource',
            startMs: startDate.getTime(),
            endMs: endDate.getTime(),
            nonRevenue: NON_REVENUE,
          })
        ).map(r => ({
          priceSource: r.priceSource ?? null,
          priceGroupApplied: r.priceGroupApplied ?? null,
          _sum: { quantity: r.quantity, total: r.total },
        }))
      : (await pgLineRevenue(storeId, startDate, endDate, 'priceSource')).map(r => ({
          priceSource: r.priceSource,
          priceGroupApplied: r.priceGroupApplied,
          _sum: { quantity: r.quantity, total: r.total },
        }));
    const bucket = { revenue: 0, units: 0 };
    const out = { retail: { ...bucket }, tier: { ...bucket }, group: { ...bucket } };
    for (const g of grouped) {
      const key =
        g.priceSource === 'group' || (g.priceSource === 'tier' && g.priceGroupApplied === true)
          ? 'group'
          : g.priceSource === 'tier'
            ? 'tier'
            : 'retail';
      out[key].revenue += g._sum.total ?? 0;
      out[key].units += g._sum.quantity ?? 0;
    }
    const wholesale = {
      revenue: out.tier.revenue + out.group.revenue,
      units: out.tier.units + out.group.units,
    };
    const total = out.retail.revenue + wholesale.revenue;
    return {
      ...out,
      wholesale,
      wholesaleSharePercent: total > 0 ? Math.round((wholesale.revenue / total) * 100) : 0,
    };
  }

  static async getTopProducts(
    storeId: string,
    limit = 10,
    dateRange?: DateRange
  ): Promise<TopProduct[]> {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    const endDate = dateRange?.endDate || now;

    // Aggregate quantity sold and revenue per product at the DB level (a DO store: the DO op, same population and order)
    const money = await storeMoney(storeId);
    const grouped = money
      ? (
          await money.analyticsItems({
            by: 'product',
            startMs: startDate.getTime(),
            endMs: endDate.getTime(),
            nonRevenue: NON_REVENUE,
            limit,
          })
        ).map(r => ({
          productId: r.productId as string,
          _sum: { quantity: r.quantity, total: r.total },
        }))
      : (await pgLineRevenue(storeId, startDate, endDate, 'product', limit)).map(r => ({
          productId: r.productId,
          _sum: { quantity: r.quantity, total: r.total },
        }));

    if (grouped.length === 0) return [];

    // Fetch product details for the top productIds in a single query
    const productIds = grouped.map(g => g.productId);
    const products = await (
      await storeDb(storeId)
    ).product.findMany({
      where: { id: { in: productIds }, storeId },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
        images: { take: 1, orderBy: { position: 'asc' } },
      },
    });

    const productById = new Map(products.map(p => [p.id, p]));

    const results: TopProduct[] = [];
    for (const g of grouped) {
      const product = productById.get(g.productId);
      if (!product) continue;
      results.push({
        id: product.id,
        name: product.name,
        nameAr: product.nameAr,
        slug: product.slug,
        revenue: g._sum.total ?? 0,
        quantity: g._sum.quantity ?? 0,
        image: product.images[0]?.url,
      });
    }
    return results;
  }

  /**
   * Get top categories by revenue
   *
   * Aggregates revenue per product at the DB level using groupBy, then
   * resolves category membership with a single targeted query — avoiding the
   * previous pattern that fetched every order item row with full product and
   * category joins into JavaScript memory.
   */
  static async getTopCategories(
    storeId: string,
    limit = 5,
    dateRange?: DateRange
  ): Promise<TopCategory[]> {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    const endDate = dateRange?.endDate || now;

    // Step 1: aggregate revenue per product at the DB level (a DO store: the DO op)
    const money = await storeMoney(storeId);
    const grouped = money
      ? (
          await money.analyticsItems({
            by: 'product',
            startMs: startDate.getTime(),
            endMs: endDate.getTime(),
            nonRevenue: NON_REVENUE,
          })
        ).map(r => ({ productId: r.productId as string, _sum: { total: r.total } }))
      : (await pgLineRevenue(storeId, startDate, endDate, 'product')).map(r => ({
          productId: r.productId,
          _sum: { total: r.total },
        }));

    if (grouped.length === 0) return [];

    // Step 2: resolve category memberships for the aggregated products in one query
    const productIds = grouped.map(g => g.productId);
    const productRevenueMap = new Map(grouped.map(g => [g.productId, g._sum.total ?? 0]));

    const productCategories = await (
      await storeDb(storeId)
    ).productCategory.findMany({
      where: { productId: { in: productIds } },
      include: { category: true },
    });

    // Step 3: accumulate revenue per category in JS (small result set)
    const categoryMap = new Map<string, TopCategory & { productIds: Set<string> }>();

    productCategories.forEach(pc => {
      const revenue = productRevenueMap.get(pc.productId) ?? 0;
      const existing = categoryMap.get(pc.categoryId);
      if (existing) {
        existing.revenue += revenue;
        existing.productIds.add(pc.productId);
      } else {
        categoryMap.set(pc.categoryId, {
          id: pc.category.id,
          name: pc.category.name,
          slug: pc.category.slug,
          revenue,
          productCount: 1,
          productIds: new Set([pc.productId]),
        });
      }
    });

    return Array.from(categoryMap.values())
      .map(({ productIds: ids, ...rest }) => ({ ...rest, productCount: ids.size }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  /**
   * Get orders by status
   */
  static async getOrdersByStatus(
    storeId: string,
    dateRange?: DateRange
  ): Promise<OrdersByStatus[]> {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    const endDate = dateRange?.endDate || now;

    const money = await storeMoney(storeId);
    const orders = money
      ? (
          await money.analyticsOrdersBy({
            by: 'status',
            startMs: startDate.getTime(),
            endMs: endDate.getTime(),
          })
        ).map(r => ({ status: r.key, _count: { id: r.count } }))
      : await prisma.order.groupBy({
          by: ['status'],
          where: {
            storeId,
            deletedAt: null,
            createdAt: { gte: startDate, lte: endDate },
          },
          _count: { id: true },
        });

    const total = orders.reduce((sum, o) => sum + o._count.id, 0);

    return orders.map(o => ({
      status: o.status,
      count: o._count.id,
      percentage: total > 0 ? Math.round((o._count.id / total) * 100) : 0,
    }));
  }

  /**
   * Get customer statistics
   *
   * Replaces the previous unbounded findMany (which loaded every customer with
   * all their orders) with targeted aggregate queries that run entirely in the
   * database.
   */
  static async getCustomerStats(storeId: string, dateRange?: DateRange): Promise<CustomerStats> {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    const endDate = dateRange?.endDate || now;

    const odb = await storeDb(storeId);
    const onDo = (await storeRepo(storeId)).backend === 'do';
    const money = await storeMoney(storeId);
    if (money) {
      const d = await money.analyticsCustomers({
        startMs: startDate.getTime(),
        endMs: endDate.getTime(),
        nonRevenue: NON_REVENUE,
      });
      const ids = d.top.map(g => g.customerId).filter((id): id is string => id != null);
      const details = (await customerRows(storeId, ids)) ?? [];
      const byId = new Map(details.map(c => [c.id, c]));
      const topCustomers = d.top
        .map(g => {
          const c = g.customerId ? byId.get(g.customerId) : undefined;
          if (!c) return null;
          return {
            id: c.id,
            name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Anonymous',
            email: c.email,
            totalSpent: g.total,
            orderCount: g.count,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      return {
        newCustomers: d.newCustomers,
        returningCustomers: d.returningCustomers,
        topCustomers,
      };
    }

    // New customers: those whose very first order for this store falls inside the period
    const [{ newCustomers, returningCustomers }, topOrderGroups] = await Promise.all([
      onDo
        ? doNewAndReturning(odb, storeId, startDate, endDate)
        : (async () => {
            const [newCustomers, returningCustomers] = await Promise.all([
              // Customers with at least one order in the period who had no earlier orders
              prisma.user.count({
                where: {
                  storeId,
                  orders: {
                    some: { storeId, createdAt: { gte: startDate, lte: endDate } },
                  },
                  NOT: {
                    orders: {
                      some: { storeId, createdAt: { lt: startDate } },
                    },
                  },
                },
              }),

              // Customers with more than one order in this store (returning buyers)
              prisma.user.count({
                where: {
                  storeId,
                  orders: {
                    some: { storeId },
                  },
                  AND: [
                    // At least two orders exist: one before or at endDate and one more
                    // We approximate "returning" as having orders both before and after startDate
                    { orders: { some: { storeId, createdAt: { lt: startDate } } } },
                    { orders: { some: { storeId, createdAt: { gte: startDate, lte: endDate } } } },
                  ],
                },
              }),
            ]);
            return { newCustomers, returningCustomers };
          })(),

      // Top customers by NET spend (REVENUE-DEF-1), through the store's own backend, never raw SQL on public.orders.
      topCustomersNet(odb, storeId, 10),
    ]);

    // Resolve customer details for the top spenders in a single query
    const topCustomerIds = topOrderGroups
      .map(g => g.customerId)
      .filter((id): id is string => id != null);
    const customerDetails =
      (await customerRows(storeId, topCustomerIds)) ??
      (await prisma.user.findMany({
        where: { id: { in: topCustomerIds }, storeId },
        select: { id: true, email: true, firstName: true, lastName: true },
      }));

    const customerById = new Map(customerDetails.map(c => [c.id, c]));

    const topCustomers = topOrderGroups
      .map(g => {
        const customer = g.customerId ? customerById.get(g.customerId) : undefined;
        if (!customer) return null;
        return {
          id: customer.id,
          name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Anonymous',
          email: customer.email,
          totalSpent: g._sum.total ?? 0,
          orderCount: g._count,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return {
      newCustomers,
      returningCustomers,
      topCustomers,
    };
  }

  /**
   * Get recent orders
   */
  static async getRecentOrders(storeId: string, limit = 10) {
    if (await storeMoney(storeId)) {
      // A DO store: the order and its first lines come from the DO; the buyer (a platform account) is attached from the
      // customer directory, the way the order list does it. Same output shape as the Postgres include below.
      const db = await storeDb(storeId);
      const orders = await db.order.findMany({
        where: { storeId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { items: { take: 3, include: { product: { select: { name: true } } } } },
      });
      const people = await customerRows(
        storeId,
        orders.map(o => o.customerId)
      );
      const byId = new Map((people ?? []).map(c => [c.id, c]));
      return orders.map(o => {
        const c = o.customerId ? byId.get(o.customerId) : undefined;
        return {
          ...o,
          customer: c
            ? { firstName: c.firstName, lastName: c.lastName, email: c.email }
            : shippingContact(o.shippingAddress),
        };
      });
    }
    const pgOrders = await prisma.order.findMany({
      where: { storeId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        customer: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        items: {
          take: 3,
          include: {
            product: {
              select: { name: true },
            },
          },
        },
      },
    });
    return pgOrders.map(o => ({
      ...o,
      customer: o.customer ?? shippingContact(o.shippingAddress),
    }));
  }

  /**
   * Get low stock products
   */
  static async getLowStockProducts(storeId: string, threshold = 10) {
    // Variant-aware. This filtered and sorted on `products.inventory`, which
    // is not stock for a variant product — so every variant product (parent 0,
    // or drifted negative) matched `lte threshold` and the admin's Low Stock
    // Alerts card was filled with products holding thousands of units, each
    // rendered as "0 units left". See lib/effective-inventory.ts.
    //
    // Raw SQL because the filter and the sort both need the computed on-hand.
    const money = await storeMoney(storeId);
    if (money)
      return (await money.analyticsLowStock({ threshold })).map(r => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        sku: r.sku,
        inventory: r.inventory,
        images: r.imageUrl ? [{ url: r.imageUrl }] : [],
      }));
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        slug: string;
        sku: string | null;
        inventory: bigint | number;
        image_url: string | null;
      }>
    >`
      SELECT p.id, p.name, p.slug, p.sku, ${ON_HAND_SQL} AS inventory,
             (SELECT pi.url FROM public.product_images pi
               WHERE pi.product_id = p.id ORDER BY pi.position ASC LIMIT 1) AS image_url
      FROM public.products p
      WHERE p.store_id = ${storeId}
        AND p.status = 'active'
        AND p.track_inventory = true
        AND ${ON_HAND_SQL} <= ${threshold}
      ORDER BY inventory ASC, p.id ASC
      LIMIT 20
    `;

    // Same shape the card already consumes (`images: [{ url }]`).
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      sku: r.sku,
      inventory: Number(r.inventory),
      images: r.image_url ? [{ url: r.image_url }] : [],
    }));
  }

  /**
   * Revenue by payment status — DELIBERATELY the full population, failed payments included (issue 2235,
   * ruling AUI-1a): this is a breakdown BY payment status and the failed
   * bucket is its point. Its `total`/`percentage` are therefore NOT comparable
   * with the headline revenue KPIs, which exclude failed payments.
   */
  static async getRevenueByPaymentStatus(storeId: string, dateRange?: DateRange) {
    const now = new Date();
    const startDate = dateRange?.startDate || currentMonthStart(now);
    const endDate = dateRange?.endDate || now;

    const money = await storeMoney(storeId);
    const orders = money
      ? (
          await money.analyticsOrdersBy({
            by: 'paymentStatus',
            startMs: startDate.getTime(),
            endMs: endDate.getTime(),
            nonRevenue: NON_REVENUE,
          })
        ).map(r => ({ paymentStatus: r.key, _sum: { total: r.total }, _count: r.count }))
      : await prisma.order.groupBy({
          by: ['paymentStatus'],
          where: {
            storeId,
            deletedAt: null,
            createdAt: { gte: startDate, lte: endDate },
            status: { notIn: [...NON_REVENUE_ORDER_STATUSES] },
          },
          _sum: { total: true },
          _count: true,
        });

    const total = orders.reduce((sum, o) => sum + (o._sum?.total || 0), 0);

    return orders.map(o => ({
      status: o.paymentStatus,
      revenue: o._sum?.total || 0,
      orders: o._count,
      percentage: total > 0 ? Math.round(((o._sum?.total || 0) / total) * 100) : 0,
    }));
  }

  // =====================================================================
  // GL-aware helpers (Task 16b — Batch 2)
  // =====================================================================

  /**
   * Returns period P&L figures sourced from the General Ledger.
   * Refund-aware and deferred-COGS-aware (journal lines are the source of truth).
   */
  static async glRevenueWindow(storeId: string, from: Date, to: Date) {
    const pnl = await profitAndLoss(storeId, from, to);
    const cogs = pnl.expenses
      .filter(e => e.code.startsWith('50'))
      .reduce((s, e) => s + e.balance, 0);
    return {
      revenue: pnl.totalRevenue,
      cogs,
      grossProfit: pnl.totalRevenue - cogs,
      netIncome: pnl.netIncome,
    };
  }

  /**
   * Point-in-time inventory snapshot: stock value, open backorder demand,
   * and active reorder rules count.
   */
  static async stockSnapshot(storeId: string) {
    const money = await storeMoney(storeId);
    if (money) {
      const [d, rulesCount] = await Promise.all([
        money.analyticsStock({}),
        (await storeDb(storeId)).reorderRule.count({ where: { storeId, isActive: true } }),
      ]);
      return {
        stockValue: d.stockValue,
        openBackorderCount: d.backorderCount,
        backorderedDemandValue: d.backorderValue,
        reorderRulesCount: rulesCount,
      };
    }
    const [stockValue, backorderRow, rulesCount] = await Promise.all([
      // Variant-aware quantity AND cost, active variants only — the finance
      // dashboard's own query (storeStockValueFils), so the two cannot drift.
      storeStockValueFils(storeId),
      prisma.$queryRaw<{ count: bigint; value: bigint }[]>`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(bl.qty * COALESCE(pv.cost_price, p.cost_price, 0)), 0) AS value
        FROM public.backorder_lines bl
        JOIN public.products p ON p.id = bl.product_id
        LEFT JOIN public.product_variants pv ON pv.id = bl.variant_id
        WHERE bl.store_id = ${storeId}
          AND bl.fulfilled_at IS NULL
          AND bl.cancelled_at IS NULL
      `,
      prisma.reorderRule.count({ where: { storeId, isActive: true } }),
    ]);
    return {
      stockValue,
      openBackorderCount: Number(backorderRow[0]?.count ?? 0),
      backorderedDemandValue: Number(backorderRow[0]?.value ?? 0),
      reorderRulesCount: rulesCount,
    };
  }

  /**
   * Daily net cash movement (DR - CR on cash accounts 1000/1010/1020/1030)
   * over the given window. Used for the cashflow trend chart.
   */
  static async cashflowTrend(storeId: string, from: Date, to: Date) {
    const money = await storeMoney(storeId);
    if (money)
      return (await money.analyticsCashflow({ fromMs: from.getTime(), toMs: to.getTime() })).map(
        r => ({
          day: new Date(r.dayMs),
          net: r.net,
        })
      );
    const rows = await prisma.$queryRaw<Array<{ day: Date; net: bigint }>>`
      SELECT DATE_TRUNC('day', e.posted_at) AS day,
             COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS net
      FROM public.journal_lines l
      JOIN public.journal_entries e ON e.id = l.entry_id
      JOIN public.accounts a       ON a.id = l.account_id
      WHERE e.store_id = ${storeId}
        -- 'reversed' too: a refund flips the ORIGINAL to 'reversed' and posts
        -- the mirror as 'posted'. Counting only 'posted' kept the mirror and
        -- dropped the original, subtracting every refund twice.
        AND e.status IN ('posted', 'reversed')
        AND e.posted_at BETWEEN ${from} AND ${to}
        AND a.code IN ('1000','1010','1020','1030')
      GROUP BY DATE_TRUNC('day', e.posted_at)
      ORDER BY day ASC
    `;
    return rows.map(r => ({ day: r.day, net: Number(r.net) }));
  }

  /**
   * Get store performance summary
   */
  static async getPerformanceSummary(storeId: string) {
    const now = new Date();
    const today = regionDayStart(now);
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonth = currentMonthStart(now);

    const [todayStats, weekStats, monthStats] = await Promise.all([
      this.getPeriodStats(storeId, today, now),
      this.getPeriodStats(storeId, thisWeek, now),
      this.getPeriodStats(storeId, thisMonth, now),
    ]);

    return {
      today: todayStats,
      thisWeek: weekStats,
      thisMonth: monthStats,
    };
  }
}
