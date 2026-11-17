import { Router, Request, Response, NextFunction } from 'express';
import { featureService } from '../services/feature.service';
import { storeDb } from '../lib/repo-factory';
import { activeVariants, lineAllowsBackorder } from '../lib/effective-inventory';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireFeature } from '../middleware/feature-gate';
import { requirePermission } from '../middleware/rbac';
import { AnalyticsService, currentMonthStart } from '../services/analytics.service';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@ebda/database';
import logger from '../lib/logger';
import { z } from 'zod/v3';
import { analyticsPeriodSchema, parseReportRange, type ReportRange } from '@ebda/shared';

const router = Router({ mergeParams: true });

/**
 * Parses the shared report-range contract (`@ebda/shared` report-range).
 * Half a range, an unparseable date or start > end is a 422 — before this, a
 * route that got only one bound silently used month-to-date, and an invalid
 * date reached Prisma as `Invalid Date` (500). Returns `null` after answering.
 */
function parseDateRange(req: Request, res: Response): { range: ReportRange | undefined } | null {
  const parsed = parseReportRange(req.query);
  if (!parsed.ok) {
    res.status(422).json({
      success: false,
      error: {
        code: 'validation_failed',
        message: 'Invalid date range.',
        details: parsed.error.flatten(),
      },
    });
    return null;
  }
  return { range: parsed.range };
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
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

      // GL cards follow the period picker like every other widget on the
      // page. Month-to-date only when the caller sends no range.
      const now = new Date();
      const glFrom = dateRange?.startDate ?? currentMonthStart(now);
      const glTo = dateRange?.endDate ?? now;

      // 2026-05-21: switched Promise.all -> Promise.allSettled so a single
      // failing sub-query (e.g. GL queries breaking when a store has no
      // posted journal entries) doesn't kill the whole dashboard. Each
      // rejection is logged with which subroutine failed, so Railway logs
      // surface the real cause without needing to bisect.
      const [statsRes, glRes, stockRes] = await Promise.allSettled([
        AnalyticsService.getDashboardStats(storeId, dateRange),
        AnalyticsService.glRevenueWindow(storeId, glFrom, glTo),
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

      // A sub-query that failed is REPORTED, not just nulled (issue 2256): the
      // admin detects errors by HTTP status, so a 200 with `stats: null` used
      // to render EGP 0.000 revenue and 0 orders with no banner. `failed`
      // names each part that did not load; the page treats a non-empty list
      // as a load error and shows the unknown values as unknown.
      const failed = [
        ...(statsRes.status === 'rejected' ? ['stats'] : []),
        ...(glRes.status === 'rejected' ? ['gl'] : []),
        ...(stockRes.status === 'rejected' ? ['stock'] : []),
      ];

      res.json({
        success: true,
        data: {
          stats: statsRes.status === 'fulfilled' ? statsRes.value : null,
          gl: glRes.status === 'fulfilled' ? glRes.value : null,
          stock: stockRes.status === 'fulfilled' ? stockRes.value : null,
          failed,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/analytics/sales - Get sales chart data
//
// `period` is validated against the shared preset enum (an unknown value is a
// 422, not a silent fall-through to daily buckets). The bucket size is picked
// from the range length; `tzOffset` is the viewer's UTC offset in minutes
// (east-positive) so buckets are the viewer's calendar days.
const salesQuerySchema = z.object({
  period: analyticsPeriodSchema.optional(),
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

router.get(
  '/sales',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const parsed = salesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { period, tzOffset } = parsed.data;
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

      const { sales, granularity } = await AnalyticsService.getSalesChart(
        storeId,
        period,
        dateRange,
        tzOffset
      );

      res.json({
        success: true,
        data: { sales, granularity },
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
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

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
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

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
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

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
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

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
        const sdb = await storeDb(storeId); // the store's backend (DO or Postgres), Ruling NZ-INTEG-1
        const backorderGroups = await sdb.backorderLine.groupBy({
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
        const reorderRules = await sdb.reorderRule.findMany({
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

        // Whether each product takes backorders: the cart/checkout rule
        // (lineAllowsBackorder: the store feature AND the product flag or an ACTIVE
        // variant's flag), so the report never says "accepts backorder" for a
        // product the cart refuses (W1b fix round 2).
        const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
        const productFlags = await (
          await storeDb(storeId)
        ).product.findMany({
          where: { storeId, id: { in: productIds } },
          select: {
            id: true,
            allowBackorder: true,
            variants: { select: { allowBackorder: true, isActive: true } },
          },
        });
        const allowBackorderById = new Map(
          productFlags.map(p => [
            p.id,
            lineAllowsBackorder(p, null, backorderOn) ||
              activeVariants(p.variants).some(v => lineAllowsBackorder(p, v, backorderOn)),
          ])
        );

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
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

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

// GET /stores/:storeId/analytics/price-source - B2B: line revenue split retail vs quantity break vs wholesale group
router.get(
  '/price-source',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      res.json({
        success: true,
        data: await AnalyticsService.getRevenueByPriceSource(storeId, parsedRange.range),
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
  requireMfaEnrolled,
  // BE:S-4: GL profit, cash flow and cost-based stock value are finance data: owner + `accounting.basic`, like /finance/*.
  authorize('store_admin', 'super_admin'),
  requirePermission('analytics:read'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const dateRange = parsedRange.range;

      // GL gross profit follows an explicit range when one is sent;
      // month-to-date otherwise.
      const now = new Date();
      const glFrom = dateRange?.startDate ?? currentMonthStart(now);
      const glTo = dateRange?.endDate ?? now;

      const [performance, glThisMonth] = await Promise.all([
        AnalyticsService.getPerformanceSummary(storeId),
        AnalyticsService.glRevenueWindow(storeId, glFrom, glTo),
      ]);

      res.json({
        success: true,
        data: {
          performance,
          glGrossProfit: glThisMonth.costsStatus === 'unknown' ? null : glThisMonth.grossProfit,
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
  requireMfaEnrolled,
  // BE:S-4: GL profit, cash flow and cost-based stock value are finance data: owner + `accounting.basic`, like /finance/*.
  authorize('store_admin', 'super_admin'),
  requirePermission('analytics:read'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Same `startDate`/`endDate` names as every other analytics endpoint —
      // the admin always sent those, but this route read only `from`/`to`, so
      // the chart ignored the period picker and was always the last 30 days.
      // `from`/`to` stay accepted as aliases for any older caller.
      const parsedRange = parseDateRange(req, res);
      if (!parsedRange) return;
      const range = parsedRange.range;
      const from =
        range?.startDate ?? (req.query.from ? new Date(req.query.from as string) : defaultFrom);
      const to = range?.endDate ?? (req.query.to ? new Date(req.query.to as string) : now);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        res.status(422).json({
          success: false,
          error: { code: 'validation_failed', message: 'Invalid date range.' },
        });
        return;
      }

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
  requireMfaEnrolled,
  // BE:S-4: GL profit, cash flow and cost-based stock value are finance data: owner + `accounting.basic`, like /finance/*.
  authorize('store_admin', 'super_admin'),
  requirePermission('analytics:read'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
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
