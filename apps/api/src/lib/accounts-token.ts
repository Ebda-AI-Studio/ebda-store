/**
 * Verification of access tokens issued by the shared identity service (accounts.ebda.app, Rulings ID-1/ID-2).
 * Contract: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md.
 *
 * ES256 only (HS*, none and RS* are refused), exact issuer, `aud === 'store'`, `typ at+jwt`, <=60 s clock skew. The public
 * keys come from the identity Worker over a Service Binding (never from a URL in a token), are cached for <=10 minutes,
 * and an unknown `kid` triggers ONE refetch (rate limited so a stream of junk kids cannot turn into a fetch storm).
 */
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { cfBindings } from '../cf/bindings';
import { resetLiveIdentityCache } from './identity-live-cache';
import type { StoreClaim } from './identity-directory';

export const ACCOUNTS_ISSUER = 'https://accounts.ebda.app';
export const ACCOUNTS_AUDIENCE = 'store';
const JWKS_TTL_MS = 10 * 60_000;
const REFETCH_MIN_INTERVAL_MS = 30_000;

export interface AccountsClaims {
  sub: string;
  sid: string;
  jti: string;
  stores: StoreClaim[];
  pa?: 'super_admin';
  /** Seconds since epoch of the interactive login behind the session. */
  authTime?: number;
  email?: string;
  emailVerified?: boolean;
  exp: number;
}

type FetchJwks = () => Promise<{ keys: JWK[] }>;

/** Default source: the identity Worker's public JWKS through the `ACCOUNTS` Service Binding. */
const bindingFetch: FetchJwks = async () => {
  const b = cfBindings()?.ACCOUNTS;
  if (!b) throw new Error('ACCOUNTS service binding is not configured');
  const res = await b.fetch(`${ACCOUNTS_ISSUER}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: JWK[] };
  if (!Array.isArray(body.keys) || body.keys.some(k => (k as { d?: unknown }).d !== undefined))
    throw new Error('jwks malformed');
  return { keys: body.keys };
};

let fetchJwks: FetchJwks = bindingFetch;
let cache: { at: number; keys: JWK[]; resolver: JWTVerifyGetKey } | undefined;
let lastRefetchAt = 0;

/** Test seam: swap the key source and forget the cache. */
export function configureAccountsVerifier(f?: FetchJwks): void {
  fetchJwks = f ?? bindingFetch;
  cache = undefined;
  lastRefetchAt = 0;
}

async function load(): Promise<void> {
  const set = await fetchJwks();
  cache = { at: Date.now(), keys: set.keys, resolver: createLocalJWKSet(set) };
}

async function resolverFor(kid: string | undefined): Promise<JWTVerifyGetKey> {
  const now = Date.now();
  if (!cache || now - cache.at > JWKS_TTL_MS) await load();
  const known = (): boolean => !!kid && !!cache?.keys.some(k => k.kid === kid);
  if (!known() && now - lastRefetchAt > REFETCH_MIN_INTERVAL_MS) {
    lastRefetchAt = now;
    await load(); // a rotation may have just happened
  }
  return cache!.resolver;
}

/** Cheap routing decision: is this an identity-service token (ES256), as opposed to a Store-internal HS256 one? */
export function isAccountsToken(token: string): boolean {
  try {
    return decodeProtectedHeader(token).alg === 'ES256';
  } catch {
    return false;
  }
}

/** Verifies signature, issuer, audience, type and expiry. Throws on anything wrong. */
export async function verifyAccountsToken(
  token: string,
  opts: { ignoreExpiration?: boolean } = {}
): Promise<AccountsClaims> {
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'ES256') throw new Error('alg must be ES256');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, await resolverFor(header.kid), {
      algorithms: ['ES256'],
      issuer: ACCOUNTS_ISSUER,
      audience: ACCOUNTS_AUDIENCE,
      clockTolerance: 60,
      typ: 'at+jwt',
    }));
  } catch (e) {
    // Expiry is checked AFTER the signature, issuer, audience and type, so a JWTExpired still proves who signed it.
    if (opts.ignoreExpiration && e instanceof joseErrors.JWTExpired) payload = e.payload;
    else throw e;
  }
  // Identity v1.3: an integrator CLIENT token is a machine principal for another product. The Store has no client audience, so
  // none may ever pass here, whatever it was signed for: refuse any trace of one rather than filter it into an empty profile.
  if ('client' in payload) throw new Error('client tokens are not accepted by the Store');
  const { sub, sid, jti, stores, pa, auth_time, email, email_verified, exp } = payload as Record<
    string,
    unknown
  >;
  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof jti !== 'string')
    throw new Error('token has no sub/sid/jti');
  if (!Array.isArray(stores)) throw new Error('token has no stores claim');
  if (stores.some(s => (s as { role?: unknown } | null)?.role === 'integration'))
    throw new Error('integration role is not accepted by the Store');
  return {
    sub,
    sid,
    jti,
    stores: stores.filter(
      (s): s is StoreClaim =>
        !!s &&
        typeof (s as { id?: unknown }).id === 'string' &&
        ['owner', 'staff'].includes((s as { role?: string }).role ?? '')
    ),
    ...(pa === 'super_admin' ? { pa: 'super_admin' as const } : {}),
    ...(typeof auth_time === 'number' ? { authTime: auth_time } : {}),
    ...(typeof email === 'string' ? { email } : {}),
    ...(typeof email_verified === 'boolean' ? { emailVerified: email_verified } : {}),
    exp: typeof exp === 'number' ? exp : 0,
  };
}

/** Session revocation: ask the identity service (Service Binding RPC). Fails CLOSED when it cannot answer. */
export async function isAccountsSessionRevoked(sid: string): Promise<boolean> {
  const b = cfBindings()?.ACCOUNTS as unknown as
    | { isRevoked?(sid: string): Promise<boolean> }
    | undefined;
  if (!b?.isRevoked) throw new Error('ACCOUNTS service binding is not configured');
  return b.isRevoked(sid);
}

let revocationOverride: ((sid: string) => Promise<boolean>) | undefined;
/** Test seam for the revocation check. */
export function configureRevocationCheck(f?: (sid: string) => Promise<boolean>): void {
  revocationOverride = f;
  resetLiveIdentityCache();
}
export const sessionRevoked = (sid: string): Promise<boolean> =>
  revocationOverride ? revocationOverride(sid) : isAccountsSessionRevoked(sid);
