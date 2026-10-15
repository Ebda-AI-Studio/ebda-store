/**
 * Search insights route (search program, Task 6): what shoppers searched in the storefront.
 *
 * GET /:storeId/search-insights?days=7|30|90&filter=zero|all
 *
 * Reads ONLY through `getSearchInsights`, which owns the window (Cairo days, inclusive of
 * today), the ≥2-searches privacy floor (Ruling SEARCH-T5-6) and the store scope. Never query
 * `search_query_daily` from here: the floor would be bypassed.
 *
 * Auth: authenticate → MFA → store_admin|super_admin → requireStoreAccess. No analytics-tier
 * gate: finding what shoppers could not find is a core search tool, not a paid report
 * (Ruling SEARCH-5).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { SearchInsightsResponse } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { getSearchInsights } from '../services/search-log.service';

const router = Router({ mergeParams: true });

const query = z.object({
  days: z.enum(['7', '30', '90']).default('30'),
  filter: z.enum(['zero', 'all']).default('zero'),
});

router.get(
  '/:storeId/search-insights',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'days must be 7, 30 or 90');
      const data: SearchInsightsResponse = await getSearchInsights(req.params.storeId, {
        days: Number(parsed.data.days) as 7 | 30 | 90,
        filter: parsed.data.filter,
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
