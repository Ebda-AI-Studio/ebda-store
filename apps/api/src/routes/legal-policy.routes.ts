import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { z } from 'zod/v3';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { parseInput } from '../lib/parse-input';
import {
  ackItemsSchema,
  ackNotices,
  acceptOwnerConsent,
  consentStatusFor,
  myAcceptances,
  pendingNoticesFor,
  policyOverview,
  requestNoticeSend,
  resumeNoticeSend,
  retryFailedDeliveries,
  userLegalRecord,
} from '../services/legal-notice.service';

/**
 * Legal policy notices (Ruling LEGAL-4), mounted at /me/legal-notices.
 *
 *  GET  /      the signed-in user's pending material-change notices (never cached)
 *  POST /ack   { items: [{ docKey, version }] } -> records "Got it" (source notice_ack)
 *  POST /accept { accepted: true } -> the owner's Terms + Privacy acceptance (source consent_gate)
 *
 * User-level, not store-level: no storeId, no tenantContext; the service opens its own
 * user-scoped transaction. `rejectImpersonated`: an acknowledgement is the merchant's own
 * consent, so a support impersonation session must not give it (amendment A5); the read is
 * closed too so the banner is never "seen" on their behalf.
 * `authorize` admits all admin roles so a non-owner gets the service's precise 403.
 */
export const meLegalNoticeRoutes = Router();

meLegalNoticeRoutes.get(
  '/',
  authenticate,
  rejectImpersonated,
  authorize('store_admin', 'staff', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [notices, consent] = await Promise.all([
        pendingNoticesFor(req.user!.userId, req.user!.role),
        consentStatusFor(req.user!.userId, req.user!.role),
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { notices, consent } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /accept: the owner's affirmative acceptance of the Terms and the Privacy policy (Ruling CONSENT-ADMIN-1).
 * The body must say `accepted: true` (the modal's ticked checkbox); the server never records consent from a bare call.
 */
meLegalNoticeRoutes.post(
  '/accept',
  authenticate,
  rejectImpersonated,
  authorize('store_admin'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      parseInput(z.object({ accepted: z.literal(true) }).strict(), req.body);
      const data = await acceptOwnerConsent(req.user!.userId, req.user!.role, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

meLegalNoticeRoutes.post(
  '/ack',
  authenticate,
  rejectImpersonated,
  authorize('store_admin', 'staff', 'super_admin'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { items } = parseInput(ackItemsSchema, req.body);
      const data = await ackNotices(req.user!.userId, req.user!.role, items, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /me/legal-acceptances: the signed-in user's own acceptance records (I6, account
 * settings "Policies you accepted"). Read-only; never cached.
 */
export const meLegalAcceptanceRoutes = Router();

meLegalAcceptanceRoutes.get(
  '/',
  authenticate,
  authorize('store_admin', 'staff', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const acceptances = await myAcceptances(req.user!.userId);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { acceptances } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 *  Super admin (mounted at /admin, BEFORE adminRoutes' catch-all MFA gate; carries its own chain):
 *    GET  /legal-policies                                   every document's current version + notice state
 *    POST /legal-policies/:docKey/:version/send-notice      announce a material version (202 | 409 | 422 | 502)
 *    POST /legal-policies/:docKey/:version/resume           re-emit the email run of a send (202 | 404 | 502)
 *    POST /legal-policies/:docKey/:version/retry-failed     failed -> queued, then resume (202 | 404 | 502)
 *    GET  /users/:userId/legal-acceptances                  one account's acceptances + deliveries (I6)
 */
export const adminLegalPolicyRoutes = Router();
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];
const sendParams = z.object({
  docKey: z.string().max(40),
  version: z
    .string()
    .regex(/^\d+(\.\d+)*$/)
    .max(20),
});

adminLegalPolicyRoutes.get(
  '/legal-policies',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policies = await policyOverview(req.user!.userId);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { policies } });
    } catch (error) {
      next(error);
    }
  }
);

adminLegalPolicyRoutes.post(
  '/legal-policies/:docKey/:version/send-notice',
  ...superAdmin,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { docKey, version } = parseInput(sendParams, req.params);
      const send = await requestNoticeSend(req.user!.userId, docKey, version);
      await auditLog({
        action: 'legal.notice_sent',
        userId: req.user!.userId,
        resourceType: 'legal_policy',
        resourceId: `${docKey}@${version}`,
        details: { docKey, version },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(202).json({ success: true, data: { send } });
    } catch (error) {
      next(error);
    }
  }
);

/** Resume / Retry failed (I5): audited like Send, each its own action name. */
function recoveryRoute(
  path: 'resume' | 'retry-failed',
  action: string,
  run: (op: string, docKey: string, version: string) => Promise<Record<string, unknown>>
) {
  adminLegalPolicyRoutes.post(
    `/legal-policies/:docKey/:version/${path}`,
    ...superAdmin,
    writeLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { docKey, version } = parseInput(sendParams, req.params);
        const data = await run(req.user!.userId, docKey, version);
        await auditLog({
          action,
          userId: req.user!.userId,
          resourceType: 'legal_policy',
          resourceId: `${docKey}@${version}`,
          details: data,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        res.status(202).json({ success: true, data });
      } catch (error) {
        next(error);
      }
    }
  );
}
recoveryRoute('resume', 'legal.notice_resumed', resumeNoticeSend);
recoveryRoute('retry-failed', 'legal.notice_retry_failed', retryFailedDeliveries);

const userParams = z.object({ userId: z.string().min(1).max(64) });

adminLegalPolicyRoutes.get(
  '/users/:userId/legal-acceptances',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = parseInput(userParams, req.params);
      const data = await userLegalRecord(req.user!.userId, userId);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);
