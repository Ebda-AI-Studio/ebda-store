import { InstapayReceiptService } from './payment-providers/instapay-receipt.service';
import { scrubProviderVerifier } from './provider-verification.service';
import { redactWebhookCustomerData } from './webhook-erasure';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  eraseIdentityUser,
  exportIdentityUser,
  forgotIdentityPassword,
  getAccountState,
  getAccountsBrief,
  revokeIdentityIfManaged,
} from '../lib/identity-client';
import { postgresRemovedOnThisWorker } from '../lib/postgres-present';
import { hubOnD1, hubOwnedStores } from '../lib/platform-hub';
import { eraseHubUserData, exportHubUserPlatform } from './platform/hub-user-data';
import crypto from 'crypto';
import {
  prisma,
  Prisma,
  currentStoreId,
  hasTenantContext,
  runInTenantContext,
  withStore,
  withUser,
} from '@ebda/database';
import {
  deleteUserAddresses,
  deleteUserPasskeys,
  deleteUserTokens,
  findUserIdByEmail,
  getUserState,
  insertAuditLog,
  purgeRefreshTokens,
  refreshTokenUser,
  revokeUserSessionsRow,
  verificationTokenUser,
} from '../lib/definer';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { loginGate } from './login-gate';
import { redactOrderForCustomer } from './gold-rate/public';
import { announcePasskeyPurge } from './passkey-purge';
import { sendMerchantPasswordResetEmail, sendMerchantVerificationEmail } from './platform-mailer';
import { accountLockout } from './account-lockout.service';
import {
  BRAND_STORE_APP_URL,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_MFA_AUDIENCE,
  PASSWORD_RESET_TTL_MINUTES,
  registrationEventId as registrationEventIdFor,
  toE164,
} from '@ebda/shared';
import { cfWaitUntil } from '../cf/bindings';
import logger from '../lib/logger';
import { buyerKeyForErasure } from '../lib/wa/buyer-key';
import { exportCiOutcomes } from '../lib/ci/export';
import { ciSinceDay } from '../lib/ci/layout';
import {
  WhatsAppConsentService,
  lockAccountConsent,
  phoneOnOwnOrder,
  revokeForPhoneChangeInTx,
  revokeForPhoneChange,
} from '../lib/wa/consent';
import { maskEmail } from '../lib/pii-mask';
import { smsConsentPhoneKey } from '../lib/sms-consent';
import { redis } from './redis.service';
import { deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { sendAlert } from './alerts.service';
import { SEND_CAP_WINDOW_MS } from './campaign.service';
import { storeDb, storeRepo } from '../lib/repo-factory';
import { inngest } from '../lib/inngest/client';
import { WalletService } from './wallet.service';
import { emitEbdaConversion } from './ebda-ads-emit';
import { signSessionTokens } from './session-tokens';
import {
  clientForScopedToken,
  customerAuthRoute,
  type CustomerAuthClient,
} from '../lib/customer-auth';
import { doStoreIdList, hasStoresOnBackend, storeDo } from '../lib/store-backend';
import { scrubOrEnqueue } from '../lib/customer-pg-scrub';
import { CustomerAuthFlows, type DoCustomer } from './customer-auth-flows';
import { verifyRefreshJwt } from '../middleware/security';

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

/** Password-reset link lifetime (minutes): the shared constant, see @ebda/shared auth-policy. */
export const RESET_TOKEN_TTL_MINUTES = PASSWORD_RESET_TTL_MINUTES;

/**
 * Origin of the Ebda Store merchant app for links in platform mail. Production
 * pins it to the BRAND host, so a mis-set ADMIN_URL can never point a reset
 * link (a bearer credential) at another host; elsewhere ADMIN_URL so local and
 * CI runs get a followable localhost link.
 */
export function storeAppOrigin(): string {
  return config.nodeEnv === 'production' ? BRAND_STORE_APP_URL : config.adminUrl;
}

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
 * Ruling B1-13: the demo showroom's seeded owner (`storedemo-owner@ebda.app`) has no mailbox and
 * no login. Account mail for it is never sent (a bounce hurts the sender's reputation); callers
 * answer exactly as for an unknown address, so nothing about the account is revealed.
 */
async function ownsDemoStore(userId: string): Promise<boolean> {
  const row = await withUser(userId, tx =>
    tx.store.findFirst({ where: { ownerId: userId, isDemo: true }, select: { id: true } })
  );
  return row !== null;
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

const PROFILE_SELECT = {
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
} as const;

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
    // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash -- dummy hash for timing equalisation (random plaintext discarded), not a credential
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

    // N-9: a DO store's customers live in its StoreDO (marker on); otherwise Postgres, refused while frozen for the copy.
    const route = await customerAuthRoute(storeId, { write: true });
    if (route.kind === 'do') {
      let first = data.firstName;
      let last = data.lastName;
      if (data.name && !first) {
        const parts = data.name.trim().split(' ');
        first = parts[0];
        last = parts.slice(1).join(' ') || '';
      }
      return CustomerAuthFlows.register(route.client, {
        email: data.email,
        password: data.password,
        firstName: first || '',
        lastName: last || '',
        language: data.language,
      });
    }

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
      const existingStoreId = existingUser.storeId;
      const storeName = existingStoreId
        ? (
            await withStore(existingStoreId, tx =>
              tx.store.findUnique({
                where: { id: existingStoreId },
                select: { name: true },
              })
            ).catch(() => null)
          )?.name
        : undefined;
      const recipientName =
        `${existingUser.firstName ?? ''} ${existingUser.lastName ?? ''}`.trim() ||
        existingUser.email;
      const notifyStoreId = storeId ?? existingUser.storeId;
      if (notifyStoreId) {
        void deferAfterTenantCommit('auth.duplicate-registration-notice', () =>
          EmailService.sendDuplicateRegistrationNotice(
            notifyStoreId,
            {
              email: existingUser.email,
              name: recipientName,
              storeName: storeName ?? undefined,
            },
            (existingUser.language as 'en' | 'ar' | undefined) ?? undefined
          )
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
    // Delete any existing verification tokens for this user. Token rows are
    // user-keyed (RLS on app.current_user_id): every write runs AS the user.
    await withUser(userId, tx =>
      tx.verificationToken.deleteMany({
        where: {
          userId,
          type: 'email',
        },
      })
    );

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
    await withUser(userId, tx =>
      tx.verificationToken.create({
        data: {
          token: tokenHash,
          userId,
          type: 'email',
          expiresAt,
        },
      })
    );

    // Send verification email
    if (storeId) {
      await EmailService.sendEmailVerification(
        storeId,
        {
          email,
          name,
          verificationPath: `/auth/verify-email?token=${token}`,
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
  static async verifyEmail(
    token: string
  ): Promise<{ success: boolean; message: string; registrationEventId?: string }> {
    // N-9: a token minted for a DO store carries its store id (lib/customer-auth.ts).
    const doClient = await clientForScopedToken(token);
    if (doClient) return CustomerAuthFlows.verifyEmail(doClient, token);

    // Hash the provided token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find the verification token: the presented token names its user through the
    // `ebda_verification_token_user` definer (it is the credential), and the row is
    // then read AS that user (`verification_tokens` is RLS-keyed on the user).
    const tokenOwner = await verificationTokenUser(tokenHash);
    const verificationToken = tokenOwner
      ? await withUser(tokenOwner, tx =>
          tx.verificationToken.findFirst({
            where: {
              userId: tokenOwner,
              token: tokenHash,
              type: 'email',
              usedAt: null,
            },
          })
        )
      : null;

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
      await withUser(verificationToken.userId, tx =>
        tx.verificationToken.delete({
          where: { id: verificationToken.id, userId: verificationToken.userId },
        })
      );
      throw new AppError(
        400,
        'TOKEN_EXPIRED',
        'Verification token has expired. Please request a new one.'
      );
    }

    if (tokenUser.emailVerified) {
      return { success: true, message: 'Email already verified' };
    }

    // N-9: refused (503) while the store's rows are frozen for the copy; and a pre-flip link of a store now served by its StoreDO
    // is invalid, never "verified" in the stale Postgres copy while the live account is unchanged.
    if ((await customerAuthRoute(tokenUser.storeId, { write: true })).kind === 'do')
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid verification token');

    // Update user as verified and mark token as used
    await withUser(
      verificationToken.userId,
      async tx => {
        await tx.user.update({
          where: { id: verificationToken.userId },
          data: { emailVerified: true },
        });
        await tx.verificationToken.update({
          where: { id: verificationToken.id, userId: verificationToken.userId },
          data: { usedAt: new Date() },
        });
      },
      tokenUser.storeId ?? undefined
    );

    // Welcome email is a follow-up — fire-and-forget so SMTP latency can't
    // delay the verify-email API response.
    if (tokenUser.storeId) {
      const welcomeStoreId = tokenUser.storeId;
      void deferAfterTenantCommit('auth.welcome-after-verify', () =>
        EmailService.sendWelcome(
          welcomeStoreId,
          {
            email: tokenUser.email,
            name: `${tokenUser.firstName} ${tokenUser.lastName}`.trim() || tokenUser.email,
          },
          (tokenUser.language as 'en' | 'ar' | undefined) ?? undefined
        )
      ).catch(err =>
        logger.error(
          { err, userId: verificationToken.userId },
          'Failed to send welcome email after verify'
        )
      );
    }

    // Ebda's own ads funnel: a MERCHANT (admin namespace, no storeId) just verified. The browser
    // fires CompleteRegistration with this id; the server twin dedups against it. Fail-open.
    let registrationEventId: string | undefined;
    if (!tokenUser.storeId) {
      registrationEventId = registrationEventIdFor(tokenUser.id);
      await emitEbdaConversion({
        name: 'CompleteRegistration',
        eventId: registrationEventId,
        userId: tokenUser.id,
      });
    }

    return { success: true, message: 'Email verified successfully', registrationEventId };
  }

  /**
   * Resend verification email. Storefront callers pass `storeId` so we
   * find the right tenant's account; admin app omits it.
   */
  static async resendVerificationEmail(
    email: string,
    storeId: string | null = null
  ): Promise<{ success: boolean; message: string }> {
    if (typeof email !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'Email is required');
    const route = await customerAuthRoute(storeId, { write: true });
    if (route.kind === 'do') return CustomerAuthFlows.resend(route.client, email);
    // NEON-ZERO (Ruling NZ-ACCT-1): no store + no Postgres = a merchant/staff address (identity-managed, ID-1..ID-11);
    // there is no user row to read, so answer the same enumeration-safe generic success a missing user gets.
    if (postgresRemovedOnThisWorker()) return { ...GENERIC_RESEND_VERIFICATION_RESULT };
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

    if (!user || (await ownsDemoStore(user.id))) {
      // Don't reveal if user exists (and never mail the demo owner, B1-13)
      return { ...GENERIC_RESEND_VERIFICATION_RESULT };
    }

    if (user.emailVerified) {
      return { success: true, message: 'Email is already verified' };
    }

    // Check if there's a recent verification token (within last 2 minutes) to prevent spam
    const recentToken = await withUser(user.id, tx =>
      tx.verificationToken.findFirst({
        where: {
          userId: user.id,
          type: 'email',
          createdAt: { gt: new Date(Date.now() - 2 * 60 * 1000) },
        },
      })
    );

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
    const route = await customerAuthRoute(storeId, { write: true });
    if (route.kind === 'do') return CustomerAuthFlows.login(route.client, email, password, ip);
    // No store: the admin namespace (merchants, staff, super admins), whose credentials live in the identity service. The answer
    // does not depend on the email or the password, so it needs no Postgres lookup and reveals nothing about any account.
    if (storeId === null && (await hasStoresOnBackend('do')) && !(await hasStoresOnBackend('pg')))
      throw new AppError(
        409,
        'USE_IDENTITY_SERVICE',
        'Sign in through the Ebda AI Studio account service'
      );

    const lockoutKey = loginGate.lockoutKey(email, storeId);
    await loginGate.assertNotLocked(lockoutKey);

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
      await loginGate.recordFailure(lockoutKey, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      const result = await loginGate.recordFailure(lockoutKey, ip);

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
    await loginGate.recordSuccess(lockoutKey, ip);

    // Reject non-active accounts. Checked AFTER the password is confirmed
    // correct (not before) — checking status before/instead of the password
    // would let a wrong-password guess distinguish "no such account",
    // "wrong password" and "suspended account" by response shape, reopening
    // the account-enumeration oracle the dummy-bcrypt-compare above exists to
    // close. S3-1, 2026-09-22 security audit: a super_admin who suspends a
    // compromised or departing account previously found the account could
    // still log in with its password — `status` was recorded but never read.
    loginGate.assertActive(user);

    // Merchants, staff and super admins sign in at the shared identity service (Rulings ID-1/ID-2). This legacy path would
    // accept a password hash the identity service no longer controls (a reset there would not reach it), so it is closed for
    // them: the right password here proves nothing and issues nothing.
    if (user.storeId === null && user.role !== 'customer') {
      throw new AppError(
        409,
        'USE_IDENTITY_SERVICE',
        'Sign in through the Ebda AI Studio account service'
      );
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
        issuer: JWT_ISSUER,
        // Distinct audience so this token is NEVER accepted by the authenticate
        // middleware (which requires audience:'ebda-app'). Belt-and-suspenders
        // against token-confusion attacks where the challenge is used as a
        // real access token before the second factor is verified.
        audience: JWT_MFA_AUDIENCE,
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
    // The only place a legacy (HS256) session is minted for a login: closed for identity-managed accounts, which sign in at
    // the identity service. Covers the passkey and MFA completions that reach here.
    if (user.storeId === null && user.role !== 'customer') {
      throw new AppError(
        409,
        'USE_IDENTITY_SERVICE',
        'Sign in through the Ebda AI Studio account service'
      );
    }

    // N-9: a passkey completion for a StoreDO customer mints its refresh row in the DO.
    const issueRoute = await customerAuthRoute(user.storeId, { write: true });
    if (issueRoute.kind === 'do')
      return CustomerAuthFlows.issueSession(issueRoute.client, user as unknown as DoCustomer);

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
    // `refresh_tokens` is user-keyed (RLS on app.current_user_id): read AS the user.
    const first = await withUser(userId, tx =>
      tx.refreshToken.findUnique({
        where: { id: replacedById, userId },
        select: { revokedAt: true, revokedReason: true, replacedById: true },
      })
    );
    if (!first) return false;
    if (!first.revokedAt) return true;
    if (!this.endedByRotation(first.revokedReason)) return false;
    if (!first.replacedById) return false;

    // A chain deeper than one hop. Every row in it was created inside the
    // grace window that led here, so it is part of this user's newest rows;
    // read that slice once and finish in memory rather than paying a
    // round-trip per remaining hop.
    const rows = await withUser(userId, tx =>
      tx.refreshToken.findMany({
        where: { userId },
        select: { id: true, revokedAt: true, revokedReason: true, replacedById: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
    );
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
    revokedReason: string | null,
    userId: string
  ): Promise<GraceClaim> {
    let reason = revokedReason;

    for (let attempt = 0; attempt <= ROTATION_RACE_MAX_GRACE_USES; attempt++) {
      const spent = this.graceUsesSpent(reason);
      if (spent >= ROTATION_RACE_MAX_GRACE_USES) return { claimed: false, exhausted: true, spent };

      const expected = reason;
      const claimed = await withUser(userId, tx =>
        tx.refreshToken.updateMany({
          where: { id: tokenId, userId, revokedReason: expected },
          data: { revokedReason: `${REASON_GRACE_PREFIX}${spent + 1}` },
        })
      );
      if (claimed.count > 0) return { claimed: true, exhausted: false, spent: spent + 1 };

      const fresh = await withUser(userId, tx =>
        tx.refreshToken.findUnique({
          where: { id: tokenId, userId },
          select: { revokedReason: true },
        })
      );
      // The row is gone — pruned, or deleted underneath us. That is not a
      // budget problem, and reporting it as one would blame the cap for
      // something the cap did not do.
      if (!fresh) return { claimed: false, exhausted: false, spent };
      reason = fresh.revokedReason;
    }

    return { claimed: false, exhausted: true, spent: ROTATION_RACE_MAX_GRACE_USES };
  }

  static async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    // N-9: the (verified) refresh JWT names the store; a DO store on the marker rotates inside its StoreDO.
    const claims = verifyRefreshJwt(refreshToken, { ignoreExpiration: true });
    const refreshRoute = await customerAuthRoute(
      typeof claims?.storeId === 'string' ? claims.storeId : null,
      { write: true }
    );
    if (refreshRoute.kind === 'do' && claims)
      return CustomerAuthFlows.refresh(refreshRoute.client, refreshToken, claims as never);
    // Hash the token to look it up
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    // The presented token names its user through the `ebda_refresh_token_user` definer
    // (it is the credential); every read and write of the user-keyed `refresh_tokens`
    // after that runs AS that user, each in its own short transaction, so a revocation
    // written just before a 401 is committed, not rolled back with the error.
    const tokenUserId = await refreshTokenUser(tokenHash);
    const storedRow = tokenUserId
      ? await withUser(tokenUserId, tx =>
          tx.refreshToken.findUnique({
            where: { token: tokenHash, userId: tokenUserId },
          })
        )
      : null;

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
    // A legacy refresh token of an identity-managed account is dead: the session now lives at the identity service
    // (Ruling ID-5: one re-login). Nothing here can mint a Store token for it.
    if (tokenOwner.storeId === null && tokenOwner.role !== 'customer') {
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
        ? await this.claimGraceUse(storedToken.id, storedToken.revokedReason, storedToken.userId)
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
        await withUser(storedToken.userId, tx =>
          tx.refreshToken.updateMany({
            where: { userId: storedToken.userId, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'reuse_detected' },
          })
        );
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
      await withUser(storedToken.userId, tx =>
        tx.refreshToken.update({
          where: { id: storedToken.id, userId: storedToken.userId },
          data: { revokedAt: new Date(), revokedReason: 'expired' },
        })
      );
      throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token expired');
    }

    // Reject refresh if user has been soft-deleted
    if (storedToken.user.deletedAt) {
      await withUser(storedToken.userId, tx =>
        tx.refreshToken.update({
          where: { id: storedToken.id, userId: storedToken.userId },
          data: { revokedAt: new Date(), revokedReason: 'account_deleted' },
        })
      );
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
      await withUser(storedToken.userId, tx =>
        tx.refreshToken.update({
          where: { id: storedToken.id, userId: storedToken.userId },
          data: { revokedAt: new Date(), revokedReason: 'account_suspended' },
        })
      );
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
    const newRow = await withUser(storedToken.userId, tx =>
      tx.refreshToken.findUnique({
        where: { token: newHash, userId: storedToken.userId },
        select: { id: true },
      })
    );

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
      await withUser(storedToken.userId, tx =>
        tx.refreshToken.updateMany({
          where: { id: storedToken.id, userId: storedToken.userId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokedReason: REASON_ROTATED,
            replacedById: newRow?.id ?? null,
          },
        })
      );
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
      await withUser(storedToken.userId, tx =>
        tx.refreshToken.updateMany({
          where: { token: newHash, userId: storedToken.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'revoke_all' },
        })
      );
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

    // N-9: a DO store's refresh rows are its DO's (expired and long-revoked ones; the DO alarm does the same nightly). The
    // Postgres definer is asked ONLY while a `pg` store exists: with every store on D1 / a DO there is nothing in Postgres to
    // purge, and the cron must not need it.
    let total = 0;
    for (const storeId of await doStoreIdList()) {
      const route = await customerAuthRoute(storeId, { write: true });
      if (route.kind !== 'do') continue;
      try {
        total += (await route.client.call<{ deleted: number }>('purge', {})).deleted;
      } catch (err) {
        // a closed store keeps its rows as a retained record (Ruling NZ-D15); anything else fails the job
        if (!(err instanceof AppError && err.code === 'STORE_CLOSED')) throw err;
      }
    }
    if (!(await hasStoresOnBackend('pg'))) {
      if (total > 0)
        logger.info({ deleted: total }, 'Refresh-token cleanup removed stale rows (DO stores)');
      return total;
    }

    // `refresh_tokens` is user-keyed under RLS; the cross-user purge is the
    // `ebda_refresh_tokens_purge` definer, which only the named platform job
    // 'token-retention' may call (`withSystemJob`).
    total += await purgeRefreshTokens(now, thirtyDaysAgo);
    if (total > 0) {
      logger.info({ deleted: total }, 'Refresh-token cleanup removed stale rows');
    }
    return total;
  }

  static async logout(refreshToken: string): Promise<void> {
    const claims = verifyRefreshJwt(refreshToken, { ignoreExpiration: true });
    const route = await customerAuthRoute(
      typeof claims?.storeId === 'string' ? claims.storeId : null,
      {
        write: true,
      }
    );
    if (route.kind === 'do') return CustomerAuthFlows.logout(route.client, refreshToken);
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    // Mark instead of delete so a stolen copy of the same token replayed
    // after logout still triggers the reuse-detection path in
    // refreshTokens() instead of returning a generic TOKEN_INVALID.
    // `refresh_tokens` is user-keyed: the token names its user through the definer,
    // and the revoke runs AS that user. An unknown token is a no-op, as before.
    const ownerId = await refreshTokenUser(tokenHash);
    if (!ownerId) return;
    await withUser(ownerId, tx =>
      tx.refreshToken.updateMany({
        where: { token: tokenHash, userId: ownerId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      })
    );
  }

  static async getProfile(userId: string, scope?: { storeId?: string | null }) {
    const route = await customerAuthRoute(scope?.storeId, { write: false });
    if (route.kind === 'do') {
      const u = await route.client.call<DoCustomer | null>('getProfile', { userId });
      if (!u) throw new AppError(404, 'NOT_FOUND', 'User not found');
      return CustomerAuthFlows.toProfile(u);
    }
    // NZ-D23: the Worker has no Postgres `users` table. A merchant, staff member or platform admin (the admin namespace)
    // IS their identity-service account, so the profile is read from there. 2026-11-10 P1: a new merchant's first
    // `POST /auth/session` fell through to `user.findUnique` here and answered 500 POSTGRES_REMOVED.
    if (postgresRemovedOnThisWorker()) {
      const st = await getAccountState(userId);
      if (!st) throw new AppError(404, 'NOT_FOUND', 'User not found');
      return {
        id: st.id,
        email: st.email,
        firstName: st.firstName,
        lastName: st.lastName,
        phone: st.phone,
        role: st.role,
        avatar: null,
        emailVerified: st.emailVerified,
        mfaEnabled: st.mfaEnabled,
        mfaEnrolledAt: st.mfaEnrolledAt ? new Date(st.mfaEnrolledAt) : null,
        createdAt: null,
        updatedAt: null,
      };
    }
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
    data: { firstName?: string; lastName?: string; phone?: string },
    tenant?: { storeId?: string | null }
  ) {
    const route = await customerAuthRoute(tenant?.storeId, { write: true });
    if (route.kind === 'do') {
      // WA-CONSENT-1: the old number's consent ends with the number. Revoked FIRST; a failed revoke aborts the update.
      if (data.phone !== undefined) {
        const cur = await route.client.call<DoCustomer | null>('getProfile', { userId });
        if (cur?.phone && toE164(cur.phone) !== toE164(data.phone))
          await revokeForPhoneChange(route.client.storeId, userId, cur.phone);
      }
      const r = await route.client.call<{ user: DoCustomer }>('updateProfile', { userId, ...data });
      return CustomerAuthFlows.toProfile(r.user);
    }
    // WA-CONSENT-1: the old number's WhatsApp marketing consent ends with the number (the new one needs
    // a fresh tick and proof). For a store customer the revoke and the phone write are ONE transaction
    // holding the account's consent lock, the same lock a grant takes, so a grant can never land on a
    // number that was just replaced. A failed revoke aborts the whole update: the phone is unchanged.
    const scope =
      data.phone !== undefined
        ? await withUser(userId, () =>
            prisma.user.findUnique({
              where: { id: userId },
              select: { phone: true, storeId: true },
            })
          )
        : null;
    if (scope?.storeId) {
      const storeId = scope.storeId;
      return runInTenantContext(
        storeId,
        async () => {
          await lockAccountConsent(userId);
          const user = await prisma.user.findUnique({ where: { id: userId } });
          if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
          if (user.phone && toE164(user.phone) !== toE164(data.phone!)) {
            await revokeForPhoneChangeInTx(storeId, userId, user.phone);
          }
          return prisma.user.update({
            where: { id: userId },
            data: {
              ...(data.firstName !== undefined && { firstName: data.firstName }),
              ...(data.lastName !== undefined && { lastName: data.lastName }),
              phone: data.phone,
            },
            select: PROFILE_SELECT,
          });
        },
        userId
      );
    }
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
        select: PROFILE_SELECT,
      });

      return updated;
    });
  }

  static async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    scope?: { storeId?: string | null }
  ) {
    const route = await customerAuthRoute(scope?.storeId, { write: true });
    if (route.kind === 'do') {
      // One DO section: verify the current password, set the new hash, drop every passkey, bump the version, revoke every session.
      const r = await CustomerAuthFlows.changePassword(
        route.client,
        userId,
        currentPassword,
        newPassword
      );
      await pushTokenVersion(userId, r.tokenVersion, 'auth.changePassword.setTokenVersion');
      await announcePasskeyPurge({
        user: { ...r.user, storeId: route.client.storeId },
        count: r.purgedPasskeys,
        reason: 'password_changed',
      });
      return;
    }
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
    // Ruling PASSKEY-13: a password CHANGE removes every passkey, in the SAME transaction as the new
    // hash (all or nothing). An attacker who held the old password and a session may have registered a
    // passkey of their own; revoking their session alone would leave a key that satisfies MFA.
    const purged = await withUser(userId, async tx => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
      return tx.passkeyCredential.deleteMany({ where: { userId } });
    });

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

    await announcePasskeyPurge({ user, count: purged.count, reason: 'password_changed' });
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
    reason: 'revoke_all' | 'password_changed' | 'password_reset' = 'revoke_all',
    scope?: { storeId?: string | null }
  ): Promise<void> {
    // No scope given (admin suspend, MFA change, any sibling path): resolve the customer's store from the user row, so a DO-served
    // customer is revoked in its DO and never only in a stale Postgres row (security review of 5bd6aac92).
    let scopeStoreId = scope?.storeId ?? null;
    if (!scopeStoreId) {
      // Fail CLOSED: if the store cannot be resolved the revocation might belong to a DO-served customer, and reporting success
      // after revoking only a stale Postgres row is the exact bug this guards. 503, retryable.
      let st: Awaited<ReturnType<typeof getUserState>> = null;
      try {
        st = await getUserState(userId);
      } catch (err) {
        logger.error(
          { err, userId },
          '[auth.revokeAllSessions] user lookup failed; refusing to revoke blind'
        );
        throw new AppError(
          503,
          'REVOCATION_UNAVAILABLE',
          'Could not resolve the account to revoke; retry',
          {
            retryable: true,
          }
        );
      }
      if (st?.role === 'customer') scopeStoreId = st.storeId;
    }
    const route = await customerAuthRoute(scopeStoreId, { write: true });
    if (route.kind === 'do') {
      // The DO is the revocation authority: the bump and the refresh revocation are one section; the cache push follows.
      const r = await route.client.call<{ tokenVersion: number }>('revokeAll', { userId, reason });
      await pushTokenVersion(userId, r.tokenVersion, 'auth.revokeAllSessions.setTokenVersion');
      return;
    }
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

    // Merchant / staff / super-admin sessions live in the identity service (Rulings ID-1/ID-2): end them THERE too, or the
    // user's 15 minute token and the refresh behind it keep working after every revocation reason handled here (password
    // change, logout everywhere, admin suspension). Fails loud: a revocation that did not reach the source is not a revocation.
    await revokeIdentityIfManaged(userId, reason);

    // Revoke all live refresh tokens — prevents session resumption via
    // token rotation even before the access token's tv is checked.
    //
    // The caller names the reason. `revokedReason` is the only forensic record
    // of WHY a session died
    // reads `password_reset` off these rows to tell a redeemed reset from a
    // sign-out — so folding a password change or reset into a generic
    // `revoke_all` would buy correct ordering at the cost of the audit trail.
    await withUser(userId, tx =>
      tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      })
    );

    // Belt and braces on top of the revoke above (S5-1, 2026-09-22 security
    // audit): password-reset rows are stored as `reset:<hash>` RefreshToken
    // rows and are already covered by the unconditional `updateMany` above
    // (it has no `token` filter), so this is a second, explicit guarantee —
    // not a fix for a gap the updateMany leaves open — that no outstanding
    // reset link survives a revocation. Deleting rather than revoking mirrors
    // resetPassword's own single-use cleanup (it deletes the row it redeems).
    await withUser(userId, tx =>
      tx.refreshToken.deleteMany({
        where: { userId, token: { startsWith: 'reset:' } },
      })
    );
  }

  /**
   * Operator / merchant status change of a CUSTOMER served by a StoreDO: status + version bump + revocation of every session in
   * ONE DO section, then the cache push. Returns false when the customer is not DO-served (the caller keeps its Postgres write).
   * Throws if the store is DO-served and the DO does not know the customer: a Postgres-only write there would leave it active.
   */
  static async setCustomerStatusOnDo(
    userId: string,
    storeId: string | null,
    status: 'active' | 'inactive' | 'suspended'
  ): Promise<boolean> {
    const route = await customerAuthRoute(storeId, { write: true });
    if (route.kind !== 'do') return false;
    const r = await route.client.call<{ tokenVersion: number }>('setStatus', { userId, status });
    await pushTokenVersion(userId, r.tokenVersion, 'auth.setCustomerStatus.setTokenVersion');
    return true;
  }

  /**
   * Store-scoped status change of a customer (suspend / deactivate / reactivate): the DO when the store is DO-served (status +
   * session revocation in one section), else the Postgres row followed by `revokeAllSessions`. Used by the store-scoped customer
   * route; a customer unknown to the store is a 404.
   */
  static async setCustomerStatus(
    userId: string,
    storeId: string,
    status: 'active' | 'inactive' | 'suspended'
  ): Promise<void> {
    if (await AuthService.setCustomerStatusOnDo(userId, storeId, status)) return;
    const before = await withStore(storeId, tx =>
      tx.user.findFirst({
        where: { id: userId, storeId, role: 'customer' },
        select: { status: true },
      })
    );
    if (!before) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    await withStore(storeId, tx =>
      tx.user.update({ where: { id: userId, storeId }, data: { status } })
    );
    await AuthService.revokeAllSessions(userId, 'revoke_all', { storeId });
  }

  /**
   * Store-scoped deactivation (soft delete) of a customer: sessions end NOW. DO: one section (`softDelete`) then the cache push;
   * Postgres: deletedAt then `revokeAllSessions`. Returns the phone for the caller's WhatsApp-consent withdrawal.
   */
  static async softDeleteCustomer(
    userId: string,
    storeId: string
  ): Promise<{ phone: string | null }> {
    const route = await customerAuthRoute(storeId, { write: true });
    if (route.kind === 'do') {
      const r = await route.client.call<{ tokenVersion: number; phone: string | null }>(
        'softDelete',
        { userId }
      );
      await pushTokenVersion(userId, r.tokenVersion, 'auth.softDelete.setTokenVersion');
      return { phone: r.phone };
    }
    const before = await withStore(storeId, tx =>
      tx.user.findFirst({
        where: { id: userId, storeId, role: 'customer' },
        select: { phone: true },
      })
    );
    if (!before) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    await withStore(storeId, tx =>
      tx.user.update({ where: { id: userId, storeId }, data: { deletedAt: new Date() } })
    );
    await AuthService.revokeAllSessions(userId, 'revoke_all', { storeId });
    return { phone: before.phone ?? null };
  }

  /**
   * Create a single-use password-set/reset token for a known account and store
   * its hash as a `reset:<hash>` RefreshToken row (redeemed by `resetPassword`,
   * same as a self-service "forgot password"). Only the SHA-256 is stored; the
   * plaintext is returned here for the caller to put in an email and nowhere
   * else. Shared by `requestPasswordReset` (self-service) and the staff-invite
   * flow (owner-initiated) — both end up on the exact same redemption path.
   */
  private static async issuePasswordSetToken(userId: string): Promise<string> {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await withUser(userId, tx =>
      tx.refreshToken.create({
        data: {
          token: `reset:${resetTokenHash}`,
          userId,
          expiresAt: resetExpires,
        },
      })
    );
    return resetToken;
  }

  /**
   * Issue a password-set link for a brand-new staff account (lens-2 "staff
   * invite consent", 2026-09-22 security audit): until this, a staff account
   * created without an owner-supplied password got one nobody — not even the
   * invitee — knew, with no invite-token flow to discover it existed. Reuses
   * the exact same token + redemption path as a self-service password reset.
   */
  static async issueStaffInviteToken(userId: string): Promise<string> {
    return this.issuePasswordSetToken(userId);
  }

  /**
   * Issue a password-reset link. Returns the account id when one was found (for
   * the caller's audit row only; the HTTP answer never depends on it).
   *
   * The mail is handed to `cfWaitUntil` instead of being awaited: the found and
   * not-found branches then answer in roughly the same time, so response latency
   * does not reveal whether an account exists (a Resend round trip is ~100s of
   * ms; the remaining gap is one indexed insert). A failed send is logged, never
   * surfaced, exactly as before when the route swallowed it.
   */
  static async requestPasswordReset(
    email: string,
    storeId: string | null = null
  ): Promise<{ userId: string } | null> {
    if (typeof email !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'Email is required');
    const route = await customerAuthRoute(storeId, { write: true });
    if (route.kind === 'do') return CustomerAuthFlows.requestReset(route.client, email);
    // NEON-ZERO (Ruling NZ-ACCT-1): no store + no Postgres = a merchant/staff address; the credential lives in the
    // identity service, which issues + mails its own code (and answers generically for an unknown address). Never
    // reach `withUser`; return null (the route's generic response) as a missing user does.
    if (postgresRemovedOnThisWorker()) {
      cfWaitUntil(
        forgotIdentityPassword(email).catch(err =>
          logger.error({ err }, 'identity password-reset request failed')
        )
      );
      return null;
    }
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
          role: true,
          language: true,
        },
      },
      { includeDeleted: true }
    );

    if (!user || (await ownsDemoStore(user.id))) {
      // Silently return to prevent email enumeration (and never mail the demo owner, B1-13)
      return null;
    }

    if (user.storeId === null && user.role !== 'customer') {
      // Admin namespace (merchant / staff / operator): the credential lives in the identity service, which issues and mails
      // its own one-time code. The Store issues no password token for these accounts (Ruling ID-2).
      cfWaitUntil(
        forgotIdentityPassword(user.email).catch(err =>
          logger.error({ err, userId: user.id }, 'identity password-reset request failed')
        )
      );
      return { userId: user.id };
    }

    const resetToken = await this.issuePasswordSetToken(user.id);

    const name = `${user.firstName} ${user.lastName}`.trim() || user.email;
    const language = (user.language as 'en' | 'ar' | undefined) ?? undefined;
    if (user.storeId) {
      // Storefront customer: the store's branded sender, storefront page.
      cfWaitUntil(
        EmailService.sendPasswordReset(
          user.storeId,
          {
            email: user.email,
            name,
            resetPath: `/auth/reset-password?token=${resetToken}`,
            expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
          },
          language
        ).catch(err => logger.error({ err, userId: user.id }, 'password-reset mail failed'))
      );
    }
    return { userId: user.id };
  }

  /**
   * Redeem a reset token: set the new password, burn the token, end every
   * session. Returns the account id for the caller's audit row.
   *
   * What this deliberately does NOT touch: MFA. `mfaEnabled` / `mfaSecret`
   * survive a reset, so the next login still stops at the MFA challenge — a
   * reset proves control of the inbox, not of the second factor.
   */
  static async resetPassword(token: string, newPassword: string): Promise<{ userId: string }> {
    const doClient = await clientForScopedToken(token);
    if (doClient) {
      const r = await CustomerAuthFlows.resetPassword(doClient, token, newPassword);
      await pushTokenVersion(r.userId, r.tokenVersion, 'auth.resetPassword.setTokenVersion');
      await announcePasskeyPurge({
        user: {
          id: r.userId,
          email: r.email,
          firstName: r.firstName,
          language: r.language,
          storeId: doClient.storeId,
        },
        count: r.purgedPasskeys,
        reason: 'password_reset',
      });
      await accountLockout
        .unlockAccount(`${doClient.storeId}:${r.email.trim().toLowerCase()}`)
        .catch(err => logger.warn({ err, userId: r.userId }, 'lockout clear after reset failed'));
      return { userId: r.userId };
    }
    // Hash the provided token. The lookup below is an equality match on this
    // SHA-256 digest, never on the plaintext: a timing difference in the
    // index walk can only leak bits of a hash of 256 random bits, which says
    // nothing about any live token (Ruling EBDA-PWRESET-3).
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find the reset token. `revokedAt: null` mirrors the check the refresh
    // path already makes (see the reuse-detection block in refreshTokens
    // above): without it, a reset link that `revokeAllSessions` already
    // revoked (by an intervening password change, or by redeeming a sibling
    // reset link) was still redeemable — the token lookup never looked at
    // whether the row had been revoked at all. S5-1, 2026-09-22 security audit.
    const resetOwner = await refreshTokenUser(`reset:${tokenHash}`);
    const storedToken = resetOwner
      ? await withUser(resetOwner, tx =>
          tx.refreshToken.findFirst({
            where: {
              userId: resetOwner,
              token: `reset:${tokenHash}`,
              expiresAt: { gt: new Date() },
              revokedAt: null,
            },
          })
        )
      : null;

    if (!storedToken) {
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid or expired reset token');
    }

    // N-9: a pre-flip (Postgres) link of a customer whose store is now served by its StoreDO must NOT write the stale Postgres
    // copy and report "reset" while the live account is unchanged: it is simply invalid (the customer asks for a new link).
    // For a store still on Postgres this is the freeze guard (retryable 503 while its rows are copied).
    const resetUser = await getUserState(storedToken.userId);
    if (resetUser?.storeId) {
      const r = await customerAuthRoute(resetUser.storeId, { write: true });
      if (r.kind === 'do')
        throw new AppError(400, 'TOKEN_INVALID', 'Invalid or expired reset token');
    }

    // Hash new password (slow) BEFORE claiming the token, so the claim and the
    // password write sit as close together as possible.
    const passwordHash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

    // Claim the token atomically: single-use is decided by this DELETE's row
    // count, not by the read above. Two concurrent redemptions of one link both
    // pass the findFirst; only one can delete the row, and the loser stops here
    // before writing a password. (It used to be read -> write password ->
    // delete, so both requests set a password and the later one won.)
    const claimed = await withUser(storedToken.userId, tx =>
      tx.refreshToken.deleteMany({
        where: {
          id: storedToken.id,
          userId: storedToken.userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      })
    );
    if (claimed.count !== 1) {
      throw new AppError(400, 'TOKEN_INVALID', 'Invalid or expired reset token');
    }

    // Update user password (as that user: `users` is RLS-scoped to app.current_user_id)
    // Ruling PASSKEY-10 / review M5: the new hash and the removal of EVERY passkey commit together. If the
    // delete fails the password does not change either, so the owner simply retries the reset; there is no
    // state where the password moved on and an attacker's passkey survived.
    const { updated, purged } = await withUser(storedToken.userId, async tx => {
      const updated = await tx.user.update({
        where: { id: storedToken.userId },
        data: { passwordHash },
        select: { id: true, email: true, storeId: true, firstName: true, language: true },
      });
      const purged = await tx.passkeyCredential.deleteMany({
        where: { userId: storedToken.userId },
      });
      return { updated, purged };
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

    // Account recovery removed every passkey above (PASSKEY-10): record it and tell the owner, so a reset
    // that silently drops their devices is never a surprise (review M5).
    await announcePasskeyPurge({ user: updated, count: purged.count, reason: 'password_reset' });

    // A merchant who reset because they were locked out after too many wrong
    // passwords must be able to use the new one at once. The lockout exists to
    // stop password guessing; whoever holds a valid reset link no longer needs
    // to guess. Same key shape as login (`<storeId>:<email>` or `<email>`).
    // Best-effort: Redis being down must not fail a reset that already landed.
    const lockoutEmail = updated.email.trim().toLowerCase();
    await accountLockout
      .unlockAccount(updated.storeId ? `${updated.storeId}:${lockoutEmail}` : lockoutEmail)
      .catch(err =>
        logger.warn({ err, userId: storedToken.userId }, 'lockout clear after reset failed')
      );

    return { userId: storedToken.userId };
  }

  /**
   * Irreversible PII anonymization (GDPR Art. 17 and applicable GCC
   * data-protection law — see docs/privacy/data-map.md).
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
    opts: { scopeStoreId?: string; actorId?: string; storeHint?: string | null } = {}
  ): Promise<EraseOutcome> {
    // N-9: a customer served by the StoreDO is erased there (store rows AND the auth rows), with no Postgres transaction.
    const hint = opts.storeHint ?? opts.scopeStoreId;
    const doRoute = hint
      ? await customerAuthRoute(hint, { write: true })
      : ({ kind: 'pg' } as const);
    if (doRoute.kind === 'do') return AuthService.eraseOnDo(doRoute.client, userId, opts);
    if (await hubOnD1()) return AuthService.eraseHubUser(userId);
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

    // A shopper of a store on its Durable Object: the store-owned rows (orders, reviews, wallet, carts, consents, campaign mail,
    // CRM copy) live there, so they are erased there, in ONE section, BEFORE the Postgres transaction below (Ruling CF-R6A-3).
    // The Postgres transaction still runs for the platform rows and for the pre-cutover copy of the same data, which is erased
    // too; a retry after a failure in either half converges because both are idempotent.
    const doMoney = user.storeId ? ((await storeRepo(user.storeId)).money ?? null) : null;
    let doErase: Awaited<ReturnType<NonNullable<typeof doMoney>['eraseShopper']>> | undefined;
    let doProvenBuyerKey: string | undefined;
    if (doMoney && user.storeId) {
      const proofStore = opts.scopeStoreId ?? user.storeId;
      const key = await buyerKeyForErasure(user.phone);
      doProvenBuyerKey =
        key &&
        user.phone &&
        (await phoneOnOwnOrder(
          proofStore,
          userId,
          user.phone,
          (await storeDb(user.storeId)) as never
        ))
          ? key
          : undefined;
      doErase = await doMoney.eraseShopper({
        userId,
        role: user.role,
        email: user.email,
        phone: user.phone,
        smsPhoneKey: smsConsentPhoneKey(user.phone),
        provenBuyerKey: doProvenBuyerKey ?? null,
        actorId,
        capWindowMs: SEND_CAP_WINDOW_MS,
      });
      // the wallet audit row Postgres writes for a self-service / cron erasure (a merchant-scoped one writes none)
      if (
        opts.scopeStoreId === undefined &&
        (doErase.walletForfeited > 0 || doErase.walletNotesScrubbed)
      )
        await insertAuditLog({
          action: 'customer.wallet.erased',
          userId: actorId !== 'system' ? actorId : null,
          storeId: user.storeId,
          resourceType: 'user',
          resourceId: userId,
          details: {
            actor: actorId,
            reason: 'account_erasure',
            forfeitedFils: doErase.walletForfeited,
            notesScrubbed: doErase.walletNotesScrubbed,
          },
        });
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
      await withUser(userId, tx =>
        tx.oneSignalSubscription.findMany({
          where: { userId },
          select: { playerId: true },
        })
      )
    ).map(s => s.playerId);

    // The suite buyer key of this person's phone (Ebda Chat contract `customer.erased`), taken
    // BEFORE the scrub removes the phone. Undefined when no phone or the secret is not configured.
    const buyerKey = await buyerKeyForErasure(user.phone);
    // Set by `anonymize` below: the user's token version after the erase bumps it.
    let erasedTokenVersion: number | undefined;
    // Customer Intelligence erase scope, collected BEFORE the scrub nulls the keys: the account's OWN orders in
    // its store (and the keys on them) are always erased; a buyer-key erase happens only for a phone the
    // account proved it holds (`eraseProvenBuyerKey`, the WA-CONSENT-1 proof) and only in the store that proof was made in. A buyer key is a hash of a phone
    // someone typed at checkout, so it never widens the scope on its own.
    let ciScope:
      | { storeId: string; orderIds: string[]; buyerKeys: string[]; sinceDay?: string }
      | undefined;
    let ciProven: { storeId: string; buyerKeys: string[] } | undefined;
    // The buyer key of the profile phone, ONLY when that phone is proven to be this account's (a delivered
    // order). Set inside `anonymize`; it is what the `account/erased` event carries, so an attacker who
    // typed a victim's number cannot make WhatsApp erase the victim's contact (WA-CONSENT-PROOF-1).
    let eraseProvenBuyerKey: string | undefined;
    // What the merchant-CRM scrub actually did (#1880) — returned to the
    // caller so a partial erasure is recorded and shown, not just logged.
    const outcome: EraseOutcome = { crmChecked: false, crmRowsScrubbed: 0, crmAmbiguous: false };

    const anonymize = async (tx: Prisma.TransactionClient) => {
      // The ambient store of this erasure: the shopper's own store (self-service,
      // retention cron) or the merchant route's store (== user.storeId, checked above).
      const eraseStoreId = user.storeId ?? currentStoreId();
      // ORDERING: the WhatsApp-consent ownership proof reads the shopper's delivered orders, so it MUST run
      // before the order scrub below nulls `customerId` and the address snapshots (afterwards it would
      // always be false and the current number's consent row would silently survive the erasure). It runs
      // on THIS transaction (tenant + user context, ebda_app under RLS) with the same store id as the
      // erase; a missing store id fails loud.
      const consentStoreId = opts.scopeStoreId ?? eraseStoreId;
      if (!consentStoreId)
        throw new Error('[auth.eraseAccount] no store id for the consent erasure');
      eraseProvenBuyerKey = doMoney
        ? (doErase?.provenBuyerKey ?? undefined)
        : buyerKey && user.phone && (await phoneOnOwnOrder(consentStoreId, userId, user.phone, tx))
          ? buyerKey
          : undefined;

      // Webhook delivery log: strip the shopper's contact data from stored payloads (Ruling WH-7).
      // Must run before the orders lose their customer link below. Already-delivered payloads on
      // the merchant's own server cannot be recalled.
      const erasedOrderIds = (
        await tx.order.findMany({
          where: { customerId: userId, storeId: eraseStoreId },
          select: { id: true },
        })
      ).map(o => o.id);
      await redactWebhookCustomerData(tx, {
        storeId: eraseStoreId,
        orderIds: erasedOrderIds,
        email: user.email,
      });
      const ownOrders = await tx.order.findMany({
        where: { customerId: userId, storeId: eraseStoreId },
        select: { id: true, buyerKey: true, createdAt: true },
      });
      // a DO store's orders are the DO's (the Postgres rows are only the pre-cutover copy)
      ciScope = {
        storeId: eraseStoreId,
        orderIds: doErase ? doErase.orderIds : ownOrders.map(o => o.id),
        buyerKeys: doErase
          ? doErase.buyerKeys
          : [...new Set(ownOrders.flatMap(o => (o.buyerKey ? [o.buyerKey] : [])))],
        // The prefix pass starts at the sink's partition day of the first order minus a margin (lib/ci/layout.ts).
        sinceDay: doErase
          ? ciSinceDay(doErase.since == null ? [] : [new Date(doErase.since)])
          : ciSinceDay(ownOrders.map(o => o.createdAt)),
      };
      ciProven = eraseProvenBuyerKey
        ? { storeId: consentStoreId, buyerKeys: [eraseProvenBuyerKey] }
        : undefined;
      // InstaPay receipts of those orders: the payer's typed / AI-read personal fields and the screenshot go (M-025);
      // the amount, reference and status stay with the order's financial record.
      await InstapayReceiptService.scrubForOrders(tx, eraseStoreId, erasedOrderIds);
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
          // CI-1: the pseudonymous buyer key and the coarse area go with the identity.
          buyerKey: null,
          areaKey: null,
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

      // Platform state that names the user (a super-admin who confirmed a provider): null the id, keep the fact.
      await scrubProviderVerifier(tx, userId);

      await tx.abandonedCart.deleteMany({ where: { customerId: userId, storeId: eraseStoreId } });
      await tx.cart.deleteMany({ where: { customerId: userId, storeId: eraseStoreId } });
      await tx.wishlist.deleteMany({ where: { userId, storeId: eraseStoreId } });
      await tx.pushSubscription.deleteMany({
        where: { customerId: userId, storeId: eraseStoreId },
      });
      // User-keyed rows: like `addresses` above, deleted by the shopper's id through a
      // guarded definer INSIDE this transaction (the GUC may be the merchant's id).
      await deleteUserTokens(userId);
      // Passkeys (Ruling PASSKEY-1): same shape, same guarded-definer reason as the tokens above.
      await deleteUserPasskeys(userId);
      await tx.loyaltyTransaction.deleteMany({
        where: { customerId: userId, storeId: eraseStoreId },
      });
      await tx.loyaltyPoints.deleteMany({ where: { customerId: userId, storeId: eraseStoreId } });
      // B2B wholesale (Task 5): the application holds PII (business name, phone, commercial registration no.) and the
      // CRM row's user_id link is what grants a group price. Erase the applications and sever the link + membership, so an
      // erased account can never price as a wholesaler again (the account is anonymised, not deleted, so no FK cascade fires).
      await tx.wholesaleApplication.deleteMany({ where: { userId, storeId: eraseStoreId } });
      await tx.customer.updateMany({
        where: { userId, storeId: eraseStoreId },
        data: { userId: null, groupId: null },
      });

      // Customer wallet (D1, Ruling W-4). Unlike loyalty, the wallet ledger is
      // a FINANCIAL record of money the merchant owed and paid out, so it is
      // kept — it carries no PII once its one free-text field (`note`) is
      // nulled. Any remaining balance is written off with an `expire` entry:
      // the anonymized account can no longer sign in to spend it, and leaving
      // it would overstate the merchant's outstanding store-credit liability
      // forever. Runs on this erasure transaction, so it is atomic with it.
      // (a DO store's wallet was forfeited in the DO section above; the Postgres copy of it is not a live balance)
      if (!doErase)
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
      // WhatsApp marketing consent (Ruling WA-CONSENT-1): keyed by the suite buyer key, gone with the
      // account. The consent observer announces the resulting `false` to Ebda Chat.
      // (the proof, `eraseProvenBuyerKey`, was computed at the START of this transaction, before the order scrub)
      await WhatsAppConsentService.eraseForAccount(tx, consentStoreId, userId, eraseProvenBuyerKey);

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
          // Ebda's own ads tracking (ip, user agent, Meta ids, utm): personal data on the row.
          acquisition: Prisma.DbNull,
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

    // The merchant-CRM result of a DO store is the DO's (the Postgres pass above only erased the pre-cutover copy).
    if (doErase) {
      outcome.crmChecked = doErase.crmChecked;
      outcome.crmRowsScrubbed = doErase.crmRowsScrubbed;
      outcome.crmAmbiguous = doErase.crmAmbiguous;
      // The receipt screenshots (private R2) go after the commits: an object delete before the erasure is final would lose
      // the evidence of a rolled-back one. Each miss is retried by the retention sweep (the rows are marked scrubbed).
      if (user.storeId && doErase.receiptIds.length > 0) {
        const receiptStore = user.storeId;
        const receiptIds = doErase.receiptIds;
        void deferAfterTenantCommit('auth.eraseAccount.receipt-images', () =>
          InstapayReceiptService.deleteImages(receiptStore, receiptIds)
        ).catch(err =>
          logger.warn({ err, userId }, '[auth.eraseAccount] receipt image cleanup failed')
        );
      }
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
      // The user's own store owns the avatar (`stores/<storeId>/...`); a user-scoped erase has no store
      // in scope, and the delete refuses a store-namespaced key it cannot attribute.
      void deleteR2ObjectIfOrphan(user.avatar, { ownerStoreId: user.storeId }).catch(err =>
        logger.warn({ err, userId }, '[auth.eraseAccount] r2 avatar cleanup failed')
      );
    }

    // Third-party deletion propagation (GDPR Art. 17 and applicable GCC
    // data-protection law — see docs/privacy/data-map.md):
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
    void deferAfterTenantCommit('auth.eraseAccount.propagate', async () => {
      await inngest.send({
        name: 'account/erased',
        // `storeId` + `buyerKey` (the hashed phone, never the phone) let Ebda Chat erase the
        // contact and its messages (contract `customer.erased`); computed BEFORE the scrub below.
        data: {
          userId,
          oneSignalPlayerIds,
          storeId: user.storeId ?? undefined,
          buyerKey: eraseProvenBuyerKey,
          ciProven,
          ciScope,
        },
      });
      // The DO's saved erasure scope is NOT finalized here: enqueue is not execution. The job's last step does it once
      // every propagation succeeded (Ruling CF-OPUS-1); the nightly alarm purges it after the TTL if the job never does.
    }).catch(err =>
      logger.warn({ err, userId }, '[auth.eraseAccount] account/erased enqueue failed')
    );

    return outcome;
  }

  /**
   * Erasure of a customer served by the StoreDO (N-9). The store-owned rows (orders, wallet, carts, consents, CRM copy) are
   * erased by the DO's own `eraseShopper` section (Ruling CF-R6A-3), the auth rows by `eraseCustomer`; nothing touches
   * Postgres. Both are idempotent, so a retry after a failure in either converges.
   */
  /**
   * A merchant / staff account after Postgres: identity account, D1 platform rows and StoreDO actor ids (Ruling FOLD-ERASURE-1).
   * Refuses what the admin delete route refuses: a platform administrator, and an owner who still owns stores.
   */
  private static async eraseHubUser(userId: string): Promise<EraseOutcome> {
    const acct = (await getAccountsBrief([userId]))[0];
    if (!acct) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (acct.role === 'super_admin')
      throw new AppError(
        409,
        'OPERATOR_ONLY',
        'Platform administrators are removed by the platform operator.'
      );
    const owned = (await hubOwnedStores([userId])).get(userId) ?? [];
    if (owned.length > 0)
      throw new AppError(
        409,
        'USER_OWNS_STORES',
        `You still own ${owned.length} store(s). Delete or transfer them first.`
      );
    await eraseIdentityUser(userId);
    await eraseHubUserData({ userId, email: acct.email });
    return { crmChecked: false, crmRowsScrubbed: 0, crmAmbiguous: false };
  }

  /** Data portability for a merchant / staff account: the identity service's rows plus every platform-D1 row that is theirs. */
  private static async exportHubUser(userId: string) {
    const acct = (await getAccountsBrief([userId]))[0];
    if (!acct) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const identity = await exportIdentityUser(userId);
    return {
      account: identity,
      platform: await exportHubUserPlatform({ userId, email: acct.email }),
    };
  }

  private static async eraseOnDo(
    client: CustomerAuthClient,
    userId: string,
    opts: { scopeStoreId?: string; actorId?: string }
  ): Promise<EraseOutcome> {
    const actorId = opts.actorId ?? 'system';
    const storeId = client.storeId;
    if (opts.scopeStoreId !== undefined && opts.scopeStoreId !== storeId)
      throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    const user = await client.call<DoCustomer | null>('getProfile', { userId });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const doMoney = (await storeRepo(storeId)).money;
    if (!doMoney)
      throw new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'Store backend is unavailable');
    const db = await storeDb(storeId);
    const oneSignalPlayerIds =
      (
        await (db as any).oneSignalSubscription
          ?.findMany({ where: { userId }, select: { playerId: true } })
          .catch(() => [])
      )?.map((x: { playerId: string }) => x.playerId) ?? [];
    const key = await buyerKeyForErasure(user.phone);
    const provenKey =
      key && user.phone && (await phoneOnOwnOrder(storeId, userId, user.phone, db as never))
        ? key
        : undefined;
    const doErase = await doMoney.eraseShopper({
      userId,
      role: user.role,
      email: user.email,
      phone: user.phone,
      smsPhoneKey: smsConsentPhoneKey(user.phone),
      provenBuyerKey: provenKey ?? null,
      actorId,
      capWindowMs: SEND_CAP_WINDOW_MS,
    });
    const auth = await client.call<{ erased: boolean; tokenVersion: number | null }>(
      'eraseCustomer',
      { userId }
    );
    if (auth.tokenVersion !== null)
      await pushTokenVersion(userId, auth.tokenVersion, 'auth.eraseAccount.revoke-sessions');
    // The stale Postgres copy of the same person goes too (queued + P1 if Postgres is unreachable).
    await scrubOrEnqueue(userId, storeId);
    if (doErase.receiptIds.length > 0)
      void deferAfterTenantCommit('auth.erase.receipt-images', () =>
        InstapayReceiptService.deleteImages(storeId, doErase.receiptIds)
      ).catch(err =>
        logger.warn({ err, userId }, '[auth.eraseAccount] receipt image cleanup failed')
      );
    if (user.avatar)
      void deferAfterTenantCommit('auth.erase.avatar', () =>
        deleteR2ObjectIfOrphan(user.avatar!, { ownerStoreId: storeId })
      ).catch(err => logger.warn({ err, userId }, '[auth.eraseAccount] r2 avatar cleanup failed'));
    const eraseProvenBuyerKey = doErase.provenBuyerKey ?? undefined;
    void inngest
      .send({
        name: 'account/erased',
        data: {
          userId,
          oneSignalPlayerIds,
          storeId,
          buyerKey: eraseProvenBuyerKey,
          ciProven: eraseProvenBuyerKey ? { storeId, buyerKeys: [eraseProvenBuyerKey] } : undefined,
          ciScope: {
            storeId,
            orderIds: doErase.orderIds,
            buyerKeys: doErase.buyerKeys,
            sinceDay: ciSinceDay(doErase.since == null ? [] : [new Date(doErase.since)]),
          },
        },
      })
      .catch(err =>
        logger.warn({ err, userId }, '[auth.eraseAccount] account/erased enqueue failed')
      );
    return {
      crmChecked: doErase.crmChecked,
      crmRowsScrubbed: doErase.crmRowsScrubbed,
      crmAmbiguous: doErase.crmAmbiguous,
    };
  }

  /**
   * Data portability for a StoreDO customer: the auth slice (profile + passkey LABELS, never a hash or key) plus every
   * customer-pii table of the store DO, found by the same registry the PDPL job uses (cf/erasure/registry.ts).
   */
  private static async exportOnDo(client: CustomerAuthClient, userId: string) {
    const acct = await client.call<{ profile: unknown; passkeys: unknown[] } | null>(
      'exportCustomer',
      { userId }
    );
    if (!acct) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const profile = acct.profile as DoCustomer;
    const key = await buyerKeyForErasure(profile.phone);
    const stub = storeDo(client.storeId) as unknown as {
      exportSubject(s: Record<string, unknown>): Promise<{ tables: Record<string, unknown[]> }>;
    };
    const store = await stub.exportSubject({
      kind: 'customer',
      requestId: crypto.randomUUID(),
      buyerKey: key ?? '',
      email: profile.email,
      phoneE164: profile.phone ? (toE164(profile.phone) ?? undefined) : undefined,
      userId,
      storeIds: [client.storeId],
    });
    return { account: acct.profile, passkeys: acct.passkeys, store: store.tables };
  }

  /**
   * Right to data portability (GDPR Art. 20 and applicable GCC
   * data-protection law — see docs/privacy/data-map.md).
   *
   * Returns every row across the schema that ties back to this user as a
   * single JSON bundle. Intentionally returns the raw shape — the
   * exported file is the user's data, not a marketing surface, so field
   * names match the schema for transparency.
   */
  static async exportAccount(userId: string, storeHint?: string | null) {
    const exportRoute = await customerAuthRoute(storeHint, { write: false });
    if (exportRoute.kind === 'do') return AuthService.exportOnDo(exportRoute.client, userId);
    if (await hubOnD1()) return AuthService.exportHubUser(userId);
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
      passkeys,
      smsMarketingConsents,
      wholesaleApplications,
    ] = await Promise.all([
      // Same user-scoped RLS policy as the erase path above: on the
      // merchant-initiated export `current_user_id()` is the MERCHANT, so a
      // plain read returns an EMPTY addresses section and ships an incomplete
      // Art. 20 portability bundle that looks complete. `withUser` reads them AS
      // the shopper — unlike the erase, this is read-only, so a second
      // connection carries no atomicity or independent-commit hazard.
      // A Durable Object store keeps the shopper's address book in its DO (Ruling NZ-SF-5).
      storeRepo(storeId).then(repo =>
        repo.backend === 'do'
          ? repo.db.address.findMany({ where: { userId } })
          : withUser(userId, tx => tx.address.findMany({ where: { userId } }))
      ),
      prisma.order.findMany({
        where: { customerId: userId, storeId },
        include: { items: true, payments: true },
      }),
      storeDb(storeId).then(db =>
        db.abandonedCart.findMany({ where: { customerId: userId, storeId } })
      ),
      storeDb(storeId).then(db => db.wishlist.findMany({ where: { userId, storeId } })),
      storeDb(storeId).then(db => db.review.findMany({ where: { customerId: userId, storeId } })),
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
      withUser(userId, tx =>
        tx.oneSignalSubscription.findMany({
          where: { userId },
          select: { id: true, playerId: true, createdAt: true },
        })
      ),
      // Passkeys: metadata only. The public key is not personal data worth shipping and nothing in this
      // bundle can be a secret (the private key never leaves the person's device).
      withUser(userId, tx =>
        tx.passkeyCredential.findMany({
          where: { userId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            rpId: true,
            deviceType: true,
            backedUp: true,
            createdAt: true,
            lastUsedAt: true,
          },
        })
      ),
      // SMS-marketing consent (issue 206): what was given, when, where, and
      // any withdrawal. Keyed by the user id (the shopper's own rows). Through the store's own backend: a DO store's consent
      // rows (grant, withdrawal) are written on its Durable Object, so a Postgres read would export nothing for them.
      (storeId ? await storeDb(storeId) : prisma).smsMarketingConsent.findMany({
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
      // B2B wholesale applications (business name, phone, commercial registration no., decision note): the applicant's own data.
      prisma.wholesaleApplication.findMany({
        where: { userId, storeId },
        // Explicit select (review M2): the staff user id that decided it (`decidedBy`) is not the applicant's data. The
        // decision note IS exported: the applicant is shown it already.
        select: {
          id: true,
          businessName: true,
          commercialRegNo: true,
          phone: true,
          notes: true,
          status: true,
          decisionNote: true,
          decidedAt: true,
          consentAt: true,
          createdAt: true,
        },
      }),
    ]);
    // WhatsApp marketing consent (Ruling WA-CONSENT-1): what was ticked, when, where, and any withdrawal.
    const exportBuyerKey = await buyerKeyForErasure(
      typeof user.phone === 'string' ? user.phone : null
    );
    // Only for a PROVEN number: a profile phone is self-declared, and an export must not reveal whether
    // someone else's number opted in (same rule as the checkout box state).
    const provenKey =
      exportBuyerKey &&
      typeof user.phone === 'string' &&
      (await phoneOnOwnOrder(storeId, userId, user.phone))
        ? exportBuyerKey
        : undefined;
    // Rows this account created (any earlier number) plus the current number's row when proven.
    const whatsappMarketingConsent = await WhatsAppConsentService.exportForAccount(
      storeId,
      userId,
      provenKey
    );

    // Customer Intelligence: the commerce outcomes recorded under this person's buyer key(s), pseudonymous.
    const customerIntelligence = await exportCiOutcomes({
      storeId,
      orderIds: orders.map(o => o.id),
      buyerKeys: [
        ...new Set([
          ...orders.flatMap(o => (o.buyerKey ? [o.buyerKey] : [])),
          ...(provenKey ? [provenKey] : []),
        ]),
      ],
    });

    return {
      exportedAt: new Date().toISOString(),
      user,
      addresses,
      // The customer's own orders, without the merchant's cost and the gold margin (Ruling B5-13).
      orders: orders.map(redactOrderForCustomer),
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
      passkeys,
      smsMarketingConsents,
      whatsappMarketingConsent,
      customerIntelligence,
      wholesaleApplications,
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
    // Access + refresh JWTs: one signer shared with the StoreDO customer flow (services/session-tokens.ts).
    const { accessToken, refreshToken } = signSessionTokens(payload);

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

    // `refresh_tokens` is user-keyed: the row is written AS its user.
    await withUser(payload.userId, tx =>
      tx.refreshToken.create({
        data: {
          token: tokenHash,
          userId: payload.userId,
          expiresAt,
        },
      })
    );

    return { accessToken, refreshToken };
  }
}
