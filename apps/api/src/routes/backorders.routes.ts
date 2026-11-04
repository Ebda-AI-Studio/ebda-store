import { Router } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';

import { listOpenBackorders, cancelBackorder } from '../services/accounting/backorder.service';
import { runInStoreCtx } from '../lib/jobs/store-db';

const router = Router();

const cancelSchema = z.object({
  reason: z.string().min(1).max(500),
});

// GET /:storeId/backorders — list all open backorder lines
router.get(
  '/:storeId/backorders',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.backorder'),
  async (req, res, next) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
        listOpenBackorders(req.params.storeId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /:storeId/backorders/:id/cancel — cancel an open backorder line
router.post(
  '/:storeId/backorders/:id/cancel',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.backorder'),
  async (req, res, next) => {
    try {
      const body = cancelSchema.safeParse(req.body);
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
        cancelBackorder(req.params.storeId, req.params.id, body.data.reason, req.user?.userId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
