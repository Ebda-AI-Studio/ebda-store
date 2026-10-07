import { Request, Response, NextFunction } from 'express';
import { FeatureKey } from '@force/shared';
import { featureService } from '../services/feature.service';
import { resolvePublicStoreId } from '../utils/store-helpers';
import logger from '../lib/logger';
import { getEntitlements } from '../services/plan-entitlements';
import { PLAN_LIMIT_ERROR_CODE, planLimitMessage, upgradePlanFor } from '@force/shared';

/** Features whose availability comes from the plan's boolean limits. */
const PLAN_GATED_FEATURES: Record<
  string,
  'apiAccess' | 'brandingRemoval' | 'abandonedCartAutomation'
> = {
  merchant_mcp: 'apiAccess',
  remove_branding: 'brandingRemoval',
  abandoned_cart: 'abandonedCartAutomation',
};

/**
 * Feature Gate Middleware — Fail Closed
 *
 * Returns 403 if the feature is disabled, unavailable, or if the storeId
 * cannot be resolved. Call next() only when the feature is confirmed enabled.
 *
 * Super-admin bypass: a super_admin user bypasses the feature gate at every
 * layer so the platform team can debug a merchant's store even when a feature
 * is toggled off. The gate only runs the flag check for store_admin and
 * customer roles.
 *
 * Usage:
 *   router.get('/route', authenticate, requireStoreAccess, requireFeature('coupons'), handler);
 */
export function requireFeature(featureKey: FeatureKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Super-admin bypass — platform staff can access any store's features
    // regardless of toggle state. This lets them debug and reproduce issues
    // in a merchant's environment without needing to re-enable features.
    if (req.user?.role === 'super_admin') {
      return next();
    }

    // Resolve storeId from multiple possible locations. Route params and an
    // already-attached req.store (set by requireStoreAccess upstream) come
    // first — both are already trustworthy. Only when neither is present
    // (a public route with no :storeId/:id param, e.g. POST
    // /public/cart/bundles) does this fall through to
    // resolvePublicStoreId — the SAME validated X-Store-ID/x-store-domain
    // resolution the route handler itself uses via getStoreIdFromRequest, so
    // the gate and the handler it guards can never disagree about which
    // store this request is for. A raw, unvalidated header read here used to
    // diverge from that: it had no x-store-domain fallback at all, so a
    // client sending only that header got FEATURE_DISABLED even when the
    // domain-resolved store had the feature enabled.
    const storeId =
      req.params.storeId ||
      req.params.id ||
      (req as any).store?.id ||
      (await resolvePublicStoreId(req));

    // Fail closed — no storeId means we cannot check the feature
    if (!storeId) {
      logger.warn(
        { featureKey, path: req.path },
        '[requireFeature] No storeId found, denying access'
      );
      res.status(403).json({
        success: false,
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        feature: featureKey,
      });
      return;
    }

    try {
      const enabled = await featureService.isFeatureEnabled(storeId, featureKey);

      if (!enabled) {
        logger.debug({ storeId, featureKey }, '[requireFeature] Feature disabled');
        // A feature the PLAN withholds is an upsell (402 + upgrade target), not
        // a toggle the merchant switched off (Ruling EBDA-FUNNEL-14).
        const planKey = PLAN_GATED_FEATURES[featureKey as string];
        if (planKey) {
          const e = await getEntitlements(storeId);
          if (e && e.limits[planKey] !== true) {
            const messageEn = planLimitMessage(planKey, false, 'en');
            const messageAr = planLimitMessage(planKey, false, 'ar');
            res.status(402).json({
              success: false,
              error: {
                code: PLAN_LIMIT_ERROR_CODE,
                message: messageEn,
                details: {
                  limitKey: planKey,
                  limit: false,
                  planCode: e.planCode,
                  upgradeTo: upgradePlanFor(planKey, true),
                  messageEn,
                  messageAr,
                },
              },
            });
            return;
          }
        }
        res.status(403).json({
          success: false,
          error: 'Feature not available',
          code: 'FEATURE_DISABLED',
          feature: featureKey,
        });
        return;
      }

      next();
    } catch (err) {
      // Fail closed on any service error
      logger.error({ err, storeId, featureKey }, '[requireFeature] Service error, denying access');
      res.status(403).json({
        success: false,
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        feature: featureKey,
      });
    }
  };
}
