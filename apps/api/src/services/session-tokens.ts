import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '@ebda/shared';
import { config } from '../config';

export interface SessionPayload {
  userId: string;
  email: string;
  role: string;
  /** Tenant scope for customer accounts; NULL for platform admins. */
  storeId: string | null;
  /** Token version for bulk revocation. Bumped on logout-all / password change. */
  tv?: number;
}

/** Refresh lifetime (days) of the stored row: mirrors the JWT's 1 year. */
export const REFRESH_ROW_DAYS = 365;

export function signAccessToken(payload: SessionPayload): string {
  // Access token: unique jti (per-token revocation via the JTI denylist) and tv (bulk revocation).
  return jwt.sign({ ...payload, tv: payload.tv ?? 0 }, config.jwtSecret, {
    algorithm: 'HS256',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expiresIn: config.jwtExpiresIn as any,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: payload.userId,
    jwtid: crypto.randomUUID(),
  });
}

export function signRefreshToken(payload: SessionPayload): string {
  // Long-lived, single use server-side; the jti nonce keeps two tokens minted in the same second distinct.
  return jwt.sign({ ...payload, type: 'refresh' }, config.jwtSecret, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expiresIn: config.refreshTokenExpiresIn as any,
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: payload.userId,
    jwtid: crypto.randomUUID(),
  });
}

/**
 * Sign the access + refresh JWT pair. The ONE place both are built (Postgres `AuthService.generateTokens` and the StoreDO
 * customer flow share it), so their claims cannot drift. Storing the refresh row is the caller's job.
 */
export function signSessionTokens(payload: SessionPayload): {
  accessToken: string;
  refreshToken: string;
} {
  return { accessToken: signAccessToken(payload), refreshToken: signRefreshToken(payload) };
}
