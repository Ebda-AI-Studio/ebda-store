import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma, Prisma, withMoneyTx, withRlsBypass } from '@force/database';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { accountLockout } from './account-lockout.service';
import logger from '../lib/logger';
import { redis } from './redis.service';
import { deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { inngest } from '../lib/inngest/client';

interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  /** Tenant scope for customer accounts; NULL for platform admins. */
  storeId: string | null;
  /** Token version for bulk revocation. Bumped on logout-all / password change. */
  tv?: number;
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
/**
 * The no-such-user answer for `resendVerificationEmail`. Exported because
 * `auth.routes.ts` must return the BYTE-IDENTICAL body when the submitted
 * email fails validation — if a malformed/filter-object email produced a 400
 * while an unknown-but-valid email produced this 200, the enumeration oracle
 * this fix closes would simply reappear from a different angle (FM-5).
 */
export const GENERIC_RESEND_VERIFICATION_RESULT = {
  success: true,
  message: 'If an account exists with this email, a verification link has been sent.',
} as const;

function authScope(email: string, storeId: string | null) {
  // P1-1 — defence in depth at the SINK. `email` lands at the top level of a
  // Prisma `where`, where Prisma happily accepts a StringFilter OBJECT
  // (`{ startsWith: 'a' }`, `{ not: 'zzz' }`) instead of a scalar. Two
  // UNAUTHENTICATED routes reached here with a raw `req.body.email`
  // (`POST /auth/forgot-password`, `POST /auth/resend-verification` — both
  // guarded by truthiness only, unlike register/login which are Zod-parsed),
  // which turned this lookup into an enumeration oracle that defeats the
  // deliberate enumeration defences 300 lines below (DUMMY_PASSWORD_HASH, the
  // both-branches bcrypt, the silent no-user return) and could mail a real
  // reset link to a real customer the attacker never named.
  //
  // Those two routes are now Zod-parsed, which is the primary fix. This throw
  // is the second layer: a FUTURE unvalidated caller cannot reopen the hole,
  // and `sanitizeObject` will not help — it recurses into nested objects and
  // PRESERVES their keys, so a filter object survives sanitisation intact.
  if (typeof email !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Email is required');
  }
  return storeId === null ? { email, storeId: null as null } : { email, storeId };
}

/**
 * How long after a rotation the same refresh token may be presented again
 * without being treated as a stolen-token replay.
 *
 * Sized to the thing it forgives: two browser contexts whose access tokens
 * expire together and refresh within milliseconds of each other, plus the
 * round-trip and any retry. Seconds, not minutes — the window is a hole in
 * reuse detection, and an attacker who has the token can use it inside the
 * window, so it stays as small as the race allows.
 */
const ROTATION_RACE_GRACE_MS = 30_000;

/**
 * How far the grace check will follow `replacedById` looking for a live tip.
 *
 * A client racing itself rotates a handful of times inside the grace window,
 * never dozens, so the cap costs nothing legitimate. It exists so a cyclic or
 * corrupt back-link cannot spin a request forever.
 */
const ROTATION_RACE_MAX_CHAIN_HOPS = 10;

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
    /** Buyer's UI locale at registration time — used to send the
     *  verification email in the customer's language. */
    language?: 'en' | 'ar';
  }) {
    const storeId = data.storeId ?? null;

    // Check if user exists in the target scope. Customers in different
    // stores can share an email — the lookup must use the composite key.
    const existingUser = await prisma.user.findFirst({
      where: authScope(data.email, storeId),
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        storeId: true,
        language: true,
      },
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
      const notifyStoreId = storeId ?? existingUser.storeId;
      if (notifyStoreId) {
        void EmailService.sendDuplicateRegistrationNotice(
          notifyStoreId,
          {
            email: existingUser.email,
            name: recipientName,
            storeName: storeName ?? undefined,
          },
          (existingUser.language as 'en' | 'ar' | undefined) ?? undefined
        ).catch(err =>
          logger.error(
            { err, email: existingUser.email },
            'Failed to send duplicate-registration notice'
          )
        );
      } else {
        logger.info(
          { email: existingUser.email },
          'Skipping duplicate-registration notice — admin account'
        );
      }
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
      storeId,
      data.language
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
    storeId: string | null = null,
    language?: 'en' | 'ar'
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
      await EmailService.sendEmailVerification(
        storeId,
        {
          email,
          name,
          verificationUrl,
          expiresIn: '24 hours',
        },
        language
      );
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
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            emailVerified: true,
            storeId: true,
            language: true,
            deletedAt: true,
          },
        },
      },
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
      void EmailService.sendWelcome(
        verificationToken.user.storeId,
        {
          email: verificationToken.user.email,
          name:
            `${verificationToken.user.firstName} ${verificationToken.user.lastName}`.trim() ||
            verificationToken.user.email,
        },
        (verificationToken.user.language as 'en' | 'ar' | undefined) ?? undefined
      ).catch(err =>
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
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        storeId: true,
        emailVerified: true,
        language: true,
      },
    });

    if (!user) {
      // Don't reveal if user exists
      return { ...GENERIC_RESEND_VERIFICATION_RESULT };
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

    // Send new verification email — forward storeId and language so the branded
    // sender and buyer's locale are both preserved.
    await this.sendVerificationEmail(
      user.id,
      user.email,
      `${user.firstName} ${user.lastName}`.trim() || user.email,
      user.storeId,
      (user.language as 'en' | 'ar' | undefined) ?? undefined
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
    // passwordHash + mfaSecret are globally omitted (see packages/database);
    // login is one of the few places that legitimately needs them, so it asks
    // for them by name. Dropping this opt-in makes bcrypt.compare below run
    // against undefined and every login fail.
    const user = await prisma.user.findFirst({
      where: { ...authScope(email, storeId), deletedAt: null },
      omit: { passwordHash: false, mfaSecret: false },
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

    // If MFA is enabled and a TOTP secret is configured, return a short-lived
    // challenge token instead of a full session. The client must verify the
    // TOTP code via /auth/mfa/verify to exchange it for a real session.
    // Guard: mfaEnabled without mfaSecret is an inconsistent state (should
    // not occur in production — /enroll/verify always sets both atomically).
    // Treat it as "not yet fully enrolled" so login still issues a session;
    // the requireMfaEnrolled middleware will use the mfaEnabled flag to gate
    // access until a real TOTP secret is confirmed.
    if (user.mfaEnabled && user.mfaSecret) {
      // Stamp a jti on the challenge token so /auth/mfa/verify can maintain
      // a per-challenge attempt counter in Redis (H2 brute-force guard).
      const challengeToken = jwt.sign({ userId: user.id, purpose: 'mfa' }, config.jwtSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
        issuer: 'force-api',
        // Distinct audience so this token is NEVER accepted by the authenticate
        // middleware (which requires audience:'force-app'). Belt-and-suspenders
        // against token-confusion attacks where the challenge is used as a
        // real access token before the second factor is verified.
        audience: 'force-mfa-challenge',
        // Unique id — lets /auth/mfa/verify key a per-challenge Redis counter
        // so failed attempts are isolated per login attempt, not per IP.
        jwtid: crypto.randomUUID(),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { mfaRequired: true, challengeToken } as any;
    }

    return this.issueSessionFor(user);
  }

  /**
   * Issue a full session (access + refresh tokens) for an already-authenticated
   * user. Extracted from `login()` so MFA-verify can reuse the same token-issue
   * and response-shape logic without duplicating the cookie/payload construction.
   *
   * Returns the same shape as a normal login response: `{ user, accessToken, refreshToken }`.
   */
  static async issueSessionFor(user: {
    id: string;
    email: string;
    storeId: string | null;
    firstName: string;
    lastName: string;
    role: string;
    emailVerified: boolean;
    tokenVersion: number;
  }): Promise<{
    user: {
      id: string;
      email: string;
      storeId: string | null;
      firstName: string;
      lastName: string;
      role: string;
      emailVerified: boolean;
    };
    accessToken: string;
    refreshToken: string;
  }> {
    const tokens = await this.generateTokens({
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
      tv: user.tokenVersion,
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

  /**
   * Follow `replacedById` from a rotated row to the tip of its family and
   * report whether that tip is still live.
   *
   * Recency alone cannot tell a rotation race from a defeated revocation.
   * Every mass revocation in this service is an `updateMany({ where: {
   * revokedAt: null } })` — by design it does not touch rows that are already
   * revoked. A row rotated at t0 therefore keeps `revokedReason: 'rotated'`
   * and its original `revokedAt` forever, so at t0+6s it is indistinguishable
   * from a race even if `revokeAllSessions`, logout-all, a password change or
   * reuse detection fired at t0+5s. Honouring it there would mint a fresh
   * access token carrying the just-bumped `tv` plus a 365-day refresh row,
   * turning a 30-second window into a permanent parallel session that survives
   * the very "sign out all devices" it was answering.
   *
   * The successor chain is what actually records those events: a revocation
   * lands on whichever row is live. So if the tip is gone — revoked for any
   * reason other than a further rotation, dead-ended, or pruned away — the
   * family is dead and this presentation is a replay, not a race.
   */
  private static async successorChainIsLive(replacedById: string): Promise<boolean> {
    let cursor = replacedById;

    for (let hop = 0; hop < ROTATION_RACE_MAX_CHAIN_HOPS; hop++) {
      const successor = await prisma.refreshToken.findUnique({
        where: { id: cursor },
        select: { revokedAt: true, revokedReason: true, replacedById: true },
      });

      // Never written, or aged out by cleanupRefreshTokens(): nothing proves
      // the family is alive, so don't assume it.
      if (!successor) return false;
      // A live tip — the successor is still refreshing. This is the race.
      if (!successor.revokedAt) return true;
      // Revoked by anything other than a further rotation: the family was
      // deliberately killed after this row rotated.
      if (successor.revokedReason !== 'rotated') return false;
      // Rotated but with no back-link: chain ends without a live row.
      if (!successor.replacedById) return false;

      cursor = successor.replacedById;
    }

    return false;
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
      // A ROTATION RACE is not a replay. Two tabs (or admin + orders) whose
      // access tokens expire in the same instant both POST /auth/refresh with
      // the same cookie. One wins and rotates; the other arrives moments later
      // holding a token this service has just marked `rotated`. Treating that
      // as a compromised family logs the user out of everything they have open.
      //
      // Measured in production 2026-09-10: 46 sessions for ONE user revoked in
      // a single second, and the triggering token had been rotated 1.8s
      // earlier. Across all history `reuse_detected` (58) had overtaken
      // `rotated` (48) as the reason sessions die. It clusters after a deploy,
      // when every open tab re-authenticates at once.
      //
      // So a narrow, precisely-conditioned exemption: the row must have been
      // rotated (never revoked by logout, expiry, deletion or a previous reuse
      // event), must carry the back-link proving a successor exists, must be
      // within seconds of that rotation, AND the family it belongs to must
      // still be alive. Anything else still burns the family down.
      const rotationRace =
        storedToken.revokedReason === 'rotated' &&
        storedToken.replacedById !== null &&
        Date.now() - storedToken.revokedAt.getTime() <= ROTATION_RACE_GRACE_MS &&
        (await this.successorChainIsLive(storedToken.replacedById));

      if (!rotationRace) {
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

      // Logged at warn, not info: the exemption is a deliberate hole in a
      // security control, so a sustained rate of it must be visible rather
      // than inferred. A spike here is either a client refreshing in a loop or
      // an attacker racing a real rotation — both worth looking at.
      logger.warn(
        {
          userId: storedToken.userId,
          tokenId: storedToken.id,
          rotatedMsAgo: Date.now() - storedToken.revokedAt.getTime(),
        },
        'Refresh-token rotation race — issuing a fresh token instead of revoking the family'
      );
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
    // L4 fix: pass the live tokenVersion so refreshed access tokens carry
    // the current tv and are not spuriously rejected by the tv check in
    // authenticate() when the user's tokenVersion has been bumped since
    // the original access token was issued.
    const newTokens = await this.generateTokens({
      userId: storedToken.user.id,
      email: storedToken.user.email,
      role: storedToken.user.role,
      storeId: storedToken.user.storeId,
      tv: storedToken.user.tokenVersion,
    });

    const newHash = crypto.createHash('sha256').update(newTokens.refreshToken).digest('hex');
    const newRow = await prisma.refreshToken.findUnique({
      where: { token: newHash },
      select: { id: true },
    });

    // Only the row that is still live gets marked rotated. On the race path
    // the row is ALREADY revoked, and rewriting `revokedAt` to now would slide
    // the grace window forward on every replay — turning a 30-second exemption
    // into an indefinite one for anyone holding that token.
    if (!storedToken.revokedAt) {
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: {
          revokedAt: new Date(),
          revokedReason: 'rotated',
          replacedById: newRow?.id ?? null,
        },
      });
    }

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
        // MFA status — every client reads these from /auth/me to render the
        // 2FA toggle (admin Security page) and to gate the Orders PWA login.
        // Omitting them made /auth/me report MFA as undefined → "disabled"
        // everywhere, even for fully-enrolled accounts.
        mfaEnabled: true,
        mfaEnrolledAt: true,
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
    // Needs the hash to verify the CURRENT password — opt back in by name.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      omit: { passwordHash: false },
    });
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

    // Bump tokenVersion so all outstanding access tokens (which carry the
    // old tv claim) are rejected by the auth middleware on next use.
    await AuthService.revokeAllSessions(userId);
  }

  /**
   * Increment tokenVersion in DB + cache, and revoke all active refresh
   * tokens for the user. Any issued access token carrying an older `tv`
   * claim will be rejected by the authenticate middleware on next request.
   * Fail-open: if Redis is unavailable, the DB increment is still written
   * and the next authenticate call will re-populate the cache from DB.
   */
  static async revokeAllSessions(userId: string): Promise<void> {
    // Atomically increment tokenVersion and read the new value.
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });

    // Warm the Redis cache with the new version so the middleware sees it
    // immediately without a DB round-trip on the next request.
    await redis.setUserTokenVersion(userId, updated.tokenVersion);

    // Revoke all live refresh tokens — prevents session resumption via
    // token rotation even before the access token's tv is checked.
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'revoke_all' },
    });

    // …and every merchant MCP key this user holds. "Sign out all devices" has
    // to mean ALL devices: a merchant key is a long-lived credential acting as
    // this user, so leaving it live would make the strongest lever the platform
    // has a partial one. `verifyMerchantKey` also refuses a suspended or
    // soft-deleted user on every call, so this is the second of two
    // independent checks rather than the only one.
    // `withRlsBypass`: this is CROSS-TENANT by nature — it revokes this user's
    // keys in every store they hold one for. `revokeAllSessions` is called
    // from request handlers that may already be inside a tenant context
    // (auth.routes logout-all, mfa.routes), and under the table's RLS policy
    // that would silently revoke only the current store's keys while reporting
    // success. A partial "sign out all devices" is worse than a failed one.
    await withRlsBypass(tx =>
      tx.merchantApiKey.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    );
  }

  static async requestPasswordReset(email: string, storeId: string | null = null): Promise<void> {
    // Tenant-scoped lookup so a Store A reset request doesn't leak the
    // existence of an account on Store B with the same email.
    const user = await prisma.user.findFirst({
      where: authScope(email, storeId),
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        storeId: true,
        language: true,
      },
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
      await EmailService.sendPasswordReset(
        user.storeId,
        {
          email: user.email,
          name: `${user.firstName} ${user.lastName}`.trim() || user.email,
          resetUrl,
          expiresIn: '1 hour',
        },
        (user.language as 'en' | 'ar' | undefined) ?? undefined
      );
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

  /**
   * Irreversible PII anonymization (GDPR Art. 17 + Kuwait Law 13/2023).
   *
   * Wipes every personally-identifying field on the user and removes child
   * rows that have no audit/financial basis (addresses, push subs, cart,
   * wishlist, abandoned-cart, refresh tokens). Orders + reviews + returns
   * keep their structure but lose their tie to the now-anonymized user
   * (orders preserve totals/line-items/order-number for Kuwait MOF's ≥5y
   * invoice-retention requirement; shipping/billing address JSON snapshots
   * are scrubbed since they store the same PII as the addresses table).
   *
   * Idempotent: re-running on an already-erased account is a no-op (the
   * second call's `update` succeeds with the same data, the `deleteMany`s
   * delete zero rows). Callers should still clear auth cookies on the
   * client side after the response.
   *
   * NOT a soft-delete superset — soft-deleted accounts still expose PII
   * and only `eraseAccount` makes the user actually disappear.
   */
  static async eraseAccount(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, storeId: true, role: true, avatar: true },
    });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }
    // Platform admins (super_admin / store_admin without storeId) can't
    // self-erase via this endpoint — their account is a business identity
    // for the platform, not a customer's personal data. They go through
    // the manual super_admin offboarding path.
    if (user.role !== 'customer') {
      throw new AppError(403, 'FORBIDDEN', 'Admin accounts cannot be erased via this endpoint');
    }

    const anonymizedEmail = `erased-${user.id}@anonymized.local`;
    const anonymizedAddressJson = { anonymized: true } as const;

    // Capture third-party identifiers BEFORE the transaction deletes the
    // local rows that carry them — the account/erased propagation consumer
    // (fired after commit, below) needs these to reach OneSignal's API.
    // Read-only, so it doesn't need to be inside the transaction.
    const oneSignalPlayerIds = (
      await prisma.oneSignalSubscription.findMany({
        where: { userId },
        select: { playerId: true },
      })
    ).map(s => s.playerId);

    await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      // Orders: preserve for tax records (Kuwait MOF ≥5y), drop the PII.
      // The customer FK is already `onDelete: SetNull` but we explicitly
      // null it so the row's history loses the back-reference even before
      // the user row is deactivated. Address JSON snapshots get scrubbed
      // because they duplicate the now-deleted addresses table data.
      await tx.order.updateMany({
        where: { customerId: userId },
        data: {
          customerId: null,
          shippingAddress: anonymizedAddressJson,
          billingAddress: anonymizedAddressJson,
          customerNotes: null,
        },
      });

      // Reviews: keep the body (anonymous review is valid public content)
      // but drop the author link. SetNull happens via FK on user-delete,
      // but we don't delete the user row; null explicitly.
      await tx.review.updateMany({
        where: { customerId: userId },
        data: { customerId: null },
      });

      // Pure-PII child rows — no business reason to retain. The FK
      // column names vary across models (some use `userId`, some
      // `customerId`) — match each model's actual schema.
      await tx.address.deleteMany({ where: { userId } });
      await tx.abandonedCart.deleteMany({ where: { customerId: userId } });
      await tx.cart.deleteMany({ where: { customerId: userId } });
      await tx.wishlist.deleteMany({ where: { userId } });
      await tx.pushSubscription.deleteMany({ where: { customerId: userId } });
      await tx.oneSignalSubscription.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.verificationToken.deleteMany({ where: { userId } });
      await tx.loyaltyTransaction.deleteMany({ where: { customerId: userId } });
      await tx.loyaltyPoints.deleteMany({ where: { customerId: userId } });

      // Finally rewrite the user row itself. Password hash is regenerated
      // from random bytes so a stolen DB snapshot can't be cracked back
      // into the original credential. Email is rewritten (not nulled) so
      // the composite-unique (storeId, email) index has no collision risk
      // if the same address is re-registered later.
      await tx.user.update({
        where: { id: userId },
        data: {
          email: anonymizedEmail,
          firstName: 'Erased',
          lastName: 'User',
          phone: null,
          avatar: null,
          dateOfBirth: null,
          passwordHash: crypto.randomBytes(32).toString('hex'),
          status: 'inactive',
          deletedAt: new Date(),
        },
      });
    });

    // The avatar URL was just nulled out of the DB — clean up R2 after
    // the transaction commits. Best-effort, same pattern as other cleanup
    // sites: never let storage hiccups propagate to the caller.
    if (user.avatar) {
      void deleteR2ObjectIfOrphan(user.avatar).catch(err =>
        logger.warn({ err, userId }, '[auth.eraseAccount] r2 avatar cleanup failed')
      );
    }

    // Third-party deletion propagation (GDPR Art. 17 / Kuwait Law 13/2023
    // Art. 17): OneSignal + PostHog. Fire-and-forget, same discipline as the
    // R2 cleanup above — the primary anonymization already committed, so a
    // dead Inngest connection must never surface as a failed erase. See
    // lib/inngest/functions/account-erased-propagation.ts +
    // services/privacy-propagation.service.ts.
    inngest
      .send({ name: 'account/erased', data: { userId, oneSignalPlayerIds } })
      .catch(err =>
        logger.warn({ err, userId }, '[auth.eraseAccount] account/erased enqueue failed')
      );
  }

  /**
   * Right to data portability (GDPR Art. 20 + Kuwait Law 13/2023).
   *
   * Returns every row across the schema that ties back to this user as a
   * single JSON bundle. Intentionally returns the raw shape — the
   * exported file is the user's data, not a marketing surface, so field
   * names match the schema for transparency.
   */
  static async exportAccount(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        storeId: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        emailVerified: true,
        avatar: true,
        dateOfBirth: true,
        language: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const [
      addresses,
      orders,
      abandonedCarts,
      wishlists,
      reviews,
      returns,
      loyaltyPoints,
      loyaltyTransactions,
      pushSubscriptions,
      onesignalSubscriptions,
    ] = await Promise.all([
      prisma.address.findMany({ where: { userId } }),
      prisma.order.findMany({
        where: { customerId: userId },
        include: { items: true, payments: true },
      }),
      prisma.abandonedCart.findMany({ where: { customerId: userId } }),
      prisma.wishlist.findMany({ where: { userId } }),
      prisma.review.findMany({ where: { customerId: userId } }),
      prisma.return.findMany({ where: { customerId: userId } }),
      prisma.loyaltyPoints.findMany({ where: { customerId: userId } }),
      prisma.loyaltyTransaction.findMany({ where: { customerId: userId } }),
      prisma.pushSubscription.findMany({
        where: { customerId: userId },
        select: { id: true, endpoint: true, createdAt: true },
      }),
      prisma.oneSignalSubscription.findMany({
        where: { userId },
        select: { id: true, playerId: true, createdAt: true },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      user,
      addresses,
      orders,
      abandonedCarts,
      wishlists,
      reviews,
      returns,
      loyaltyPoints,
      loyaltyTransactions,
      pushSubscriptions,
      onesignalSubscriptions,
    };
  }

  private static async generateTokens(payload: TokenPayload): Promise<AuthTokens> {
    // Generate access token — stamped with a unique jti (for per-token
    // revocation via the JTI denylist) and a tv (token version, for
    // bulk revocation on logout-all / password change).
    const accessJti = crypto.randomUUID();
    const accessToken = jwt.sign({ ...payload, tv: payload.tv ?? 0 }, config.jwtSecret, {
      algorithm: 'HS256',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: config.jwtExpiresIn as any,
      issuer: 'force-api',
      audience: 'force-app',
      subject: payload.userId,
      jwtid: accessJti,
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
      // Unique token id. Without it, two refresh tokens minted for the same
      // user in the same second (login immediately followed by a refresh, or a
      // fast client) produce a byte-identical JWT -> identical SHA-256 hash ->
      // duplicate key on refresh_tokens.token (P2002) -> 500. The jti nonce
      // guarantees every issued token is distinct regardless of timing.
      jwtid: crypto.randomUUID(),
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
