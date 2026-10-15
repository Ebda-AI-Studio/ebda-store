import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { z } from 'zod';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { parseInput } from '../lib/parse-input';
import {
  ackItemsSchema,
  ackNotices,
  pendingNoticesFor,
  policyOverview,
  requestNoticeSend,
} from '../services/legal-notice.service';

/**
 * Legal policy notices (Ruling LEGAL-4), mounted at /me/legal-notices.
 *
 *  GET  /      the signed-in user's pending material-change notices (never cached)
 *  POST /ack   { items: [{ docKey, version }] } -> records "Got it" (source notice_ack)
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
      const notices = await pendingNoticesFor(req.user!.userId, req.user!.role);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { notices } });
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
 *  Super admin (mounted at /admin, BEFORE adminRoutes' catch-all MFA gate; carries its own chain):
 *    GET  /legal-policies                                   every document's current version + notice state
 *    POST /legal-policies/:docKey/:version/send-notice      announce a material version (202 | 409 | 422 | 502)
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
