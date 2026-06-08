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
 * Optional authentication - sets req.user if valid token provided, but doesn't require it
 */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
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
    }) as AuthPayload;
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
