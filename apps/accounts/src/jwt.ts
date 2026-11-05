/** Access-token mint and verify. The contract is docs: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md. */
import { SignJWT, jwtVerify, createLocalJWKSet } from 'jose';
import { jwks, signingKey } from './keys';

export const ACCESS_TTL_SECONDS = 15 * 60;

/**
 * Ruling NZ-D2: the Store API trusts the signed claims on plain reads, so a merchant / staff / admin token for the `store`
 * audience lives <= 5 minutes (every write and sensitive read asks this service live). Other audiences keep the 15 minute
 * contract (docs/contracts/identity-token).
 */
export const STORE_ACCESS_TTL_SECONDS = 5 * 60;
export const accessTtlFor = (aud: string): number =>
  aud === 'store' ? STORE_ACCESS_TTL_SECONDS : ACCESS_TTL_SECONDS;

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
    .setExpirationTime(now + accessTtlFor(c.aud))
    .setJti(crypto.randomUUID())
    .sign(key.privateKey);
  return { token, expiresAt: (now + accessTtlFor(c.aud)) * 1000 };
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
  // An integrator client token (v1.3) is a machine principal and never a person's session.
  if ('client' in payload) throw new Error('client token');
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
    throw new Error('token has no sub/sid');
  return { sub: payload.sub, sid: payload.sid, payload: payload as Record<string, unknown> };
}

export interface ClientTokenClaims {
  clientId: string;
  storeId: string;
  aud: string;
  scope: string;
}

/**
 * Integrator client token (identity contract v1.3): the only non-person token. sub = sid = the client id, one `integration`
 * store claim, `client: true`, the granted scope, 10 minutes. It NEVER carries pa, auth_time or email, and no RPC reaches this
 * function (Ruling ID-12): the HTTP token endpoint is the only mint.
 */
export async function mintClientToken(
  env: { JWT_PRIVATE_JWK: string; ISSUER: string },
  c: ClientTokenClaims,
  ttlSeconds: number
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const key = await signingKey(env.JWT_PRIVATE_JWK);
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const token = await new SignJWT({
    sid: c.clientId,
    stores: [{ id: c.storeId, role: 'integration' }],
    scope: c.scope,
    client: true,
  })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'at+jwt' })
    .setIssuer(env.ISSUER)
    .setAudience(c.aud)
    .setSubject(c.clientId)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(jti)
    .sign(key.privateKey);
  return { token, jti, expiresAt: (now + ttlSeconds) * 1000 };
}
