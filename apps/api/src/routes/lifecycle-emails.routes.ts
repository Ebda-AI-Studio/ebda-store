import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { listLifecycleLog } from '../services/lifecycle-emails.service';

/**
 * GET /stores/:storeId/lifecycle-emails
 * The merchant's own view of the setup / trial / referral emails Ebda sent them: each kind with
 * `sent | skipped (why) | failed | pending`, and whether they unsubscribed. Read-only. No plan gate:
 * these are onboarding emails for every self-serve store. Owner (`store_admin`) and platform support only:
 * staff never see the setup emails (Ahmad 2026-11-15), mirrored by the hidden tab + registry `owner` access.
 */
const router = Router({ mergeParams: true });

router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
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

export default router;
