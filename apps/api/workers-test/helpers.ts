import { env } from 'cloudflare:workers';
import { shardOf } from '../src/cf/auth-state-client';
import type { Op } from '../src/cf/auth-state';

import { JWT_AUDIENCE, JWT_ISSUER } from '@ebda/shared';
export interface ApiFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export const testEnv = env as unknown as {
  API: ApiFetcher;
  AUTH_STATE: {
    idFromName(n: string): unknown;
    get(id: unknown): { apply(ops: Op[], nowMs?: number): Promise<unknown[]> };
  };
  KV_CACHE: {
    get(k: string): Promise<string | null>;
    put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>;
  };
  EMAIL_QUEUE: { send(body: unknown, o?: { contentType?: string }): Promise<void> };
  EMAIL_DLQ: { send(body: unknown, o?: { contentType?: string }): Promise<void> };
  JWT_SECRET: string;
  /** The private half of the key the accounts stub serves as its JWKS (vitest.workers.config.mts). */
  TEST_ACCOUNTS_PRIVATE_JWK: string;
  E2E_DB: string;
};

export const api = testEnv.API;

/** Run ops on the AuthState shard that owns `key`: the same routing the Worker uses. */
export function authState(key: string, ops: Op[], nowMs?: number): Promise<unknown[]> {
  const ns = testEnv.AUTH_STATE;
  return ns.get(ns.idFromName(`shard-${shardOf(key)}`)).apply(ops, nowMs);
}

const b64url = (b: ArrayBuffer | string): string => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** An HS256 access token exactly as middleware/auth.ts verifies it (issuer, audience, jti, tv). */
export async function accessToken(claims: {
  userId: string;
  jti: string;
  tv?: number;
  role?: string;
  /** An impersonation session minted by POST /admin/impersonate carries this claim. */
  impersonatedBy?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      userId: claims.userId,
      email: 'tester@exit-test.invalid',
      role: claims.role ?? 'store_admin',
      tv: claims.tv ?? 0,
      ...(claims.storeId ? { storeId: claims.storeId } : {}),
      jti: claims.jti,
      ...(claims.impersonatedBy ? { impersonatedBy: claims.impersonatedBy } : {}),
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      iat: now,
      exp: now + 600,
    })
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(testEnv.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

export const ENV_DB = (): boolean => testEnv.E2E_DB === '1';

/**
 * An identity-service access token exactly as ebda-accounts mints it (ES256, typ at+jwt, aud=store) with a FRESH `auth_time`,
 * so credential-class routes behind `requireRecentLogin` (TEN-4: agent / merchant keys, provider credentials, staff changes)
 * accept it. A legacy HS256 `accessToken` has no `auth_time` and is refused there on purpose (fail closed).
 */
export async function identityAccessToken(claims: {
  sub: string;
  email?: string;
  stores: Array<{ id: string; role: string }>;
  /** Seconds since epoch of the sign-in; default now. */
  authTime?: number;
}): Promise<string> {
  const jwk = JSON.parse(testEnv.TEST_ACCOUNTS_PRIVATE_JWK) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://accounts.ebda.app',
      aud: 'store',
      sub: claims.sub,
      sid: `sid-${claims.sub}`,
      jti: crypto.randomUUID(),
      stores: claims.stores,
      email: claims.email ?? 'tester@exit-test.invalid',
      email_verified: true,
      auth_time: claims.authTime ?? now,
      iat: now,
      exp: now + 600,
    })
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(sig)}`;
}
