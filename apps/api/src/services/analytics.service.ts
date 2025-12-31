import { prisma } from '@force/database';

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
    };
  }

  private static async getPeriodStats(storeId: string, startDate: Date, endDate: Date) {
    const orders = await prisma.order.findMany({
      where: {
        storeId,
        createdAt: { gte: startDate, lte: endDate },
        status: { notIn: ['cancelled', 'refunded'] },
      },
      select: {
        total: true,
        customerId: true,
      },
    });

    const revenue = orders.reduce((sum, order) => sum + order.total, 0);
    const uniqueCustomers = new Set(orders.map(o => o.customerId).filter(Boolean)).size;

    return {
      revenue,
      orders: orders.length,
      customers: uniqueCustomers,
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

    const orders = await prisma.order.findMany({
      where: {
        storeId,
        createdAt: { gte: startDate, lte: endDate },
        status: { notIn: ['cancelled', 'refunded'] },
      },
      select: {
        total: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by period
    const salesMap = new Map<string, { revenue: number; orders: number }>();

    orders.forEach(order => {
      let key: string;
      const date = new Date(order.createdAt);

      if (groupBy === 'day') {
        key = date.toISOString().split('T')[0];
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }

      const existing = salesMap.get(key) || { revenue: 0, orders: 0 };
      salesMap.set(key, {
        revenue: existing.revenue + order.total,
        orders: existing.orders + 1,
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
   */
  static async getTopProducts(
    storeId: string,
    limit = 10,
    dateRange?: DateRange
  ): Promise<TopProduct[]> {
    const now = new Date();
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    const orderItems = await prisma.orderItem.findMany({
      where: {
        order: {
          storeId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ['cancelled', 'refunded'] },
        },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            images: { take: 1, orderBy: { position: 'asc' } },
          },
        },
      },
    });

    // Aggregate by product
    const productMap = new Map<string, TopProduct>();

    orderItems.forEach(item => {
      if (!item.product) return;

      const existing = productMap.get(item.productId);
      if (existing) {
        existing.revenue += item.price * item.quantity;
        existing.quantity += item.quantity;
      } else {
        productMap.set(item.productId, {
          id: item.product.id,
          name: item.product.name,
          slug: item.product.slug,
          revenue: item.price * item.quantity,
          quantity: item.quantity,
          image: item.product.images[0]?.url,
        });
      }
    });

    return Array.from(productMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  /**
   * Get top categories by revenue
   */
  static async getTopCategories(
    storeId: string,
    limit = 5,
    dateRange?: DateRange
  ): Promise<TopCategory[]> {
    const now = new Date();
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    const orderItems = await prisma.orderItem.findMany({
      where: {
        order: {
          storeId,
          createdAt: { gte: startDate, lte: endDate },
          status: { notIn: ['cancelled', 'refunded'] },
        },
      },
      include: {
        product: {
          include: {
            categories: {
              include: { category: true },
            },
          },
        },
      },
    });

    // Aggregate by category
    const categoryMap = new Map<string, TopCategory>();

    orderItems.forEach(item => {
      if (!item.product) return;

      item.product.categories.forEach(pc => {
        const category = pc.category;
        const existing = categoryMap.get(category.id);
        const revenue = item.price * item.quantity;

        if (existing) {
          existing.revenue += revenue;
        } else {
          categoryMap.set(category.id, {
            id: category.id,
            name: category.name,
            slug: category.slug,
            revenue,
            productCount: 1,
          });
        }
      });
    });

    return Array.from(categoryMap.values())
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
   */
  static async getCustomerStats(storeId: string, dateRange?: DateRange): Promise<CustomerStats> {
    const now = new Date();
    const startDate = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = dateRange?.endDate || now;

    // Get new customers (first order in this period)
    const customersWithOrders = await prisma.user.findMany({
      where: {
        orders: { some: { storeId } },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        orders: {
          where: { storeId },
          orderBy: { createdAt: 'asc' },
          select: {
            total: true,
            createdAt: true,
          },
        },
      },
    });

    let newCustomers = 0;
    let returningCustomers = 0;

    customersWithOrders.forEach(customer => {
      const firstOrderDate = customer.orders[0]?.createdAt;
      if (firstOrderDate && firstOrderDate >= startDate && firstOrderDate <= endDate) {
        newCustomers++;
      }
      if (customer.orders.length > 1) {
        returningCustomers++;
      }
    });

    // Get top customers
    const topCustomers = customersWithOrders
      .map(customer => ({
        id: customer.id,
        name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Anonymous',
        email: customer.email,
        totalSpent: customer.orders.reduce((sum, o) => sum + o.total, 0),
        orderCount: customer.orders.length,
      }))
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 10);

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
      where: { storeId },
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
