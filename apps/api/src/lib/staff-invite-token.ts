/**
 * Signed staff-invitation token (Ruling ID-13). Carries the invitee's address and the store; the invitee redeems it while
 * signed in as that very address (POST /staff-invites/accept). HS256 over the API secret with its own audience, so it can
 * never be accepted as a session token (the session verifier pins the session audience) and a session token can never be
 * accepted here. Stateless: expires after 72 hours; once accepted, the owner removes the member the usual way.
 */
import crypto from 'crypto';
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

export function signStaffInviteToken(c: StaffInviteClaims): string {
  return jwt.sign({ email: c.email.toLowerCase(), storeId: c.storeId }, config.jwtSecret, {
    algorithm: 'HS256',
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresIn: `${STAFF_INVITE_TTL_MINUTES}m`,
    jwtid: crypto.randomUUID(),
  });
}

export function verifyStaffInviteToken(token: string): StaffInviteClaims {
  try {
    const p = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      issuer: ISSUER,
    }) as jwt.JwtPayload;
    if (typeof p.email !== 'string' || typeof p.storeId !== 'string') throw new Error('shape');
    return { email: p.email.toLowerCase(), storeId: p.storeId };
  } catch {
    throw new AppError(400, 'INVITE_INVALID', 'This invitation link is invalid or has expired.');
  }
}
