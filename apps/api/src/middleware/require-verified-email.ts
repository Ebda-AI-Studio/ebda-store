import { Request, Response, NextFunction } from 'express';
import { withUser } from '@ebda/database';
import { AppError } from './error-handler';
import { getAccountState } from '../lib/identity-client';
import { onAccessD1 } from '../services/platform/access-d1';

/**
 * Gate for actions a self-serve merchant may only take after proving they own
 * the address (creating a store, going live). Reads the flag from the DB on
 * every call, never from the JWT, so a freshly verified user is unblocked
 * without re-login and a stale token can never carry a stale "verified".
 * Super admins (platform staff) are exempt.
 */
export async function requireVerifiedEmail(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    if (user.role === 'super_admin') return next();
    // After the `access` cutover the account (and its verified flag) lives in the identity service; before it, the
    // RLS-scoped Postgres read.
    const row = (await onAccessD1())
      ? await getAccountState(user.userId).then(a =>
          a
            ? {
                emailVerified: a.emailVerified,
                deletedAt: a.status === 'active' ? null : new Date(),
              }
            : null
        )
      : await withUser(user.userId, tx =>
          tx.user.findUnique({
            where: { id: user.userId },
            select: { emailVerified: true, deletedAt: true },
          })
        );
    if (!row || row.deletedAt || !row.emailVerified) {
      throw new AppError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before creating or publishing a store'
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}
