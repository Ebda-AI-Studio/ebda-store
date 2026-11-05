import { Router } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { writeLimiter } from '../middleware/security';

import {
  createPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  cancelPurchaseOrder,
} from '../services/accounting/purchase-order.service';
import { runInStoreCtx } from '../lib/jobs/store-db';

const router = Router();

const createSchema = z.object({
  supplierId: z.string().uuid(),
  // Accept both full ISO-8601 and bare YYYY-MM-DD from <input type="date">.
  // z.coerce.date() handles both; service stores as a DB timestamp.
  expectedDate: z.coerce.date().optional(),
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

// Zod at the edge (it was `Number(req.query.page)` unchecked: `?page=abc` reached Prisma as NaN).
// `q` filters by PO number or supplier name SERVER-side so a search reaches every PO, not just the
// first page the admin happened to load (issue 2430).
const listQuerySchema = z.object({
  status: z.enum(['draft', 'sent', 'partial', 'received', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform(v => v || undefined),
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
      const { status, page, perPage, q } = listQuerySchema.parse(req.query);
      const data = await runInStoreCtx(req.params.storeId, () =>
        listPurchaseOrders(req.params.storeId, { status, page, perPage, q })
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
      const data = await runInStoreCtx(req.params.storeId, () =>
        getPurchaseOrder(req.params.storeId, req.params.id)
      );
      if (!data) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Purchase order not found.' },
        });
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
  writeLimiter,
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation',
            message: 'Validation failed.',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const data = await runInStoreCtx(req.params.storeId, () =>
        createPurchaseOrder({
          storeId: req.params.storeId,
          ...body.data,
          expectedDate: body.data.expectedDate ? new Date(body.data.expectedDate) : undefined,
          createdBy: req.user?.userId,
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
  writeLimiter,
  async (req, res, next) => {
    try {
      const body = receiveSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation',
            message: 'Validation failed.',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const data = await runInStoreCtx(req.params.storeId, () =>
        receivePurchaseOrder({
          storeId: req.params.storeId,
          poId: req.params.id,
          receipts: body.data.receipts,
          receivedBy: req.user?.userId,
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
  writeLimiter,
  async (req, res, next) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
        cancelPurchaseOrder(req.params.storeId, req.params.id)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
