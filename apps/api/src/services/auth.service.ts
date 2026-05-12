import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '@force/database';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { accountLockout } from './account-lockout.service';
import logger from '../lib/logger';

interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  /** Tenant scope for customer accounts; NULL for platform admins. */
  storeId: string | null;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Resolve the auth scope for a user lookup. Customers register/login under a
 * specific store and the schema's `@@unique([storeId, email])` constraint
 * keeps them isolated; admins (storeId NULL) live in a global namespace
 * enforced by the partial unique index `users_admin_email_key`.
 */
function authScope(email: string, storeId: string | null) {
  return storeId === null ? { email, storeId: null as null } : { email, storeId };
}

export class AuthService {
  private static readonly SALT_ROUNDS = 12;

  /**
   * Pre-computed bcrypt hash of a value no caller can ever provide
   * (32 random bytes generated once at boot). Used to equalize the
   * login response time when the user record doesn't exist — without
   * this dummy compare, "no user" returns ~50ms faster than "user
   * exists, password wrong" and an attacker can enumerate registered
   * emails by timing the response. The hash itself is irrelevant
   * (compare always fails); we only care that the caller waits the
   * same wall-clock time as the happy path.
   */
  private static readonly DUMMY_PASSWORD_HASH: string = bcrypt.hashSync(
    crypto.randomBytes(32).toString('hex'),
    12
  );

  static async register(data: {
    email: string;
    password: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    /**
     * Storefront passes the current tenant's storeId. Admin app passes
     * `null`. Mixing the two scopes deliberately so a registration from
     * Store A doesn't conflict with an existing global admin email.
     */
    storeId?: string | null;
  }) {
    const storeId = data.storeId ?? null;

    // Check if user exists in the target scope. Customers in different
    // stores can share an email — the lookup must use the composite key.
    const existingUser = await prisma.user.findFirst({
      where: authScope(data.email, storeId),
      select: { id: true, email: true, firstName: true, lastName: true, storeId: true },
    });

    // Parse name into first/last if provided
    let firstName = data.firstName;
    let lastName = data.lastName;
    if (data.name && !firstName) {
      const nameParts = data.name.trim().split(' ');
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ') || '';
    }

    // Always hash, even for the existing-user branch. Bcrypt is the
    // expensive part of register; skipping it makes the existing-user
    // path measurably faster and lets an attacker enumerate registered
    // emails by stopwatch.
    const passwordHash = await bcrypt.hash(data.password, this.SALT_ROUNDS);

    // T1-4 enumeration close. Both branches return the IDENTICAL
    // response shape `{ emailVerificationSent: true }` with NO tokens.
    //   - new email: create user, send verification email (links to a
    //     verify endpoint that grants tokens after email is verified)
    //   - existing email: send a "registration attempt" notice to the
    //     rightful owner (no clickable tokens in the email — if it
    //     wasn't them, worst case is they reset their password)
    // The only side-channel left is the wall-clock cost of
    // `prisma.user.create` vs `EmailService.send` — both involve
    // network IO so the variance is dominated by SMTP latency, not
    // the existence check.
    if (existingUser) {
      const storeName = existingUser.storeId
        ? (
            await prisma.store
              .findUnique({
                where: { id: existingUser.storeId },
                select: { name: true },
              })
              .catch(() => null)
          )?.name
        : undefined;
      const recipientName =
        `${existingUser.firstName ?? ''} ${existingUser.lastName ?? ''}`.trim() ||
        existingUser.email;
      void EmailService.sendDuplicateRegistrationNotice(storeId ?? existingUser.storeId ?? '', {
        email: existingUser.email,
        name: recipientName,
        storeName: storeName ?? undefined,
      }).catch(err =>
        logger.error(
          { err, email: existingUser.email },
          'Failed to send duplicate-registration notice'
        )
      );
      return { emailVerificationSent: true } as const;
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        email: data.email,
        storeId,
        passwordHash,
        firstName: firstName || '',
        lastName: lastName || '',
        role: 'customer',
        emailVerified: false,
      },
      select: {
        id: true,
        email: true,
        storeId: true,
        firstName: true,
        lastName: true,
        role: true,
        emailVerified: true,
        createdAt: true,
      },
    });

    // Verification email goes out fire-and-forget so a slow / unreachable
    // SMTP host can't stall the registration response. If delivery fails
    // the customer can request a resend via /auth/resend-verification.
    void this.sendVerificationEmail(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim() || user.email,
      storeId
    ).catch(err =>
      logger.error({ err, userId: user.id }, 'Failed to send verification email after register')
    );

    return { emailVerificationSent: true } as const;
  }

  /**
   * Create and send email verification token
   */
  static async sendVerificationEmail(
    userId: string,
    email: string,
    name: string,
    storeId: string | null = null
  ): Promise<void> {
    // Delete any existing verification tokens for this user
    await prisma.verificationToken.deleteMany({
      where: {
        userId,
        type: 'email',
      },
    });

    // Generate verification token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Store verification token
    await prisma.verificationToken.create({
      data: {
        token: tokenHash,
        userId,
        type: 'email',
        expiresAt,
      },
    });

    // Send verification email
    const verificationUrl = `${config.webUrl}/auth/verify-email?token=${token}`;
    if (storeId) {
      await EmailService.sendEmailVerification(storeId, {
        email,
        name,
        verificationUrl,
        expiresIn: '24 hours',
      });
    } else {
      // Admin accounts (no storeId) skip the branded email path — they
      // don't belong to a store and verification flow is admin-only.
      logger.info(
        { userId, email },
        'Skipping branded verification email — no storeId (admin account)'
      );
    }
  }

  /**
   * Verify email with token
   */
  static async verifyEmail(token: string): Promise<{ success: boolean; message: string }> {
    // Hash the provided token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find the verification token
    const verificationToken = await prisma.verificationToken.findFirst({
      where: {
        token: tokenHash,
        type: 'email',
        usedAt: null,
      },
      include: { user: true },
    });

    if (!verificationToken) {
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid verification token');
    }

    if (verificationToken.expiresAt < new Date()) {
      // Delete expired token
      await prisma.verificationToken.delete({
        where: { id: verificationToken.id },
      });
      throw new AppError(
        400,
        'TOKEN_EXPIRED',
        'Verification token has expired. Please request a new one.'
      );
    }

    if (verificationToken.user.emailVerified) {
      return { success: true, message: 'Email already verified' };
    }

    // Update user as verified and mark token as used
    await prisma.$transaction([
      prisma.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerified: true },
      }),
      prisma.verificationToken.update({
        where: { id: verificationToken.id },
        data: { usedAt: new Date() },
      }),
    ]);

    // Welcome email is a follow-up — fire-and-forget so SMTP latency can't
    // delay the verify-email API response.
    if (verificationToken.user.storeId) {
      void EmailService.sendWelcome(verificationToken.user.storeId, {
        email: verificationToken.user.email,
        name:
          `${verificationToken.user.firstName} ${verificationToken.user.lastName}`.trim() ||
          verificationToken.user.email,
      }).catch(err =>
        logger.error(
          { err, userId: verificationToken.userId },
          'Failed to send welcome email after verify'
        )
      );
    }

    return { success: true, message: 'Email verified successfully' };
  }

  /**
   * Resend verification email. Storefront callers pass `storeId` so we
   * find the right tenant's account; admin app omits it.
   */
  static async resendVerificationEmail(
    email: string,
    storeId: string | null = null
  ): Promise<{ success: boolean; message: string }> {
    const user = await prisma.user.findFirst({
      where: authScope(email, storeId),
    });

    if (!user) {
      // Don't reveal if user exists
      return {
        success: true,
        message: 'If an account exists with this email, a verification link has been sent.',
      };
    }

    if (user.emailVerified) {
      return { success: true, message: 'Email is already verified' };
    }

    // Check if there's a recent verification token (within last 2 minutes) to prevent spam
    const recentToken = await prisma.verificationToken.findFirst({
      where: {
        userId: user.id,
        type: 'email',
        createdAt: { gt: new Date(Date.now() - 2 * 60 * 1000) },
      },
    });

    if (recentToken) {
      throw new AppError(
        429,
        'TOO_MANY_REQUESTS',
        'Please wait a few minutes before requesting another verification email'
      );
    }

    // Send new verification email
    await this.sendVerificationEmail(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim() || user.email
    );

    return { success: true, message: 'Verification email sent' };
  }

  static async login(email: string, password: string, ip?: string, storeId: string | null = null) {
    // Lockout key is scoped per tenant so a brute-force attempt against
    // Store A doesn't lock the same email out on Store B (or on the admin
    // app). Bare email is still used for admin (storeId NULL).
    const lockoutKey = storeId ? `${storeId}:${email}` : email;
    const lockStatus = await accountLockout.isLocked(lockoutKey);
    if (lockStatus.locked) {
      const remainingMinutes = Math.ceil((lockStatus.remainingMs || 0) / 60000);
      throw new AppError(
        429,
        'ACCOUNT_LOCKED',
        `Account is temporarily locked due to too many failed attempts. Please try again in ${remainingMinutes} minutes.`
      );
    }

    // Find user inside the requested scope (exclude soft-deleted).
    const user = await prisma.user.findFirst({
      where: { ...authScope(email, storeId), deletedAt: null },
    });

    if (!user) {
      // Run a dummy bcrypt.compare so the response time matches the
      // "user exists, wrong password" path. Skipping it here was
      // previously a ~50ms timing oracle that let an attacker
      // enumerate registered emails by stopwatch.
      await bcrypt.compare(password, this.DUMMY_PASSWORD_HASH);
      await accountLockout.recordFailedAttempt(lockoutKey, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      const result = await accountLockout.recordFailedAttempt(lockoutKey, ip);

      if (result.locked) {
        const remainingMinutes = Math.ceil((result.lockoutDurationMs || 0) / 60000);
        throw new AppError(
          429,
          'ACCOUNT_LOCKED',
          `Account has been locked due to too many failed attempts. Please try again in ${remainingMinutes} minutes.`
        );
      }

      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Successful login - reset lockout
    await accountLockout.recordSuccessfulLogin(lockoutKey, ip);

    // Generate tokens
    const tokens = await this.generateTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        storeId: user.storeId,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        emailVerified: user.emailVerified,
      },
      ...tokens,
    };
  }

  static async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    // Hash the token to look it up
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    });

    if (!storedToken) {
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');
    }

    // Reuse detection (OWASP refresh-token rotation guidance): once a
    // refresh token has been rotated or revoked, any subsequent
    // presentation is treated as evidence the family is compromised.
    // Revoke every token for that user — the legitimate session(s) get
    // a 401 on their next refresh and re-login, which is preferable to
    // letting an attacker keep refreshing in parallel.
    if (storedToken.revokedAt) {
      logger.warn(
        {
          userId: storedToken.userId,
          tokenId: storedToken.id,
          revokedAt: storedToken.revokedAt,
          revokedReason: storedToken.revokedReason,
        },
        'Refresh-token reuse detected — revoking all tokens for user'
      );
      await prisma.refreshToken.updateMany({
        where: { userId: storedToken.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'reuse_detected' },
      });
      throw new AppError(401, 'TOKEN_REUSED', 'Token reuse detected — please sign in again');
    }

    if (storedToken.expiresAt < new Date()) {
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date(), revokedReason: 'expired' },
      });
      throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token expired');
    }

    // Reject refresh if user has been soft-deleted
    if (storedToken.user.deletedAt) {
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date(), revokedReason: 'account_deleted' },
      });
      throw new AppError(401, 'ACCOUNT_DELETED', 'Account has been deleted');
    }

    // Generate new tokens FIRST so we have the new id available for the
    // back-link. Then mark the old token as rotated. Order matters: if
    // generateTokens fails after we've already revoked the old token,
    // the user is logged out without a replacement.
    const newTokens = await this.generateTokens({
      userId: storedToken.user.id,
      email: storedToken.user.email,
      role: storedToken.user.role,
      storeId: storedToken.user.storeId,
    });

    const newHash = crypto.createHash('sha256').update(newTokens.refreshToken).digest('hex');
    const newRow = await prisma.refreshToken.findUnique({
      where: { token: newHash },
      select: { id: true },
    });

    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: {
        revokedAt: new Date(),
        revokedReason: 'rotated',
        replacedById: newRow?.id ?? null,
      },
    });

    return newTokens;
  }

  /**
   * Periodic cleanup of refresh-token rows we no longer need. Two
   * categories are removed:
   *
   *   - Expired rows (`expiresAt < now`). The JWT itself is already
   *     dead; keeping the row only matters for reuse detection, and
   *     a 1-year-old expired token offers nothing actionable.
   *   - Revoked rows older than 30 days (`revokedAt < now - 30d`).
   *     Reuse detection only needs to fire while an attacker could
   *     plausibly still be holding a stolen token; a 30-day window
   *     is the same TTL most production OWASP-style implementations
   *     use, and bounds the table size in steady state.
   *
   * Returns the number of rows deleted (sum of both branches).
   */
  static async cleanupRefreshTokens(): Promise<number> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const expired = await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const revoked = await prisma.refreshToken.deleteMany({
      where: { revokedAt: { lt: thirtyDaysAgo } },
    });

    const total = expired.count + revoked.count;
    if (total > 0) {
      logger.info(
        { expired: expired.count, revoked: revoked.count },
        'Refresh-token cleanup removed stale rows'
      );
    }
    return total;
  }

  static async logout(refreshToken: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    // Mark instead of delete so a stolen copy of the same token replayed
    // after logout still triggers the reuse-detection path in
    // refreshTokens() instead of returning a generic TOKEN_INVALID.
    await prisma.refreshToken.updateMany({
      where: { token: tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
  }

  static async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        avatar: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    return user;
  }

  static async updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; phone?: string }
  ) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.phone !== undefined && { phone: data.phone }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        avatar: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return updated;
  }

  static async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    // Revoke (don't delete) so a replay of any of these tokens still
    // hits the reuse-detection branch in refreshTokens(). Limit to
    // session tokens — the special `reset:` rows used by password-reset
    // are short-lived and live in the same table.
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, NOT: { token: { startsWith: 'reset:' } } },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    });
  }

  static async requestPasswordReset(email: string, storeId: string | null = null): Promise<void> {
    // Tenant-scoped lookup so a Store A reset request doesn't leak the
    // existence of an account on Store B with the same email.
    const user = await prisma.user.findFirst({
      where: authScope(email, storeId),
    });

    if (!user) {
      // Silently return to prevent email enumeration
      return;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store reset token as a special refresh token
    await prisma.refreshToken.create({
      data: {
        token: `reset:${resetTokenHash}`,
        userId: user.id,
        expiresAt: resetExpires,
      },
    });

    // Send reset email
    const resetUrl = `${config.webUrl}/auth/reset-password?token=${resetToken}`;
    if (user.storeId) {
      await EmailService.sendPasswordReset(user.storeId, {
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim() || user.email,
        resetUrl,
        expiresIn: '1 hour',
      });
    } else {
      // Admin password-reset: no store context, skip branded email.
      logger.info({ userId: user.id }, 'Skipping branded password-reset email — admin account');
    }
  }

  static async resetPassword(token: string, newPassword: string): Promise<void> {
    // Hash the provided token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find the reset token
    const storedToken = await prisma.refreshToken.findFirst({
      where: {
        token: `reset:${tokenHash}`,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!storedToken) {
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid or expired reset token');
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

    // Update user password
    await prisma.user.update({
      where: { id: storedToken.userId },
      data: { passwordHash },
    });

    // Delete the reset token (single-use, no reuse-detection value).
    await prisma.refreshToken.delete({
      where: { id: storedToken.id },
    });

    // Revoke all session refresh tokens — same rationale as
    // changePassword. The reset-token row was already deleted above.
    await prisma.refreshToken.updateMany({
      where: {
        userId: storedToken.userId,
        revokedAt: null,
        NOT: { token: { startsWith: 'reset:' } },
      },
      data: { revokedAt: new Date(), revokedReason: 'password_reset' },
    });
  }

  private static async generateTokens(payload: TokenPayload): Promise<AuthTokens> {
    // Generate access token
    const accessToken = jwt.sign(payload, config.jwtSecret, {
      algorithm: 'HS256',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: config.jwtExpiresIn as any,
      issuer: 'force-api',
      audience: 'force-app',
      subject: payload.userId,
    });

    // Generate refresh token. Long-lived (1 year) so the admin PWA on
    // a phone keeps the user signed in between order pings — they can
    // tap a push notification weeks later and still land authenticated.
    // The token is single-use server-side: each refresh issues a new
    // hash and invalidates the old one (see auth.service rotation).
    const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, config.jwtSecret, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: config.refreshTokenExpiresIn as any,
      algorithm: 'HS256',
      issuer: 'force-api',
      audience: 'force-app',
      subject: payload.userId,
    });

    // Store hashed refresh token in database. The DB row expiry must
    // match the JWT's own `exp` claim or rotation breaks early — 1 year
    // mirrors the JWT lifetime above. Cleanup of expired rows happens
    // via the periodic refresh-token cleanup job.
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);

    await prisma.refreshToken.create({
      data: {
        token: tokenHash,
        userId: payload.userId,
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }
}
