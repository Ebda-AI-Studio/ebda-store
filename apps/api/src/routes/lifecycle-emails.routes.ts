import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { z } from 'zod/v3';
import { LIFECYCLE_EMAIL_KINDS } from '@ebda/shared';
import { auditLog, writeLimiter } from '../middleware/security';
import { listLifecycleLog, sendLifecycleTestEmail } from '../services/lifecycle-emails.service';

const testSendBody = z.object({ kind: z.enum(LIFECYCLE_EMAIL_KINDS) }).strict();
const TEST_SEND_ERRORS = {
  not_found: [404, 'STORE_NOT_FOUND', 'Store not found'],
  not_owner: [403, 'OWNER_ONLY', 'Only the store owner can send a test email'],
  no_recipient: [409, 'NO_OWNER_EMAIL', 'The store owner has no email address'],
  failed: [502, 'ENQUEUE_FAILED', 'The test email could not be queued'],
} as const;

/**
 * GET /stores/:storeId/lifecycle-emails
 * The merchant's own view of the setup / trial / referral emails Ebda sent them: each kind with
 * `sent | skipped (why) | failed | pending`, and whether they unsubscribed. Read-only. No plan gate:
 * these are onboarding emails for every self-serve store.
 */
const router = Router({ mergeParams: true });

router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await listLifecycleLog(req.params.storeId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /stores/:storeId/lifecycle-emails/test-send  { kind }
 * Owner-only "send this email to myself" (QA-66). Mails the owner's own address, never a customer; adds
 * no row to the log. Use it to see the real message and check its RFC 8058 List-Unsubscribe headers.
 */
router.post(
  '/test-send',
  authenticate,
  authorize('store_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { kind } = testSendBody.parse(req.body);
      const result = await sendLifecycleTestEmail(storeId, kind, req.user!.userId);
      if (result.status !== 'sent') {
        const [status, code, message] = TEST_SEND_ERRORS[result.status];
        res.status(status).json({ success: false, error: { code, message } });
        return;
      }
      await auditLog({
        action: 'lifecycle_email.test_sent',
        userId: req.user?.userId,
        storeId,
        resourceType: 'lifecycle_email',
        resourceId: kind,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: { kind, to: result.to } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
