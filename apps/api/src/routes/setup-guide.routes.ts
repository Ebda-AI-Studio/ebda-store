import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { tenantContext } from '../middleware/tenant-context';
import { writeLimiter } from '../middleware/security';
import { SetupGuideService } from '../services/setup-guide.service';

/**
 * Dashboard setup-guide checklist. Mounted at the bare `/stores` prefix, so RLS
 * tenant context comes from `router.param('storeId', tenantContext)` (same
 * pattern as tax/shipping routes). Route authorization: authenticate ->
 * authorize -> requireStoreAccess -> handler.
 */
const router = Router();
router.param('storeId', tenantContext);

router.get(
  '/:storeId/setup-guide',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await SetupGuideService.get(req.params.storeId) });
    } catch (error) {
      next(error);
    }
  }
);

const itemSchema = z.object({ done: z.boolean() }).strict();

router.put(
  '/:storeId/setup-guide/items/:key',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { done } = itemSchema.parse(req.body);
      res.json({
        success: true,
        data: await SetupGuideService.setManual(req.params.storeId, req.params.key, done),
      });
    } catch (error) {
      next(error);
    }
  }
);

const dismissSchema = z.object({ dismissed: z.boolean() }).strict();

router.put(
  '/:storeId/setup-guide/dismissed',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dismissed } = dismissSchema.parse(req.body);
      res.json({
        success: true,
        data: await SetupGuideService.setDismissed(req.params.storeId, dismissed),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
