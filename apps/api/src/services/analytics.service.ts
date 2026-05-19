import { prisma, Prisma } from '@force/database';
import { redis } from './redis.service';
import { profitAndLoss } from './accounting/reports.service';

// ==========================================
// Simple cache-aside helper for analytics queries (60s TTL).
// Uses Redis when available, falls back to an in-memory Map.
// ==========================================

const analyticsMemCache = new Map<string, { data: unknown; expiresAt: number }>();

async function getCachedAnalytics<T>(
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

  const data = await fetchFn();

  // Write to Redis (best-effort)
  try {
    await redis.set(key, JSON.stringify(data), ttl);
  } catch {
    // Redis unavailable
  }

  analyticsMemCache.set(key, { data, expiresAt: Date.now() + ttl * 1000 });
  return data;
}

interface DateRange {
  startDate: Date;
  endDate: Date;
}

interface DashboardStats {
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  averageOrderValue: number;
  conversionRate: number;
  revenueChange: number;
  ordersChange: number;
  customersChange: number;
  /**
   * Sum of (price - costPrice) * quantity across all order items in the
   * window, where the order isn't cancelled/refunded and the item has a
   * cost snapshot. Items without a cost snapshot are skipped from this
   * total — they pre-date the cost-tracking feature.
   */
  totalProfit: number;
  profitChange: number;
}

interface SalesData {
  date: string;
  revenue: number;
  orders: number;
}

interface TopProduct {
  id: string;
  name: string;
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

export class AnalyticsService {
  /**
   * Get dashboard overview stats
   */
  static async getDashboardStats(storeId: string, dateRange?: DateRange): Promise<DashboardStats> {
    const now = new Date();
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    // Build a cache key that includes the date range so different periods don't collide
    const cacheKey = `analytics:dashboard:${storeId}:${startDate.toISOString()}:${endDate.toISOString()}`;

    return getCachedAnalytics(cacheKey, 120, async () => {
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
    const [currentStats, prevStats, totalCustomers, totalProducts, customerCount] =
      await Promise.all([
        this.getPeriodStats(storeId, startDate, endDate),
        this.getPeriodStats(storeId, prevStartDate, prevEndDate),
        prisma.user.count({
          where: {
            orders: { some: { storeId } },
          },
        }),
        prisma.product.count({
          where: { storeId, status: 'active' },
        }),
        prisma.user.count({
          where: {
            orders: {
              some: {
                storeId,
                createdAt: { gte: startDate, lte: endDate },
              },
            },
          },
        }),
      ]);

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

    const profitChange =
      prevStats.profit > 0
        ? ((currentStats.profit - prevStats.profit) / prevStats.profit) * 100
        : currentStats.profit > 0
          ? 100
          : 0;

    return {
      totalRevenue: currentStats.revenue,
      totalOrders: currentStats.orders,
      totalCustomers,
      totalProducts,
      averageOrderValue: currentStats.orders > 0 ? currentStats.revenue / currentStats.orders : 0,
      conversionRate: 0, // Would need session tracking
      revenueChange: Math.round(revenueChange * 10) / 10,
      ordersChange: Math.round(ordersChange * 10) / 10,
      customersChange: Math.round(customersChange * 10) / 10,
      totalProfit: currentStats.profit,
      profitChange: Math.round(profitChange * 10) / 10,
    };
  }

  private static async getPeriodStats(storeId: string, startDate: Date, endDate: Date) {
    // deletedAt: null defends against soft-deleted orders inflating
    // analytics. Schema marks Order soft-deletable but no caller sets
    // deletedAt today; future archive-order workflows would otherwise
    // double-count revenue here.
    const where: Prisma.OrderWhereInput = {
      storeId,
      deletedAt: null,
      createdAt: { gte: startDate, lte: endDate },
      status: { notIn: ['cancelled', 'refunded'] },
    };

    // Use aggregate for revenue and order count — avoids loading all rows into JS
    const [aggregate, customerGroups, profitRows] = await Promise.all([
      prisma.order.aggregate({
        where,
        _sum: { total: true },
        _count: { id: true },
      }),
      // Count distinct customers by grouping on customerId
      prisma.order.groupBy({
        by: ['customerId'],
        where,
      }),
      // Profit per item: (price - costPrice) * quantity. We compute it in
      // the database for consistency with the order-aggregate above and
      // to avoid loading every line item into Node memory.
      prisma.$queryRaw<Array<{ profit: bigint | null }>>`
        SELECT COALESCE(SUM((oi.price - COALESCE(oi.cost_price, 0)) * oi.quantity), 0)::bigint AS profit
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.store_id = ${storeId}
          AND o.created_at >= ${startDate}
          AND o.created_at <= ${endDate}
          AND o.status NOT IN ('cancelled', 'refunded')
          AND oi.cost_price IS NOT NULL
      `,
    ]);

    const profitBig = profitRows[0]?.profit ?? null;
    const profit = profitBig === null ? 0 : Number(profitBig);

    return {
      revenue: aggregate._sum.total ?? 0,
      orders: aggregate._count.id,
      customers: customerGroups.length,
      profit,
    };
  }

  /**
   * Get sales data for chart
   */
  static async getSalesChart(
    storeId: string,
    period: 'day' | 'week' | 'month' | 'year' = 'month',
    dateRange?: DateRange
  ): Promise<SalesData[]> {
    const now = new Date();
    let startDate: Date;
    let groupBy: 'day' | 'month' = 'day';

    switch (period) {
      case 'day':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        groupBy = 'day';
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        groupBy = 'day';
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        groupBy = 'day';
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        groupBy = 'month';
        break;
      default:
        startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
        groupBy = 'day';
    }

    const endDate = dateRange?.endDate || now;

    // Aggregate revenue and order count per period at the database level
    // instead of fetching all individual order rows into JS memory.
    const truncUnit = groupBy === 'day' ? 'day' : 'month';
    const aggregated = await prisma.$queryRaw<
      Array<{ period: Date; revenue: number; orders: bigint }>
    >`
      SELECT
        date_trunc(${truncUnit}, "created_at") AS period,
        COALESCE(SUM(total), 0) AS revenue,
        COUNT(*)::bigint AS orders
      FROM orders
      WHERE store_id = ${storeId}
        AND created_at >= ${startDate}
        AND created_at <= ${endDate}
        AND status NOT IN ('cancelled', 'refunded')
      GROUP BY period
      ORDER BY period ASC
    `;

    const salesMap = new Map<string, { revenue: number; orders: number }>();

    aggregated.forEach(row => {
      const date = new Date(row.period);
      let key: string;
      if (groupBy === 'day') {
        key = date.toISOString().split('T')[0];
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }
      salesMap.set(key, {
        revenue: Number(row.revenue),
        orders: Number(row.orders),
      });
    });

    // Fill in missing dates
    const result: SalesData[] = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      let key: string;
      if (groupBy === 'day') {
        key = current.toISOString().split('T')[0];
        current.setDate(current.getDate() + 1);
      } else {
        key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
        current.setMonth(current.getMonth() + 1);
      }

      const data = salesMap.get(key) || { revenue: 0, orders: 0 };
      result.push({
        date: key,
        revenue: data.revenue,
        orders: data.orders,
      });
    }

    return result;
  }

  /**
   * Get top selling products
   *
   * Uses groupBy + _sum at the database level to avoid loading every order
   * item row into JavaScript memory.
   */
  static async getTopProducts(
    storeId: string,
    limit = 10,
    dateRange?: DateRange
  ): Promise<TopProduct[]> {
    const now = new Date();
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    // Aggregate quantity sold and revenue per product at the DB level
    const grouped = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: {
          storeId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ['cancelled', 'refunded'] },
        },
      },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: limit,
    });

    if (grouped.length === 0) return [];

    // Fetch product details for the top productIds in a single query
    const productIds = grouped.map(g => g.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
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
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    // Step 1: aggregate revenue per product at the DB level
    const grouped = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: {
          storeId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ['cancelled', 'refunded'] },
        },
      },
      _sum: { total: true },
    });

    if (grouped.length === 0) return [];

    // Step 2: resolve category memberships for the aggregated products in one query
    const productIds = grouped.map(g => g.productId);
    const productRevenueMap = new Map(grouped.map(g => [g.productId, g._sum.total ?? 0]));

    const productCategories = await prisma.productCategory.findMany({
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
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    const orders = await prisma.order.groupBy({
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
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    // New customers: those whose very first order for this store falls inside the period
    const [newCustomers, returningCustomers, topOrderGroups] = await Promise.all([
      // Customers with at least one order in the period who had no earlier orders
      prisma.user.count({
        where: {
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

      // Top customers by total spend — aggregate at DB level, return top 10
      prisma.order.groupBy({
        by: ['customerId'],
        where: {
          storeId,
          deletedAt: null,
          status: { notIn: ['cancelled', 'refunded'] },
        },
        _sum: { total: true },
        _count: true,
        orderBy: { _sum: { total: 'desc' } },
        take: 10,
      }),
    ]);

    // Resolve customer details for the top spenders in a single query
    const topCustomerIds = topOrderGroups
      .map(g => g.customerId)
      .filter((id): id is string => id != null);
    const customerDetails = await prisma.user.findMany({
      where: { id: { in: topCustomerIds } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

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
    return prisma.order.findMany({
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
  }

  /**
   * Get low stock products
   */
  static async getLowStockProducts(storeId: string, threshold = 10) {
    return prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        trackInventory: true,
        inventory: { lte: threshold },
      },
      orderBy: { inventory: 'asc' },
      take: 20,
      select: {
        id: true,
        name: true,
        slug: true,
        sku: true,
        inventory: true,
        images: { take: 1, orderBy: { position: 'asc' } },
      },
    });
  }

  /**
   * Get revenue by payment status
   */
  static async getRevenueByPaymentStatus(storeId: string, dateRange?: DateRange) {
    const now = new Date();
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    const orders = await prisma.order.groupBy({
      by: ['paymentStatus'],
      where: {
        storeId,
        deletedAt: null,
        createdAt: { gte: startDate, lte: endDate },
        status: { notIn: ['cancelled', 'refunded'] },
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
    const [valueRow, backorderRow, rulesCount] = await Promise.all([
      prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(inventory * COALESCE(cost_price, 0)), 0) AS total
        FROM public.products WHERE store_id = ${storeId}::uuid AND deleted_at IS NULL
      `,
      prisma.$queryRaw<{ count: bigint; value: bigint }[]>`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(bl.qty * COALESCE(p.cost_price, 0)), 0) AS value
        FROM public.backorder_lines bl
        JOIN public.products p ON p.id = bl.product_id
        WHERE bl.store_id = ${storeId}::uuid
          AND bl.fulfilled_at IS NULL
          AND bl.cancelled_at IS NULL
      `,
      prisma.reorderRule.count({ where: { storeId, isActive: true } }),
    ]);
    return {
      stockValue: Number(valueRow[0]?.total ?? 0),
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
    const rows = await prisma.$queryRaw<Array<{ day: Date; net: bigint }>>`
      SELECT DATE_TRUNC('day', e.posted_at) AS day,
             COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS net
      FROM public.journal_lines l
      JOIN public.journal_entries e ON e.id = l.entry_id
      JOIN public.accounts a       ON a.id = l.account_id
      WHERE e.store_id = ${storeId}::uuid
        AND e.status = 'posted'
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
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
