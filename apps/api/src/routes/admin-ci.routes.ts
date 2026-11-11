import { runBuyerKeyBackfill, MAX_BUDGET } from '../lib/wa/buyer-key-backfill';
import { backfillImageVariants } from '../services/image-variants.service';
import { AppError } from '../middleware/error-handler';
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

/**
 * One-off backfill of resized image variants for images uploaded before PREMIUM-2 (Ruling PREMIUM-2).
 * Resumable: call with the returned `nextCursor` until it is null, once per store.
 *   POST /admin/images/backfill-variants   { storeId, cursor?, limit?, dryRun? }
 */
const backfillBody = z
  .object({
    storeId: z.string().uuid(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

router.post(
  '/images/backfill-variants',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseInput(backfillBody, req.body);
      const r = await backfillImageVariants(body);
      await auditLog({
        action: 'images.variants_backfill',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: body.storeId,
        details: { ...r, dryRun: !!body.dryRun },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: r });
    } catch (e) {
      next(e);
    }
  }
);

const buyerKeyBackfillBody = z
  .object({
    /** DEFAULT TRUE: nothing is written unless the caller says `dryRun: false`. */
    dryRun: z.boolean().default(true),
    cursor: z.string().max(2048).optional(),
    budget: z.number().int().min(1).max(MAX_BUDGET).optional(),
    storeId: z.string().uuid().optional(),
  })
  .strict();

// POST /admin/wa/buyer-key-backfill: stamp orders.buyer_key on orders that have a phone but no key (Ruling WA-BRIDGE-BIND-3), before
// WA_BRIDGE_REQUIRE_BUYER_PROOF=1. Idempotent, dry-run by default, resumable (`nextCursor`), skips gone stores.
router.post(
  '/wa/buyer-key-backfill',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseInput(buyerKeyBackfillBody, req.body);
      const secret = process.env.SUITE_BUYER_KEY_SECRET ?? '';
      if (secret.length < 32)
        throw new AppError(
          503,
          'BUYER_KEY_SECRET_MISSING',
          'SUITE_BUYER_KEY_SECRET is not set on this Worker'
        );
      const r = await runBuyerKeyBackfill({ ...body, secret });
      await auditLog({
        action: 'wa.buyer_key_backfill',
        userId: req.user!.userId,
        resourceType: 'platform',
        resourceId: body.storeId ?? 'all',
        details: {
          dryRun: r.dryRun,
          totals: r.totals,
          resumed: !!body.cursor,
          done: r.nextCursor === null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: r });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
