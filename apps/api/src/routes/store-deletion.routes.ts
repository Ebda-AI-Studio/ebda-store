import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { tenantContext } from '../middleware/tenant-context';
import { AppError } from '../middleware/error-handler';
import { createStoreExportLimiter } from '../middleware/store-export-limiter';
import {
  previewStoreDeletion,
  scheduleStoreDeletion,
  cancelStoreDeletion,
  readDeletionStatus,
} from '../services/store-deletion.service';
import { productionDeletionDeps } from '../services/store-deletion.wiring';
import { exportStoreBundle } from '../services/store-export.wiring';

/**
 * Owner self-service store lifecycle (SELF-SERVICE gap A11, Ruling STORE-LIFECYCLE-1): delete the store behind a confirm token +
 * typed slug + 14-day cooling-off that can be cancelled, and export every table. OWNER ONLY (checked in the service against
 * `store.ownerId`; a staff member or a non-owner store admin is 403). The store id is ALWAYS the path param.
 *
 * Super-admin override: `DELETE /stores/:id` (store.routes.ts) stays super_admin-only and immediate, for support and test stores.
 * Money in flight / billing guards are enforced at preview, at schedule AND again at execution.
 *
 * `requireMfaEnrolled` only binds super_admin (it is a no-op for merchants today); there is no fresh-password step-up helper, so
 * the merchant's step-up is the typed slug + the single-use token. Impersonated sessions are refused.
 */
const router = Router();
// Every route declares ':storeId' itself; the bare '/' mount cannot set the RLS tenant context (F2), so the param hook does.
router.param('storeId', tenantContext);
const ownerRoles = authorize('store_admin', 'super_admin');
const guard = [
  authenticate,
  requireMfaEnrolled,
  ownerRoles,
  requireStoreAccess,
  rejectImpersonated,
] as const;

// Non-strict on purpose: a `storeId` (or anything else) in the body is stripped and never read; the store id is the path param.
const scheduleBody = z.object({
  confirmToken: z.string().min(10).max(2000),
  typedSlug: z.string().min(1).max(100),
});

function actor(req: Request) {
  return { storeId: req.params.storeId, userId: req.user!.userId };
}
// Read + cancel also accept super_admin (platform override, audited in the service); preview, schedule and export stay owner-only.
function actorWithRole(req: Request) {
  return { ...actor(req), role: req.user!.role };
}

router.get(
  '/stores/:storeId/deletion',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: await readDeletionStatus(actorWithRole(req), productionDeletionDeps()),
      });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/stores/:storeId/deletion/preview',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = await previewStoreDeletion(actor(req), productionDeletionDeps());
      if (!p.ok) {
        throw new AppError(409, p.reasons[0].code, p.reasons[0].message, {
          reasons: p.reasons,
        } as never);
      }
      res.json({ success: true, data: p });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/stores/:storeId/deletion',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = scheduleBody.parse(req.body ?? {});
      const r = await scheduleStoreDeletion(
        { ...actor(req), ...body, ownerEmail: req.user!.email || undefined },
        productionDeletionDeps()
      );
      res
        .status(202)
        .json({ success: true, data: { id: r.id, state: r.state, executeAfter: r.executeAfter } });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  '/stores/:storeId/deletion',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await cancelStoreDeletion(
        // a super_admin cancel must not email the super admin as if they were the owner
        {
          ...actorWithRole(req),
          ownerEmail: req.user!.role === 'super_admin' ? undefined : req.user!.email || undefined,
        },
        productionDeletionDeps()
      );
      res.json({ success: true, data: { id: r.id, state: r.state } });
    } catch (e) {
      next(e);
    }
  }
);

const exportLimiter = createStoreExportLimiter();
router.get(
  '/stores/:storeId/export',
  ...guard,
  exportLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await exportStoreBundle(actor(req));
      if (!r.ok) {
        res.status(413).json({
          success: false,
          error: {
            code: 'EXPORT_TOO_LARGE',
            message: `Your store has more than ${r.cap} rows, which is above what a single export can carry. Export the orders, products and customers from their own pages, or contact Ebda Store support for a full export.`,
          },
        });
        return;
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(r.zip));
    } catch (e) {
      next(e);
    }
  }
);

export default router;
