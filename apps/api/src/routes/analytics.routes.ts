import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { AnalyticsService } from '../services/analytics.service';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@force/database';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// Helper to parse date range from query
function parseDateRange(req: Request) {
  const { startDate, endDate } = req.query;
  if (startDate && endDate) {
    return {
      startDate: new Date(startDate as string),
      endDate: new Date(endDate as string),
    };
  }
  return undefined;
}

// GET /stores/:storeId/analytics/dashboard - Get dashboard stats
router.get(
  '/dashboard',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const dateRange = parseDateRange(req);

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // 2026-05-21: switched Promise.all -> Promise.allSettled so a single
      // failing sub-query (e.g. GL queries breaking when a store has no
      // posted journal entries) doesn't kill the whole dashboard. Each
      // rejection is logged with which subroutine failed, so Railway logs
      // surface the real cause without needing to bisect.
      const [statsRes, glRes, stockRes] = await Promise.allSettled([
        AnalyticsService.getDashboardStats(storeId, dateRange),
        AnalyticsService.glRevenueWindow(storeId, monthStart, now),
        AnalyticsService.stockSnapshot(storeId),
      ]);
      if (statsRes.status === 'rejected') {
        logger.error({ err: statsRes.reason, storeId }, '[ANALYTICS] dashboard stats failed');
      }
      if (glRes.status === 'rejected') {
        logger.error({ err: glRes.reason, storeId }, '[ANALYTICS] gl revenue window failed');
      }
      if (stockRes.status === 'rejected') {
        logger.error({ err: stockRes.reason, storeId }, '[ANALYTICS] stock snapshot failed');
      }

      res.json({
        success: true,
        data: {
          stats: statsRes.status === 'fulfilled' ? statsRes.value : null,
          gl: glRes.status === 'fulfilled' ? glRes.value : null,
          stock: stockRes.status === 'fulfilled' ? stockRes.value : null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/sales - Get sales chart data
router.get(
  '/sales',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { period } = req.query;
      const dateRange = parseDateRange(req);

      const salesData = await AnalyticsService.getSalesChart(
        storeId,
        period as 'day' | 'week' | 'month' | 'year',
        dateRange
      );

      res.json({
        success: true,
        data: { sales: salesData },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/top-products - Get top selling products
router.get(
  '/top-products',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { limit } = req.query;
      const dateRange = parseDateRange(req);

      const products = await AnalyticsService.getTopProducts(
        storeId,
        limit ? parseInt(limit as string) : 10,
        dateRange
      );

      res.json({
        success: true,
        data: { products },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/top-categories - Get top categories
router.get(
  '/top-categories',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { limit } = req.query;
      const dateRange = parseDateRange(req);

      const categories = await AnalyticsService.getTopCategories(
        storeId,
        limit ? parseInt(limit as string) : 5,
        dateRange
      );

      res.json({
        success: true,
        data: { categories },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/orders-by-status - Get orders breakdown
router.get(
  '/orders-by-status',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const dateRange = parseDateRange(req);

      const orderStats = await AnalyticsService.getOrdersByStatus(storeId, dateRange);

      res.json({
        success: true,
        data: { orders: orderStats },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/customers - Get customer stats
router.get(
  '/customers',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const dateRange = parseDateRange(req);

      const customerStats = await AnalyticsService.getCustomerStats(storeId, dateRange);

      res.json({
        success: true,
        data: customerStats,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/recent-orders - Get recent orders
router.get(
  '/recent-orders',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { limit } = req.query;

      const orders = await AnalyticsService.getRecentOrders(
        storeId,
        limit ? parseInt(limit as string) : 10
      );

      res.json({
        success: true,
        data: { orders },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/low-stock - Get low stock products (enriched with backorder + reorder data)
router.get(
  '/low-stock',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { threshold } = req.query;

      const products = await AnalyticsService.getLowStockProducts(
        storeId,
        threshold ? parseInt(threshold as string) : 10
      );

      let enriched = products as ((typeof products)[number] & {
        openBackorderCount: number;
        acceptsBackorder: boolean;
        reorderRule: unknown;
      })[];

      if (products.length > 0) {
        const productIds = products.map(p => p.id);

        // Batch-load open backorder counts per product
        const backorderGroups = await prisma.backorderLine.groupBy({
          by: ['productId'],
          where: {
            storeId,
            productId: { in: productIds },
            fulfilledAt: null,
            cancelledAt: null,
          },
          _count: { id: true },
        });
        const backorderCountById = new Map(backorderGroups.map(g => [g.productId, g._count.id]));

        // Batch-load reorder rules for these products
        const reorderRules = await prisma.reorderRule.findMany({
          where: { storeId, productId: { in: productIds }, isActive: true },
          select: {
            productId: true,
            minQty: true,
            reorderQty: true,
            leadTimeDays: true,
            preferredSupplier: { select: { name: true } },
          },
        });
        const reorderRuleById = new Map(reorderRules.map(r => [r.productId, r]));

        // Batch-load allowBackorder flag for these products
        const productFlags = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, allowBackorder: true },
        });
        const allowBackorderById = new Map(productFlags.map(p => [p.id, p.allowBackorder]));

        enriched = products.map(p => ({
          ...p,
          openBackorderCount: backorderCountById.get(p.id) ?? 0,
          acceptsBackorder: allowBackorderById.get(p.id) ?? false,
          reorderRule: reorderRuleById.get(p.id) ?? null,
        }));
      }

      res.json({ success: true, data: { products: enriched } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/payment-status - Revenue by payment status
router.get(
  '/payment-status',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const dateRange = parseDateRange(req);

      const paymentStats = await AnalyticsService.getRevenueByPaymentStatus(storeId, dateRange);

      res.json({
        success: true,
        data: { payments: paymentStats },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/performance - Quick performance summary (with GL gross profit)
router.get(
  '/performance',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [performance, glThisMonth] = await Promise.all([
        AnalyticsService.getPerformanceSummary(storeId),
        AnalyticsService.glRevenueWindow(storeId, monthStart, now),
      ]);

      res.json({
        success: true,
        data: {
          performance,
          glGrossProfit: glThisMonth.grossProfit,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/cashflow - Daily cash-account movement trend
router.get(
  '/cashflow',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const from = req.query.from ? new Date(req.query.from as string) : defaultFrom;
      const to = req.query.to ? new Date(req.query.to as string) : now;

      const trend = await AnalyticsService.cashflowTrend(storeId, from, to);

      res.json({ success: true, data: { trend } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/stock-snapshot - Inventory point-in-time snapshot
router.get(
  '/stock-snapshot',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const snapshot = await AnalyticsService.stockSnapshot(storeId);
      res.json({ success: true, data: snapshot });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
