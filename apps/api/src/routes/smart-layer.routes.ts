/**
 * Smart Layer Routes — Reorder Suggestions, Dead-Stock Flags, Profit Anomalies
 *
 * All routes are store-scoped (/:storeId/stock/… and /:storeId/finance/…)
 * and sit behind the standard authenticate → authorize → requireStoreAccess chain.
 *
 * Routes:
 *   GET  /:storeId/stock/reorder-suggestions             — paginated, filter by status
 *   POST /:storeId/stock/reorder-suggestions/:id/accept  — draft PO from suggestion
 *   POST /:storeId/stock/reorder-suggestions/:id/dismiss — mark dismissed
 *   GET  /:storeId/stock/deadstock-flags                 — paginated, filter by status
 *   POST /:storeId/stock/deadstock-flags/:id/clearance   — create clearance coupon
 *   POST /:storeId/stock/deadstock-flags/:id/dismiss     — mark dismissed
 *   GET  /:storeId/finance/anomalies                     — paginated, filter by severity + acknowledged
 *   POST /:storeId/finance/anomalies/:id/acknowledge     — mark acknowledged
 *   POST /:storeId/stock/reorder-scan/run-now            — super_admin: fire on-demand scan
 *   POST /:storeId/stock/low-stock-scan/run-now          — super_admin: fire on-demand scan
 *   POST /:storeId/stock/deadstock-scan/run-now          — super_admin: fire on-demand scan
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { createPoFromSuggestion } from '../services/accounting/purchase-order.service';
import { createClearanceCouponFromFlag } from '../services/accounting/deadstock-scan.service';
import { inngest } from '../lib/inngest/client';
import { runInStoreCtx } from '../lib/jobs/store-db';

const router = Router({ mergeParams: true });

// ─── Pagination helpers ───────────────────────────────────────────────────────

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
});

function pageMeta(page: number, perPage: number, total: number) {
  return { page, perPage, total, totalPages: Math.ceil(total / perPage) };
}

// ─── GET /:storeId/stock/reorder-suggestions ─────────────────────────────────

const reorderListSchema = paginationSchema.extend({
  status: z.enum(['open', 'all']).default('open'),
});

router.get(
  '/:storeId/stock/reorder-suggestions',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reorderListSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { page, perPage, status } = parsed.data;
      const where: any = { storeId: req.params.storeId };
      if (status === 'open') where.status = 'open';

      const [items, total] = await runInStoreCtx(req.params.storeId, async () => {
        const db = await storeDb(req.params.storeId);
        return Promise.all([
          db.reorderSuggestion.findMany({
            where,
            include: {
              product: { select: { id: true, name: true, nameAr: true, sku: true } },
              // Per-variant suggestions (2026-10-01): the card names the variant.
              variant: { select: { id: true, title: true, titleAr: true, sku: true } },
              supplier: { select: { id: true, name: true } },
            },
            orderBy: [{ urgencyDays: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * perPage,
            take: perPage,
          }),
          db.reorderSuggestion.count({ where }),
        ]);
      });

      res.json({ success: true, data: { data: items, meta: pageMeta(page, perPage, total) } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/reorder-suggestions/:id/accept ─────────────────────

router.post(
  '/:storeId/stock/reorder-suggestions/:id/accept',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await runInStoreCtx(req.params.storeId, () =>
        createPoFromSuggestion(req.params.id, req.params.storeId, req.user?.userId)
      );
      res.json({ data: { poId: po.id } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/reorder-suggestions/:id/dismiss ────────────────────

router.post(
  '/:storeId/stock/reorder-suggestions/:id/dismiss',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await runInStoreCtx(req.params.storeId, async () =>
        (await storeWriter(req.params.storeId)).reorderSuggestion.updateMany({
          where: { id: req.params.id, storeId: req.params.storeId, status: 'open' },
          data: {
            status: 'dismissed',
            dismissedBy: req.user?.userId ?? null,
            dismissedAt: new Date(),
          },
        })
      );
      res.json({ data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/stock/deadstock-flags ─────────────────────────────────────

const deadstockListSchema = paginationSchema.extend({
  status: z.enum(['open', 'all']).default('open'),
});

router.get(
  '/:storeId/stock/deadstock-flags',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = deadstockListSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { page, perPage, status } = parsed.data;
      const where: any = { storeId: req.params.storeId };
      if (status === 'open') where.status = 'open';

      const [items, total, valueUnknownCount] = await runInStoreCtx(req.params.storeId, async () =>
        Promise.all([
          (await storeDb(req.params.storeId)).deadStockFlag.findMany({
            where,
            include: {
              product: { select: { id: true, name: true, sku: true } },
            },
            // Known values first, largest first; flags whose product has no
            // cost price (value unknown = NULL) after them. `id` keeps the
            // page boundaries stable across ties.
            orderBy: [{ stockValueFils: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
            skip: (page - 1) * perPage,
            take: perPage,
          }),
          (await storeDb(req.params.storeId)).deadStockFlag.count({ where }),
          (await storeDb(req.params.storeId)).deadStockFlag.count({
            where: { ...where, stockValueFils: null },
          }),
        ])
      );

      res.json({
        success: true,
        data: { data: items, meta: pageMeta(page, perPage, total), valueUnknownCount },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/deadstock-flags/:id/clearance ──────────────────────

router.post(
  '/:storeId/stock/deadstock-flags/:id/clearance',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await runInStoreCtx(req.params.storeId, () =>
        createClearanceCouponFromFlag(req.params.id, req.params.storeId)
      );
      res.json({ data: { couponCode: result.couponCode } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/deadstock-flags/:id/dismiss ────────────────────────

router.post(
  '/:storeId/stock/deadstock-flags/:id/dismiss',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await runInStoreCtx(req.params.storeId, async () =>
        (await storeWriter(req.params.storeId)).deadStockFlag.updateMany({
          where: { id: req.params.id, storeId: req.params.storeId, status: 'open' },
          data: {
            status: 'dismissed',
            dismissedBy: req.user?.userId ?? null,
            dismissedAt: new Date(),
          },
        })
      );
      res.json({ data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/anomalies ─────────────────────────────────────────

const anomalyListSchema = paginationSchema.extend({
  severity: z.enum(['p0', 'warning', 'all']).default('all'),
  acknowledged: z.enum(['true', 'false', 'all']).default('all'),
});

router.get(
  '/:storeId/finance/anomalies',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // accounting.profit_anomaly is on every paid plan (AI-first policy,
  // 2026-07-21); `free` and per-store overrides can still disable it. The
  // daily-sweep Inngest job already gates the write side
  // (accounting-profit-anomaly.ts); without this gate a store with the feature
  // disabled retained unrestricted read access to historical rows forever —
  // the two layers of the same feature disagreed.
  requireFeature('accounting.profit_anomaly'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = anomalyListSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { page, perPage, severity, acknowledged } = parsed.data;
      const where: any = { storeId: req.params.storeId };
      if (severity !== 'all') where.severity = severity;
      if (acknowledged === 'true') where.acknowledged = true;
      if (acknowledged === 'false') where.acknowledged = false;

      const anomalyDb = await storeDb(req.params.storeId);
      const [items, total] = await runInStoreCtx(req.params.storeId, () =>
        Promise.all([
          anomalyDb.profitAnomaly.findMany({
            where,
            orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
            skip: (page - 1) * perPage,
            take: perPage,
          }),
          anomalyDb.profitAnomaly.count({ where }),
        ])
      );

      res.json({ success: true, data: { data: items, meta: pageMeta(page, perPage, total) } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/finance/anomalies/:id/acknowledge ────────────────────────

router.post(
  '/:storeId/finance/anomalies/:id/acknowledge',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.profit_anomaly'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const anomalyWriter = await storeWriter(req.params.storeId);
      await runInStoreCtx(req.params.storeId, () =>
        anomalyWriter.profitAnomaly.updateMany({
          where: { id: req.params.id, storeId: req.params.storeId, acknowledged: false },
          data: {
            acknowledged: true,
            acknowledgedBy: req.user?.userId ?? null,
            acknowledgedAt: new Date(),
          },
        })
      );
      res.json({ data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/reorder-scan/run-now ───────────────────────────────

router.post(
  '/:storeId/stock/reorder-scan/run-now',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await inngest.send({
        name: 'stock/reorder-scan-requested',
        data: { storeId: req.params.storeId, requestedBy: req.user?.userId },
      });
      res.status(202).json({ data: { queued: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/low-stock-scan/run-now ─────────────────────────────
//
// Mirrors reorder-scan/run-now above. `stockLowStockAlertOnDemand`
// (lib/inngest/functions/stock-low-stock-alert.ts) has listened for
// `stock/low-stock-scan-requested` since it was written, but nothing ever
// sent that event — the on-demand scan the function's own doc comment
// describes ("Fired by the admin 'Scan now' button") was unreachable. The
// button now lives on the admin stock dashboard (stock/dashboard/page.tsx).

router.post(
  '/:storeId/stock/low-stock-scan/run-now',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await inngest.send({
        name: 'stock/low-stock-scan-requested',
        data: { storeId: req.params.storeId, requestedBy: req.user?.userId },
      });
      res.status(202).json({ data: { queued: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/stock/deadstock-scan/run-now ─────────────────────────────

router.post(
  '/:storeId/stock/deadstock-scan/run-now',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await inngest.send({
        name: 'stock/deadstock-scan-requested',
        data: { storeId: req.params.storeId, requestedBy: req.user?.userId },
      });
      res.status(202).json({ data: { queued: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
