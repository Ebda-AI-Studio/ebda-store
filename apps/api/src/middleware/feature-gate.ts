import { Request, Response, NextFunction } from 'express';
import { FeatureKey } from '@force/shared';
import { featureService } from '../services/feature.service';
import logger from '../lib/logger';

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
    if ((req as any).user?.role === 'super_admin') {
      return next();
    }

    // Resolve storeId from multiple possible locations
    const storeId =
      req.params.storeId ||
      req.params.id ||
      (req as any).store?.id ||
      (req.headers['x-store-id'] as string | undefined);

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
