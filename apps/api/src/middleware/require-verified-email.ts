import { Request, Response, NextFunction } from 'express';
import { withUser } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { getAccountState } from '../lib/identity-client';
import { AppError } from './error-handler';

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
    // As that user: `users` is RLS-scoped to app.current_user_id.
    // With the identity service bound the account (and its verified flag) lives there, not in Postgres (NEON-ZERO identity).
    // A deleted account has no state record, so "no row" refuses exactly as the Postgres read does.
    const row = cfBindings()?.ACCOUNTS
      ? await getAccountState(user.userId).then(a =>
          a ? { emailVerified: a.emailVerified, deletedAt: null } : null
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
