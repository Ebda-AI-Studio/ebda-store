import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { featureService } from '../services/feature.service';
import { getFeedHealth } from '../lib/catalogue-feed/service';
import { AppError } from '../middleware/error-handler';

/**
 * Merchant read API for the "Product feeds" admin page: feed health (what is advertisable, what is excluded and why).
 * Same auth chain and fail-closed feature gate as answer-engine.routes.ts: authenticate -> permission -> store access ->
 * requireFeature (403 FEATURE_DISABLED). Mounted at /stores/:storeId/product-feeds under tenantContext.
 */
const router = Router({ mergeParams: true });

const healthQuery = z.object({ lang: z.enum(['ar', 'en']).default('ar') });

// GET /stores/:storeId/product-feeds/health?lang=ar|en
router.get(
  '/health',
  authenticate,
  requirePermission('products:read'),
  requireStoreAccess,
  requireFeature('product_feeds'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const q = healthQuery.safeParse(req.query);
      if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'lang must be ar or en');
      const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
      const health = await getFeedHealth(storeId, q.data.lang, backorderOn);
      res.json({ success: true, data: health });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
