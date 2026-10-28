/** Access-token mint and verify. The contract is docs: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md. */
import { SignJWT, jwtVerify, createLocalJWKSet } from 'jose';
import { jwks, signingKey } from './keys';

export const ACCESS_TTL_SECONDS = 15 * 60;

export interface StoreClaim {
  id: string;
  role: 'owner' | 'staff';
}

export interface AccessClaims {
  sub: string;
  sid: string;
  aud: string;
  stores: StoreClaim[];
  /** Platform role, only when set. */
  pa?: 'super_admin';
  /** Seconds since epoch of the interactive login that created the session (additive). A platform admin's `pa` is honoured only within 12 h of it. */
  auth_time?: number;
  /** Additive v1 claims (proposed to the contract owners): convenience for products that have no user table. */
  email?: string;
  email_verified?: boolean;
}

export async function mintAccessToken(
  env: { JWT_PRIVATE_JWK: string; ISSUER: string },
  c: AccessClaims
): Promise<{ token: string; expiresAt: number }> {
  const key = await signingKey(env.JWT_PRIVATE_JWK);
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { sid: c.sid, stores: c.stores };
  if (c.pa) payload.pa = c.pa;
  if (c.auth_time !== undefined) payload.auth_time = c.auth_time;
  if (c.email) payload.email = c.email;
  if (c.email_verified !== undefined) payload.email_verified = c.email_verified;
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'at+jwt' })
    .setIssuer(env.ISSUER)
    .setAudience(c.aud)
    .setSubject(c.sub)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(key.privateKey);
  return { token, expiresAt: (now + ACCESS_TTL_SECONDS) * 1000 };
}

/** Verify one of OUR tokens (used by logout/revoke/passkey management when called with a bearer). */
export async function verifyOwnAccessToken(
  env: { JWT_PRIVATE_JWK: string; JWT_PREVIOUS_PUBLIC_JWKS?: string; ISSUER: string },
  token: string,
  audience: string
): Promise<{ sub: string; sid: string; payload: Record<string, unknown> }> {
  const set = createLocalJWKSet(await jwks(env));
  const { payload, protectedHeader } = await jwtVerify(token, set, {
    algorithms: ['ES256'],
    issuer: env.ISSUER,
    audience,
    clockTolerance: 60,
    typ: 'at+jwt',
  });
  void protectedHeader;
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
    throw new Error('token has no sub/sid');
  return { sub: payload.sub, sid: payload.sid, payload: payload as Record<string, unknown> };
}
