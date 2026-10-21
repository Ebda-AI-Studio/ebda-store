import { AppError } from '../middleware/error-handler';
import { accountLockout } from './account-lockout.service';

/**
 * The account gates every way of signing in goes through (password login AND passkey sign-in), so the
 * two cannot drift apart: one lockout counter per account, one suspended/deleted check, one key shape.
 * `tests/unit/login-gate-parity.test.ts` fails if `AuthService.login` starts using a gate here that
 * `PasskeyService.finishAuthentication` does not (Ruling PASSKEY-8).
 */
export const loginGate = {
  /**
   * Per-tenant lockout key: a brute-force attempt against Store A must not lock the same email out on
   * Store B (bare email for the admin namespace). Case-folded so re-casing the address is not a fresh
   * 5-attempt budget (Ebda SP5 review).
   */
  lockoutKey(email: string, storeId: string | null): string {
    const e = typeof email === 'string' ? email.trim().toLowerCase() : email;
    return storeId ? `${storeId}:${e}` : e;
  },

  /** Throws 429 ACCOUNT_LOCKED while the account's counter is tripped. */
  async assertNotLocked(key: string): Promise<void> {
    const status = await accountLockout.isLocked(key);
    if (status.locked) {
      const remainingMinutes = Math.ceil((status.remainingMs || 0) / 60000);
      throw new AppError(
        429,
        'ACCOUNT_LOCKED',
        `Account is temporarily locked due to too many failed attempts. Please try again in ${remainingMinutes} minutes.`
      );
    }
  },

  recordFailure(key: string, ip?: string) {
    return accountLockout.recordFailedAttempt(key, ip);
  },

  recordSuccess(key: string, ip?: string) {
    return accountLockout.recordSuccessfulLogin(key, ip);
  },

  /** Suspended, inactive or soft-deleted accounts do not get a session (S3-1, #1864). */
  assertActive(user: { status: string; deletedAt?: Date | null }): void {
    if (user.status !== 'active' || user.deletedAt) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is not active');
    }
  },
};
