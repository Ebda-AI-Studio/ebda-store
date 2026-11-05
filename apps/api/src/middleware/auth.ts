import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './error-handler';
import { redis } from '../services/redis.service';
import { getUserState } from '../lib/definer';
import { getAccountState } from '../lib/identity-client';
import { withIdentityTimeout } from '../lib/identity-timeout';
import { accountStateCached } from '../lib/identity-live-cache';
import { needsLiveIdentity } from '../lib/auth-sensitivity';
import logger from '../lib/logger';
import { runWithImpersonation } from '../lib/impersonation-context';
import { recordTiming } from '../lib/request-timing';
import { customerTokenMatchesRequestStore } from '../lib/customer-store-binding';
import { customerAuthRoute } from '../lib/customer-auth';
import { isPlatformOrigin } from '../lib/cors-cache';
import {
  isAccountsToken,
  sessionRevoked,
  verifyAccountsToken,
  type AccountsClaims,
} from '../lib/accounts-token';

import { JWT_AUDIENCES_ACCEPTED, JWT_ISSUERS_ACCEPTED } from '@ebda/shared';
export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
  /**
   * Tenant scope. Set on customer tokens (= the store the customer
   * registered with). NULL/undefined for admin tokens, which are
   * authorized via Store.ownerId + requireStoreAccess instead. Older
   * tokens issued before this field shipped will simply be `undefined`
   * and callers should treat that as "not tenant-scoped" — those tokens
   * still work as before until they expire.
   */
  storeId?: string | null;
  /** Token version stamped at issue time. Used for bulk revocation. */
  tv?: number;
  /**
   * Set to the acting super_admin's userId when this token was minted by
   * POST /admin/impersonate. Read by `rejectImpersonated` — an impersonation
   * session must not be able to perform irreversible account actions on the
   * person being impersonated.
   */
  impersonatedBy?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload;
  }
}

/**
 * Extract token from Authorization header or HTTP-only cookie.
 * The header takes precedence; the cookie is a fallback for
 * browser-based requests that rely on cookie-based auth.
 */
function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  // Fallback: check HTTP-only cookie set by login/register routes
  const cookieToken = req.cookies?.token as string | undefined;
  if (cookieToken) {
    return cookieToken;
  }

  return undefined;
}

/**
 * Resolve the user's current token version, plus (on a cache miss only) their
 * account status.
 *
 * Redis first, Postgres on a miss. There is deliberately NO in-process cache
 * behind that.
 *
 * One was added here to bound the DB stampede when Redis is unavailable —
 * `getUserTokenVersion` returns null both for a miss and for an outage, so a
 * degraded Redis turns every authenticated request into a round-trip. The
 * reasoning attached to it was wrong: it claimed a stale-low `tv` would keep a
 * revoked token alive "for at most the same bound the Redis tier already
 * accepts". The Redis tier accepts no such bound — revocation OVERWRITES that
 * key with the bumped value, or DELETES it when that write fails
 * (`pushTokenVersion` in auth.service.ts), so the next request sees the bump
 * immediately, from the cache or from Postgres. An
 * in-process memo has nothing clearing it, and being per-process, nothing
 * could: a bump on one instance cannot evict another instance's copy. It
 * bought a cache hit and sold the revocation guarantee, keeping logged-out
 * sessions and password-change victims authenticated for a full TTL window
 * across every API instance. tests/integration/token-revocation.test.ts caught
 * it — 200 where the suite demands 401.
 *
 * If the Redis-outage stampede is worth solving, it needs a mechanism that
 * revocation can still reach: a shorter-lived negative cache keyed on the
 * outage rather than on the user, or a circuit breaker in the Redis client.
 * Not a silent local copy of a security-critical value.
 *
 * STATUS (S3-1, 2026-09-22 security audit): the primary enforcement for a
 * suspended/inactive account is `revokeAllSessions`, called from
 * `PUT /admin/users/:id` whenever `status` leaves `active` — that bumps
 * `tokenVersion`, which every request already checks below, cache hit or
 * miss. Reading `status` here too is defense-in-depth for the case that call
 * is skipped or fails: whenever the tv cache is COLD and this middleware has
 * to hit Postgres anyway, it reads `status` off the same row for free and
 * rejects a non-active user even if nothing ever bumped their tv. It cannot
 * detect a suspension while the tv cache stays warm (that gap is what
 * `revokeAllSessions` closes), so it is a second layer, not a replacement for
 * the admin-route call.
 */
async function resolveTokenVersionAndStatus(
  userId: string,
  customerStoreId?: string | null
): Promise<{ tokenVersion: number; blocked: boolean }> {
  const cachedTv = await redis.getUserTokenVersion(userId);
  if (cachedTv !== null) return { tokenVersion: cachedTv, blocked: false };

  // N-9: a customer of a store served by its StoreDO is known to THAT DO only (the HS256 token names the store). Unknown there =
  // BLOCKED, never "tokenVersion 0", and nothing is cached for it. Postgres is not asked.
  const route = await customerAuthRoute(customerStoreId, { write: false });
  if (route.kind === 'do') {
    const st = await route.client.call<{
      tokenVersion: number;
      status: string;
      deletedAt: number | null;
    } | null>('userState', { userId });
    if (!st) return { tokenVersion: 0, blocked: true };
    await redis.setUserTokenVersion(userId, st.tokenVersion);
    return {
      tokenVersion: st.tokenVersion,
      blocked: st.status !== 'active' || st.deletedAt !== null,
    };
  }

  // `users` is under strict RLS and the caller is not scoped to anyone yet, so
  // this exact-id read goes through the `ebda_user_state` definer.
  const u = await getUserState(userId);
  // Ruling NZ-D2: an UNKNOWN user is BLOCKED, never "tokenVersion 0", and nothing is cached for it (a miss answered by a
  // backend that does not know the user must not become the authoritative value for the next request).
  if (!u) return { tokenVersion: 0, blocked: true };
  await redis.setUserTokenVersion(userId, u.tokenVersion);
  return { tokenVersion: u.tokenVersion, blocked: u.status !== 'active' || !!u.deletedAt };
}

/**
 * Map an identity-service token (Rulings ID-1/ID-2) onto the Store's request identity.
 *
 * role: `pa: super_admin` -> super_admin; owning at least one store (or none yet: a merchant who has not created a store) ->
 * store_admin; only staff memberships -> staff. Store ACCESS is still decided from the database (requireStoreAccess:
 * ownerId / StoreStaff), not from the claim: the claim is up to 15 minutes old, the database is not (Ruling ID-9).
 */
/** Maximum age of the login behind a platform-admin token. */
export const SUPER_ADMIN_MAX_AUTH_AGE_SECONDS = 12 * 3600;

export function accountsUser(c: AccountsClaims, profileRole?: string): AuthPayload {
  // The identity-managed profile row's role is authoritative for store_admin vs staff (the stores[] claim cannot express a
  // mixed owner+staff user); a platform admin is only ever what the token's `pa` claim says.
  const role =
    c.pa === 'super_admin'
      ? 'super_admin'
      : profileRole === 'staff' || profileRole === 'store_admin'
        ? profileRole
        : c.stores.length > 0 && !c.stores.some(s => s.role === 'owner')
          ? 'staff'
          : 'store_admin';
  return { userId: c.sub, email: c.email ?? '', role, storeId: null };
}

export interface LiveIdentityMemo {
  key?: string;
  value?: { revoked: boolean; account: Awaited<ReturnType<typeof getAccountState>> };
}
const LIVE_MEMO = Symbol('ebda.liveIdentityMemo');
/** The request's live-identity memo (created on first use). Shared by tenantContext's pre-check and `authenticate`. */
export function liveIdentityMemo(req: Request): LiveIdentityMemo {
  const holder = req as unknown as Record<symbol, LiveIdentityMemo | undefined>;
  return (holder[LIVE_MEMO] ??= {});
}

/** Verify an identity-service token and its session. Throws AppError on any failure. */
export async function authenticateAccounts(
  token: string,
  opts: {
    /** Kept for the one caller that mints the Store session (`POST /auth/session`); the identity service is the authority now. */
    allowMissingProfile?: boolean;
    /**
     * `true` (default): ask the identity service for revocation + account state NOW (every write, bulk / sensitive read,
     * refresh). `false`: trust the signed claims (plain reads; tokens live <= 5 minutes). Ruling NZ-D2.
     */
    live?: boolean;
    /** Out-parameter: how long the identity round trip took (0 on a cache hit / non-live), for Server-Timing. */
    timing?: { identityMs?: number };
    /**
     * Per-request memo of the live answers. `tenantContext` pre-checks before it opens the request transaction and hands the
     * same memo to `authenticate`, so the RPCs are not repeated inside the transaction.
     */
    memo?: LiveIdentityMemo;
  } = {}
): Promise<{ user: AuthPayload; claims: AccountsClaims }> {
  let claims: AccountsClaims;
  try {
    claims = await verifyAccountsToken(token);
  } catch {
    throw new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token');
  }
  // A platform admin's power needs a FRESH login (Ruling ID-15): at most 12 h since the interactive login that created the
  // session. A token without `auth_time` cannot prove it, so it is refused too.
  if (claims.pa === 'super_admin') {
    const age = Date.now() / 1000 - (claims.authTime ?? 0);
    if (!claims.authTime || age > SUPER_ADMIN_MAX_AUTH_AGE_SECONDS) {
      throw new AppError(
        401,
        'REAUTH_REQUIRED',
        'Sign in again to continue as a platform administrator'
      );
    }
  }
  if (opts.live === false) return { user: accountsUser(claims), claims };

  // LIVE: ONE source for revocation + existence + status (the identity service). Postgres is not consulted.
  let revoked: boolean;
  let account: Awaited<ReturnType<typeof getAccountState>>;
  const memoKey = `${claims.sid}|${claims.sub}`;
  const identityStart = performance.now();
  try {
    if (opts.memo?.key === memoKey && opts.memo.value) {
      // The pre-check made moments ago in THIS request (tenantContext, before its transaction opened): same answers, no
      // second round trip while a pooled client is leased.
      ({ revoked, account } = opts.memo.value);
    } else {
      // 3 s budget per RPC. Revocation is asked every time; the account state is shared by concurrent requests and kept 30 s
      // when positive (lib/identity-live-cache.ts documents the NEVER-stale class and the cross-isolate residual).
      const [r, a] = await Promise.all([
        withIdentityTimeout(sessionRevoked(claims.sid), 'isRevoked'),
        accountStateCached(
          claims.sub,
          () => withIdentityTimeout(getAccountState(claims.sub), 'getAccountState'),
          v => v?.status === 'active'
        ),
      ]);
      revoked = r;
      account = a;
      if (opts.memo) {
        opts.memo.key = memoKey;
        opts.memo.value = { revoked, account };
      }
    }
    if (opts.timing) opts.timing.identityMs = performance.now() - identityStart;
  } catch (err) {
    // Cannot confirm the session is alive: refuse, but as an outage (503), not as a bad credential (401 would log users out).
    logger.error({ err: (err as Error).message }, '[auth] identity live check failed');
    throw new AppError(503, 'IDENTITY_UNAVAILABLE', 'Sign-in service unavailable, try again');
  }
  if (revoked) throw new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked');
  // Unknown (or erased) user = BLOCKED, never a default (Ruling NZ-D2).
  if (!account) throw new AppError(401, 'TOKEN_REVOKED', 'Account not found');
  if (account.status !== 'active')
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is not active');
  return { user: accountsUser(claims, account.role), claims };
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }

  // Identity-service (ES256) token: merchants, staff and super admins. Customer and impersonation tokens stay HS256.
  if (isAccountsToken(token)) {
    try {
      const timing: { identityMs?: number } = {};
      const authStart = performance.now();
      const { user, claims } = await authenticateAccounts(token, {
        live: needsLiveIdentity(req),
        timing,
        memo: liveIdentityMemo(req),
      });
      recordTiming(req, 'auth', performance.now() - authStart);
      if (timing.identityMs !== undefined) recordTiming(req, 'identity', timing.identityMs);
      req.user = user;
      (req as any).tokenJti = claims.jti;
      (req as any).accountsSid = claims.sid;
      (req as any).accountsStores = claims.stores;
      return next();
    } catch (err) {
      return next(
        err instanceof AppError
          ? err
          : new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token')
      );
    }
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUERS_ACCEPTED,
      audience: JWT_AUDIENCES_ACCEPTED,
    }) as AuthPayload & { type?: string };

    // Reject refresh tokens used as access tokens
    if (payload.type === 'refresh') {
      return next(
        new AppError(401, 'TOKEN_INVALID', 'Refresh tokens cannot be used for authentication')
      );
    }

    // Belt-and-suspenders: reject any token that carries a non-access purpose
    // claim. Real access tokens have no `purpose` field. MFA challenge tokens
    // carry purpose:'mfa' and are audience:'ebda-mfa-challenge' so jwt.verify
    // above already rejects them via audience mismatch — but this guard closes
    // the window in case the audience check is ever weakened or bypassed.
    if ((payload as any).purpose && (payload as any).purpose !== 'access') {
      return next(new AppError(401, 'TOKEN_INVALID', 'Token cannot be used for authentication'));
    }

    // --- Revocation check 1: per-token JTI denylist ---
    // jwt.verify decoded the header+payload; re-use jwt.decode here (no
    // re-verify cost) just to extract jti cleanly from the raw token.
    const decoded = jwt.decode(token) as { jti?: string } | null;
    if (decoded?.jti && (await redis.isJtiDenied(decoded.jti))) {
      return next(new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked'));
    }

    // --- Revocation check 2: per-user token-version (bulk revocation) ---
    // Read tv from Redis cache; fall back to DB + repopulate cache on miss.
    const { tokenVersion: currentTv, blocked } = await resolveTokenVersionAndStatus(
      payload.userId,
      payload.role === 'customer' ? payload.storeId : null
    );
    if ((payload.tv ?? 0) < currentTv) {
      return next(new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked'));
    }
    // S3-1: defense-in-depth status check — see resolveTokenVersionAndStatus.
    if (blocked) {
      return next(new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked'));
    }

    // F-01 / Ruling S11-1: a CUSTOMER token only works for the store it was issued
    // for AND from that store's own origin. One place for every customer route.
    // Merchant/staff/super_admin tokens are authorised by ownership + requireStoreAccess
    // instead and are not touched. Same 401 as any dead token, so a probe learns nothing.
    if (
      payload.role === 'customer' &&
      !(await customerTokenMatchesRequestStore(req, payload.storeId))
    ) {
      return next(new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token'));
    }

    req.user = payload;
    // Expose the jti on the request so downstream middleware (e.g. logout)
    // can denylist this specific token without re-decoding.
    (req as any).tokenJti = decoded?.jti;
    // BE:S-2: every audit row written for the rest of this request names the impersonating super_admin. `run`, not
    // `enterWith` (not implemented on workerd), see lib/impersonation-context.ts.
    if (payload.impersonatedBy) {
      runWithImpersonation(payload.impersonatedBy, () => next());
      return;
    }
    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    return next(new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token'));
  }
}

/**
 * Optional authentication — sets req.user if a valid token is provided, but
 * doesn't require one.
 *
 * This applies the SAME four guards as `authenticate` (refresh-token reject,
 * non-access purpose reject, JTI denylist, token-version) and differs only in
 * what it does on failure: continue as a guest rather than 401.
 *
 * It used to run `jwt.verify` alone. That made it a strictly weaker second
 * verifier on the same secret: a 1-year REFRESH token (minted with the same
 * `ebda-app` audience) was accepted as an access identity, and a token
 * revoked by logout / logout-all / password-change was still honoured here.
 * Ownership checks downstream meant a stale identity only ever reached its own
 * orders — but "revoked" has to mean revoked everywhere, or the revocation
 * guarantees the rest of the codebase builds are only as strong as the
 * weakest verifier.
 *
 * Cost note: every check below is behind `if (!token)`, so guest traffic (the
 * common case on these public routes) still does zero Redis/DB work.
 */
export async function optionalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    // No token provided, continue without user
    next();
    return;
  }

  // #1255: crypto verification and the I/O revocation checks used to share
  // ONE bare try/catch, so a Redis/Postgres blip in
  // resolveTokenVersionAndStatus/isJtiDenied was indistinguishable from a bad
  // signature — both silently degraded to guest with zero log signal. A
  // widespread Redis/Postgres degradation could therefore make every
  // logged-in visitor intermittently appear logged out across the whole
  // storefront with nothing to alert on. Split so the two failure classes
  // are observable separately; the I/O branch still fails toward guest (the
  // safe default — we do not want to grant an identity we could not confirm
  // is unrevoked), but now logs loudly instead of silently.
  if (isAccountsToken(token)) {
    try {
      const { user, claims } = await authenticateAccounts(token);
      req.user = user;
      (req as any).tokenJti = claims.jti;
      (req as any).accountsSid = claims.sid;
      (req as any).accountsStores = claims.stores;
    } catch {
      /* invalid, revoked or unconfirmable: continue as a guest, like every other failure on this path */
    }
    return next();
  }

  let payload: (AuthPayload & { type?: string; purpose?: string }) | null = null;
  try {
    payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUERS_ACCEPTED,
      audience: JWT_AUDIENCES_ACCEPTED,
    }) as AuthPayload & { type?: string; purpose?: string };
  } catch {
    // Invalid/expired/malformed token — routine, unauthenticated traffic on
    // a public route. Continue as guest, no log.
    return next();
  }

  // Same rejections as `authenticate` — a refresh token or any non-access
  // purpose claim must never establish an identity.
  if (payload.type === 'refresh') return next();
  if (payload.purpose && payload.purpose !== 'access') return next();

  try {
    const decoded = jwt.decode(token) as { jti?: string } | null;
    if (decoded?.jti && (await redis.isJtiDenied(decoded.jti))) return next();

    const { tokenVersion: currentTv, blocked } = await resolveTokenVersionAndStatus(
      payload.userId,
      payload.role === 'customer' ? payload.storeId : null
    );
    if ((payload.tv ?? 0) < currentTv) return next();
    // S3-1: same defense-in-depth status check as `authenticate` — a
    // suspended user must fall through to "continue as guest", never
    // establish an identity.
    if (blocked) return next();

    // F-01 / Ruling S11-1: a customer token for another store (or from another store's
    // origin) is no identity here — continue as a guest, exactly as for a dead token.
    if (
      payload.role === 'customer' &&
      !(await customerTokenMatchesRequestStore(req, payload.storeId))
    ) {
      return next();
    }

    req.user = payload;
  } catch (err) {
    // A validly-signed token whose REVOCATION status we could not confirm
    // (Redis/Postgres error) — distinct from, and logged unlike, a bad
    // signature above. Still degrades to guest (never grant an identity this
    // request couldn't confirm is unrevoked), but loudly instead of silently.
    logger.error(
      { err, userId: payload.userId },
      '[auth] optionalAuthenticate revocation check failed — degrading to guest'
    );
  }

  // Same attribution as `authenticate`: an impersonated request that reaches a public route names the impersonator in its audit rows.
  if (req.user?.impersonatedBy) {
    runWithImpersonation(req.user.impersonatedBy, () => next());
    return;
  }
  next();
}

export function authorize(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!roles.includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    }

    next();
  };
}

/**
 * "Is this request a real customer?" guard. The api host's auth cookie is
 * shared between admin (store.ebda.app) and storefront
 * (ebda.app) origins, so a merchant signed into admin sends
 * the SAME cookie to public/customer-facing endpoints — and naively reading
 * `req.user?.userId` as a customerId attaches the merchant's user record to
 * carts / wishlists / reviews / loyalty rows.
 *
 * Returns the authenticated customer's userId, or `undefined` for guests
 * AND for any token whose role isn't `customer`. Use this in every
 * customer-scoped route that previously did `req.user?.userId`. The
 * AuthContext.refreshUser on the storefront has the matching client-side
 * guard.
 */
export function customerUserId(req: Request): string | undefined {
  return req.user?.role === 'customer' ? req.user.userId : undefined;
}

/**
 * Refuse irreversible, account-level self-service actions when the caller is
 * an impersonation session.
 *
 * POST /admin/impersonate mints a 1h token carrying the target user's real
 * role plus an `impersonatedBy` claim. The claim was documented as letting
 * "downstream guards reject it for high-privilege operations if desired" —
 * but nothing read it, so an impersonation session was indistinguishable from
 * a real one and could erase the impersonated person's account, change their
 * password or email, or revoke all their sessions.
 *
 * That is the amplifier that turned the merchant-custom-origin CSRF hole
 * (fixed 2026-09-02) into a full takeover: read one impersonation token, then
 * act irreversibly as anyone. Impersonation is for support and debugging —
 * looking, not destroying.
 */
export function rejectImpersonated(req: Request, res: Response, next: NextFunction) {
  if (req.user?.impersonatedBy) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'IMPERSONATION_FORBIDDEN',
        message: 'This action is not available while impersonating another user',
      },
    });
  }
  return next();
}

/**
 * Admin-namespace identities (`store_admin`, `staff`, `super_admin`) are served account endpoints only to
 * PLATFORM origins (review M4).
 *
 * CORS allowlists every verified merchant domain with `credentials: true` and the session cookie is
 * `SameSite=None`, so a page the merchant controls can lure a signed-in admin and READ whatever an
 * account endpoint answers (profile, MFA state, the data export, the passkey list). `csrfProtection` only
 * guards writes and `restrictPlatformOnlyOrigins` is a path list that never covered `/auth/*`. Admin
 * sessions are only ever used from the admin/orders apps, which are platform origins; the storefront carries
 * `customer` tokens. A request with no Origin (server-to-server, no ambient cookie) passes.
 * Mount AFTER `authenticate`.
 */
export function rejectAdminOnMerchantOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin as string | undefined;
  if (!origin || !req.user || req.user.role === 'customer') return next();
  if (
    isPlatformOrigin(origin, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    })
  ) {
    return next();
  }
  logger.warn(
    { origin, role: req.user.role, path: req.path },
    '[SECURITY] admin credentials presented from a non-platform origin'
  );
  return res.status(403).json({
    success: false,
    error: {
      code: 'ORIGIN_NOT_PERMITTED',
      message: 'This endpoint is not available from this origin',
    },
  });
}

/**
 * Credential management (password, MFA, passkeys) of a merchant, staff or super-admin account belongs to the identity service
 * (Rulings ID-1/ID-2). A change made here would only touch a profile row the identity service ignores, so it would LOOK
 * enrolled while protecting nothing. Mount AFTER `authenticate`. Customers are unaffected.
 */
export async function rejectIdentityManaged(req: Request, _res: Response, next: NextFunction) {
  try {
    // Decided from the verified token, not a Postgres read: a non-customer without a store is an admin-namespace account, and
    // those live in the identity service (a HS256 admin token and an identity ES256 token both carry no storeId).
    if (req.user && req.user.role !== 'customer' && !req.user.storeId) {
      return next(
        new AppError(
          409,
          'USE_IDENTITY_SERVICE',
          'Manage sign-in settings in your Ebda AI Studio account settings'
        )
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}
