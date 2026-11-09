/**
 * Storefront customer auth flows served by the store's StoreDO (NEON-ZERO-1 N-9, Ruling NZ-A3). `AuthService` dispatches here
 * for a DO store whose `customer_auth_cutover` marker is on (lib/customer-auth.ts); everything else stays on Postgres.
 *
 * Secrets: a password hash never leaves the DO (login / verify / change run the bcrypt compare THERE); refresh and one-time
 * tokens are stored as sha256 only; this file hashes a NEW password (CPU work stays out of the single-threaded DO) and hands
 * the hash in.
 */
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { PASSWORD_RESET_TTL_MINUTES } from '@ebda/shared';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { cfWaitUntil } from '../cf/bindings';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { mintScopedToken, sha256, type CustomerAuthClient } from '../lib/customer-auth';
import { EmailService } from './email.service';
import { loginGate } from './login-gate';
import { signAccessToken, signRefreshToken, REFRESH_ROW_DAYS } from './session-tokens';
import { storeDb } from '../lib/repo-factory';

const SALT_ROUNDS = 12;
/** bcrypt of 32 random bytes whose plaintext was discarded: compared when the account is unknown (same constant as auth.service). */
const DUMMY_PASSWORD_HASH = '$2b$12$OW.xBchkmJbVjXDhBSQ6ke4cdbV/iuOcgjbbGK9ZslpcF5fkkynha';
const EMAIL_VERIFICATION_EXPIRY_HOURS = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const lang = (l: unknown): 'en' | 'ar' | undefined => (l === 'ar' || l === 'en' ? l : undefined);

/** What the DO returns for an account (no secrets; dates are epoch ms). */
export interface DoCustomer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: 'customer';
  status: string;
  emailVerified: boolean;
  avatar: string | null;
  language: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  mfaEnabled: boolean;
  mfaEnrolledAt: number | null;
  tokenVersion: number;
}

const rid = () => crypto.randomUUID();

/**
 * Ruling NZ-N9-1: TOTP is not ported to the StoreDO, so an account with it ON is refused everywhere a second factor would
 * be needed (login, passkey step-up / enrol / sign-in). A password reset does NOT clear MFA (by design), so the copy says to ask
 * the store, whose owner clears it, rather than to reset the password.
 */
export const mfaUnavailable = () =>
  new AppError(
    409,
    'MFA_UNAVAILABLE',
    'Two-factor sign-in is not available for this account on this store yet. Ask the store to turn it off for you, then sign in again.',
    {
      messageEn:
        'Two-factor sign-in is not available for this account on this store yet. Ask the store to turn it off for you, then sign in again.',
      messageAr:
        'التحقق بخطوتين لسه مش متاح لحسابك في المتجر ده. اطلب من المتجر يقفله ليك وبعدها سجّل دخولك تاني.',
    }
  );

async function sendVerification(
  c: CustomerAuthClient,
  token: string,
  u: { email: string; firstName: string; lastName: string; language?: string }
): Promise<void> {
  await EmailService.sendEmailVerification(
    c.storeId,
    {
      email: u.email,
      name: `${u.firstName} ${u.lastName}`.trim() || u.email,
      verificationUrl: `${config.webUrl}/auth/verify-email?token=${token}`,
      expiresInHours: EMAIL_VERIFICATION_EXPIRY_HOURS,
    },
    lang(u.language)
  );
}

export const CustomerAuthFlows = {
  async register(
    c: CustomerAuthClient,
    d: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      language?: 'en' | 'ar';
    }
  ): Promise<{ emailVerificationSent: true }> {
    // Always hash, even when the account exists: skipping it would make the existing-email path measurably faster.
    const passwordHash = await bcrypt.hash(d.password, SALT_ROUNDS);
    const t = mintScopedToken(c.storeId);
    const r = await c.call<
      | { created: true; user: DoCustomer }
      | {
          created: false;
          existing: { email: string; firstName: string; lastName: string; language: string };
        }
    >('register', {
      id: rid(),
      email: d.email,
      passwordHash,
      firstName: d.firstName,
      lastName: d.lastName,
      language: d.language,
      verification: {
        tokenHash: t.hash,
        expiresAt: Date.now() + EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000,
        rowId: rid(),
      },
    });
    if (r.created) {
      cfWaitUntil(
        sendVerification(c, t.token, r.user).catch(err =>
          logger.error(
            { err, userId: r.user.id },
            'Failed to send verification email after register'
          )
        )
      );
    } else {
      const storeName = (
        await storeDb(c.storeId)
          .then(db => db.store.findUnique({ where: { id: c.storeId }, select: { name: true } }))
          .catch(() => null)
      )?.name;
      const ex = r.existing;
      void deferAfterTenantCommit('customer-auth.duplicate-registration-notice', () =>
        EmailService.sendDuplicateRegistrationNotice(
          c.storeId,
          {
            email: ex.email,
            name: `${ex.firstName} ${ex.lastName}`.trim() || ex.email,
            storeName: storeName ?? undefined,
          },
          lang(ex.language)
        )
      ).catch(err =>
        logger.error(
          { err, email: maskEmail(ex.email) },
          'Failed to send duplicate-registration notice'
        )
      );
    }
    return { emailVerificationSent: true };
  },

  async verifyEmail(c: CustomerAuthClient, token: string) {
    const r = await c.call<{
      already: boolean;
      user: { id: string; email: string; firstName: string; lastName: string; language: string };
    }>('verifyEmail', { tokenHash: sha256(token) });
    if (r.already) return { success: true, message: 'Email already verified' };
    void deferAfterTenantCommit('customer-auth.welcome-after-verify', () =>
      EmailService.sendWelcome(
        c.storeId,
        {
          email: r.user.email,
          name: `${r.user.firstName} ${r.user.lastName}`.trim() || r.user.email,
        },
        lang(r.user.language)
      )
    ).catch(err =>
      logger.error({ err, userId: r.user.id }, 'Failed to send welcome email after verify')
    );
    return { success: true, message: 'Email verified successfully' };
  },

  async resend(
    c: CustomerAuthClient,
    email: string
  ): Promise<{ success: boolean; message: string }> {
    const t = mintScopedToken(c.storeId);
    const r = await c.call<
      | { kind: 'none' }
      | { kind: 'verified' }
      | { kind: 'recent' }
      | {
          kind: 'issued';
          user: {
            id: string;
            email: string;
            firstName: string;
            lastName: string;
            language: string;
          };
        }
    >('resendVerification', {
      email,
      tokenHash: t.hash,
      rowId: rid(),
      expiresAt: Date.now() + EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000,
    });
    if (r.kind === 'none')
      return {
        success: true,
        message: 'If an account exists with this email, a verification link has been sent.',
      };
    if (r.kind === 'verified') return { success: true, message: 'Email is already verified' };
    if (r.kind === 'recent')
      throw new AppError(
        429,
        'TOO_MANY_REQUESTS',
        'Please wait a few minutes before requesting another verification email'
      );
    await sendVerification(c, t.token, r.user);
    return { success: true, message: 'Verification email sent' };
  },

  /** Mint the refresh row in the DO and sign the pair. The DO re-checks status + token version at issue time. */
  async issueSession(c: CustomerAuthClient, user: DoCustomer) {
    const payload = {
      userId: user.id,
      email: user.email,
      role: 'customer',
      storeId: c.storeId,
      tv: user.tokenVersion,
    };
    const refreshToken = signRefreshToken(payload);
    await c.call('issueSession', {
      userId: user.id,
      expectedTv: user.tokenVersion,
      tokenHash: sha256(refreshToken),
      rowId: rid(),
      expiresAt: Date.now() + REFRESH_ROW_DAYS * DAY_MS,
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        storeId: c.storeId as string | null,
        firstName: user.firstName,
        lastName: user.lastName,
        role: 'customer',
        emailVerified: user.emailVerified,
      },
      accessToken: signAccessToken(payload),
      refreshToken,
    };
  },

  async login(c: CustomerAuthClient, email: string, password: string, ip?: string) {
    const lockoutKey = loginGate.lockoutKey(email, c.storeId);
    // The compare runs HERE, in the Worker (bcrypt cost 12 in the single-threaded store DO would let a login flood starve that
    // store's checkout / stock). Unknown account: a dummy compare keeps the timing equal. The DO re-validates the hash it handed
    // out when it stamps the success, so a reset / revoke that lands during the compare voids the login.
    // PERF-LATENCY: the lockout read (AuthState) and the credential read (StoreDO) are independent reads, made in parallel; a
    // locked account still gets its 429 BEFORE any password compare (the credential read writes nothing).
    const [, cred] = await Promise.all([
      loginGate.assertNotLocked(lockoutKey),
      c.call<{ id: string; hash: string; tokenVersion: number } | null>('credential', { email }),
    ]);
    const good = await bcrypt.compare(password, cred ? cred.hash : DUMMY_PASSWORD_HASH);
    const r: { valid: boolean; user?: DoCustomer; mfa?: boolean } =
      cred && good
        ? {
            valid: true,
            ...(await c.call<{ user: DoCustomer; mfa: boolean }>('loginSucceeded', cred)),
          }
        : { valid: false };
    if (!r.valid || !r.user) {
      const res = await loginGate.recordFailure(lockoutKey, ip);
      if (res.locked) {
        const minutes = Math.ceil((res.lockoutDurationMs || 0) / 60000);
        throw new AppError(
          429,
          'ACCOUNT_LOCKED',
          `Account has been locked due to too many failed attempts. Please try again in ${minutes} minutes.`
        );
      }
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    // PERF-LATENCY: clearing the lockout counters + logging the success (AuthState, D1) runs alongside the session issue (StoreDO)
    // instead of before it. Same outcome as the old sequence: the clear always completes (awaited on every path), the gate checks
    // below still refuse before any session is issued, and a failed issue still leaves the counters cleared.
    const cleared = loginGate.recordSuccess(lockoutKey, ip);
    const user = r.user;
    try {
      loginGate.assertActive({
        status: user.status,
        deletedAt: user.deletedAt ? new Date(user.deletedAt) : null,
      });
      // Ruling NZ-N9-1: TOTP for storefront customers is not offered by any storefront screen (no enrol UI) and is not ported.
      // An account that nevertheless has it ON is refused, never signed in without the second factor.
      if (r.mfa) throw mfaUnavailable();
    } catch (err) {
      await cleared;
      throw err;
    }
    const [, session] = await Promise.all([cleared, CustomerAuthFlows.issueSession(c, user)]);
    return session;
  },

  /** Rotate. `claims` come from the VERIFIED refresh JWT. Returns the new pair; the DO decided everything else. */
  async refresh(
    c: CustomerAuthClient,
    presented: string,
    claims: { sub?: string; userId?: string; email?: string; tv?: number }
  ) {
    const userId = claims.userId ?? claims.sub ?? '';
    // Pre-sign the new refresh token (the DO only needs its hash); the access token is signed after, with the LIVE token version.
    const pre = {
      userId,
      email: claims.email ?? '',
      role: 'customer',
      storeId: c.storeId as string | null,
      tv: claims.tv,
    };
    const refreshToken = signRefreshToken(pre);
    const r = await c.call<{ user: { id: string; email: string; tokenVersion: number } }>(
      'rotateRefresh',
      {
        presentedHash: sha256(presented),
        newHash: sha256(refreshToken),
        newRowId: rid(),
        newExpiresAt: Date.now() + REFRESH_ROW_DAYS * DAY_MS,
      }
    );
    const accessToken = signAccessToken({
      userId: r.user.id,
      email: r.user.email,
      role: 'customer',
      storeId: c.storeId,
      tv: r.user.tokenVersion,
    });
    return { accessToken, refreshToken };
  },

  async logout(c: CustomerAuthClient, presented: string): Promise<void> {
    await c.call('logout', { tokenHash: sha256(presented) });
  },

  async requestReset(c: CustomerAuthClient, email: string): Promise<{ userId: string } | null> {
    const t = mintScopedToken(c.storeId);
    const r = await c.call<{
      user: { id: string; email: string; firstName: string; lastName: string; language: string };
    } | null>('requestReset', {
      email,
      tokenHash: t.hash,
      rowId: rid(),
      expiresAt: Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
    });
    if (!r) return null;
    const u = r.user;
    cfWaitUntil(
      EmailService.sendPasswordReset(
        c.storeId,
        {
          email: u.email,
          name: `${u.firstName} ${u.lastName}`.trim() || u.email,
          resetUrl: `${config.webUrl}/auth/reset-password?token=${t.token}`,
          expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
        },
        lang(u.language)
      ).catch(err => logger.error({ err, userId: u.id }, 'password-reset mail failed'))
    );
    return { userId: u.id };
  },

  async resetPassword(c: CustomerAuthClient, token: string, newPassword: string) {
    // Hash first (slow), then claim: the DO claims the link and sets the password in ONE section.
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    return c.call<{
      userId: string;
      email: string;
      firstName: string;
      language: string;
      purgedPasskeys: number;
      tokenVersion: number;
    }>('resetPassword', {
      tokenHash: sha256(token),
      newHash,
    });
  },

  /** Compare in the Worker, then ONE DO section (new hash + passkeys gone + everything revoked) that re-checks the hash is current. */
  async changePassword(c: CustomerAuthClient, userId: string, current: string, next: string) {
    const cred = await c.call<{ id: string; hash: string } | null>('credentialById', { userId });
    if (!cred) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (!(await bcrypt.compare(current, cred.hash)))
      throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
    const newHash = await bcrypt.hash(next, SALT_ROUNDS);
    return c.call<{
      tokenVersion: number;
      purgedPasskeys: number;
      user: { id: string; email: string; firstName: string; language: string };
    }>('changePassword', { userId, expectedHash: cred.hash, newHash });
  },

  /** Verify a customer's password in the Worker (passkey step-up). The hash is read from the DO and never leaves this process. */
  async verifyPassword(c: CustomerAuthClient, userId: string, password: string): Promise<boolean> {
    const cred = await c.call<{ id: string; hash: string } | null>('credentialById', { userId });
    const ok = await bcrypt.compare(password, cred ? cred.hash : DUMMY_PASSWORD_HASH);
    return ok && !!cred;
  },

  /** Profile in the shape `GET /auth/me` returns today (Dates, not epoch ms). */
  toProfile(u: DoCustomer) {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone,
      role: u.role,
      avatar: u.avatar,
      emailVerified: u.emailVerified,
      mfaEnabled: u.mfaEnabled,
      mfaEnrolledAt: u.mfaEnrolledAt ? new Date(u.mfaEnrolledAt) : null,
      createdAt: new Date(u.createdAt),
      updatedAt: new Date(u.updatedAt),
    };
  },
};
