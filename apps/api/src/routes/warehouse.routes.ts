/**
 * Warehouse Routes — Multi-Warehouse Inventory (Enterprise)
 *
 * All routes require:
 *   authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess
 *   → requireFeature('inventory.multi_warehouse')
 *
 * Middleware chain mirrors the existing inventory.routes.ts pattern.
 *
 * NOTE (fixed 2026-07-02, F2): this router is mounted at the BARE '/stores'
 * prefix in routes/index.ts, NOT '/stores/:storeId' — Express only
 * populates req.params for params declared in the mount path, so
 * tenantContext at the mount level was a no-op here. Every route below
 * declares its own '/:storeId/...' path, so tenant context is now set via
 * router.param (below), which runs AFTER Express resolves :storeId for the
 * matched route. See docs/plans/done/2026-07-02-rls-cutover.md.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { WarehouseService } from '../services/warehouse.service';
import { tenantContext } from '../middleware/tenant-context';
import { inngest } from '../lib/inngest/client';

const router = Router();

router.param('storeId', tenantContext);

// ─── Validation schemas ────────────────────────────────────────────────────────

const createWarehouseSchema = z.object({
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  code: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'Code must be alphanumeric (A-Z, 0-9, -, _)'),
  isDefault: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  address: z.string().max(500).optional(),
});

export const updateWarehouseSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  nameAr: z.string().max(200).nullable().optional(),
  code: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'Code must be alphanumeric (A-Z, 0-9, -, _)')
    .optional(),
  isDefault: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

const setStockSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(0),
});

const adjustStockSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  delta: z.number().int(),
  reason: z.string().max(500).optional(),
});

const routeOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().nullable().optional(),
        qty: z.number().int().min(1),
      })
    )
    .min(1),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  rule: z.enum(['priority', 'proximity']).optional(),
});

const productStockQuerySchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
});

// ─── Common middleware ─────────────────────────────────────────────────────────

const mw = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.multi_warehouse'),
];

// ─── Warehouse CRUD ───────────────────────────────────────────────────────────

// GET /stores/:storeId/warehouses
router.get(
  '/:storeId/warehouses',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const warehouses = await WarehouseService.listWarehouses(storeId);
      res.json({ success: true, data: { warehouses } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /stores/:storeId/warehouses
router.post(
  '/:storeId/warehouses',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = createWarehouseSchema.parse(req.body);
      const warehouse = await WarehouseService.createWarehouse(storeId, body);
      res.status(201).json({ success: true, data: { warehouse } });
    } catch (err) {
      next(err);
    }
  }
);

// GET /stores/:storeId/warehouses/:warehouseId
router.get(
  '/:storeId/warehouses/:warehouseId',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, warehouseId } = req.params;
      const warehouse = await WarehouseService.getWarehouse(storeId, warehouseId);
      res.json({ success: true, data: { warehouse } });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /stores/:storeId/warehouses/:warehouseId
router.put(
  '/:storeId/warehouses/:warehouseId',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, warehouseId } = req.params;
      const body = updateWarehouseSchema.parse(req.body);
      const warehouse = await WarehouseService.updateWarehouse(storeId, warehouseId, body);
      res.json({ success: true, data: { warehouse } });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /stores/:storeId/warehouses/:warehouseId
// Soft-deletes (sets isActive=false). Blocks if it's the last active warehouse.
router.delete(
  '/:storeId/warehouses/:warehouseId',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, warehouseId } = req.params;
      await WarehouseService.deactivateWarehouse(storeId, warehouseId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Stock reads ──────────────────────────────────────────────────────────────

// GET /stores/:storeId/warehouses/:warehouseId/stock
// List all stock rows in a warehouse (paginated, searchable)
router.get(
  '/:storeId/warehouses/:warehouseId/stock',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, warehouseId } = req.params;
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const search = req.query.search as string | undefined;
      const result = await WarehouseService.listWarehouseStock(storeId, warehouseId, {
        page,
        limit,
        search,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// GET /stores/:storeId/warehouse-stock/product?productId=&variantId=
// Cross-warehouse breakdown for a single product/variant
router.get(
  '/:storeId/warehouse-stock/product',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productId, variantId } = productStockQuerySchema.parse(req.query);
      const breakdown = await WarehouseService.getProductStock(storeId, productId, variantId);
      res.json({ success: true, data: { breakdown } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Stock writes ─────────────────────────────────────────────────────────────

// PUT /stores/:storeId/warehouses/:warehouseId/stock
// Set absolute quantity for a product/variant in a warehouse
router.put(
  '/:storeId/warehouses/:warehouseId/stock',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, warehouseId } = req.params;
      const body = setStockSchema.parse(req.body);
      await WarehouseService.setStock(storeId, warehouseId, body);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// POST /stores/:storeId/warehouses/:warehouseId/stock/adjust
// Delta adjustment with audit trail
router.post(
  '/:storeId/warehouses/:warehouseId/stock/adjust',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, warehouseId } = req.params;
      const body = adjustStockSchema.parse(req.body);
      const result = await WarehouseService.adjustStock(storeId, warehouseId, body);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Reconciliation (Task 5, item 5 data-integrity) ───────────────────────────

// POST /stores/:storeId/warehouses/reconcile-all
// Merchant-facing "Reconcile to aggregate" action. Resyncs every SKU's
// WarehouseStock shadow (SUM across warehouses) to match the authoritative
// Product.inventory / ProductVariant.inventory for this store — repairs any
// drift left by a writer that doesn't call reconcileWarehouseStockToAggregate
// directly (Task 2's helper; Task 3 wires the 3 admin writers, Task 4 wires
// the refund fanout + a daily cron sweep). This is the on-demand, admin-
// triggered fourth path.
//
// ASYNC (fixed 2026-07-23, Important fix wave 1): this used to call
// `WarehouseService.backfillReconcileAll` SYNCHRONOUSLY inside the request's
// tenant-context transaction. `backfillReconcileAll` iterates EVERY
// WarehouseStock SKU for the store (not just drifted ones), each opening its
// own nested `withMoneyTx` + `FOR UPDATE` serially — a large Enterprise
// multi-warehouse catalog can blow the 30s Prisma transaction budget
// (P2028 500), violating the project's >300ms→Inngest rule. The endpoint
// now just emits the `warehouse/reconcile-requested` event (already wired by
// Task 4 for exactly this — `warehouseReconcileOnDemand` in
// `warehouse-reconcile-sweep.ts` runs `backfillReconcileAll` inside an
// Inngest step) and returns `202 { accepted: true }` immediately. The admin
// UI counts arrive via the async job + the daily completeness sweep, not in
// this response.
router.post(
  '/:storeId/warehouses/reconcile-all',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      await inngest.send({
        name: 'warehouse/reconcile-requested',
        data: { storeId, requestedBy: req.user!.userId },
      });
      res.status(202).json({ success: true, accepted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Order routing ────────────────────────────────────────────────────────────

// POST /stores/:storeId/warehouses/route-order
// Pick fulfilling warehouse per line item
router.post(
  '/:storeId/warehouses/route-order',
  ...mw,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = routeOrderSchema.parse(req.body);
      const routing = await WarehouseService.routeOrder(storeId, {
        items: body.items.map(i => ({
          productId: i.productId,
          variantId: i.variantId ?? null,
          qty: i.qty,
        })),
        lat: body.lat,
        lng: body.lng,
        rule: body.rule,
      });
      res.json({ success: true, data: { routing } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
