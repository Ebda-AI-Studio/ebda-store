import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { writeLimiter } from '../middleware/security';
import { parseInput } from '../lib/parse-input';
import { ackItemsSchema, ackNotices, pendingNoticesFor } from '../services/legal-notice.service';

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
