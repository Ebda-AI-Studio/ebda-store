import { Request, Response, NextFunction } from 'express';
import { withUser } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { getAccountState } from '../lib/identity-client';
import { AppError } from './error-handler';
import { onAccessD1 } from '../services/platform/access-d1';

/**
 * Gate for actions a self-serve merchant may only take after proving they own
 * the address (creating a store, going live). Reads the flag from the DB on
 * every call, never from the JWT, so a freshly verified user is unblocked
 * without re-login and a stale token can never carry a stale "verified".
 * Super admins (platform staff) are exempt.
 */
export async function assertVerifiedEmail(user: { userId: string; role: string }): Promise<void> {
  if (user.role === 'super_admin') return;
  // The account (and its verified flag) lives in the identity service wherever it is bound (NEON-ZERO identity) or once the
  // `access` family is on D1; otherwise the RLS-scoped Postgres read as that user. A deleted account has no state record and
  // an inactive / suspended one is treated as gone: both refuse exactly as the Postgres read does.
  const row =
    cfBindings()?.ACCOUNTS || (await onAccessD1())
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
}

export async function requireVerifiedEmail(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    await assertVerifiedEmail(user);
    next();
  } catch (error) {
    next(error);
  }
}
