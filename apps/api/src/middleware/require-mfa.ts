import { Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { AppError } from './error-handler';

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
    const u = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { mfaEnabled: true },
    });

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
