import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './error-handler';
import { redis } from '../services/redis.service';
import { prisma } from '@force/database';

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

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'force-api',
      audience: 'force-app',
    }) as AuthPayload & { type?: string };

    // Reject refresh tokens used as access tokens
    if (payload.type === 'refresh') {
      return next(
        new AppError(401, 'TOKEN_INVALID', 'Refresh tokens cannot be used for authentication')
      );
    }

    // Belt-and-suspenders: reject any token that carries a non-access purpose
    // claim. Real access tokens have no `purpose` field. MFA challenge tokens
    // carry purpose:'mfa' and are audience:'force-mfa-challenge' so jwt.verify
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
    const cachedTv = await redis.getUserTokenVersion(payload.userId);
    let currentTv: number;
    if (cachedTv === null) {
      const u = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { tokenVersion: true },
      });
      currentTv = u?.tokenVersion ?? 0;
      await redis.setUserTokenVersion(payload.userId, currentTv);
    } else {
      currentTv = cachedTv;
    }
    if ((payload.tv ?? 0) < currentTv) {
      return next(new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked'));
    }

    req.user = payload;
    // Expose the jti on the request so downstream middleware (e.g. logout)
    // can denylist this specific token without re-decoding.
    (req as any).tokenJti = decoded?.jti;
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
 * `force-app` audience) was accepted as an access identity, and a token
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

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'force-api',
      audience: 'force-app',
    }) as AuthPayload & { type?: string; purpose?: string };

    // Same rejections as `authenticate` — a refresh token or any non-access
    // purpose claim must never establish an identity.
    if (payload.type === 'refresh') return next();
    if (payload.purpose && payload.purpose !== 'access') return next();

    const decoded = jwt.decode(token) as { jti?: string } | null;
    if (decoded?.jti && (await redis.isJtiDenied(decoded.jti))) return next();

    const cachedTv = await redis.getUserTokenVersion(payload.userId);
    let currentTv: number;
    if (cachedTv === null) {
      const u = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { tokenVersion: true },
      });
      currentTv = u?.tokenVersion ?? 0;
      await redis.setUserTokenVersion(payload.userId, currentTv);
    } else {
      currentTv = cachedTv;
    }
    if ((payload.tv ?? 0) < currentTv) return next();

    req.user = payload;
  } catch {
    // Invalid token, continue without user
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
 * shared between admin (app.forcemediakw.com) and storefront
 * (store.forcemediakw.com) origins, so a merchant signed into admin sends
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
