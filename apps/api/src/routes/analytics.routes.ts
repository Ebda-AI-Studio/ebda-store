import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { AnalyticsService } from '../services/analytics.service';

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const dateRange = parseDateRange(req);

      const stats = await AnalyticsService.getDashboardStats(storeId, dateRange);

      res.json({
        success: true,
        data: { stats },
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

// GET /stores/:storeId/analytics/low-stock - Get low stock products
router.get(
  '/low-stock',
  authenticate,
  requirePermission('analytics:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { threshold } = req.query;

      const products = await AnalyticsService.getLowStockProducts(
        storeId,
        threshold ? parseInt(threshold as string) : 10
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

// GET /stores/:storeId/analytics/payment-status - Revenue by payment status
router.get(
  '/payment-status',
  authenticate,
  requirePermission('analytics:read'),
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

// GET /stores/:storeId/analytics/performance - Quick performance summary
router.get(
  '/performance',
  authenticate,
  requirePermission('analytics:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const performance = await AnalyticsService.getPerformanceSummary(storeId);

      res.json({
        success: true,
        data: { performance },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
