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

/** How recent the interactive login behind a session must be for a credential-class change (TEN-4). */
export const STEP_UP_MAX_AGE_SECONDS = 30 * 60;

/**
 * TEN-4: a real step-up for credential-class changes (minting keys, staff and provider credentials).
 *
 * `requireMfaEnrolled` only ever bites a super_admin, so a stolen merchant session (cookie, XSS, an unattended laptop) could
 * mint a durable key or add staff with nothing more than the 30-day session. This gate asks for the one thing the identity
 * service already stamps on every token: `auth_time`, the instant of the interactive login (password + the second factor when
 * the account has one) behind the session. Older than {@link STEP_UP_MAX_AGE_SECONDS}, or absent, = 403 STEP_UP_REQUIRED, and
 * the client sends the user through the identity service's sign-in again, which mints a fresh session. 403 and not 401 on
 * purpose: a 401 would make clients try a refresh, which keeps the SAME auth_time and would loop.
 * Not a TOTP prompt per action (that needs an accounts-side endpoint and a UI): a fresh login already includes the factor.
 * Mount AFTER `authenticate`. Tokens that are not identity-service tokens carry no auth_time and are refused (fail closed).
 */
export function requireRecentLogin(req: Request, _res: Response, next: NextFunction): void {
  const authTime = (req as Request & { accountsAuthTime?: number }).accountsAuthTime;
  const age = authTime ? Date.now() / 1000 - authTime : Infinity;
  if (age > STEP_UP_MAX_AGE_SECONDS) {
    return next(
      new AppError(403, 'STEP_UP_REQUIRED', 'Sign in again to confirm this change', {
        stepUp: true,
      })
    );
  }
  next();
}
