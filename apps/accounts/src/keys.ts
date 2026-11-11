/**
 * ES256 signing key handling (token contract: ES256, `kid`, JWKS).
 * The private key is a Worker secret (a JWK JSON string carrying its `kid`); it is never stored in D1 or logged.
 * The public JWKS is derived from it plus the retired public keys that stay published for 24 h after a rotation.
 */
import { importJWK, type JWK, type CryptoKey as JoseKey } from 'jose';

export interface SigningKey {
  kid: string;
  privateKey: JoseKey | Uint8Array;
  publicJwk: JWK;
}

let cache: { raw: string; key: SigningKey } | undefined;

export async function signingKey(raw: string | undefined): Promise<SigningKey> {
  if (!raw) throw new Error('JWT_PRIVATE_JWK is not configured');
  if (cache?.raw === raw) return cache.key;
  const jwk = JSON.parse(raw) as JWK;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid)
    throw new Error('JWT_PRIVATE_JWK must be an EC P-256 private JWK with a kid');
  const privateKey = await importJWK({ ...jwk, alg: 'ES256' }, 'ES256');
  // Public half only: never publish `d`.
  const { d: _d, ...pub } = jwk;
  void _d;
  const key: SigningKey = {
    kid: jwk.kid,
    privateKey,
    publicJwk: { ...pub, alg: 'ES256', use: 'sig' },
  };
  cache = { raw, key };
  return key;
}

/** A retired key is published for at most this long from now, whatever its `exp` says (a typo'd far-future exp must not keep it alive). */
export const RETIRED_KEY_MAX_AHEAD_SECONDS = 30 * 24 * 3600;

/** Kids of retired keys that are NOT published: no numeric `exp`, or an `exp` more than 30 days ahead (ID-08). Surfaced on /health. */
export function retiredKeysWithoutExp(env: { JWT_PREVIOUS_PUBLIC_JWKS?: string }): string[] {
  if (!env.JWT_PREVIOUS_PUBLIC_JWKS) return [];
  try {
    return (JSON.parse(env.JWT_PREVIOUS_PUBLIC_JWKS) as Array<{ kid?: string; exp?: unknown }>)
      .filter(
        k =>
          typeof k.exp !== 'number' ||
          k.exp > Math.floor(Date.now() / 1000) + RETIRED_KEY_MAX_AHEAD_SECONDS
      )
      .map(k => k.kid ?? '(no kid)');
  } catch {
    return ['(unparseable JWT_PREVIOUS_PUBLIC_JWKS)'];
  }
}

/** The published key set: current + retired public keys. Rejects anything carrying a private member. */
export async function jwks(env: {
  JWT_PRIVATE_JWK: string;
  JWT_PREVIOUS_PUBLIC_JWKS?: string;
}): Promise<{ keys: JWK[] }> {
  const current = (await signingKey(env.JWT_PRIVATE_JWK)).publicJwk;
  const previous: JWK[] = env.JWT_PREVIOUS_PUBLIC_JWKS
    ? (JSON.parse(env.JWT_PREVIOUS_PUBLIC_JWKS) as JWK[])
    : [];
  for (const k of previous) {
    if (k.d || !k.kid) throw new Error('JWT_PREVIOUS_PUBLIC_JWKS must hold public keys with a kid');
  }
  // ID-08: a retired key is published only until ITS OWN `exp` (unix seconds, set when it was retired; rotation runbook: now +
  // 24 h). Without an `exp` the key is not published at all (fail closed: a retired signing key must never verify forever); with
  // one in the past it is dropped. `exp` is our bookkeeping, not a JWK member, so it is stripped from the published set.
  const nowS = Math.floor(Date.now() / 1000);
  const live = previous
    .filter(k => {
      const exp = (k as JWK & { exp?: unknown }).exp;
      if (typeof exp !== 'number') {
        console.error(JSON.stringify({ msg: 'retired jwk has no exp, not published', kid: k.kid }));
        return false;
      }
      if (exp > nowS + RETIRED_KEY_MAX_AHEAD_SECONDS) {
        console.error(
          JSON.stringify({ msg: 'retired jwk exp too far ahead, not published', kid: k.kid })
        );
        return false;
      }
      return exp > nowS;
    })
    .map(k => {
      const { exp: _exp, ...rest } = k as JWK & { exp?: number };
      void _exp;
      return rest as JWK;
    });
  return { keys: [current, ...live.filter(k => k.kid !== current.kid)] };
}
