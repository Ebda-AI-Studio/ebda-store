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
  return { keys: [current, ...previous.filter(k => k.kid !== current.kid)] };
}
