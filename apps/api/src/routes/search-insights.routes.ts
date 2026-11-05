/**
 * Search insights route (search program, Task 6): what shoppers searched in the storefront.
 *
 * GET /:storeId/search-insights?days=7|30|90&filter=zero|all
 * Also returns `index`: the store's smart-search index status (Task 12, counts only).
 *
 * Reads ONLY through `getSearchInsights`, which owns the window (Cairo days, inclusive of
 * today), the ≥2-searches privacy floor (Ruling SEARCH-T5-6) and the store scope. Never query
 * `search_query_daily` from here: the floor would be bypassed.
 *
 * Auth: authenticate → MFA → requirePermission('analytics:read') → requireStoreAccess, the same
 * gate as the /analytics routes (Ruling SEARCH-T6-1: aggregated, k>=2, no shopper data, so staff
 * who may read analytics may read this). No analytics-tier gate: finding what shoppers could not
 * find is a core search tool, not a paid report (Ruling SEARCH-5).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod/v3';
import type { SearchInsightsResponse } from '@ebda/shared';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { withStore } from '@ebda/database';
import { getSearchInsights } from '../services/search-log.service';
import { storeMoney } from '../lib/repo-factory';
import { storeIndexStatus } from '../services/product-index.service';
import { semanticSearchEnabled } from '../lib/search/embedding-provider';
import { withSavepoint } from '../lib/savepoint';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

const query = z.object({
  days: z.enum(['7', '30', '90']).default('30'),
  filter: z.enum(['zero', 'all']).default('zero'),
});

router.get(
  '/:storeId/search-insights',
  authenticate,
  requireMfaEnrolled,
  requirePermission('analytics:read'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'days must be 7, 30 or 90');
      const storeId = req.params.storeId;
      const insights = await getSearchInsights(storeId, {
        days: Number(parsed.data.days) as 7 | 30 | 90,
        filter: parsed.data.filter,
      });
      // Task 12: the smart-search index line ("N of M ready / N failed"). Counts only; no shopper
      // data. Its failure drops only that line (`index` is optional), never the page (review M8);
      // the savepoint keeps a failed statement from aborting the request transaction.
      let index: SearchInsightsResponse['index'];
      try {
        // Ruling NZ-PG-7: a DO store's index state is in its DO (no Postgres scope, no savepoint); a Postgres store keeps the
        // savepointed tenant read.
        const money = await storeMoney(storeId);
        const status = money
          ? await money.vectorStatus({})
          : await withSavepoint(() => withStore(storeId, () => storeIndexStatus(storeId)));
        index = { ...status, semanticEnabled: semanticSearchEnabled() };
      } catch (err) {
        logger.warn(
          { storeId, err: err instanceof Error ? err.message : 'unknown' },
          '[search-insights] index status unavailable; omitted'
        );
      }
      const data: SearchInsightsResponse = { ...insights, ...(index ? { index } : {}) };
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
