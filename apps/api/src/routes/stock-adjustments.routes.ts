import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { runInTenantContext } from '@force/database';
import {
  createAdjustment,
  postAdjustment,
  listAdjustments,
  getAdjustment,
} from '../services/accounting/stock-adjustment.service';

const router = Router();

const itemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  newQty: z.number().int().min(0),
});

const createSchema = z.object({
  type: z.enum([
    'cycle_count',
    'damage',
    'theft',
    'loss',
    'write_off',
    'found',
    'return_to_supplier',
  ]),
  reason: z.string().max(500).optional(),
  reasonAr: z.string().max(500).optional(),
  evidenceUrl: z.string().url().optional(),
  items: z.array(itemSchema).min(1),
});

router.get(
  '/:storeId/stock-adjustments',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  async (req, res, next) => {
    try {
      const from = req.query.from ? new Date(String(req.query.from) + 'T00:00:00') : undefined;
      const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : undefined;
      const data = await runInTenantContext(req.params.storeId, () =>
        listAdjustments(req.params.storeId, { from, to })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/stock-adjustments/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        getAdjustment(req.params.storeId, req.params.id)
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
  '/:storeId/stock-adjustments',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        createAdjustment({
          storeId: req.params.storeId,
          createdBy: req.user?.userId,
          ...body.data,
        })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/stock-adjustments/:id/post',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        postAdjustment(req.params.storeId, req.params.id, req.user?.userId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
