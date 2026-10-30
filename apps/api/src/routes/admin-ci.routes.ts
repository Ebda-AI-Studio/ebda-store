import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { auditLog } from '../middleware/security';
import { parseInput } from '../lib/parse-input';
import { CI_HINT_FEATURES, allGates, setGate } from '../lib/ci/hints/gates';
import { decideInsight, listInsights } from '../services/ci-insights.service';

/**
 * Super-admin Customer Intelligence (CI-2 insights, CI-3 kill switches; Ruling CI-9, CI-10), mounted at
 * `/admin` BEFORE admin.routes.ts (its catch-all MFA gate would swallow these). Every route:
 * authenticate -> requireMfaEnrolled -> authorize('super_admin').
 *
 *   GET /admin/ci/insights?status=      findings over the k-anonymous cohort
 *   PUT /admin/ci/insights/:id          accept | dismiss (a person decides; nothing changes a default by itself)
 *   GET /admin/ci/gates                 kill switch per hint feature
 *   PUT /admin/ci/gates/:feature        close / reopen one
 */
const router = Router();
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

const statusQuery = z.object({ status: z.enum(['new', 'accepted', 'dismissed']).optional() });
const decideBody = z.object({ status: z.enum(['accepted', 'dismissed']) }).strict();
const gateBody = z
  .object({ enabled: z.boolean(), reason: z.string().trim().max(200).optional() })
  .strict();

router.get(
  '/ci/insights',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = parseInput(statusQuery, req.query);
      res.json({ success: true, data: { insights: await listInsights(status) } });
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  '/ci/insights/:id',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInput(z.string().uuid(), req.params.id);
      const { status } = parseInput(decideBody, req.body);
      const r = await decideInsight(id, status);
      await auditLog({
        action: 'ci.insight_decided',
        userId: req.user!.userId,
        resourceType: 'ci_insight',
        resourceId: id,
        details: { status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: r });
    } catch (e) {
      next(e);
    }
  }
);

router.get('/ci/gates', ...superAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { gates: await allGates() } });
  } catch (e) {
    next(e);
  }
});

router.put(
  '/ci/gates/:feature',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const feature = parseInput(z.enum(CI_HINT_FEATURES), req.params.feature);
      const { enabled, reason } = parseInput(gateBody, req.body);
      const gate = await setGate(feature, enabled, reason ?? null);
      await auditLog({
        action: 'ci.gate_changed',
        userId: req.user!.userId,
        resourceType: 'ci_gate',
        resourceId: feature,
        details: { enabled, reason: reason ?? null },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { gate } });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
