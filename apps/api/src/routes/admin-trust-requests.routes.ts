import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { auditLog } from '../middleware/security';
import { asOperator } from '../lib/platform-scope';
import { parseInput } from '../lib/parse-input';
import {
  TRUST_KINDS,
  TRUST_STATUSES,
  decideTrustRequest,
  getTrustRequest,
  listTrustRequests,
  type ReviewDb,
  type TrustDecision,
} from '../services/trust-requests.service';

/**
 * Super-admin review of every trust / support request (A13, A14, A16), mounted at /admin:
 *    GET  /admin/trust-requests               list (filter kind, status, storeId, created from/to; cursor)
 *    GET  /admin/trust-requests/:id           one request
 *    POST /admin/trust-requests/:id/resolve   staff acted on it
 *    POST /admin/trust-requests/:id/reject    staff declined it (starts the appeal cooldown for an appeal)
 * authenticate -> MFA enrolled -> super_admin on every route; each decision writes an audit row. A merchant has no
 * route here and none that decides anything.
 */
const router = Router();
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];
const db = () => prisma as unknown as ReviewDb;

const listQuery = z.object({
  kind: z.enum(TRUST_KINDS).optional(),
  status: z.enum(TRUST_STATUSES).optional(),
  storeId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const idParam = z.string().uuid();

router.get(
  '/trust-requests',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filter = parseInput(listQuery, req.query);
      const data = await asOperator(req.user!.userId, () => listTrustRequests(db(), filter));
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/trust-requests/:id',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInput(idParam, req.params.id);
      const row = await asOperator(req.user!.userId, () => getTrustRequest(db(), id));
      res.json({ success: true, data: { request: row } });
    } catch (error) {
      next(error);
    }
  }
);

const DECISIONS: Array<[string, TrustDecision]> = [
  ['resolve', 'resolved'],
  ['reject', 'rejected'],
];
for (const [action, decision] of DECISIONS) {
  router.post(
    `/trust-requests/:id/${action}`,
    ...superAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = parseInput(idParam, req.params.id);
        const done = await asOperator(req.user!.userId, () =>
          decideTrustRequest(db(), id, decision)
        );
        await auditLog({
          action: `trust_request.${action}`,
          userId: req.user!.userId,
          ...(done.storeId ? { storeId: done.storeId } : {}),
          resourceType: 'trust_request',
          resourceId: id,
          details: { kind: done.kind, status: done.status },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        res.json({ success: true, data: done });
      } catch (error) {
        next(error);
      }
    }
  );
}

export default router;
