import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { getAuthUser } from '../utils/store-helpers';
import { buildStoreEvent, sendStoreEvents } from '../lib/wa/events';
import { notifyPlanChanged } from '../lib/wa/plan-state';
import { WhatsAppLinkService, canLinkWhatsApp, whatsAppLinkState } from '../lib/wa/link';

/**
 * The merchant connects / disconnects Ebda WhatsApp in Store admin (contract 2026-10-24, sections 4
 * and 7). This is the ONLY request path that writes the server-owned link row, and it does so
 * through `WhatsAppLinkService` after an owner/admin check and the plan entitlement; a merchant can
 * never set it through the store settings (reserved key, Ruling WA-LINK-1). Each change emits
 * `store.linked` / `store.unlinked` to Ebda WhatsApp on `ebda-wa-events`.
 *
 * The DB write and the enqueue form one unit: the write lives in the request transaction, so an
 * enqueue failure throws, the transaction rolls back and the merchant sees an error with the old
 * state intact (fail fast, no half-linked store).
 */
const router = Router({ mergeParams: true });

const guards = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
];

router.get('/', ...guards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await whatsAppLinkState(req.params.storeId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: state });
  } catch (err) {
    next(err);
  }
});

async function change(req: Request, linked: boolean): Promise<{ linked: boolean }> {
  const { storeId } = req.params;
  const userId = getAuthUser(req).userId;
  if (linked) {
    if (!(await canLinkWhatsApp(storeId))) {
      throw new AppError(
        403,
        'WHATSAPP_NOT_INCLUDED',
        'Your plan does not include Ebda WhatsApp. Upgrade to connect it.'
      );
    }
  }
  await WhatsAppLinkService.setLinked(storeId, linked, userId);
  const event = await buildStoreEvent(
    { type: linked ? 'store.linked' : 'store.unlinked', storeId, data: { ownerUserId: userId } },
    { seed: `link:${storeId}:${linked}:${Date.now()}` }
  );
  await sendStoreEvents([event]);
  // Ebda WhatsApp learns the store's plan state right after it learns the store (and again on unlink).
  await notifyPlanChanged(storeId);
  await auditLog({
    action: linked ? 'whatsapp.linked' : 'whatsapp.unlinked',
    userId,
    storeId,
    resourceType: 'store',
    resourceId: storeId,
  });
  return { linked };
}

for (const [method, linked] of [
  ['post', true],
  ['delete', false],
] as const) {
  router[method]('/', ...guards, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await change(req, linked) });
    } catch (err) {
      next(err);
    }
  });
}

export default router;
