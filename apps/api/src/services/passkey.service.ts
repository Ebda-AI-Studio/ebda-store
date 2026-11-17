import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { withUser } from '@ebda/database';
import { BRAND } from '@ebda/shared';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { lookupStore, passkeyLookup } from '../lib/definer';
import { loadSimpleWebAuthn } from '../lib/lazy-modules';
import { storeLookupForHost } from '../lib/store-host';
import { isP2002 } from '../lib/prisma-errors';
import logger from '../lib/logger';
import { encryption } from './encryption.service';
import { MfaService } from './mfa.service';
import { AuthService } from './auth.service';
import { loginGate } from './login-gate';
import { sendPasskeyNotice } from './passkey-notices';
import { redis } from './redis.service';
import { customerAuthRoute, type CustomerAuthClient } from '../lib/customer-auth';
import { CustomerAuthFlows, mfaUnavailable, type DoCustomer } from './customer-auth-flows';

/** N-9: the store's StoreDO client when this shopper's credentials live there, else null (Postgres). */
async function doClientFor(storeId: string | null | undefined): Promise<CustomerAuthClient | null> {
  const r = await customerAuthRoute(storeId, { write: true });
  return r.kind === 'do' ? r.client : null;
}
interface DoPasskey {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  rpId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}
const passkeyItem = (r: DoPasskey) => ({
  id: r.id,
  name: r.name,
  createdAt: new Date(r.createdAt),
  lastUsedAt: r.lastUsedAt === null ? null : new Date(r.lastUsedAt),
  deviceType: r.deviceType,
  backedUp: r.backedUp,
  rpId: r.rpId,
});

/**
 * Passkeys (WebAuthn) for merchants/staff (admin) and shoppers (one store). Plan:
 * docs/plans/done/2026-10-21-passkeys.md. The rulings that shape this file:
 *
 *  PASSKEY-1  Credentials are user-keyed under strict RLS (no store_id column): the user row is the tenant.
 *  PASSKEY-2  Challenges live in Redis for 300s (floor is 120s), keyed by sha256(challenge), consumed with
 *             DEL (returns 1 for exactly one caller). Redis down => 503, never "skip the check".
 *  PASSKEY-3  RP ID = the request HOST. Admin: the admin app host. Storefront: the Origin must resolve to a
 *             store (slug host or verified custom domain) and the credential is bound to that host + store.
 *             A custom-domain switch changes the host, so old credentials stop matching ("needs re-enrol").
 *  PASSKEY-4  A passkey sign-in satisfies MFA (user verification is REQUIRED, the key is phishing-resistant),
 *             so it mints the session directly and skips the TOTP challenge.
 *  PASSKEY-5  super_admin is excluded: their MFA enforcement is the TOTP flag, which a passkey does not set.
 *  PASSKEY-6  Every sign-in failure is the same 401 PASSKEY_AUTH_FAILED; sign-in begin takes no account input.
 *  PASSKEY-7  Register, rename and remove need a step-up (password, plus a TOTP code when TOTP is on, or a
 *             passkey sign-in) within 5 minutes, held in Redis and checked on the server. A stolen session
 *             can neither add a backdoor passkey nor delete the owner's.
 *  PASSKEY-8  Sign-in gates are shared with password login through `loginGate` (one lockout counter per
 *             account, one active-account check). Failures for an identified account count toward it.
 *  PASSKEY-12 The step-up proof is bound to the user AND the session (access-token jti), server-side, 5 min,
 *             never client-supplied: another session or user of the same account cannot reuse it.
 *  PASSKEY-9  Add/remove emails the account (best-effort); removing signs the account out everywhere.
 */

export const PASSKEY_CHALLENGE_TTL_SECONDS = 300;
export const PASSKEY_MAX_PER_USER = 10;
const CEREMONY_TIMEOUT_MS = 60_000;
const NAME_MAX = 60;
/** Step-up window. Above the 120s Redis TTL floor, short enough that a stolen session cannot sit on it. */
export const PASSKEY_STEP_UP_TTL_SECONDS = 300;

const ADMIN_ROLES = new Set(['store_admin', 'staff']);

export type PasskeySurface = 'admin' | 'storefront';
export interface PasskeyContext {
  surface: PasskeySurface;
  rpId: string;
  origin: string;
  /** The store a storefront host belongs to; null on the admin surface. */
  storeId: string | null;
}

interface ChallengeRecord {
  purpose: 'register' | 'login';
  rpId: string;
  origin: string;
  surface: PasskeySurface;
  storeId: string | null;
  userId?: string;
}

export interface PasskeyListItem {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string;
  backedUp: boolean;
  /** Registered for a different host than the one asking (custom-domain switch): cannot sign in here. */
  needsReenrol: boolean;
}

const notAvailable = () =>
  new AppError(404, 'PASSKEY_NOT_AVAILABLE', 'Passkeys are not available here');
const notAllowed = () =>
  new AppError(403, 'PASSKEY_NOT_ALLOWED', 'Passkeys are not available for this account');
const authFailed = () => new AppError(401, 'PASSKEY_AUTH_FAILED', 'Passkey sign-in failed');
const registrationFailed = () =>
  new AppError(400, 'PASSKEY_REGISTRATION_FAILED', 'Passkey could not be registered');

// ---------------------------------------------------------------------------------------------
// Context: which host is asking, and what RP ID / store does that mean
// ---------------------------------------------------------------------------------------------

/**
 * Resolve the browser `Origin` to the RP the ceremony is for. Fails CLOSED (404): an unparseable origin,
 * a platform/reserved host, an unknown slug or an unverified custom domain never defaults to anything.
 */
export async function resolvePasskeyContext(
  rawOrigin: string | undefined | null
): Promise<PasskeyContext> {
  if (!rawOrigin || rawOrigin === 'null') throw notAvailable();
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw notAvailable();
  }
  // An Origin is scheme://host[:port] and nothing else.
  if (url.origin !== rawOrigin || url.origin === 'null') throw notAvailable();
  const devLocal = config.nodeEnv !== 'production' && url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(devLocal && url.protocol === 'http:')) throw notAvailable();

  const origin = url.origin;
  const rpId = url.hostname;

  let adminOrigin: string | null = null;
  try {
    adminOrigin = new URL(config.adminUrl).origin;
  } catch {
    adminOrigin = null;
  }
  if (adminOrigin && origin === adminOrigin) {
    return { surface: 'admin', rpId, origin, storeId: null };
  }

  const lookup = storeLookupForHost(rpId);
  if (!lookup) throw notAvailable();
  const store = await lookupStore(
    lookup.by === 'slug' ? { slug: lookup.slug } : { domain: lookup.domain }
  );
  if (!store) throw notAvailable();
  return { surface: 'storefront', rpId, origin, storeId: store.id };
}

// ---------------------------------------------------------------------------------------------
// Challenge store (single-use, short TTL, fail closed)
// ---------------------------------------------------------------------------------------------

const challengeKey = (challenge: string) =>
  `passkey:ch:${crypto.createHash('sha256').update(challenge).digest('hex')}`;

function challengeClient() {
  const c = redis.getClient();
  if (!c) throw new AppError(503, 'PASSKEY_UNAVAILABLE', 'Passkeys are temporarily unavailable');
  return c;
}

async function putChallenge(challenge: string, record: ChallengeRecord): Promise<void> {
  const c = challengeClient();
  await c.setex(challengeKey(challenge), PASSKEY_CHALLENGE_TTL_SECONDS, JSON.stringify(record));
}

/** Read and CONSUME. `DEL` answers 1 to exactly one caller, so two concurrent finishes cannot both win. */
async function takeChallenge(challenge: string): Promise<ChallengeRecord | null> {
  const c = challengeClient();
  const key = challengeKey(challenge);
  const raw = await c.get(key);
  if (!raw) return null;
  if ((await c.del(key)) !== 1) return null;
  try {
    return JSON.parse(raw) as ChallengeRecord;
  } catch {
    return null;
  }
}

/** The challenge the authenticator signed, out of clientDataJSON (untrusted until verified). */
function challengeOf(response: { response?: { clientDataJSON?: unknown } }): string | null {
  const raw = response?.response?.clientDataJSON;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof parsed?.challenge === 'string' && parsed.challenge.length <= 256
      ? parsed.challenge
      : null;
  } catch {
    return null;
  }
}

function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
  return s || 'Passkey';
}

/** Does this account belong on this surface? Admin namespace <-> admin app; a shopper <-> their own store. */
function accountFitsContext(
  user: { role: string; storeId: string | null },
  ctx: PasskeyContext
): boolean {
  if (ctx.surface === 'admin') return user.storeId === null && ADMIN_ROLES.has(user.role);
  return user.role === 'customer' && user.storeId !== null && user.storeId === ctx.storeId;
}

/**
 * Every authenticated passkey endpoint runs this (review M4): the browser origin must be the surface this
 * account belongs on (admin namespace <-> admin app; a shopper <-> their own store host). It is what keeps
 * a merchant-controlled page from reading or changing an admin's, or another store's shopper's, passkeys.
 */
export async function assertPasskeyOrigin(
  user: { role: string; storeId?: string | null },
  origin: string | undefined
): Promise<PasskeyContext> {
  const ctx = await resolvePasskeyContext(origin);
  if (!accountFitsContext({ role: user.role, storeId: user.storeId ?? null }, ctx)) {
    throw notAllowed();
  }
  return ctx;
}

const userIdBytes = (id: string) => new TextEncoder().encode(id);

/** Who is acting: the user AND the specific session (access-token jti) presenting the request. */
export interface PasskeyActor {
  userId: string;
  sessionId: string | undefined;
  /** The shopper's store (token claim); null for the admin namespace. */
  storeId?: string | null;
}

// Ruling PASSKEY-12: the proof is bound to user + session. The key is derived from both (the session id is
// hashed, so a Redis dump never lists live token ids) and its VALUE is the user id, checked on read.
// Nothing the client sends decides it: no timestamp, no flag.
const stepUpKey = (userId: string, sessionId: string) =>
  `passkey:stepup:${userId}:${crypto.createHash('sha256').update(sessionId).digest('hex')}`;

async function requireStepUp(actor: PasskeyActor): Promise<void> {
  const held = actor.sessionId
    ? await challengeClient().get(stepUpKey(actor.userId, actor.sessionId))
    : null;
  if (held !== actor.userId) {
    throw new AppError(403, 'STEP_UP_REQUIRED', 'Confirm your password to manage passkeys');
  }
}

/** Account-security notice. Best-effort: a mail outage must not undo or block the change. */
async function notifyPasskeyChange(
  userId: string,
  kind: 'added' | 'removed',
  passkeyName: string,
  storeId?: string | null
): Promise<void> {
  try {
    const dc = await doClientFor(storeId);
    if (dc) {
      const p = await dc.call<DoCustomer | null>('getProfile', { userId });
      if (!p) return;
      await sendPasskeyNotice(
        {
          email: p.email,
          name: p.firstName,
          kind,
          passkeyName,
          at: new Date().toISOString(),
          storeId: dc.storeId,
        },
        p.language === 'ar' ? 'ar' : 'en'
      );
      return;
    }
    const u = await withUser(userId, tx =>
      tx.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, language: true, storeId: true },
      })
    );
    if (!u) return;
    await sendPasskeyNotice(
      {
        email: u.email,
        name: u.firstName,
        kind,
        passkeyName,
        at: new Date().toISOString(),
        storeId: u.storeId,
      },
      u.language === 'ar' ? 'ar' : 'en'
    );
  } catch (err) {
    logger.error({ err, userId, kind }, '[passkey] notice email failed');
  }
}

export class PasskeyService {
  // -------------------------------------------------------------------------------------------
  // Step-up (PASSKEY-7)
  // -------------------------------------------------------------------------------------------

  /** Prove who is holding the session: password, plus a current TOTP code when TOTP is on. */
  static async stepUp(
    userId: string,
    sessionId: string | undefined,
    input: { password: string; code?: string },
    ip?: string,
    storeId?: string | null
  ): Promise<{ expiresInSeconds: number }> {
    const failed = () => new AppError(401, 'STEP_UP_FAILED', 'Could not confirm your identity');
    if (!sessionId) throw failed();
    const dc = await doClientFor(storeId);
    if (dc) {
      const p = await dc.call<DoCustomer | null>('getProfile', { userId });
      if (!p || p.status !== 'active' || p.deletedAt) throw failed();
      // Ruling NZ-N9-1: the PG path demands the TOTP code too; the DO has no TOTP, so an MFA account gets NO step-up (a password
      // alone must never unlock registering a passkey, which would be a second-factor-free way in).
      if (p.mfaEnabled) throw mfaUnavailable();
      const key = loginGate.lockoutKey(p.email, dc.storeId);
      await loginGate.assertNotLocked(key);
      // The compare runs in the Worker (Ruling NZ-N9-2). MFA accounts were refused above (NZ-N9-1): there is no TOTP leg.
      const ok =
        typeof input.password === 'string' &&
        (await CustomerAuthFlows.verifyPassword(dc, userId, input.password));
      if (!ok) {
        await loginGate.recordFailure(key, ip);
        throw failed();
      }
      await PasskeyService.markStepUp(userId, sessionId);
      return { expiresInSeconds: PASSKEY_STEP_UP_TTL_SECONDS };
    }
    const user = await withUser(userId, tx =>
      tx.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          storeId: true,
          status: true,
          deletedAt: true,
          passwordHash: true,
          mfaEnabled: true,
          mfaSecret: true,
        },
      })
    );
    if (!user || user.status !== 'active' || user.deletedAt) throw failed();

    // Same counter as password login: guessing the password here is guessing it there.
    const key = loginGate.lockoutKey(user.email, user.storeId);
    await loginGate.assertNotLocked(key);

    let ok =
      typeof input.password === 'string' &&
      (await bcrypt.compare(input.password, user.passwordHash));
    if (ok && user.mfaEnabled && user.mfaSecret) {
      ok =
        typeof input.code === 'string' &&
        MfaService.verifyCode(encryption.decrypt(user.mfaSecret), input.code);
    }
    if (!ok) {
      await loginGate.recordFailure(key, ip);
      throw failed();
    }
    await PasskeyService.markStepUp(userId, sessionId);
    return { expiresInSeconds: PASSKEY_STEP_UP_TTL_SECONDS };
  }

  /** Record a fresh authentication for this user in THIS session (also after a passkey sign-in). */
  static async markStepUp(userId: string, sessionId: string): Promise<void> {
    await challengeClient().setex(
      stepUpKey(userId, sessionId),
      PASSKEY_STEP_UP_TTL_SECONDS,
      userId
    );
  }

  // -------------------------------------------------------------------------------------------
  // Registration (authenticated)
  // -------------------------------------------------------------------------------------------

  static async beginRegistration(
    actor: PasskeyActor,
    origin: string | undefined,
    _input?: unknown
  ) {
    const ctx = await resolvePasskeyContext(origin);
    await requireStepUp(actor);
    const dcBegin = await doClientFor(actor.storeId);
    let doUser: DoCustomer | null = null;
    let doExisting: DoPasskey[] = [];
    if (dcBegin) {
      doUser = await dcBegin.call<DoCustomer | null>('getProfile', { userId: actor.userId });
      doExisting = await dcBegin.call<DoPasskey[]>('passkeyList', { userId: actor.userId });
    }
    const user = dcBegin
      ? doUser && { ...doUser, storeId: dcBegin.storeId }
      : await withUser(actor.userId, tx =>
          tx.user.findUnique({
            where: { id: actor.userId },
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              role: true,
              storeId: true,
              status: true,
            },
          })
        );
    if (!user || user.status !== 'active' || !accountFitsContext(user, ctx)) throw notAllowed();
    if (dcBegin && doUser?.mfaEnabled) throw mfaUnavailable();

    const existing = dcBegin
      ? doExisting.map(p => ({
          credentialId: p.credentialId,
          transports: p.transports,
          rpId: p.rpId,
        }))
      : await withUser(actor.userId, tx =>
          tx.passkeyCredential.findMany({
            where: { userId: actor.userId },
            select: { credentialId: true, transports: true, rpId: true },
          })
        );
    if (existing.length >= PASSKEY_MAX_PER_USER) {
      throw new AppError(409, 'PASSKEY_LIMIT', 'Too many passkeys on this account');
    }

    const { generateRegistrationOptions } = await loadSimpleWebAuthn();
    const options = await generateRegistrationOptions({
      rpName: ctx.surface === 'admin' ? BRAND.product.nameEn : ctx.rpId,
      rpID: ctx.rpId,
      userName: user.email,
      userDisplayName: `${user.firstName} ${user.lastName}`.trim() || user.email,
      userID: userIdBytes(user.id),
      attestationType: 'none',
      timeout: CEREMONY_TIMEOUT_MS,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: existing
        .filter(c => c.rpId === ctx.rpId)
        .map(c => ({ id: c.credentialId, transports: c.transports as never })),
    });
    await putChallenge(options.challenge, {
      purpose: 'register',
      rpId: ctx.rpId,
      origin: ctx.origin,
      surface: ctx.surface,
      storeId: ctx.storeId,
      userId: user.id,
    });
    return options;
  }

  static async finishRegistration(
    actor: PasskeyActor,
    origin: string | undefined,
    body: { response: RegistrationResponseJSON; name?: string }
  ): Promise<PasskeyListItem> {
    await requireStepUp(actor);
    const challenge = challengeOf(body.response as never);
    // Consumed even when a later check fails: one begin, one attempt.
    const record = challenge ? await takeChallenge(challenge) : null;
    if (
      !challenge ||
      !record ||
      record.purpose !== 'register' ||
      record.userId !== actor.userId ||
      origin !== record.origin
    ) {
      throw registrationFailed();
    }

    const { verifyRegistrationResponse } = await loadSimpleWebAuthn();
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: record.origin,
        expectedRPID: record.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw registrationFailed();
    }
    if (!verified.verified || !verified.registrationInfo) throw registrationFailed();

    const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
    try {
      const dcFin = await doClientFor(actor.storeId);
      if (dcFin) {
        const rowId = crypto.randomUUID();
        const added = await dcFin.call<DoPasskey>('passkeyAdd', {
          id: rowId,
          userId: actor.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: (credential.transports ?? []) as string[],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          rpId: record.rpId,
          name: cleanName(body.name),
        });
        await notifyPasskeyChange(actor.userId, 'added', added.name, actor.storeId);
        return toItem(passkeyItem(added), record.rpId);
      }
      const row = await withUser(actor.userId, tx =>
        tx.passkeyCredential.create({
          data: {
            userId: actor.userId,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            transports: (credential.transports ?? []) as string[],
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            rpId: record.rpId,
            name: cleanName(body.name),
          },
        })
      );
      await notifyPasskeyChange(actor.userId, 'added', row.name);
      return toItem(row, record.rpId);
    } catch (e) {
      if (isP2002(e) || (e instanceof AppError && e.code === 'PASSKEY_EXISTS'))
        throw registrationFailed();
      throw e;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Authentication (credential-less: no email, nothing to enumerate)
  // -------------------------------------------------------------------------------------------

  static async beginAuthentication(origin: string | undefined) {
    const ctx = await resolvePasskeyContext(origin);
    const { generateAuthenticationOptions } = await loadSimpleWebAuthn();
    const options = await generateAuthenticationOptions({
      rpID: ctx.rpId,
      userVerification: 'required',
      timeout: CEREMONY_TIMEOUT_MS,
    });
    await putChallenge(options.challenge, {
      purpose: 'login',
      rpId: ctx.rpId,
      origin: ctx.origin,
      surface: ctx.surface,
      storeId: ctx.storeId,
    });
    return options;
  }

  /**
   * Verify an assertion. Resolves to the account (for `AuthService.issueSessionFor`) and the credential
   * row; EVERY failure is the same `PASSKEY_AUTH_FAILED` (the reason, and the account once identified,
   * go to `onFailure` for the audit log, never to the client).
   *
   * Gates are the password login's (PASSKEY-8): the shared lockout counter is checked once the account is
   * known and every failure after that point feeds it, an inactive account gets nothing, and success
   * clears it. The IP bucket is the route's `passkeyFinishLimiter`.
   */
  static async finishAuthentication(
    origin: string | undefined,
    response: AuthenticationResponseJSON,
    onFailure?: (reason: string, userId?: string) => void,
    meta: { ip?: string } = {}
  ) {
    // Filled in as the account becomes known; read by the failure helpers below.
    const known: { userId?: string; lockoutKey?: string } = {};
    const fail = async (reason: string): Promise<never> => {
      onFailure?.(reason, known.userId);
      throw authFailed();
    };
    // After the account is identified, a failure also counts against its (shared) lockout budget.
    const failKnown = async (reason: string): Promise<never> => {
      if (known.lockoutKey) {
        await loginGate.recordFailure(known.lockoutKey, meta.ip).catch(() => undefined);
      }
      return fail(reason);
    };

    const challenge = challengeOf(response as never);
    if (!challenge) return fail('malformed');
    const record = await takeChallenge(challenge);
    if (!record || record.purpose !== 'login') return fail('challenge');
    if (origin !== record.origin) return fail('origin_mismatch');

    let ctx: PasskeyContext;
    try {
      ctx = await resolvePasskeyContext(origin);
    } catch {
      return fail('context');
    }
    if (ctx.rpId !== record.rpId || ctx.storeId !== record.storeId) return fail('context');

    // N-9: a store served by its StoreDO looks the credential up THERE (its credentials are in no other DO), by construction.
    const dcAuth = ctx.surface === 'storefront' ? await doClientFor(ctx.storeId) : null;
    const doHit =
      dcAuth && typeof response.id === 'string'
        ? await dcAuth.call<{ passkey: DoPasskey; user: DoCustomer } | null>('passkeyLookup', {
            credentialId: response.id,
          })
        : null;
    const stored = dcAuth
      ? doHit && {
          id: doHit.passkey.id,
          userId: doHit.passkey.userId,
          publicKey: doHit.passkey.publicKey,
          counter: doHit.passkey.counter,
          transports: doHit.passkey.transports,
          rpId: doHit.passkey.rpId,
        }
      : typeof response.id === 'string'
        ? await passkeyLookup(response.id)
        : null;
    if (!stored) return fail('unknown_credential');
    known.userId = stored.userId;
    if (stored.rpId !== record.rpId) return fail('rp_mismatch');

    const user = dcAuth
      ? doHit && {
          id: doHit.user.id,
          email: doHit.user.email,
          storeId: dcAuth.storeId as string | null,
          firstName: doHit.user.firstName,
          lastName: doHit.user.lastName,
          role: 'customer',
          emailVerified: doHit.user.emailVerified,
          tokenVersion: doHit.user.tokenVersion,
          status: doHit.user.status,
          deletedAt: doHit.user.deletedAt === null ? null : new Date(doHit.user.deletedAt),
        }
      : await withUser(stored.userId, tx =>
          tx.user.findUnique({
            where: { id: stored.userId },
            select: {
              id: true,
              email: true,
              storeId: true,
              firstName: true,
              lastName: true,
              role: true,
              emailVerified: true,
              tokenVersion: true,
              status: true,
              deletedAt: true,
            },
          })
        );
    if (!user) return fail('account');
    // Ruling NZ-N9-1: a passkey sign-in "satisfies MFA" only where TOTP is enforced elsewhere; a DO account with TOTP on is refused.
    if (dcAuth && doHit?.user.mfaEnabled) return fail('mfa');
    const lockoutKey = loginGate.lockoutKey(user.email, user.storeId);
    known.lockoutKey = lockoutKey;
    try {
      await loginGate.assertNotLocked(lockoutKey);
    } catch {
      return fail('locked');
    }
    try {
      loginGate.assertActive(user);
    } catch {
      return fail('account');
    }
    if (!accountFitsContext(user, ctx)) return fail('surface');

    const handle = response.response?.userHandle;
    if (handle && Buffer.from(handle, 'base64url').toString('utf8') !== user.id) {
      return failKnown('user_handle');
    }

    const { verifyAuthenticationResponse } = await loadSimpleWebAuthn();
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: record.origin,
        expectedRPID: record.rpId,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: Buffer.from(stored.publicKey, 'base64url'),
          counter: stored.counter,
          transports: stored.transports as never,
        },
      });
    } catch (e) {
      // The library throws on a sign count that did not advance: a cloned authenticator looks like this.
      const msg = e instanceof Error ? e.message : '';
      return failKnown(/counter/i.test(msg) ? 'counter_regression' : 'verification');
    }
    if (!verified.verified) return failKnown('verification');

    const next = verified.authenticationInfo.newCounter;
    if (dcAuth) {
      const t = await dcAuth.call<{ touched: boolean }>('passkeyTouch', {
        id: stored.id,
        userId: user.id,
        counter: next,
        backedUp: verified.authenticationInfo.credentialBackedUp,
      });
      if (!t.touched) return failKnown('counter_race');
      await loginGate.recordSuccess(lockoutKey, meta.ip).catch(() => undefined);
      return { user, credentialRowId: stored.id };
    }
    const touched = await withUser(user.id, tx =>
      tx.passkeyCredential.updateMany({
        // Compare-and-set on the sign count: two racing assertions cannot both advance it.
        where:
          next > 0
            ? { id: stored.id, userId: user.id, counter: { lt: next } }
            : { id: stored.id, userId: user.id },
        data: {
          counter: next,
          lastUsedAt: new Date(),
          backedUp: verified.authenticationInfo.credentialBackedUp,
        },
      })
    );
    if (touched.count !== 1) return failKnown('counter_race');

    await loginGate.recordSuccess(lockoutKey, meta.ip).catch(() => undefined);
    // The route opens the step-up window for the NEW session once it has minted it (PASSKEY-12).
    return { user, credentialRowId: stored.id };
  }

  // -------------------------------------------------------------------------------------------
  // Management (authenticated)
  // -------------------------------------------------------------------------------------------

  static async list(
    userId: string,
    origin?: string,
    storeId?: string | null
  ): Promise<PasskeyListItem[]> {
    let rpId: string | null = null;
    try {
      rpId = (await resolvePasskeyContext(origin)).rpId;
    } catch {
      rpId = null;
    }
    const dcList = await doClientFor(storeId);
    if (dcList) {
      const rows = await dcList.call<DoPasskey[]>('passkeyList', { userId });
      return rows.map(r => toItem(passkeyItem(r), rpId));
    }
    const rows = await withUser(userId, tx =>
      tx.passkeyCredential.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          lastUsedAt: true,
          deviceType: true,
          backedUp: true,
          rpId: true,
        },
      })
    );
    return rows.map(r => toItem(r, rpId));
  }

  static async rename(actor: PasskeyActor, id: string, name: string): Promise<void> {
    await requireStepUp(actor);
    const { userId } = actor;
    const dcRen = await doClientFor(actor.storeId);
    if (dcRen) {
      const r = await dcRen.call<{ updated: number }>('passkeyRename', {
        userId,
        id,
        name: cleanName(name),
      });
      if (r.updated !== 1) throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
      return;
    }
    const res = await withUser(userId, tx =>
      tx.passkeyCredential.updateMany({
        where: { id, userId },
        data: { name: cleanName(name) },
      })
    );
    if (res.count !== 1) throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
  }

  static async remove(actor: PasskeyActor, id: string): Promise<void> {
    await requireStepUp(actor);
    const { userId } = actor;
    const dcRem = await doClientFor(actor.storeId);
    if (dcRem) {
      const r = await dcRem.call<{ removed: number; name: string | null }>('passkeyRemove', {
        userId,
        id,
      });
      if (r.removed !== 1) throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
      await AuthService.revokeAllSessions(userId, 'revoke_all', { storeId: actor.storeId });
      await notifyPasskeyChange(userId, 'removed', r.name ?? 'Passkey', actor.storeId);
      return;
    }
    const row = await withUser(userId, tx =>
      tx.passkeyCredential.findMany({ where: { userId }, select: { id: true, name: true } })
    ).then(rows => rows.find(r => r.id === id));
    const res = await withUser(userId, tx =>
      tx.passkeyCredential.deleteMany({ where: { id, userId } })
    );
    if (res.count !== 1) throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
    // Sessions and refresh tokens minted through this passkey must die with it. They are not tagged with
    // the credential they came from, so the whole account signs out (token-version bump + every refresh
    // token revoked): a superset, and the one mechanism every other revocation path already uses.
    await AuthService.revokeAllSessions(userId);
    await notifyPasskeyChange(userId, 'removed', row?.name ?? 'Passkey');
  }
}

function toItem(
  r: {
    id: string;
    name: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    deviceType: string;
    backedUp: boolean;
    rpId: string;
  },
  currentRpId: string | null
): PasskeyListItem {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    deviceType: r.deviceType,
    backedUp: r.backedUp,
    needsReenrol: currentRpId !== null && r.rpId !== currentRpId,
  };
}
