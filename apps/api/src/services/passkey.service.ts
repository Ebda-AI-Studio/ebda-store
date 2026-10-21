import crypto from 'crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { withUser } from '@ebda/database';
import { BRAND } from '@ebda/shared';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { lookupStore, passkeyLookup } from '../lib/definer';
import { loadSimpleWebAuthn } from '../lib/lazy-modules';
import { storeLookupForHost } from '../lib/store-host';
import { isP2002 } from '../lib/prisma-errors';
import { encryption } from './encryption.service';
import { MfaService } from './mfa.service';
import { redis } from './redis.service';

/**
 * Passkeys (WebAuthn) for merchants/staff (admin) and shoppers (one store). Plan:
 * docs/plans/2026-10-21-passkeys.md. The rulings that shape this file:
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
 */

export const PASSKEY_CHALLENGE_TTL_SECONDS = 300;
export const PASSKEY_MAX_PER_USER = 10;
const CEREMONY_TIMEOUT_MS = 60_000;
const NAME_MAX = 60;

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

const userIdBytes = (id: string) => new TextEncoder().encode(id);

export class PasskeyService {
  // -------------------------------------------------------------------------------------------
  // Registration (authenticated)
  // -------------------------------------------------------------------------------------------

  static async beginRegistration(
    actor: { userId: string },
    origin: string | undefined,
    input: { code?: string }
  ) {
    const ctx = await resolvePasskeyContext(origin);
    const user = await withUser(actor.userId, tx =>
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
          mfaEnabled: true,
          mfaSecret: true,
        },
      })
    );
    if (!user || user.status !== 'active' || !accountFitsContext(user, ctx)) throw notAllowed();

    // A hijacked session must not silently add an authenticator (same rule as TOTP re-enrol).
    if (user.mfaEnabled && user.mfaSecret) {
      const ok =
        typeof input.code === 'string' &&
        MfaService.verifyCode(encryption.decrypt(user.mfaSecret), input.code);
      if (!ok) {
        throw new AppError(400, 'MFA_REAUTH_REQUIRED', 'Provide current 2FA code to add a passkey');
      }
    }

    const existing = await withUser(actor.userId, tx =>
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
    actor: { userId: string },
    origin: string | undefined,
    body: { response: RegistrationResponseJSON; name?: string }
  ): Promise<PasskeyListItem> {
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
      return toItem(row, record.rpId);
    } catch (e) {
      if (isP2002(e)) throw registrationFailed();
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
   * row; EVERY failure is the same `PASSKEY_AUTH_FAILED` (the reason goes to `onFailure` for the audit
   * log, never to the client).
   */
  static async finishAuthentication(
    origin: string | undefined,
    response: AuthenticationResponseJSON,
    onFailure?: (reason: string) => void
  ) {
    const fail = (reason: string): never => {
      onFailure?.(reason);
      throw authFailed();
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

    const stored = typeof response.id === 'string' ? await passkeyLookup(response.id) : null;
    if (!stored) return fail('unknown_credential');
    if (stored.rpId !== record.rpId) return fail('rp_mismatch');

    const user = await withUser(stored.userId, tx =>
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
    if (!user || user.status !== 'active' || user.deletedAt) return fail('account');
    if (!accountFitsContext(user, ctx)) return fail('surface');

    const handle = response.response?.userHandle;
    if (handle && Buffer.from(handle, 'base64url').toString('utf8') !== user.id) {
      return fail('user_handle');
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
      return fail(/counter/i.test(msg) ? 'counter_regression' : 'verification');
    }
    if (!verified.verified) return fail('verification');

    const next = verified.authenticationInfo.newCounter;
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
    if (touched.count !== 1) return fail('counter_race');

    return { user, credentialRowId: stored.id };
  }

  // -------------------------------------------------------------------------------------------
  // Management (authenticated)
  // -------------------------------------------------------------------------------------------

  static async list(userId: string, origin?: string): Promise<PasskeyListItem[]> {
    let rpId: string | null = null;
    try {
      rpId = (await resolvePasskeyContext(origin)).rpId;
    } catch {
      rpId = null;
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

  static async rename(userId: string, id: string, name: string): Promise<void> {
    const res = await withUser(userId, tx =>
      tx.passkeyCredential.updateMany({
        where: { id, userId },
        data: { name: cleanName(name) },
      })
    );
    if (res.count !== 1) throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
  }

  static async remove(userId: string, id: string): Promise<void> {
    const res = await withUser(userId, tx =>
      tx.passkeyCredential.deleteMany({ where: { id, userId } })
    );
    if (res.count !== 1) throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
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
