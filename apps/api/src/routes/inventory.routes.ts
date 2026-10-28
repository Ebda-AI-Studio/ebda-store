import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { InventoryService } from '../services/inventory.service';
import { InventoryChangeType } from '@ebda/database';
import {
  lookupBarcode,
  receiveByBarcode,
  pickOrderItemByBarcode,
  getOrderPickProgress,
  openCountSession,
  submitCountLine,
  closeCountSession,
  reconcileCountSession,
  listCountSessions,
  getCountSession,
} from '../services/barcode-scan.service';

const router = Router();

// Per-route feature gates — each inventory endpoint checks the appropriate
// granular sub-feature key from PLAN_BASELINE. The old broad
// `router.use(requireFeature('inventory'))` was replaced because:
//  1. `inventory` (parent) is not in PLAN_BASELINE — only sub-keys are.
//  2. A router-level .use() with a dynamic `:storeId` param in the path
//     pattern fired on ALL requests mounted at this router including
//     unrelated siblings (e.g. /stores/:id/reviews → 403 FEATURE_DISABLED).
// Each handler below carries the narrowest applicable sub-key.

// Validation schemas
export const adjustInventorySchema = z.object({
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

export const setInventorySchema = z.object({
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.basic'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.basic'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.stock_alerts'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.basic'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.basic'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.stock_alerts'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.basic'),
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.basic'),
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

// ─────────────────────────────────────────────────────────────────────────────
// Barcode Scanning endpoints (inventory.barcode — Enterprise)
// ─────────────────────────────────────────────────────────────────────────────

const receiveBarcodeSchema = z.object({
  barcode: z.string().min(1).max(128),
  qty: z.number().int().positive(),
  reference: z.string().max(255).optional(),
});

const pickBarcodeSchema = z.object({
  barcode: z.string().min(1).max(128),
  qty: z.number().int().positive().optional().default(1),
});

const openSessionSchema = z.object({
  note: z.string().max(500).optional(),
});

const submitCountLineSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  countedQty: z.number().int().min(0),
});

// GET /stores/:storeId/inventory/lookup?barcode=X
router.get(
  '/:storeId/inventory/lookup',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const barcodeParam = req.query.barcode;
      if (typeof barcodeParam !== 'string' || !barcodeParam.trim()) {
        res.status(400).json({ success: false, error: 'Missing barcode query parameter' });
        return;
      }
      const result = await lookupBarcode(storeId, barcodeParam.trim());
      if (!result) {
        res.status(404).json({ success: false, error: 'BARCODE_NOT_FOUND', barcode: barcodeParam });
        return;
      }
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/receive — scan-to-receive stock
router.post(
  '/:storeId/inventory/receive',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = receiveBarcodeSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ success: false, error: 'validation', issues: body.error.issues });
        return;
      }
      const userId = req.user!.userId;
      const result = await receiveByBarcode(
        storeId,
        body.data.barcode,
        body.data.qty,
        userId,
        body.data.reference
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/orders/:orderId/pick-progress
router.get(
  '/:storeId/inventory/orders/:orderId/pick-progress',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const result = await getOrderPickProgress(storeId, orderId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/orders/:orderId/pick — scan-to-pick
router.post(
  '/:storeId/inventory/orders/:orderId/pick',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const body = pickBarcodeSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ success: false, error: 'validation', issues: body.error.issues });
        return;
      }
      const result = await pickOrderItemByBarcode(
        storeId,
        orderId,
        body.data.barcode,
        body.data.qty
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/count-sessions
router.get(
  '/:storeId/inventory/count-sessions',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const status = req.query.status as 'open' | 'closed' | 'reconciled' | undefined;
      const sessions = await listCountSessions(storeId, { status });
      res.json({ success: true, data: sessions });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/count-sessions — open a new session
router.post(
  '/:storeId/inventory/count-sessions',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = openSessionSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ success: false, error: 'validation', issues: body.error.issues });
        return;
      }
      const userId = req.user!.userId;
      const session = await openCountSession(storeId, userId, body.data.note);
      res.status(201).json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/inventory/count-sessions/:sessionId
router.get(
  '/:storeId/inventory/count-sessions/:sessionId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sessionId } = req.params;
      const session = await getCountSession(storeId, sessionId);
      if (!session) {
        res.status(404).json({ success: false, error: 'SESSION_NOT_FOUND' });
        return;
      }
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/count-sessions/:sessionId/lines
router.post(
  '/:storeId/inventory/count-sessions/:sessionId/lines',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sessionId } = req.params;
      const body = submitCountLineSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ success: false, error: 'validation', issues: body.error.issues });
        return;
      }
      const line = await submitCountLine(storeId, sessionId, body.data);
      res.status(201).json({ success: true, data: line });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/count-sessions/:sessionId/close
router.post(
  '/:storeId/inventory/count-sessions/:sessionId/close',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sessionId } = req.params;
      const result = await closeCountSession(storeId, sessionId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/inventory/count-sessions/:sessionId/reconcile
router.post(
  '/:storeId/inventory/count-sessions/:sessionId/reconcile',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, sessionId } = req.params;
      const userId = req.user!.userId;
      const result = await reconcileCountSession(storeId, sessionId, userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
