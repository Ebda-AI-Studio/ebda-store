/**
 * Wholesale account routes (B2B Task 5).
 *   shopper  POST /public/wholesale/apply, GET /public/wholesale/status   (customer session; rate-limited; no-store)
 *   merchant GET/POST /stores/:storeId/wholesale-applications[/:id/(approve|reject|revoke)]
 *            authenticate -> authorize(store_admin, super_admin) -> requireStoreAccess -> requireFeature on decisions
 * The applicant is ALWAYS the signed-in customer (customerUserId); a body can never name another user. Zod `.strict()`.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  authenticate,
  authorize,
  optionalAuthenticate,
  customerUserId,
  rejectImpersonated,
} from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { writeLimiter } from '../middleware/security';
import { getStoreIdFromRequest, getAuthUser } from '../utils/store-helpers';
import { setBuyerPrivate } from '../lib/edge-cache';
import { WholesaleApplicationService } from '../services/wholesale-application.service';
import { AppError } from '../middleware/error-handler';

export const publicWholesaleRouter = Router();
export const merchantWholesaleRouter = Router();
merchantWholesaleRouter.param('storeId', tenantContext);

const applySchema = z
  .object({
    businessName: z.string().trim().min(2).max(160),
    commercialRegNo: z.string().trim().max(60).nullish(),
    phone: z.string().trim().min(6).max(40),
    notes: z.string().trim().max(1000).nullish(),
  })
  .strict();

function requireCustomer(req: Request): string {
  const id = customerUserId(req);
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return id;
}

publicWholesaleRouter.post(
  '/wholesale/apply',
  optionalAuthenticate,
  // An impersonation session must not apply as the customer (design review I5).
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requireCustomer(req);
      const storeId = await getStoreIdFromRequest(req);
      const body = applySchema.parse(req.body);
      const application = await WholesaleApplicationService.apply(storeId, userId, body);
      setBuyerPrivate(res);
      res.status(201).json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);

publicWholesaleRouter.get('/wholesale/status', optionalAuthenticate, async (req, res, next) => {
  try {
    const userId = requireCustomer(req);
    const storeId = await getStoreIdFromRequest(req);
    const out = await WholesaleApplicationService.status(storeId, userId);
    setBuyerPrivate(res);
    res.json({ success: true, data: out });
  } catch (e) {
    next(e);
  }
});

const guard = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];
const base = '/:storeId/wholesale-applications';
const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'revoked']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(),
});
const approveSchema = z.object({ groupId: z.string().uuid() }).strict();
const noteSchema = z.object({ note: z.string().trim().max(500).nullish() }).strict();

merchantWholesaleRouter.get(
  base,
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = listSchema.parse(req.query);
      res.json({
        success: true,
        data: await WholesaleApplicationService.list(req.params.storeId, q),
      });
    } catch (e) {
      next(e);
    }
  }
);

merchantWholesaleRouter.post(
  `${base}/:id/approve`,
  ...guard,
  requireFeature('b2b.wholesale'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId } = approveSchema.parse(req.body);
      const application = await WholesaleApplicationService.approve(
        req.params.storeId,
        req.params.id,
        groupId,
        getAuthUser(req).userId
      );
      res.json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);

merchantWholesaleRouter.post(
  `${base}/:id/reject`,
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { note } = noteSchema.parse(req.body ?? {});
      const application = await WholesaleApplicationService.reject(
        req.params.storeId,
        req.params.id,
        note ?? null,
        getAuthUser(req).userId
      );
      res.json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);

merchantWholesaleRouter.post(
  `${base}/:id/revoke`,
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { note } = noteSchema.parse(req.body ?? {});
      const application = await WholesaleApplicationService.revoke(
        req.params.storeId,
        req.params.id,
        note ?? null,
        getAuthUser(req).userId
      );
      res.json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);
