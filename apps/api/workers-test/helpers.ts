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
