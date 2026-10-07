import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  prisma,
  Prisma,
  currentStoreId,
  hasTenantContext,
  runInTenantContext,
  withStore,
  withUser,
} from '@force/database';
import {
  deleteUserAddresses,
  findUserIdByEmail,
  getUserState,
  revokeUserSessionsRow,
} from '../lib/definer';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { sendMerchantVerificationEmail } from './platform-mailer';
import { accountLockout } from './account-lockout.service';
import { cfWaitUntil } from '../cf/bindings';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { smsConsentPhoneKey } from '../lib/sms-consent';
import { redis } from './redis.service';
import { deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { sendAlert } from './alerts.service';
import { SEND_CAP_WINDOW_MS } from './campaign.service';
import { inngest } from '../lib/inngest/client';
import { WalletService } from './wallet.service';

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
 * Find a user by email inside ONE namespace (`storeId` null = the admin
 * namespace) and read the row.
 *
 * `users` is under strict RLS and a login/forgot-password caller is not scoped
 * to anyone yet, so the id comes from the `ebda_auth_find_user_id` definer
 * (exact email + namespace, id only) and the row is then read AS that user —
 * `withUser` joins an ambient transaction for the same user, else opens a short
 * one. Soft-deleted users are excluded unless `includeDeleted`.
 */
async function findUserInScope<T extends Prisma.UserDefaultArgs>(
  email: string,
  storeId: string | null,
  args: T,
  opts: { includeDeleted?: boolean } = {}
): Promise<Prisma.UserGetPayload<T> | null> {
  // Same sink guard as `authScope`: only a scalar email may reach the lookup.
  if (typeof email !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Email is required');
  }
  const id = await findUserIdByEmail(email, storeId, opts);
  if (!id) return null;
  return withUser(
    id,
    tx =>
      tx.user.findUnique({
        where: { id },
        ...args,
      } as Prisma.UserFindUniqueArgs) as Promise<Prisma.UserGetPayload<T> | null>,
    storeId ?? undefined
  );
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
 *
 * What the window bounds is WHEN a replay is forgiven, not how long the
 * result lives (#1671): a forgiven replay mints a refresh row that inherits
 * the presented token's remaining lifetime (up to the full 365 days) and has
 * NO lineage link back to the chain it forked from — `replacedById` on the
 * presented row already points at the first successor. The two chains then
 * never share a row again, so family-level reuse detection cannot see the
 * fork. Containment rests on the USER-scoped revocation paths —
 * `password_changed`, `password_reset`, `revoke_all` (sign out everywhere)
 * and `reuse_detected`, each an `updateMany({ where: { userId, revokedAt:
 * null } })` — which kill both chains. A single-session `logout` does NOT:
 * it revokes only the one presented token, so the forked chain survives it.
 * The `familyId` column that would restore lineage is deferred by Ruling
 * P2-B1-2 (docs/RULINGS.md) to its own migration PR.
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

/**
 * How many times ONE rotated row may be forgiven before reuse detection fires.
 *
 * Without a cap the window bounds the opportunity but not the consequence: a
 * stolen token could be replayed in a loop for the whole 30 seconds, minting a
 * separate full-length session on every pass. The cap covers the legitimate
 * shape of the race — the tabs that were already in flight when the winner
 * rotated, which is a handful, never dozens — and turns an unbounded
 * amplifier into a bounded one.
 */
const ROTATION_RACE_MAX_GRACE_USES = 5;

/**
 * The outcome of trying to claim a grace use.
 *
 * Three states, not two. "Refused because the budget is gone" and "refused
 * because the row vanished" look identical to a boolean, and they are the
 * difference between "the cap is set too low for how this merchant works" and
 * "a token was pruned". The first is the only signal that tells an operator
 * to raise the cap — and the log line that was supposed to carry it only ever
 * ran on the SUCCESS path, so the case that matters never reached it.
 */
interface GraceClaim {
  claimed: boolean;
  /** The budget was spent. The presentation may have been entirely legitimate. */
  exhausted: boolean;
  spent: number;
}

/** `revokedReason` written by a rotation that has not been raced yet. */
const REASON_ROTATED = 'rotated';

/**
 * Prefix for a rotated row whose grace uses are partly spent
 * (`rotated_grace_1` … `rotated_grace_5`).
 *
 * The count lives in `revokedReason` rather than a column of its own because
 * every reader of that field is in this file, so the encoding cannot leak, and
 * because a bounded counter is not worth a schema migration on the table every
 * authenticated request touches. A dedicated `familyId` column is the right
 * home for the lineage work this cap only bounds — see the P2 backlog plan.
 */
const REASON_GRACE_PREFIX = 'rotated_grace_';

/**
 * What `eraseAccount` did to the merchant-CRM copy of the shopper (#1880).
 * The `customers` table has no FK to `users`, so the scrub matches by
 * email/phone and can legitimately find nothing (a differently-normalised
 * phone, a changed email) or refuse an ambiguous match. Callers record this
 * in the audit row and surface it, so an erasure that left the CRM copy
 * readable is not reported as complete.
 */
export interface EraseOutcome {
  /** The account had a store and an email/phone, so a CRM copy could exist. */
  crmChecked: boolean;
  /** `customers` rows scrubbed. */
  crmRowsScrubbed: number;
  /** An identifier matched more than one row, so that identifier scrubbed nothing. */
  crmAmbiguous: boolean;
}

/**
 * True when a CRM copy is KNOWN to have been left behind: an identifier
 * matched more than one row, so it scrubbed nothing. A zero match is NOT
 * flagged — CRM rows only exist for shoppers a merchant has grouped, so most
 * erasures legitimately match nothing; it is recorded (`crmRowsScrubbed: 0`)
 * and shown as information, not as a failure.
 */
export function eraseNeedsCrmReview(o: EraseOutcome): boolean {
  return o.crmChecked && o.crmAmbiguous;
}

/**
 * Push a bumped tokenVersion into the tv cache the authenticate middleware
 * reads FIRST (`user:tv:<id>`, no TTL — a hit never consults Postgres).
 *
 * A failed SET must not leave the old, stale-LOW value being served: that
 * keeps every already-issued access token valid for its full life after a
 * revocation the caller was told succeeded (issues 1964 / 2062). So it falls
 * back to DELETING the key — a miss makes the next request read the bumped
 * value (and `status`) from Postgres. Only when both fail is the revocation
 * genuinely not in effect, and that is a P1 alert + error log, the same
 * visibility a failed deferred task gets (`reportDeferredFailure`). Never
 * throws: revocation's DB half has already committed.
 */
async function pushTokenVersion(userId: string, tv: number, source: string): Promise<void> {
  try {
    await redis.setUserTokenVersion(userId, tv);
    return;
  } catch (setErr) {
    try {
      await redis.clearUserTokenVersion(userId);
      logger.warn(
        { err: setErr, userId, source },
        '[auth] tokenVersion cache SET failed — key deleted, next request reads Postgres'
      );
      return;
    } catch (delErr) {
      logger.error(
        { err: delErr, setErr, userId, source },
        '[auth] tokenVersion cache SET and DEL both failed — revoked access tokens may still authenticate'
      );
      await sendAlert({
        level: 'p1',
        source,
        title: 'Session revocation did not reach the token-version cache',
        body:
          'The DB tokenVersion bump committed but Redis kept the old value, so access tokens ' +
          'issued before the revocation keep authenticating until they expire (30 min) or ' +
          'the key is deleted.',
        context: { userId },
      }).catch(() => undefined);
    }
  }
}

export class AuthService {
  private static readonly SALT_ROUNDS = 12;

  /**
   * Pre-computed bcrypt hash (cost 12) of a value no caller can ever provide:
   * 32 random bytes whose plaintext was discarded when the constant was
   * generated. Used to equalize the login response time when the user record
   * doesn't exist — without this dummy compare, "no user" returns ~50ms faster
   * than "user exists, password wrong" and an attacker can enumerate registered
   * emails by timing the response. The hash itself is irrelevant (compare
   * always fails); we only care that the caller waits the same wall-clock time
   * as the happy path.
   *
   * A constant rather than `bcrypt.hashSync(randomBytes(32), 12)` at class
   * init: that ran ~250ms of CPU plus `crypto.randomBytes` in GLOBAL scope on
   * every cold start, which workerd forbids (R-EBDA-001, experiment B2c).
   */
  private static readonly DUMMY_PASSWORD_HASH: string =
    '$2b$12$OW.xBchkmJbVjXDhBSQ6ke4cdbV/iuOcgjbbGK9ZslpcF5fkkynha';

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
    // `users` is under strict RLS: a storefront registration is read inside the
    // store's scope. The admin namespace (no storeId) is not registrable here —
    // store owners and staff are provisioned (ProvisioningService, staff invite),
    // never self-registered — so there is nothing to look up for it.
    const existingUser = storeId
      ? await withStore(storeId, tx =>
          tx.user.findFirst({
            where: authScope(data.email, storeId),
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              storeId: true,
              language: true,
            },
          })
        )
      : null;

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
            { err, email: maskEmail(existingUser.email) },
            'Failed to send duplicate-registration notice'
          )
        );
      } else {
        logger.info(
          { email: maskEmail(existingUser.email) },
          'Skipping duplicate-registration notice — admin account'
        );
      }
      return { emailVerificationSent: true } as const;
    }

    if (!storeId) {
      // No store, no account: same generic answer as every other branch (the
      // enumeration close above), nothing created, no email sent.
      logger.info(
        { email: maskEmail(data.email) },
        'Registration without a storeId — admin accounts are provisioned, not self-registered'
      );
      return { emailVerificationSent: true } as const;
    }

    // Create user (inside the store's scope: users.store_id must match it)
    const user = await withStore(storeId, tx =>
      tx.user.create({
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
      })
    );

    // Verification email goes out fire-and-forget so a slow / unreachable
    // SMTP host can't stall the registration response. If delivery fails
    // the customer can request a resend via /auth/resend-verification.
    // `cfWaitUntil`: on a Worker a bare floating promise is cancelled with the response (and its
    // database lease is gone), so the email would silently never go out. On Node it is `void`.
    cfWaitUntil(
      this.sendVerificationEmail(
        user.id,
        user.email,
        `${user.firstName} ${user.lastName}`.trim() || user.email,
        storeId,
        data.language
      ).catch(err =>
        logger.error({ err, userId: user.id }, 'Failed to send verification email after register')
      )
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
    // Same constant feeds both the token's real TTL and the copy that
    // describes it, so a TTL change can never again desync the two (#1860 —
    // the previous literal 'expiresIn: string' let an English phrase get
    // baked in and rendered verbatim inside the Arabic template).
    const EMAIL_VERIFICATION_EXPIRY_HOURS = 24;
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000);

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
    if (storeId) {
      const verificationUrl = `${config.webUrl}/auth/verify-email?token=${token}`;
      await EmailService.sendEmailVerification(
        storeId,
        {
          email,
          name,
          verificationUrl,
          expiresInHours: EMAIL_VERIFICATION_EXPIRY_HOURS,
        },
        language
      );
    } else {
      // Accounts with no storeId are merchants (self-serve signup): no store
      // exists yet, so the branded per-store sender is unavailable. They get
      // the platform-sender mail with a link to the admin app's verify page.
      // Outside production this is captured, never sent (platform-mailer).
      await sendMerchantVerificationEmail(
        {
          email,
          name,
          verificationUrl: `${config.adminUrl}/verify-email?token=${token}`,
          expiresInHours: EMAIL_VERIFICATION_EXPIRY_HOURS,
        },
        language
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
    });

    if (!verificationToken) {
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid verification token');
    }

    // The user is read as themselves (`users` is RLS-scoped to app.current_user_id);
    // a join from the token would hide the row. The token is the credential: it is
    // looked up by its hash before any identity is known.
    const tokenUser = await withUser(verificationToken.userId, tx =>
      tx.user.findUnique({
        where: { id: verificationToken.userId },
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
      })
    );
    if (!tokenUser) {
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

    if (tokenUser.emailVerified) {
      return { success: true, message: 'Email already verified' };
    }

    // Update user as verified and mark token as used
    await withUser(
      verificationToken.userId,
      async tx => {
        await tx.user.update({
          where: { id: verificationToken.userId },
          data: { emailVerified: true },
        });
        await tx.verificationToken.update({
          where: { id: verificationToken.id },
          data: { usedAt: new Date() },
        });
      },
      tokenUser.storeId ?? undefined
    );

    // Welcome email is a follow-up — fire-and-forget so SMTP latency can't
    // delay the verify-email API response.
    if (tokenUser.storeId) {
      void EmailService.sendWelcome(
        tokenUser.storeId,
        {
          email: tokenUser.email,
          name: `${tokenUser.firstName} ${tokenUser.lastName}`.trim() || tokenUser.email,
        },
        (tokenUser.language as 'en' | 'ar' | undefined) ?? undefined
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
    const user = await findUserInScope(
      email,
      storeId,
      {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          storeId: true,
          emailVerified: true,
          language: true,
        },
      },
      { includeDeleted: true }
    );

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
    // Case-folded so `Victim@x.com` / `VICTIM@x.com` share one counter: an
    // exact-case key let an attacker reset the 5-per-15-min budget by
    // re-casing the address (Ebda SP5 review).
    const lockoutEmail = typeof email === 'string' ? email.trim().toLowerCase() : email;
    const lockoutKey = storeId ? `${storeId}:${lockoutEmail}` : lockoutEmail;
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
    const user = await findUserInScope(email, storeId, {
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

    // Reject non-active accounts. Checked AFTER the password is confirmed
    // correct (not before) — checking status before/instead of the password
    // would let a wrong-password guess distinguish "no such account",
    // "wrong password" and "suspended account" by response shape, reopening
    // the account-enumeration oracle the dummy-bcrypt-compare above exists to
    // close. S3-1, 2026-09-22 security audit: a super_admin who suspends a
    // compromised or departing account previously found the account could
    // still log in with its password — `status` was recorded but never read.
    if (user.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is not active');
    }

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
    status: string;
    deletedAt: Date | null;
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
    // The session-mint chokepoint re-checks status itself (#1864). `login()`
    // gates before issuing a challenge, but `/auth/mfa/verify` calls this up to
    // 5 minutes later with a freshly-read row: a super_admin suspended between
    // the challenge and the TOTP code would otherwise get a live session
    // stamped with the CURRENT (already-bumped) token version, and the
    // authenticate middleware only reads status on a tv-cache MISS, which
    // `revokeAllSessions` just filled. Same code as login's gate. A
    // soft-deleted row is treated the same — login never finds it
    // (`deletedAt: null`), and this path must not either.
    if (user.status !== 'active' || user.deletedAt) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is not active');
    }

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
  private static async successorChainIsLive(
    replacedById: string,
    userId: string
  ): Promise<boolean> {
    // Hop 1 is a primary-key lookup, and hop 1 is almost always the whole
    // walk: the presented row's successor IS the live tip unless the client
    // rotated more than once inside the grace window.
    //
    // The previous version replaced every hop with ONE
    // `findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 500 })`
    // to cut round-trips on the thundering-herd path. That was a pessimisation
    // dressed as an optimisation: `RefreshToken` has `@@index([userId])` but
    // no `(userId, createdAt)` composite, so Postgres fetches every row for
    // that user and sorts before applying `take` — and `cleanupRefreshTokens`
    // keeps revoked rows for 30 days and live rows until they expire, so a
    // merchant refreshing across admin, orders and the storefront accumulates
    // on the order of a thousand. It traded one index-unique read for a full
    // per-user scan plus sort, per replaying request, exactly when concurrency
    // is highest.
    //
    // So: pay the cheap read for the common shape, and fall back to the bulk
    // read only when a SECOND hop is actually needed. Worst case is two
    // queries instead of the original ten; the common case is one, as it was
    // before either change. No new index, so Ruling P2-B1-1's "no migration on
    // the hottest table in the schema" still holds.
    const first = await prisma.refreshToken.findUnique({
      where: { id: replacedById },
      select: { revokedAt: true, revokedReason: true, replacedById: true },
    });
    if (!first) return false;
    if (!first.revokedAt) return true;
    if (!this.endedByRotation(first.revokedReason)) return false;
    if (!first.replacedById) return false;

    // A chain deeper than one hop. Every row in it was created inside the
    // grace window that led here, so it is part of this user's newest rows;
    // read that slice once and finish in memory rather than paying a
    // round-trip per remaining hop.
    const rows = await prisma.refreshToken.findMany({
      where: { userId },
      select: { id: true, revokedAt: true, revokedReason: true, replacedById: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const byId = new Map(rows.map(r => [r.id, r]));

    let cursor: string | null = first.replacedById;
    const seen = new Set<string>([replacedById]);

    for (let hop = 1; hop < ROTATION_RACE_MAX_CHAIN_HOPS; hop++) {
      // A back-link that loops would otherwise spin until the hop cap; a cycle
      // is corruption, and corruption is not evidence of a live family.
      if (cursor === null || seen.has(cursor)) return false;
      seen.add(cursor);

      const successor = byId.get(cursor);

      // Never written, or aged out by cleanupRefreshTokens(): nothing proves
      // the family is alive, so don't assume it.
      if (!successor) return false;
      // A live tip — the successor is still refreshing. This is the race.
      if (!successor.revokedAt) return true;
      // Revoked by anything other than a further rotation: the family was
      // deliberately killed after this row rotated.
      if (!this.endedByRotation(successor.revokedReason)) return false;

      cursor = successor.replacedById;
    }

    return false;
  }

  /**
   * Was this row ended by a rotation, rather than by a revocation?
   *
   * Accepts both the untouched `rotated` and the `rotated_grace_N` forms a
   * raced row carries once some of its grace uses are spent. Spending a grace
   * use records that the row was replayed; it does not change WHY the row
   * stopped being live, so a partly-spent row is still a rotation to every
   * reader that asks that question.
   */
  private static endedByRotation(revokedReason: string | null): boolean {
    return (
      revokedReason === REASON_ROTATED || (revokedReason?.startsWith(REASON_GRACE_PREFIX) ?? false)
    );
  }

  /**
   * How many of a rotated row's grace uses are already spent.
   *
   * An unparseable `rotated_grace_*` value reads as exhausted rather than as
   * zero: this number gates a hole in a security control, so an encoding we
   * did not write closes the hole instead of opening it.
   */
  private static graceUsesSpent(revokedReason: string | null): number {
    if (!revokedReason?.startsWith(REASON_GRACE_PREFIX)) return 0;
    const spent = Number.parseInt(revokedReason.slice(REASON_GRACE_PREFIX.length), 10);
    return Number.isInteger(spent) && spent > 0 ? spent : ROTATION_RACE_MAX_GRACE_USES;
  }

  /**
   * Claim one of a rotated row's bounded grace uses, or report that they are
   * gone.
   *
   * The claim is a compare-and-set on `revokedReason`, so two replays landing
   * in the same millisecond cannot both spend the same use — exactly the case
   * a read-then-write counter would miss, and exactly the case an attacker
   * replaying in parallel would exploit. Losing the CAS is not a denial: it
   * means a concurrent replay moved the count, which is the legitimate
   * multi-tab race, so re-read and try for the next use instead. The loop is
   * bounded by the cap itself, so it terminates whoever wins.
   */
  private static async claimGraceUse(
    tokenId: string,
    revokedReason: string | null
  ): Promise<GraceClaim> {
    let reason = revokedReason;

    for (let attempt = 0; attempt <= ROTATION_RACE_MAX_GRACE_USES; attempt++) {
      const spent = this.graceUsesSpent(reason);
      if (spent >= ROTATION_RACE_MAX_GRACE_USES) return { claimed: false, exhausted: true, spent };

      const claimed = await prisma.refreshToken.updateMany({
        where: { id: tokenId, revokedReason: reason },
        data: { revokedReason: `${REASON_GRACE_PREFIX}${spent + 1}` },
      });
      if (claimed.count > 0) return { claimed: true, exhausted: false, spent: spent + 1 };

      const fresh = await prisma.refreshToken.findUnique({
        where: { id: tokenId },
        select: { revokedReason: true },
      });
      // The row is gone — pruned, or deleted underneath us. That is not a
      // budget problem, and reporting it as one would blame the cap for
      // something the cap did not do.
      if (!fresh) return { claimed: false, exhausted: false, spent };
      reason = fresh.revokedReason;
    }

    return { claimed: false, exhausted: true, spent: ROTATION_RACE_MAX_GRACE_USES };
  }

  static async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    // Hash the token to look it up
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const storedRow = await prisma.refreshToken.findUnique({
      where: { token: tokenHash },
    });

    if (!storedRow) {
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');
    }

    // The owning user is read AS themselves (`users` is RLS-scoped to
    // app.current_user_id), not joined from the token: the token is the
    // credential and is looked up by its hash before any identity is known.
    const tokenOwner = await withUser(storedRow.userId, tx =>
      tx.user.findUnique({
        where: { id: storedRow.userId },
        select: {
          id: true,
          email: true,
          role: true,
          storeId: true,
          status: true,
          deletedAt: true,
          tokenVersion: true,
        },
      })
    );
    if (!tokenOwner) {
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');
    }
    const storedToken = { ...storedRow, user: tokenOwner };

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
      //
      // The window bounds the OPPORTUNITY to replay; the use cap bounds the
      // CONSEQUENCE of replaying. Without the cap a single stolen token could
      // be presented in a loop for thirty seconds and mint a separate session
      // every pass, so a 30-second hole paid out indefinitely.
      const raceSignalsAgree =
        this.endedByRotation(storedToken.revokedReason) &&
        storedToken.replacedById !== null &&
        Date.now() - storedToken.revokedAt.getTime() <= ROTATION_RACE_GRACE_MS &&
        (await this.successorChainIsLive(storedToken.replacedById, storedToken.userId));

      // Claimed last, and only once everything else has said yes: it is the
      // single step here that writes, and a row's grace uses are not spent by
      // a presentation that was going to be refused anyway. The budget is
      // checked inside the claim rather than again out here — a second copy of
      // the test would be a line no mutation can reach, which reads as covered
      // while proving nothing.
      const claim = raceSignalsAgree
        ? await this.claimGraceUse(storedToken.id, storedToken.revokedReason)
        : { claimed: false, exhausted: false, spent: 0 };
      const rotationRace = claim.claimed;

      if (!rotationRace) {
        // `graceExhausted` is the field that separates "a stolen token was
        // replayed" from "a legitimate seventh tab exceeded a cap of five".
        // Without it the two are byte-identical in the log, and the cap being
        // wrong is invisible precisely when it is hurting someone: every tab
        // of admin, orders and the storefront shares ONE refresh cookie, so
        // six simultaneous tabs is ordinary for a busy merchant and the sixth
        // replay burns the account out of all of them.
        logger.warn(
          {
            userId: storedToken.userId,
            tokenId: storedToken.id,
            revokedAt: storedToken.revokedAt,
            revokedReason: storedToken.revokedReason,
            graceExhausted: claim.exhausted,
            ...(claim.exhausted
              ? { graceUsesSpent: claim.spent, graceUsesAllowed: ROTATION_RACE_MAX_GRACE_USES }
              : {}),
          },
          claim.exhausted
            ? 'Refresh-token grace budget exhausted — revoking all tokens for user'
            : 'Refresh-token reuse detected — revoking all tokens for user'
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
          graceUsesSpent: claim.spent,
          graceUsesAllowed: ROTATION_RACE_MAX_GRACE_USES,
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

    // Reject refresh for a non-active account. S3-1, 2026-09-22 security
    // audit: this is one of the two places a NEW valid session can be minted
    // (the other is issueSessionFor, reached from login() AND
    // /auth/mfa/verify, which checks status itself — #1864; super_admin
    // impersonation in admin.routes.ts signs its own short-lived access token
    // and is an operator action, not a user session) — without this check, an already-open
    // session on a suspended user kept refreshing forever, independent of
    // whether the admin PUT handler also revoked the row (belt and braces
    // with the revokeAllSessions call added to that handler).
    if (storedToken.user.status !== 'active') {
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date(), revokedReason: 'account_suspended' },
      });
      throw new AppError(401, 'ACCOUNT_SUSPENDED', 'Account is not active');
    }

    // Generate new tokens FIRST so we have the new id available for the
    // back-link. Then mark the old token as rotated. Order matters: if
    // generateTokens fails after we've already revoked the old token,
    // the user is logged out without a replacement.
    // L4 fix: pass the live tokenVersion so refreshed access tokens carry
    // the current tv and are not spuriously rejected by the tv check in
    // authenticate() when the user's tokenVersion has been bumped since
    // the original access token was issued.
    const newTokens = await this.generateTokens(
      {
        userId: storedToken.user.id,
        email: storedToken.user.email,
        role: storedToken.user.role,
        storeId: storedToken.user.storeId,
        tv: storedToken.user.tokenVersion,
      },
      // A rotation renews the clock; being forgiven for a replay does not.
      // On the race path the caller is holding a token it already had, so it
      // gets back what was left of that token's life rather than a fresh
      // year — replaying a nine-month-old stolen token cannot manufacture a
      // new twelve-month session out of a thirty-second window.
      storedToken.revokedAt ? storedToken.expiresAt : undefined
    );

    const newHash = crypto.createHash('sha256').update(newTokens.refreshToken).digest('hex');
    const newRow = await prisma.refreshToken.findUnique({
      where: { token: newHash },
      select: { id: true },
    });

    // Only the row that is still live gets marked rotated. On the race path
    // the row is ALREADY revoked, and rewriting `revokedAt` to now would slide
    // the grace window forward on every replay — turning a 30-second exemption
    // into an indefinite one for anyone holding that token.
    //
    // The write is conditional on the row STILL being live, not on the read
    // from the top of this function. Two requests rotating the same live row
    // both passed that read; an unconditional `update` would let the second
    // overwrite `replacedById`, orphaning the first successor and leaving the
    // chain walk following a branch whose tip is dead. Compare-and-set means
    // the first rotation wins and the second is a no-op — the second caller
    // still keeps the tokens it minted, which is the race resolving, not an
    // error.
    if (!storedToken.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { id: storedToken.id, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedReason: REASON_ROTATED,
          replacedById: newRow?.id ?? null,
        },
      });
    }

    // The liveness check above and the row just written are not one atomic
    // step. A `revokeAllSessions` — sign-out-everywhere, a password change, a
    // password reset — landing between them revokes the rows it can see and
    // never sees this one, so the session it was answering would outlive it.
    // Every one of those paths increments `tokenVersion` first, so re-reading
    // it after the write is a cheap primary-key check that closes the window:
    // if it moved, the revocation happened under us and this token dies with
    // the rest.
    const currentVersion = await getUserState(storedToken.userId);
    if (!currentVersion || currentVersion.tokenVersion !== storedToken.user.tokenVersion) {
      await prisma.refreshToken.updateMany({
        where: { token: newHash, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'revoke_all' },
      });
      logger.warn(
        { userId: storedToken.userId, tokenId: storedToken.id },
        'Sessions revoked while a refresh was in flight — discarding the new token'
      );
      throw new AppError(401, 'TOKEN_REVOKED', 'Session was revoked — please sign in again');
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
    const user = await withUser(userId, tx =>
      tx.user.findUnique({
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
      })
    );

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    return user;
  }

  static async updateProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; phone?: string }
  ) {
    return withUser(userId, async () => {
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
    });
  }

  static async changePassword(userId: string, currentPassword: string, newPassword: string) {
    // Needs the hash to verify the CURRENT password — opt back in by name.
    const user = await withUser(userId, tx =>
      tx.user.findUnique({
        where: { id: userId },
        omit: { passwordHash: false },
      })
    );
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    await withUser(userId, tx =>
      tx.user.update({
        where: { id: userId },
        data: { passwordHash },
      })
    );

    // ONE call, and it runs BEFORE anything else observes the change.
    //
    // This used to revoke the rows first and bump `tokenVersion` second. That
    // ordering is backwards for the mid-flight guard in `refreshTokens`,
    // which re-reads `tokenVersion` after writing its new row to find out
    // whether a revocation landed underneath it: a refresh could read tv=N,
    // have this revoke commit (unable to see a row that does not exist yet),
    // create its row, re-read tv — still N, because the bump had not run —
    // and be handed a live session that outlives the password change. Bumping
    // first is what makes that re-read able to observe anything.
    //
    // `revokeAllSessions` also supersedes the old `updateMany`: it revokes
    // every live row for the user, warms the Redis tv cache, and revokes the
    // merchant MCP keys. The old query's `NOT: { token: { startsWith:
    // 'reset:' } }` filter was already ineffective, since the unconditional
    // call on the next line revoked those rows anyway.
    await AuthService.revokeAllSessions(userId, 'password_changed');
  }

  /**
   * Increment tokenVersion in DB + cache, and revoke all active refresh
   * tokens for the user. Any issued access token carrying an older `tv`
   * claim will be rejected by the authenticate middleware on next request.
   * Fail-open: if Redis is unavailable, the DB increment is still written
   * and the next authenticate call will re-populate the cache from DB.
   */
  static async revokeAllSessions(
    userId: string,
    reason: 'revoke_all' | 'password_changed' | 'password_reset' = 'revoke_all'
  ): Promise<void> {
    // Atomically increment tokenVersion and read the new value — and revoke the
    // user's merchant MCP keys in EVERY store they hold one for. One definer call
    // (`ebda_user_revoke_sessions`): it runs inside the caller's transaction (so
    // an ambient request transaction stays atomic with it, #1859), and it is the
    // only way to reach another user's row or another store's keys under strict
    // RLS. A partial "sign out all devices" is worse than a failed one, so the
    // key revocation is not left to a store-scoped query.
    //
    // The definer only answers the user themself, a super_admin, or a caller scoped
    // to the user's own store (SQLSTATE 42501 otherwise). With an ambient
    // transaction the request's own scope decides (admin editing a user, a
    // merchant acting on its customer). With none (logout-all, password change,
    // MFA change, and a password reset whose token was just validated) the caller
    // has already established that it is acting for this user, so the call runs AS
    // that user, in its own short transaction that commits before the cache push.
    const updated = hasTenantContext()
      ? await revokeUserSessionsRow(userId)
      : await withUser(userId, () => revokeUserSessionsRow(userId));

    // Warm the Redis cache with the new version so the middleware sees it
    // immediately without a DB round-trip on the next request.
    //
    // Deferred (#1859, 2026-09-25): Redis has no rollback. Awaiting this
    // inline — inside a caller's ambient tenant transaction (e.g.
    // `PUT /admin/users/:id`) — bumps the cache before that transaction's own
    // COMMIT. A later COMMIT or audit-log failure then rolls back Postgres
    // while Redis keeps the bumped tokenVersion: every access token for this
    // user is permanently rejected with no DB row recording why, and no
    // retry path recovers it. `deferAfterTenantCommit` fires this only once
    // the ambient transaction has actually committed, and DROPS it if the
    // transaction rolled back — matching `eraseAccount`'s propagation above.
    // Outside a request transaction (Inngest, scripts, self-service auth
    // routes with no ambient tx) it still runs inline, unchanged.
    //
    // Awaited: when deferred it resolves at once; inline (logout-all, password
    // change/reset, MFA changes) the caller's success now means the cache
    // holds the bump. A failed push is never quiet — see pushTokenVersion
    // (issue 2062).
    await deferAfterTenantCommit('auth.revokeAllSessions.setTokenVersion', () =>
      pushTokenVersion(userId, updated.tokenVersion, 'auth.revokeAllSessions.setTokenVersion')
    ).catch(err =>
      logger.error({ err, userId }, '[auth.revokeAllSessions] tokenVersion push failed')
    );

    // Revoke all live refresh tokens — prevents session resumption via
    // token rotation even before the access token's tv is checked.
    //
    // The caller names the reason. `revokedReason` is the only forensic record
    // of WHY a session died — docs/audits/2026-05-28-auth-access-audit.md
    // reads `password_reset` off these rows to tell a redeemed reset from a
    // sign-out — so folding a password change or reset into a generic
    // `revoke_all` would buy correct ordering at the cost of the audit trail.
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });

    // Belt and braces on top of the revoke above (S5-1, 2026-09-22 security
    // audit): password-reset rows are stored as `reset:<hash>` RefreshToken
    // rows and are already covered by the unconditional `updateMany` above
    // (it has no `token` filter), so this is a second, explicit guarantee —
    // not a fix for a gap the updateMany leaves open — that no outstanding
    // reset link survives a revocation. Deleting rather than revoking mirrors
    // resetPassword's own single-use cleanup (it deletes the row it redeems).
    await prisma.refreshToken.deleteMany({
      where: { userId, token: { startsWith: 'reset:' } },
    });
  }

  static async requestPasswordReset(email: string, storeId: string | null = null): Promise<void> {
    // Tenant-scoped lookup so a Store A reset request doesn't leak the
    // existence of an account on Store B with the same email.
    const user = await findUserInScope(
      email,
      storeId,
      {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          storeId: true,
          language: true,
        },
      },
      { includeDeleted: true }
    );

    if (!user) {
      // Silently return to prevent email enumeration
      return;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    // 15 minutes (S5-2, 2026-09-22 security audit — was 1 hour). A reset
    // link outstanding for an hour is an hour-long window for a forwarded
    // or intercepted email to take over the account.
    const RESET_TOKEN_TTL_MINUTES = 15;
    const resetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

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
          expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
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

    // Find the reset token. `revokedAt: null` mirrors the check the refresh
    // path already makes (see the reuse-detection block in refreshTokens
    // above): without it, a reset link that `revokeAllSessions` already
    // revoked (by an intervening password change, or by redeeming a sibling
    // reset link) was still redeemable — the token lookup never looked at
    // whether the row had been revoked at all. S5-1, 2026-09-22 security audit.
    const storedToken = await prisma.refreshToken.findFirst({
      where: {
        token: `reset:${tokenHash}`,
        expiresAt: { gt: new Date() },
        revokedAt: null,
      },
    });

    if (!storedToken) {
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid or expired reset token');
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

    // Update user password (as that user: `users` is RLS-scoped to app.current_user_id)
    await withUser(storedToken.userId, tx =>
      tx.user.update({
        where: { id: storedToken.userId },
        data: { passwordHash },
      })
    );

    // Delete the reset token (single-use, no reuse-detection value).
    await prisma.refreshToken.delete({
      where: { id: storedToken.id },
    });

    // Revoke all sessions — same call, and the same ordering, as
    // changePassword. The reset-token row was already deleted above.
    //
    // This used to be a bare `updateMany` that never touched `tokenVersion`,
    // which had two consequences. The mid-flight guard in `refreshTokens` was
    // a NO-OP on this path — it arbitrates on a tv that a reset never moved,
    // so a refresh racing the reset kept its new session. And, independently
    // of any race, every access token already issued survived the reset for
    // the rest of its lifetime: a password CHANGE killed them immediately, a
    // password RESET did not — and a reset is the one a compromised user
    // performs precisely because they believe someone else is holding their
    // credentials.
    await AuthService.revokeAllSessions(storedToken.userId, 'password_reset');
  }

  /**
   * Irreversible PII anonymization (GDPR Art. 17 and applicable GCC
   * data-protection law — see docs/legal/gcc-data-protection.md).
   *
   * Wipes every personally-identifying field on the user and removes child
   * rows that have no audit/financial basis (addresses, push subs, cart,
   * wishlist, abandoned-cart, refresh tokens). Orders + reviews + returns
   * keep their structure but lose their tie to the now-anonymized user
   * (orders preserve totals/line-items/order-number for Egypt MOF's ≥5y
   * invoice-retention requirement; shipping/billing address JSON snapshots
   * are scrubbed since they store the same PII as the addresses table).
   * The merchant-CRM copy of the same shopper (`customers` +
   * `customer_addresses`, matched by phone/email because it has no FK to
   * `users`) is scrubbed/deleted too — otherwise an "erased" shopper stays
   * fully readable in the customers list, group queries and the bot.
   *
   * Idempotent: re-running on an already-erased account is a no-op (the
   * second call's `update` succeeds with the same data, the `deleteMany`s
   * delete zero rows, and the wallet forfeit finds every balance at 0 so it
   * writes neither a ledger entry nor a `customer.wallet.erased` audit row). Callers should still clear auth cookies on the
   * client side after the response.
   *
   * NOT a soft-delete superset — soft-deleted accounts still expose PII
   * and only `eraseAccount` makes the user actually disappear.
   *
   * `opts.scopeStoreId` (owner decision 2026-09-26, Ruling W-7): a store
   * deletes ONLY its own data. The merchant route passes its store id; the
   * erasure then refuses any account that is not that store's own customer
   * and limits the wallet forfeit to that store. The shopper's own erasure
   * and the retention cron pass no scope and may span every store.
   * `opts.actorId` (a user id, or 'system') is recorded on the wallet ledger
   * and on the per-store audit rows of a cross-store erasure.
   */
  static async eraseAccount(
    userId: string,
    opts: { scopeStoreId?: string; actorId?: string } = {}
  ): Promise<EraseOutcome> {
    const actorId = opts.actorId ?? 'system';
    const eraseUserSelect = {
      id: true,
      storeId: true,
      role: true,
      avatar: true,
      // Needed to reach the `customers` CRM row, which is keyed by
      // phone/email rather than by a FK to `users` — see the scrub
      // inside `anonymize` below.
      email: true,
      phone: true,
    } as const;
    // Merchant route: the ambient store transaction already shows the shopper
    // (users.store_id = its store). Self-service and the retention cron have no
    // ambient scope — or the shopper belongs to another store — so read them as
    // themselves (`users` is RLS-scoped to app.current_user_id).
    const user =
      (hasTenantContext()
        ? await prisma.user.findUnique({
            where: { id: userId, storeId: currentStoreId() },
            select: eraseUserSelect,
          })
        : null) ??
      (await withUser(userId, tx =>
        tx.user.findUnique({ where: { id: userId }, select: eraseUserSelect })
      ));
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
    // A store-scoped erasure may only erase that store's own customer: every
    // row it then clears belongs to that store. (A legacy store_id = NULL
    // account spans stores and is erased only by the shopper or the cron.)
    if (opts.scopeStoreId !== undefined && user.storeId !== opts.scopeStoreId) {
      throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    }

    const anonymizedEmail = `erased-${user.id}@anonymized.local`;
    const anonymizedAddressJson = { anonymized: true } as const;

    // The `customers` table is a SECOND copy of the same shopper's PII
    // (email, firstName, lastName, phone, notes + a `customer_addresses`
    // child table) that the merchant CRM, customer groups and the WhatsApp
    // bot read from. It has NO foreign key to `users` — it is keyed by
    // phone/email — so none of the `userId`/`customerId` deletes below can
    // reach it. It is resolved at the scrub site below, and BOTH identifiers
    // require a single-row match — deliberately NOT the
    // `OR: [{phone}, {email}]` the rest of the codebase uses for LOOKUP
    // (customers.routes.ts group lookup). A read that returns an extra row
    // merely shows the merchant too much; this WRITE would destroy that extra
    // person's record, so the same heuristic is not safe here.

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

    // Set by `anonymize` below: the user's token version after the erase bumps it.
    let erasedTokenVersion: number | undefined;
    // What the merchant-CRM scrub actually did (#1880) — returned to the
    // caller so a partial erasure is recorded and shown, not just logged.
    const outcome: EraseOutcome = { crmChecked: false, crmRowsScrubbed: 0, crmAmbiguous: false };

    const anonymize = async (tx: Prisma.TransactionClient) => {
      // The ambient store of this erasure: the shopper's own store (self-service,
      // retention cron) or the merchant route's store (== user.storeId, checked above).
      const eraseStoreId = user.storeId ?? currentStoreId();
      // Orders: preserve for tax records (Egypt MOF ≥5y), drop the PII.
      // The customer FK is already `onDelete: SetNull` but we explicitly
      // null it so the row's history loses the back-reference even before
      // the user row is deactivated. Address JSON snapshots get scrubbed
      // because they duplicate the now-deleted addresses table data.
      await tx.order.updateMany({
        where: { customerId: userId, storeId: eraseStoreId },
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
        where: { customerId: userId, storeId: eraseStoreId },
        data: { customerId: null },
      });

      // Pure-PII child rows — no business reason to retain. The FK
      // column names vary across models (some use `userId`, some
      // `customerId`) — match each model's actual schema.
      // `addresses` is the ONE erasure target with a USER-scoped RLS policy
      // (`user_id = app.current_user_id`). On the merchant-initiated path the
      // GUC is the MERCHANT's id, not the shopper's, so a plain deleteMany would
      // match ZERO rows with NO error and an "erased" account would keep the
      // shopper's name, phone, block/street and postal code. A definer
      // (`ebda_user_addresses_delete`) deletes by the shopper's id INSIDE this
      // transaction, so it stays atomic with the rest of the erasure (a second
      // connection would commit independently — the hazard eraseAccount was
      // moved off).
      await deleteUserAddresses(userId);

      await tx.abandonedCart.deleteMany({ where: { customerId: userId, storeId: eraseStoreId } });
      await tx.cart.deleteMany({ where: { customerId: userId, storeId: eraseStoreId } });
      await tx.wishlist.deleteMany({ where: { userId, storeId: eraseStoreId } });
      await tx.pushSubscription.deleteMany({
        where: { customerId: userId, storeId: eraseStoreId },
      });
      await tx.oneSignalSubscription.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.verificationToken.deleteMany({ where: { userId } });
      await tx.loyaltyTransaction.deleteMany({
        where: { customerId: userId, storeId: eraseStoreId },
      });
      await tx.loyaltyPoints.deleteMany({ where: { customerId: userId, storeId: eraseStoreId } });

      // Customer wallet (D1, Ruling W-4). Unlike loyalty, the wallet ledger is
      // a FINANCIAL record of money the merchant owed and paid out, so it is
      // kept — it carries no PII once its one free-text field (`note`) is
      // nulled. Any remaining balance is written off with an `expire` entry:
      // the anonymized account can no longer sign in to spend it, and leaving
      // it would overstate the merchant's outstanding store-credit liability
      // forever. Runs on this erasure transaction, so it is atomic with it.
      await WalletService.forfeitOnErasure(userId, tx, {
        storeId: opts.scopeStoreId ?? null,
        actorId,
      });

      // Merchant-CRM copy of the same identity (`customers` +
      // `customer_addresses`). Without this the shopper's name, email,
      // phone, notes and street addresses stay fully readable after an
      // "erase" — in customer-group queries, the customers list and the
      // WhatsApp bot — while the audit row claims the account was erased.
      // Store-scoped, so a shared phone/email across tenants only ever
      // erases THIS store's copy.
      if (user.storeId && (user.email || user.phone)) {
        // Resolve the CRM row by the STRONGEST available identifier, and refuse
        // to act on an ambiguous one.
        //
        // The previous `OR: [{phone}, {email}]` was destructive in one
        // direction: two shoppers in the same store sharing a phone — a
        // household mobile, a landline given at checkout, the same contact
        // number typed onto two rows, all ordinary in Egypt — meant erasing
        // shopper A hard-deleted shopper B's `customer_addresses` and
        // overwrote B's name/email/phone/notes with "Erased User". That is
        // irreversible destruction of a SECOND data subject's record from a
        // request that only authorised erasure of the first.
        //
        // NEITHER identifier is trusted without a count check, and the
        // EMAIL branch is the one that can actually collide.
        //
        // The earlier version trusted email on the grounds that `customers`
        // carries `@@unique([storeId, email])`. That index is a plain,
        // case-SENSITIVE Postgres unique, and nothing lowercases email on
        // write, so `Ahmad@gmail.com` and `ahmad@gmail.com` are two legal,
        // distinct rows in one store — and this read uses `mode:
        // 'insensitive'`, so it returns BOTH. Scrubbing both destroys a second
        // data subject exactly as the shared-phone case would.
        //
        // The phone branch, meanwhile, is guarded against something
        // `@@unique([storeId, phone])` already forecloses: `byPhone.length > 1`
        // cannot happen. Its guard is kept as a cheap invariant assertion (the
        // index could be relaxed later), but it is NOT the one that protects
        // anyone today — that is the email guard below.
        //
        // Both branches therefore require an unambiguous, single-row match. An
        // ambiguous match scrubs NOTHING and says so: a compliance gap someone
        // can act on beats destroying the wrong person's record.
        outcome.crmChecked = true;
        const crmIdSet = new Set<string>();

        if (user.email) {
          const byEmail = await tx.customer.findMany({
            where: { storeId: user.storeId, email: { equals: user.email, mode: 'insensitive' } },
            select: { id: true },
          });
          if (byEmail.length === 1) {
            crmIdSet.add(byEmail[0].id);
          } else if (byEmail.length > 1) {
            outcome.crmAmbiguous = true;
            logger.warn(
              { userId, storeId: user.storeId, matches: byEmail.length },
              '[auth.eraseAccount] CRM email match is ambiguous (case-variant rows) — scrubbing no email-matched row rather than erasing another data subject'
            );
          }
        }

        if (user.phone) {
          const byPhone = await tx.customer.findMany({
            where: { storeId: user.storeId, phone: user.phone },
            select: { id: true },
          });
          if (byPhone.length === 1) {
            crmIdSet.add(byPhone[0].id);
          } else if (byPhone.length > 1) {
            outcome.crmAmbiguous = true;
            logger.warn(
              { userId, storeId: user.storeId, matches: byPhone.length },
              '[auth.eraseAccount] CRM phone match is ambiguous — scrubbing no phone-matched row rather than erasing another data subject'
            );
          }
        }

        const crmRows = [...crmIdSet].map(id => ({ id }));
        if (crmRows.length === 0) {
          // Previously silent. A differently-normalised phone (+20… vs 20…)
          // and a changed email match nothing, so the shopper stays readable in
          // the customers list, group queries and the bot while the audit row
          // records a completed erasure.
          logger.warn(
            { userId, storeId: user.storeId },
            '[auth.eraseAccount] no CRM customer row matched — the merchant copy may survive this erasure'
          );
        }
        if (crmRows.length > 0) {
          const crmIds = crmRows.map(c => c.id);
          // Addresses hold nothing but PII — hard delete, same as
          // `addresses` above.
          await tx.customerAddress.deleteMany({ where: { customerId: { in: crmIds } } });
          // The row itself is scrubbed rather than deleted: totalOrders /
          // totalSpent / groupId are merchant analytics over orders that
          // are themselves retained for Egypt MOF, and carry no PII once
          // the identity fields are gone. Each row gets its OWN anonymized
          // email (keyed on the customer id, not the user id) so the
          // composite-unique (storeId, email) cannot collide when a
          // phone-matched and an email-matched row are both erased.
          for (const id of crmIds) {
            await tx.customer.update({
              where: { id, storeId: user.storeId },
              data: {
                email: `erased-${id}@anonymized.local`,
                firstName: 'Erased',
                lastName: 'User',
                phone: null,
                notes: null,
                preferredLocale: null,
                lastLocaleChoice: null,
              },
            });
          }
          outcome.crmRowsScrubbed = crmIds.length;
        }
      }

      // Newsletter + email-campaign copies of the same address (D2,
      // 2026-09-25). Both are keyed by (store, email) with no FK to `users`,
      // and newsletter emails are lowercased on write, so an exact match on
      // the lowercased address is exactly this data subject in this store —
      // no ambiguity guard is needed here, unlike the CRM branch above.
      // Hard delete: a subscription row is nothing but the address + consent,
      // and a recipient row is nothing but the address + send status. The
      // campaign's aggregate counts survive on `campaigns`.
      //
      // EXCEPT a recipient row SENT inside the rolling send-cap window: the
      // platform-wide cap (`sentInLast24h`) counts those rows, so deleting one
      // hands the store back send headroom on the shared Resend key (issue
      // 2083). Those rows are anonymized instead — the address becomes a
      // per-row tombstone (unique per campaign) and every other link is
      // dropped — so the send still counts and no PII remains.
      if (user.storeId && user.email) {
        const normalizedEmail = user.email.trim().toLowerCase();
        const capWindowStart = new Date(Date.now() - SEND_CAP_WINDOW_MS);
        const inWindow = await tx.campaignRecipient.findMany({
          where: {
            storeId: user.storeId,
            email: normalizedEmail,
            sentAt: { gte: capWindowStart },
          },
          select: { id: true },
        });
        for (const r of inWindow) {
          await tx.campaignRecipient.update({
            where: { id: r.id, storeId: user.storeId },
            data: {
              email: `erased-${r.id}@anonymized.local`,
              subscriberId: null,
              customerId: null,
              providerMessageId: null,
              error: null,
            },
          });
        }
        await tx.campaignRecipient.deleteMany({
          where: { storeId: user.storeId, email: normalizedEmail },
        });
        await tx.newsletterSubscriber.deleteMany({
          where: { storeId: user.storeId, email: normalizedEmail },
        });
      }

      // SMS-marketing consent (issue 206). Every row of the shopper's own
      // (customerKey = user id), plus — in the account's store — the rows a
      // guest checkout left under the same lowercased email or the same phone.
      // Deleting consent can only ever STOP promotional SMS (no row = no send),
      // so matching broadly here is the safe direction, unlike the CRM scrub.
      const smsConsentOr: Prisma.SmsMarketingConsentWhereInput[] = [
        { userId },
        { customerKey: userId },
      ];
      if (user.storeId) {
        if (user.email) {
          smsConsentOr.push({
            storeId: user.storeId,
            customerKey: user.email.trim().toLowerCase(),
          });
        }
        const phoneKey = smsConsentPhoneKey(user.phone);
        if (phoneKey) smsConsentOr.push({ storeId: user.storeId, phoneKey });
      }
      await tx.smsMarketingConsent.deleteMany({
        where: {
          storeId: opts.scopeStoreId ?? eraseStoreId,
          OR: smsConsentOr,
        },
      });

      // Finally rewrite the user row itself. Password hash is regenerated
      // from random bytes so a stolen DB snapshot can't be cracked back
      // into the original credential. Email is rewritten (not nulled) so
      // the composite-unique (storeId, email) index has no collision risk
      // if the same address is re-registered later.
      //
      // `tokenVersion` is bumped IN the same write (#1871): deleting the
      // refresh rows stops the NEXT session, but every access token already
      // issued carries the old `tv`, and `authenticate` only reads `status` on
      // a tv-cache miss — so without the bump the erased shopper (on the
      // merchant path, not even the actor) kept a working 30-minute session
      // that could write a name/phone straight back onto this row. Atomic with
      // the erase, so a rolled-back erase does not revoke anything.
      const erased = await tx.user.update({
        where: { id: userId, ...(user.storeId ? { storeId: user.storeId } : {}) },
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
          tokenVersion: { increment: 1 },
        },
        select: { tokenVersion: true },
      });
      erasedTokenVersion = erased?.tokenVersion;
    };

    if (hasTenantContext()) {
      // Store-scoped request (POST /stores/:storeId/customers/:customerId/erase)
      // — the whole request ALREADY runs in one tenant transaction, and
      // `withMoneyTx` is `prisma.$transaction`, which the tenant proxy
      // deliberately does NOT forward (see `hasTenantContext`'s doc comment in
      // packages/database/src/index.ts). Calling it here would open a SECOND
      // connection with neither `app.current_store_id` nor `app.current_user_id`
      // SET LOCAL, so every anonymizing write below would run RLS-contextless —
      // the tenant backstop silently off for an irreversible PII-destroying
      // write — and, worse, it would COMMIT INDEPENDENTLY of the request. If
      // anything later in that request aborted the outer transaction (a poisoned
      // statement → 25P02, or a failed COMMIT that `middleware/request-transaction.ts`
      // turns into a 500), the shopper's PII would already be irreversibly gone
      // while the `customer.account.erased_by_merchant` audit row rolled back and
      // the merchant was told the operation failed: an unlogged, unrecoverable
      // deletion. Staying on the ambient transaction makes erasure and its audit
      // row atomic and keeps both GUCs in force. Same shape as `CartService.addItem`.
      await anonymize(prisma as unknown as Prisma.TransactionClient);
    } else {
      // No tenant context — self-service `POST /auth/me/erase`, the
      // `soft-deleted-user-anonymize` retention cron, scripts. Own transaction
      // (same 10s/30s limits as `withMoneyTx`) scoped to the shopper's store AND
      // to the shopper: the store GUC reaches their carts, CRM row and consents,
      // the user GUC their `users` row.
      await runInTenantContext(
        user.storeId ?? undefined,
        () => anonymize(prisma as unknown as Prisma.TransactionClient),
        userId
      );
    }

    // Push the bumped token version into the tv cache the authenticate
    // middleware reads FIRST — a warm cache still holding the old version
    // would keep accepting the old access tokens (the cache key has no TTL).
    // Same step `revokeAllSessions` performs. Deferred so the ambient-tx
    // branch only revokes once the erase has COMMITTED; inline (awaited)
    // everywhere else. The erasure itself never fails on this (the DB bump
    // stands), but a push that cannot land is ALERTED, not warned — on the
    // inline cron path a swallowed warn left every erased user's old access
    // tokens valid against the stale cache (issue 1964). See pushTokenVersion.
    if (erasedTokenVersion !== undefined) {
      const tv = erasedTokenVersion;
      await deferAfterTenantCommit('auth.eraseAccount.revoke-sessions', () =>
        pushTokenVersion(userId, tv, 'auth.eraseAccount.revoke-sessions')
      ).catch(err =>
        logger.error({ err, userId }, '[auth.eraseAccount] token-version push failed')
      );
    }

    // The avatar URL was just nulled out of the DB — clean up R2 after
    // the transaction commits. Best-effort, same pattern as other cleanup
    // sites: never let storage hiccups propagate to the caller.
    if (user.avatar) {
      void deleteR2ObjectIfOrphan(user.avatar).catch(err =>
        logger.warn({ err, userId }, '[auth.eraseAccount] r2 avatar cleanup failed')
      );
    }

    // Third-party deletion propagation (GDPR Art. 17 and applicable GCC
    // data-protection law — see docs/legal/gcc-data-protection.md):
    // OneSignal + PostHog. Fire-and-forget, same discipline as the
    // R2 cleanup above — a dead Inngest connection must never surface as a
    // failed erase. See lib/inngest/functions/account-erased-propagation.ts +
    // services/privacy-propagation.service.ts.
    //
    // Deferred, because on the ambient-transaction branch above the
    // anonymization has NOT committed yet: sending inline would ask OneSignal
    // and PostHog to irreversibly delete the person for an erasure the request
    // may still roll back. `deferAfterTenantCommit` fires it after COMMIT and
    // DROPS it if the transaction failed. Outside a request (self-service,
    // retention cron) it runs inline, unchanged.
    void deferAfterTenantCommit('auth.eraseAccount.propagate', () =>
      inngest.send({ name: 'account/erased', data: { userId, oneSignalPlayerIds } })
    ).catch(err =>
      logger.warn({ err, userId }, '[auth.eraseAccount] account/erased enqueue failed')
    );

    return outcome;
  }

  /**
   * Right to data portability (GDPR Art. 20 and applicable GCC
   * data-protection law — see docs/legal/gcc-data-protection.md).
   *
   * Returns every row across the schema that ties back to this user as a
   * single JSON bundle. Intentionally returns the raw shape — the
   * exported file is the user's data, not a marketing surface, so field
   * names match the schema for transparency.
   */
  static async exportAccount(userId: string) {
    const user = await withUser(userId, tx =>
      tx.user.findUnique({
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
      })
    );
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    // The shopper's rows live in their store. A self-service export has no
    // ambient scope, so gather them under the shopper's store + user; on the
    // merchant route the request transaction is already that store's.
    const gather = () => AuthService.gatherExport(userId, user);
    return hasTenantContext()
      ? gather()
      : runInTenantContext(user.storeId ?? undefined, gather, userId);
  }

  private static async gatherExport(
    userId: string,
    user: { id: string; storeId: string | null } & Record<string, unknown>
  ) {
    // The ambient store of this export: the shopper's own store, or the
    // merchant route's store.
    const storeId = user.storeId ?? currentStoreId();
    const [
      addresses,
      orders,
      abandonedCarts,
      wishlists,
      reviews,
      returns,
      loyaltyPoints,
      loyaltyTransactions,
      wallets,
      walletTransactions,
      pushSubscriptions,
      onesignalSubscriptions,
      smsMarketingConsents,
    ] = await Promise.all([
      // Same user-scoped RLS policy as the erase path above: on the
      // merchant-initiated export `current_user_id()` is the MERCHANT, so a
      // plain read returns an EMPTY addresses section and ships an incomplete
      // Art. 20 portability bundle that looks complete. `withUser` reads them AS
      // the shopper — unlike the erase, this is read-only, so a second
      // connection carries no atomicity or independent-commit hazard.
      withUser(userId, tx => tx.address.findMany({ where: { userId } })),
      prisma.order.findMany({
        where: { customerId: userId, storeId },
        include: { items: true, payments: true },
      }),
      prisma.abandonedCart.findMany({ where: { customerId: userId, storeId } }),
      prisma.wishlist.findMany({ where: { userId, storeId } }),
      prisma.review.findMany({ where: { customerId: userId, storeId } }),
      prisma.return.findMany({ where: { customerId: userId, storeId } }),
      prisma.loyaltyPoints.findMany({ where: { customerId: userId, storeId } }),
      prisma.loyaltyTransaction.findMany({ where: { customerId: userId, storeId } }),
      // Customer wallet (D1): balance + full ledger — the customer's own money.
      prisma.customerWallet.findMany({
        where: { customerId: userId, storeId },
        select: { id: true, storeId: true, balance: true, createdAt: true, updatedAt: true },
      }),
      prisma.walletTransaction.findMany({
        where: { customerId: userId, storeId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          storeId: true,
          amount: true,
          balanceAfter: true,
          type: true,
          orderId: true,
          returnId: true,
          note: true,
          createdAt: true,
        },
      }),
      prisma.pushSubscription.findMany({
        where: { customerId: userId, storeId },
        select: { id: true, endpoint: true, createdAt: true },
      }),
      prisma.oneSignalSubscription.findMany({
        where: { userId },
        select: { id: true, playerId: true, createdAt: true },
      }),
      // SMS-marketing consent (issue 206): what was given, when, where, and
      // any withdrawal. Keyed by the user id (the shopper's own rows).
      prisma.smsMarketingConsent.findMany({
        where: { storeId, OR: [{ userId }, { customerKey: userId }] },
        select: {
          storeId: true,
          phone: true,
          granted: true,
          grantedAt: true,
          grantedSource: true,
          revokedAt: true,
          revokedSource: true,
          createdAt: true,
          updatedAt: true,
        },
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
      wallets,
      walletTransactions,
      pushSubscriptions,
      onesignalSubscriptions,
      smsMarketingConsents,
    };
  }

  /**
   * @param refreshRowExpiresAt When given, the stored refresh row expires then
   *   instead of a year from now. The JWT's own `exp` is untouched — the row
   *   is the shorter of the two and is what `refreshTokens()` checks, so an
   *   inherited expiry shortens the session without minting a token whose
   *   claims disagree with the database.
   */
  private static async generateTokens(
    payload: TokenPayload,
    refreshRowExpiresAt?: Date
  ): Promise<AuthTokens> {
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
    const defaultExpiresAt = new Date();
    defaultExpiresAt.setDate(defaultExpiresAt.getDate() + 365);
    // Never longer than the default: an inherited expiry may only shorten.
    const expiresAt =
      refreshRowExpiresAt && refreshRowExpiresAt < defaultExpiresAt
        ? refreshRowExpiresAt
        : defaultExpiresAt;

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
