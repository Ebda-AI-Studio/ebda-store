/**
 * Merchant to Ebda staff channel (SELF-SERVICE A13 + A14). Mounted at `/stores`; every route declares `/:storeId/...`.
 *
 *   POST /stores/:storeId/support-requests          Contact Ebda Store: topic + message + page (5 per store per day)
 *   GET  /stores/:storeId/suspension                why this store is suspended, and its appeal (404 if not suspended)
 *   POST /stores/:storeId/suspension/appeal         one open appeal per store
 *
 * Chain: authenticate -> authorize(store_admin, super_admin) -> requireStoreAccess (store id is path-checked, never the
 * body). A message to Ebda staff, not to customers: no confirm token. Staff keep the decision; a merchant has no route
 * that resolves an appeal. Super-admin override: a super admin passes requireStoreAccess for any store (files on its behalf).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod/v3';
import { SUPPORT_TOPICS } from '@ebda/shared';
import { prisma } from '@ebda/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { tenantContext } from '../middleware/tenant-context';
import { auditLog } from '../middleware/security';
import { parseInput } from '../lib/parse-input';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { sendOnboardingHelpToCi } from '../lib/ci/emit';
import { getAuthUser } from '../utils/store-helpers';
import {
  createSupportRequest,
  fileAppeal,
  getSuspension,
  notifyStaff,
  type TrustDb,
} from '../services/trust-requests.service';

const router = Router();
router.param('storeId', tenantContext);

const db = () => prisma as unknown as TrustDb;
const admin = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess] as const;

const supportBody = z.object({
  topic: z.enum(SUPPORT_TOPICS),
  message: z.string().trim().min(1).max(2000),
  // an in-app path or an https page: never a javascript: or data: url that staff might click
  pageUrl: z
    .string()
    .trim()
    .max(500)
    .refine(u => u.startsWith('/') || u.startsWith('https://'), 'Invalid page')
    .optional(),
});
const appealBody = z.object({ message: z.string().trim().min(1).max(1000) });

router.post(
  '/:storeId/support-requests',
  ...admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const input = parseInput(supportBody, req.body);
      const row = await createSupportRequest(
        db(),
        storeId,
        { userId: user.userId, email: user.email },
        input
      );
      await auditLog({
        action: 'support.request_created',
        storeId,
        userId: user.userId,
        resourceType: 'trust_request',
        resourceId: row.id,
        details: { topic: input.topic },
      });
      void deferAfterTenantCommit('support-request.notify', async () => {
        await notifyStaff({
          subject: `Support request (${input.topic}) from store ${storeId}`,
          lines: [
            `Store: ${storeId}`,
            `Topic: ${input.topic}`,
            `Page: ${input.pageUrl ?? '-'}`,
            user.email ? `From: ${user.email}` : '',
            '',
            input.message,
          ].filter(l => l !== ''),
          replyTo: user.email,
          storeId,
          ref: { requestId: row.id, kind: 'support', topic: input.topic },
        });
      });
      // Activation signal (Ruling ACT-1): the merchant asked for help. Ids only, never the message; advisory.
      void deferAfterTenantCommit('support-request.help-signal', async () => {
        await sendOnboardingHelpToCi(storeId, 'support_contact');
      });
      res.status(201).json({ success: true, data: { id: row.id } });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:storeId/suspension',
  ...admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getSuspension(db(), req.params.storeId) });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:storeId/suspension/appeal',
  ...admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const { message } = parseInput(appealBody, req.body);
      const row = await fileAppeal(
        db(),
        storeId,
        { userId: user.userId, email: user.email },
        message
      );
      await auditLog({
        action: 'store.suspension_appeal',
        storeId,
        userId: user.userId,
        resourceType: 'trust_request',
        resourceId: row.id,
      });
      void deferAfterTenantCommit('suspension-appeal.notify', async () => {
        await notifyStaff({
          subject: `Suspension appeal from store ${storeId}`,
          lines: [`Store: ${storeId}`, user.email ? `From: ${user.email}` : '', '', message].filter(
            l => l !== ''
          ),
          replyTo: user.email,
          storeId,
          ref: { requestId: row.id, kind: 'suspension_appeal' },
        });
      });
      res.status(201).json({ success: true, data: { id: row.id } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
