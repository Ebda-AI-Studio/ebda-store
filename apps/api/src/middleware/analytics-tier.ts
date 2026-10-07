import { Request, Response, NextFunction } from 'express';
import { assertAnalyticsTier, type ANALYTICS_TIER_RANK } from '../services/plan-limit.service';

/**
 * Plan analytics tier gate (locked pricing 2026-10-05: basic / standard /
 * advanced = Basic / Growth / Business). Place AFTER `requireStoreAccess`.
 * 402 PLAN_LIMIT_REACHED when the store's plan tier is below `min`.
 * Super-admin bypasses, same as `requireFeature`.
 */
export function requireAnalyticsTier(min: keyof typeof ANALYTICS_TIER_RANK) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (req.user?.role === 'super_admin') return next();
    try {
      const storeId = req.params.storeId || req.params.id || (req as any).store?.id;
      await assertAnalyticsTier(storeId, min);
      next();
    } catch (err) {
      next(err);
    }
  };
}
