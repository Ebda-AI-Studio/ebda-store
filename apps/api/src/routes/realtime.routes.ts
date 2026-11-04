/**
 * Authority for the StoreRealtime Durable Object (cf/store-realtime.ts).
 *
 * A Durable Object cannot reach Postgres, and re-implementing token validation in it
 * would fork the revocation rules. So the DO asks the API: it forwards the connecting
 * socket's token (Authorization bearer, or the upgrade request's cookie) to these two
 * endpoints and trusts the answer. They run the SAME `authenticate` middleware as every
 * other route: signature, issuer / audience, `purpose`, the jti denylist and the token
 * version. This is also why a token revoked after connecting is refused on its next
 * `subscribe:store`.
 *
 * On Node (socket.io) these routes are unused; socket.service.ts authenticates in its
 * own handshake middleware.
 */
import { Router, Request, Response } from 'express';
import { withUser } from '@ebda/database';
import { authenticate } from '../middleware/auth';
import { getAuthUser } from '../utils/store-helpers';
import { currentImpersonator } from '../lib/impersonation-context';

const router = Router();

// GET /api/v1/realtime/session -> who the token is
router.get('/session', authenticate, (req: Request, res: Response) => {
  const u = getAuthUser(req);
  // `impersonatedBy`: the token holder's own session fact; it also lets the workerd test prove the impersonation scope
  // (AsyncLocalStorage.run) survives `authenticate` on Workers (workers-test/impersonation.test.ts).
  res.json({
    success: true,
    data: {
      userId: u.userId,
      email: u.email,
      role: u.role,
      impersonatedBy: currentImpersonator() ?? null,
    },
  });
});

// GET /api/v1/realtime/stores/:storeId/access -> may this token subscribe to the store's room?
// Same rule as the socket.io handler: store_admin only for a store they own, super_admin any.
router.get('/stores/:storeId/access', authenticate, async (req: Request, res: Response) => {
  const u = getAuthUser(req);
  const { storeId } = req.params;
  if (u.role !== 'store_admin' && u.role !== 'super_admin') {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    });
    return;
  }
  if (u.role === 'store_admin') {
    // `stores` is under RLS: read AS the user (owner match), not contextless.
    const store = await withUser(u.userId, tx =>
      tx.store.findFirst({
        where: { id: storeId, ownerId: u.userId },
        select: { id: true },
      })
    );
    if (!store) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this store' },
      });
      return;
    }
  }
  res.json({ success: true, data: { storeId } });
});

export default router;
