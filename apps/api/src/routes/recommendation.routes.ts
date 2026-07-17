import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { featureService } from '../services/feature.service';
import { recommendationService } from '../services/recommendation.service';
import logger from '../lib/logger';

const router = Router();

// Matches the shape recommendationService.setProductRelations requires, so a
// malformed body is rejected at the edge instead of failing deep in the service.
const setRelationsSchema = z.object({
  relations: z.array(
    z.object({
      targetProductId: z.string().min(1),
      type: z.string().min(1),
      position: z.number().int().optional(),
    })
  ),
});

// ==========================================
// Admin Routes
// authenticate + authorize + requireStoreAccess + requireFeature
// ==========================================

// GET /:storeId/products/:productId/relations
router.get(
  '/:storeId/products/:productId/relations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const relations = await recommendationService.getRelations(storeId, productId);
      res.json({ success: true, data: { relations } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /:storeId/products/:productId/relations — bulk replace
router.put(
  '/:storeId/products/:productId/relations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;

      const parsed = setRelationsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_BODY',
            message: parsed.error.issues[0]?.message ?? 'relations must be an array of relations',
          },
        });
        return;
      }
      const { relations } = parsed.data;

      await recommendationService.setProductRelations(storeId, productId, relations);
      const updated = await recommendationService.getRelations(storeId, productId);
      res.json({ success: true, data: { relations: updated } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /:storeId/products/:productId/relations — add single relation
router.post(
  '/:storeId/products/:productId/relations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { targetProductId, type, position } = req.body;

      if (!targetProductId || !type) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FIELDS', message: 'targetProductId and type are required' },
        });
        return;
      }

      const relation = await recommendationService.addRelation(storeId, productId, {
        targetProductId,
        type,
        position,
      });

      res.status(201).json({ success: true, data: { relation } });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:storeId/products/:productId/relations/:relationId
router.delete(
  '/:storeId/products/:productId/relations/:relationId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, relationId } = req.params;
      await recommendationService.removeRelation(storeId, productId, relationId);
      res.json({ success: true, data: { message: 'Relation deleted successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /:storeId/recommendations/recalculate — trigger FBT recalculation
router.post(
  '/:storeId/recommendations/recalculate',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      // Kick off async — don't await so request returns immediately
      recommendationService.recalculateFBT(storeId).catch(err => {
        logger.error({ err, storeId }, '[FBT] Manual recalculation failed');
      });

      res.json({ success: true, data: { message: 'FBT recalculation started' } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /:storeId/recommendations — admin overview (all FBT pairs for the store)
// Gated by `upsell_crosssell` so the admin UI can 403-redirect merchants who
// attempt to navigate directly to /stores/:id/recommendations without the feature.
router.get(
  '/:storeId/recommendations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const stats = await recommendationService.getStats(storeId);
      res.json({ success: true, data: { stats } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /:storeId/recommendations/stats
router.get(
  '/:storeId/recommendations/stats',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('upsell_crosssell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const stats = await recommendationService.getStats(storeId);
      res.json({ success: true, data: { stats } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public Routes — feature check inline (return empty arrays if disabled)
// ==========================================

// GET /public/:storeId/products/:productId/recommendations
// Mounted under '/public' in routes/index.ts, so the leading '/public'
// is NOT part of the route path here.
//
// Intentionally NOT gated by `upsell_crosssell`. That flag is for the
// admin-side merchandising tools (manual cross-sell / upsell relations
// CRUD). The customer-facing related products feed has three layers:
//   1. Manual cross-sell relations  (admin curates)
//   2. AI recommendations           (bulk-ai-recommendations sweep)
//   3. Same-category fallback       (basic catalog UX, no addon)
// Gating layers 2 + 3 behind the addon defeats the point of running
// the AI sweep and breaks the "you might also like" baseline UX. The
// service itself layers manual > AI > FBT > same-category, so if a
// merchant doesn't have manual relations the storefront still gets
// the AI + category results their plan tier expects.
router.get(
  '/:storeId/products/:productId/recommendations',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const recommendations = await recommendationService.getProductRecommendations(
        storeId,
        productId
      );
      res.json({ success: true, data: recommendations });
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/cart/recommendations?products=id1,id2
// Mounted under '/public' in routes/index.ts.
router.get(
  '/:storeId/cart/recommendations',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const productsParam = req.query.products as string | undefined;

      const enabled = await featureService.isFeatureEnabled(storeId, 'upsell_crosssell');
      if (!enabled) {
        res.json({ success: true, data: { recommendations: [] } });
        return;
      }

      const productIds = productsParam
        ? productsParam
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
        : [];

      const recommendations = await recommendationService.getCartRecommendations(
        storeId,
        productIds
      );
      res.json({ success: true, data: { recommendations } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
