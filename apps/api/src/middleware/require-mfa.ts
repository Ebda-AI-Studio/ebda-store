import { Request, Response, NextFunction } from 'express';
import { withUser } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { getAccountState } from '../lib/identity-client';
import { AppError } from './error-handler';
import { liveIdentityMemo } from './auth';

/**
 * Enforce MFA enrollment for super_admin users.
 *
 * - Non-super_admin roles (store_admin, customer, …) pass through immediately —
 *   MFA is opt-in for them, not enforced.
 * - For super_admin, reads mfaEnabled from the IDENTITY SERVICE (the authority for accounts, Rulings ID-1/ID-2: the live
 *   answer `authenticate` already fetched this request, else one RPC); only a deployment with no identity binding (Node,
 *   local dev) reads the Postgres `users` row. A Worker with Postgres gone never opens a transaction here.
 *   If not enrolled, returns
 *   403 MFA_SETUP_REQUIRED so the client can redirect to the enrollment page.
 *
 * Placement: mount AFTER `authenticate` (so req.user is populated) on
 * protected admin routers. Do NOT mount on /auth/* or /auth/mfa/* — those are
 * the routes a not-yet-enrolled super_admin must reach to enroll.
 */
export async function requireMfaEnrolled(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  // Only enforce for super_admin; all other roles skip through.
  if (req.user?.role !== 'super_admin') {
    return next();
  }

  try {
    const userId = req.user.userId;
    let mfaEnabled: boolean | undefined;
    const known = liveIdentityMemo(req).value?.account;
    if (known) mfaEnabled = known.mfaEnabled;
    else if (cfBindings()?.ACCOUNTS) mfaEnabled = (await getAccountState(userId))?.mfaEnabled;
    else {
      // `users` is RLS-scoped to the user itself: read as them.
      const u = await withUser(userId, tx =>
        tx.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true } })
      );
      mfaEnabled = u?.mfaEnabled;
    }

    if (!mfaEnabled) {
      return next(
        new AppError(403, 'MFA_SETUP_REQUIRED', 'Super-admin must enable two-factor auth')
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}
