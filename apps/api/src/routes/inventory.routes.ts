import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { InventoryService } from '../services/inventory.service';
import { InventoryChangeType } from '@force/database';

const router = Router();

router.use(requireFeature('inventory'));

// Validation schemas
const adjustInventorySchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int(),
  type: z.enum([
    'manual_add',
    'manual_remove',
    'adjustment',
    'damage',
    'transfer_in',
    'transfer_out',
  ] as const),
  reason: z.string().optional(),
  reference: z.string().optional(),
});

const setInventorySchema = z.object({
  quantity: z.number().int().min(0),
  reason: z.string().optional(),
});

const updateThresholdSchema = z.object({
  threshold: z.number().int().min(0),
});

const bulkAdjustSchema = z.object({
  adjustments: z.array(adjustInventorySchema),
});

// GET /stores/:storeId/inventory/stats - Get inventory statistics
router.get(
  '/:storeId/inventory/stats',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const stats = await InventoryService.getStats(storeId);

      res.json({
        success: true,
        data: { stats },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/products - List products with inventory
router.get(
  '/:storeId/inventory/products',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, search, stockFilter, sortBy, sortOrder } = req.query;

      const result = await InventoryService.listProducts(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        search: search as string | undefined,
        stockFilter: stockFilter as 'all' | 'in_stock' | 'low_stock' | 'out_of_stock' | undefined,
        sortBy: sortBy as 'name' | 'inventory' | 'sku' | undefined,
        sortOrder: sortOrder as 'asc' | 'desc' | undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/alerts - Get low stock alerts
router.get(
  '/:storeId/inventory/alerts',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const alerts = await InventoryService.getLowStockAlerts(storeId);

      res.json({
        success: true,
        data: { alerts },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/adjust - Adjust inventory for a product
router.post(
  '/:storeId/inventory/adjust',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = adjustInventorySchema.parse(req.body);
      const userId = req.user!.userId;

      const result = await InventoryService.adjustInventory(
        storeId,
        {
          productId: data.productId,
          quantity: data.quantity,
          type: data.type as InventoryChangeType,
          reason: data.reason,
          reference: data.reference,
        },
        userId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/bulk-adjust - Bulk adjust inventory
router.post(
  '/:storeId/inventory/bulk-adjust',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { adjustments } = bulkAdjustSchema.parse(req.body);
      const userId = req.user!.userId;

      const result = await InventoryService.bulkAdjustInventory(
        storeId,
        adjustments.map(a => ({
          productId: a.productId,
          quantity: a.quantity,
          type: a.type as InventoryChangeType,
          reason: a.reason,
          reference: a.reference,
        })),
        userId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/inventory/products/:productId/set - Set inventory to specific value
router.put(
  '/:storeId/inventory/products/:productId/set',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { quantity, reason } = setInventorySchema.parse(req.body);
      const userId = req.user!.userId;

      const result = await InventoryService.setInventory(
        storeId,
        productId,
        quantity,
        reason,
        userId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/inventory/products/:productId/threshold - Update low stock threshold
router.put(
  '/:storeId/inventory/products/:productId/threshold',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { threshold } = updateThresholdSchema.parse(req.body);

      const product = await InventoryService.updateThreshold(storeId, productId, threshold);

      res.json({
        success: true,
        data: { product },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/products/:productId/history - Get product history
router.get(
  '/:storeId/inventory/products/:productId/history',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { page, limit } = req.query;

      const result = await InventoryService.getProductHistory(storeId, productId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/history - Get store inventory history
router.get(
  '/:storeId/inventory/history',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, type, startDate, endDate } = req.query;

      const result = await InventoryService.getStoreHistory(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        type: type as InventoryChangeType | undefined,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
