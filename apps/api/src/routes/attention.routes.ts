import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { tenantContext } from '../middleware/tenant-context';
import { adminReadLimiter } from '../middleware/security';
import { AttentionService } from '../services/attention.service';

/**
 * "Needs attention" for the merchant admin. Mounted at the bare `/stores` prefix: RLS tenant context
 * comes from `router.param('storeId', tenantContext)`; authorization is authenticate -> authorize ->
 * requireStoreAccess, so a merchant can only read their own store's signals.
 */
const router = Router();
router.param('storeId', tenantContext);

router.get(
  '/:storeId/attention',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  adminReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: await AttentionService.get(req.params.storeId) });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
