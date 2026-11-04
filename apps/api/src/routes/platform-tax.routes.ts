import { Router, Request, Response, NextFunction } from 'express';
import { platformDb } from '../lib/platform-directory';
import { z } from 'zod/v3';
import { withUser } from '@ebda/database';
import { TAX_PROFILE_STATUSES, taxReviewDecisionSchema } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { TaxProfileService, taxReviewQueueFromStores } from '../services/tax-profile.service';
import { getPlatformVat, updatePlatformVat } from '../services/platform-vat.service';
import { taxProfilesForReview } from '../lib/definer';
import { sendTaxDocument } from './tax.routes';
import { parseInput } from '../lib/parse-input';

/**
 * Super-admin tax surfaces (ruling TAX-2, TAX-6), mounted at `/admin` BEFORE
 * admin.routes.ts (whose catch-all MFA gate would otherwise swallow them):
 *
 *   GET  /admin/tax-verification?status=pending      review queue (all stores)
 *   GET  /admin/tax-verification/:storeId             one store's profile + documents
 *   GET  /admin/tax-verification/:storeId/documents/:documentId/file
 *   POST /admin/tax-verification/:storeId/decision    approve | reject(reason) | revoke(reason)
 *   GET  /admin/platform-vat                          Ebda's own VAT setting
 *   PUT  /admin/platform-vat
 *
 * Every route: authenticate → requireMfaEnrolled → authorize('super_admin').
 * The decision and the platform-VAT write are ALSO refused by database
 * triggers for anyone who is not an active super_admin (defence in depth), so
 * the handlers run under `withUser(admin)` to carry `app.current_user_id`.
 */
const router = Router();

const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

const UUID = z.string().uuid();
const queueQuerySchema = z.object({ status: z.enum(TAX_PROFILE_STATUSES).optional() });

function actorOf(req: Request) {
  return { userId: req.user!.userId, ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

router.get(
  '/tax-verification',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = parseInput(queueQuerySchema, req.query);
      // A Worker with D1 has no Postgres definer to ask: the queue is read from the stores' Durable Objects (bounded).
      const profiles = platformDb()
        ? await taxReviewQueueFromStores(req.user!.userId, status ?? null)
        : await withUser(req.user!.userId, () => taxProfilesForReview(status ?? null));
      res.json({ success: true, data: { profiles } });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tax-verification/:storeId',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const profile = await withUser(
        req.user!.userId,
        () => TaxProfileService.get(storeId),
        storeId
      );
      res.json({ success: true, data: { profile } });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tax-verification/:storeId/documents/:documentId/file',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const documentId = parseInput(UUID, req.params.documentId);
      const file = await withUser(
        req.user!.userId,
        () => TaxProfileService.readDocument(storeId, documentId),
        storeId
      );
      sendTaxDocument(res, file);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/tax-verification/:storeId/decision',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const decision = parseInput(taxReviewDecisionSchema, req.body);
      const profile = await TaxProfileService.review(storeId, decision, actorOf(req));
      res.json({ success: true, data: { profile } });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/platform-vat',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vat = await withUser(req.user!.userId, () => getPlatformVat());
      res.json({ success: true, data: { vat } });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/platform-vat',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const vat = await updatePlatformVat(req.body, actorOf(req));
      res.json({ success: true, data: { vat } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
