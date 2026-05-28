import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { runInTenantContext } from '@force/database';
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  cancelPurchaseOrder,
} from '../services/accounting/purchase-order.service';

const router = Router();

const createSchema = z.object({
  supplierId: z.string().uuid(),
  expectedDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  notesAr: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().optional(),
        qty: z.number().int().positive(),
        unitCost: z.number().int().nonnegative(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

const receiveSchema = z.object({
  receipts: z
    .array(
      z.object({
        poItemId: z.string().uuid(),
        qtyReceived: z.number().int().positive(),
      })
    )
    .min(1),
});

router.get(
  '/:storeId/purchase-orders',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.purchase_orders'),
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const page = Number(req.query.page ?? 1);
      const perPage = Number(req.query.perPage ?? 50);
      const data = await runInTenantContext(req.params.storeId, () =>
        listPurchaseOrders(req.params.storeId, { status, page, perPage })
      );
      res.json({
        data: data.items,
        meta: {
          page: data.page,
          perPage: data.perPage,
          total: data.total,
          totalPages: Math.ceil(data.total / data.perPage),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/purchase-orders/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.purchase_orders'),
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        getPurchaseOrder(req.params.storeId, req.params.id)
      );
      if (!data) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/purchase-orders',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.purchase_orders'),
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        createPurchaseOrder({
          storeId: req.params.storeId,
          ...body.data,
          expectedDate: body.data.expectedDate ? new Date(body.data.expectedDate) : undefined,
          createdBy: (req as any).user?.id,
        })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/purchase-orders/:id/receive',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.purchase_orders'),
  async (req, res, next) => {
    try {
      const body = receiveSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        receivePurchaseOrder({
          storeId: req.params.storeId,
          poId: req.params.id,
          receipts: body.data.receipts,
          receivedBy: (req as any).user?.id,
        })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/purchase-orders/:id/cancel',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.purchase_orders'),
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        cancelPurchaseOrder(req.params.storeId, req.params.id)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
