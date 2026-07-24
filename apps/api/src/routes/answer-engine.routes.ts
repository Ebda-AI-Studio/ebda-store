import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { getAnswerEngineSummary } from '../services/answer-engine/dashboard.service';
import { getGscDashboard } from '../services/answer-engine/gsc-dashboard.service';

/**
 * Merchant-facing answer-engine (AEO/GEO citation) dashboard read API
 * (Task 7). Mirrors `analytics.routes.ts` EXACTLY: `authenticate ->
 * requirePermission('analytics:read') -> requireStoreAccess`, mounted at
 * `/stores/:storeId/answer-engine` under `tenantContext` in
 * `routes/index.ts` — same as the analytics router.
 *
 * Gated on the `answer_engine_insights` feature via `requireFeature`, the
 * standard fail-closed gate this codebase uses everywhere else
 * (`expenses.routes.ts`, `stock-adjustments.routes.ts`, etc.) — returns
 * 403 `FEATURE_DISABLED` for a disabled store rather than a 404, matching
 * every other feature-gated route (the task brief's "404/empty" language
 * describes the desired fail-closed *behavior*, not a literal status code
 * this codebase doesn't otherwise use).
 */

const router = Router({ mergeParams: true });

// GET /stores/:storeId/answer-engine/summary
router.get(
  '/summary',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  requireFeature('answer_engine_insights'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const summary = await getAnswerEngineSummary(storeId);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/answer-engine/gsc
//
// Sibling of `/summary` (Plan 8B, Task 4) — same auth chain, same
// fail-closed feature gate, reads `GscDailyMetric` rows written by the
// daily GSC ingestion cron (Task 3). See gsc-dashboard.service.ts for the
// "not connected" vs "genuine zero" distinction.
router.get(
  '/gsc',
  authenticate,
  requirePermission('analytics:read'),
  requireStoreAccess,
  requireFeature('answer_engine_insights'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const gsc = await getGscDashboard(storeId);
      res.json({ success: true, data: gsc });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
