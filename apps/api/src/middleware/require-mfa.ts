import { Request, Response, NextFunction } from 'express';
import { withUser } from '@ebda/database';
import { AppError } from './error-handler';
import { getAccountState } from '../lib/identity-client';
import { platformFamilyOnD1 } from '../services/platform/cutover';

/**
 * Enforce MFA enrollment for super_admin users.
 *
 * - Non-super_admin roles (store_admin, customer, …) pass through immediately —
 *   MFA is opt-in for them, not enforced.
 * - For super_admin, reads mfaEnabled from DB. If not enrolled, returns
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
    // NEON-ZERO (Ruling NZ-C-2): once the `access` family is on D1 the MFA state is the identity service's (the account is
    // credential-managed there: Rulings ID-1/ID-2); the Postgres `users.mfa_enabled` is a stale mirror. An unknown account or
    // an unreachable identity service blocks (never "enrolled"). Cost if wrong: a super_admin whose identity record lacks
    // `mfaEnabled` is sent to enrollment instead of being let in.
    if (await platformFamilyOnD1('access')) {
      const st = await getAccountState(req.user.userId);
      if (!st?.mfaEnabled) {
        return next(
          new AppError(403, 'MFA_SETUP_REQUIRED', 'Super-admin must enable two-factor auth')
        );
      }
      return next();
    }
    // `users` is RLS-scoped to the user itself: read as them.
    const u = await withUser(req.user.userId, tx =>
      tx.user.findUnique({
        where: { id: req.user!.userId },
        select: { mfaEnabled: true },
      })
    );

    if (!u?.mfaEnabled) {
      return next(
        new AppError(403, 'MFA_SETUP_REQUIRED', 'Super-admin must enable two-factor auth')
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}
