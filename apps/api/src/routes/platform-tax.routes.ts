import { Router, Request, Response, NextFunction } from 'express';
import { platformDb } from '../lib/platform-directory';
import { z } from 'zod/v3';
import {
  TAX_PROFILE_STATUSES,
  taxChangeDecisionSchema,
  taxReviewDecisionSchema,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import {
  TaxProfileService,
  inReviewScope,
  listProfilesForReview,
} from '../services/tax-profile.service';
import { withPlatformUser } from '../lib/platform-scope';
import { getPlatformVat, updatePlatformVat } from '../services/platform-vat.service';
import { sendTaxDocument } from './tax.routes';
import { parseInput } from '../lib/parse-input';
import {
  decideTaxChange,
  discardTaxChange,
  listTaxChangesForReview,
  readTaxChangeEvidence,
} from '../services/tax-change.service';

/**
 * Super-admin tax surfaces (ruling TAX-2, TAX-6), mounted at `/admin` BEFORE
 * admin.routes.ts (whose catch-all MFA gate would otherwise swallow them):
 *
 *   GET  /admin/tax-verification?status=pending      review queue (all stores)
 *   GET  /admin/tax-verification/:storeId             one store's profile + documents
 *   GET  /admin/tax-verification/:storeId/documents/:documentId/file
 *   POST /admin/tax-verification/:storeId/decision    approve | reject(reason) | revoke(reason)
 *   GET  /admin/tax-verification/change-requests      pending changes of VERIFIED registrations + AI pre-check flags
 *   GET  /admin/tax-verification/:storeId/change-request/file
 *   POST /admin/tax-verification/:storeId/change-decision   approve | reject(reason)
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
      const profiles = await withPlatformUser(req.user!.userId, () =>
        listProfilesForReview(status ?? null)
      );
      res.json({ success: true, data: { profiles } });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tax-verification/change-requests',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: { requests: await listTaxChangesForReview(req.user!.userId) },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tax-verification/:storeId/change-request/file',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      sendTaxDocument(res, await readTaxChangeEvidence(storeId));
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/tax-verification/:storeId/change-decision',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const decision = parseInput(taxChangeDecisionSchema, req.body);
      res.json({ success: true, data: await decideTaxChange(storeId, decision, actorOf(req)) });
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
      const profile = await inReviewScope(req.user!.userId, storeId, () =>
        TaxProfileService.get(storeId)
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
      const file = await inReviewScope(req.user!.userId, storeId, () =>
        TaxProfileService.readDocument(storeId, documentId)
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
      // a revoked profile can no longer be "changed": drop a pending request and its evidence
      if (decision.decision === 'revoke') await discardTaxChange(storeId);
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
      const vat = await withPlatformUser(req.user!.userId, () => getPlatformVat());
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
