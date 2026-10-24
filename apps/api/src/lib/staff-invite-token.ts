/**
 * Signed staff-invitation token (Ruling ID-13). Carries the invitee's address and the store; the invitee redeems it while
 * signed in as that very address (POST /staff-invites/accept). HS256 over the API secret with its own audience, so it can
 * never be accepted as a session token (the session verifier pins the session audience) and a session token can never be
 * accepted here. STATEFUL: the jti is the id of a pending StaffInvite row; the accept route consumes that row in the same
 * transaction that creates the membership, and removing the member, re-inviting or revoking ends it.
 */
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';

export const STAFF_INVITE_TTL_MINUTES = 72 * 60;
const AUDIENCE = 'ebda:staff-invite';
const ISSUER = 'ebda-api';

export interface StaffInviteClaims {
  email: string;
  storeId: string;
}

export function signStaffInviteToken(c: StaffInviteClaims & { jti: string }): string {
  return jwt.sign({ email: c.email.toLowerCase(), storeId: c.storeId }, config.jwtSecret, {
    algorithm: 'HS256',
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresIn: `${STAFF_INVITE_TTL_MINUTES}m`,
    jwtid: c.jti,
  });
}

export interface VerifiedStaffInvite extends StaffInviteClaims {
  /** The StaffInvite row id. */
  jti: string;
}

export function verifyStaffInviteToken(token: string): VerifiedStaffInvite {
  try {
    const p = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      issuer: ISSUER,
    }) as jwt.JwtPayload;
    if (typeof p.email !== 'string' || typeof p.storeId !== 'string') throw new Error('shape');
    if (typeof p.jti !== 'string') throw new Error('shape');
    return { email: p.email.toLowerCase(), storeId: p.storeId, jti: p.jti };
  } catch {
    throw new AppError(400, 'INVITE_INVALID', 'This invitation link is invalid or has expired.');
  }
}
