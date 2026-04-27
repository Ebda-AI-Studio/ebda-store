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
    });

    if (existingUser) {
      throw new AppError(409, 'ALREADY_EXISTS', 'User with this email already exists');
    }

    // Parse name into first/last if provided
    let firstName = data.firstName;
    let lastName = data.lastName;
    if (data.name && !firstName) {
      const nameParts = data.name.trim().split(' ');
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ') || '';
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, this.SALT_ROUNDS);

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

    // Generate tokens
    const tokens = await this.generateTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
    });

    // User is registered — return to caller as fast as possible. Verification
    // email goes out fire-and-forget so a slow / unreachable SMTP host can't
    // stall the registration response. If delivery fails the customer can
    // request a resend via /auth/resend-verification.
    void this.sendVerificationEmail(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim() || user.email
    ).catch(err =>
      logger.error({ err, userId: user.id }, 'Failed to send verification email after register')
    );

    // Reflect the optimistic dispatch — the email was queued, not necessarily
    // delivered; clients use this only to tell the user to check their inbox.
    return { user, ...tokens, emailVerificationSent: true };
  }

  /**
   * Create and send email verification token
   */
  static async sendVerificationEmail(userId: string, email: string, name: string): Promise<void> {
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
    await EmailService.sendEmailVerification({
      email,
      name,
      verificationUrl,
      expiresIn: '24 hours',
    });
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
    void EmailService.sendWelcome({
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
      // Record failed attempt even for non-existent users (prevent enumeration)
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

    if (storedToken.expiresAt < new Date()) {
      await prisma.refreshToken.delete({ where: { id: storedToken.id } });
      throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token expired');
    }

    // Reject refresh if user has been soft-deleted
    if (storedToken.user.deletedAt) {
      await prisma.refreshToken.delete({ where: { id: storedToken.id } });
      throw new AppError(401, 'ACCOUNT_DELETED', 'Account has been deleted');
    }

    // Delete old refresh token
    await prisma.refreshToken.delete({ where: { id: storedToken.id } });

    // Generate new tokens — preserve the original tenant scope from the
    // user record so the new access token still authenticates against the
    // same store.
    return this.generateTokens({
      userId: storedToken.user.id,
      email: storedToken.user.email,
      role: storedToken.user.role,
      storeId: storedToken.user.storeId,
    });
  }

  static async logout(refreshToken: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await prisma.refreshToken.deleteMany({
      where: { token: tokenHash },
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

    // Invalidate all refresh tokens to force re-login on other devices
    await prisma.refreshToken.deleteMany({
      where: { userId },
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
    await EmailService.sendPasswordReset({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`.trim() || user.email,
      resetUrl,
      expiresIn: '1 hour',
    });
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

    // Delete the reset token
    await prisma.refreshToken.delete({
      where: { id: storedToken.id },
    });

    // Invalidate all other refresh tokens for this user
    await prisma.refreshToken.deleteMany({
      where: { userId: storedToken.userId },
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

    // Generate refresh token (30 days)
    const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '30d',
      issuer: 'force-api',
      audience: 'force-app',
      subject: payload.userId,
    });

    // Store hashed refresh token in database
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days

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
