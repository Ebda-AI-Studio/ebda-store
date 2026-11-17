import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { gateBackorderPayload } from '../lib/effective-inventory';
import { featureService } from '../services/feature.service';
import { recommendationService } from '../services/recommendation.service';
import logger from '../lib/logger';
import { StoreService } from '../services/store.service';
import { auditLog } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { autoRecommendationsEnabled } from '../lib/recommendations/auto-setting';

// TWO routers, deliberately (#1993): the admin half is mounted ONLY at the
// bare '/stores' prefix; `publicRouter` is the only thing mounted at
// '/public'. Do NOT collapse them back into one router mounted at both —
// `csrfProtection` skips '/public/' paths and `restrictPlatformOnlyOrigins`
// only covers '/api/v1/stores', so an admin route republished under '/public'
// becomes a CSRF-free, credentialed cross-origin target for any
// merchant-registered custom domain. Full reasoning: loyalty.routes.ts header.
// Guarded by tests/unit/public-mount-admin-route-guard.test.ts.
const router = Router();
const publicRouter = Router();

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

// Single-relation body (POST). `position` matches the bulk schema above.
const addRelationSchema = z.object({
  targetProductId: z.string().min(1),
  type: z.string().min(1),
  position: z.number().int().optional(),
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
      const parsed = addRelationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FIELDS', message: 'targetProductId and type are required' },
        });
        return;
      }
      const { targetProductId, type, position } = parsed.data;

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

// GET/PUT /:storeId/recommendations/auto-setting — the merchant's switch for automatic recommendations
// (bought-together, similar items, AI picks; absent = on). Deliberately NOT behind `upsell_crosssell`: turning the
// automatic part off must stay possible for every store. Curated picks are unaffected either way.
const autoSettingSchema = z.object({ enabled: z.boolean() });

router.get(
  '/:storeId/recommendations/auto-setting',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await StoreService.getById(req.params.storeId);
      res.json({ success: true, data: { enabled: autoRecommendationsEnabled(store.settings) } });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:storeId/recommendations/auto-setting',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const parsed = autoSettingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: 'enabled must be true or false' },
        });
        return;
      }
      const { enabled } = parsed.data;
      await StoreService.setAutoRecommendationsEnabled(storeId, enabled);
      // The cached product lists were built under the old setting.
      await recommendationService.invalidateAllProductCaches(storeId);
      await auditLog({
        action: 'store.auto_recommendations_switch',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: { enabled },
      });
      res.json({ success: true, data: { enabled } });
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
publicRouter.get(
  '/:storeId/products/:productId/recommendations',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const recommendations = await recommendationService.getProductRecommendations(
        storeId,
        productId
      );
      // Backorder feature applied after the (cached) recommendation read (X-02 fix round).
      const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
      res.json({ success: true, data: gateBackorderPayload(recommendations, backorderOn) });
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/cart/recommendations?products=id1,id2
// Mounted under '/public' in routes/index.ts.
publicRouter.get(
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

      // The feature gates the "only buyable picks" filter inside the service, so a
      // feature-off store never shows a sold-out recommendation (fix round 2).
      const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
      const recommendations = await recommendationService.getCartRecommendations(
        storeId,
        productIds,
        backorderOn
      );
      res.json({ success: true, data: { recommendations } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

// Storefront-only router, mounted at '/public' in routes/index.ts.
export { publicRouter as publicRecommendationRoutes };
