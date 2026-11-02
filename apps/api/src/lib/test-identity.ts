/**
 * Integration-suite stand-in for the shared identity service (Rulings ID-1/ID-2), Node server only.
 *
 * WHY. Stage 3 (#216) closed the Store's own password login for merchants, staff and super admins: they sign in at the identity
 * service and reach the Store with an ES256 token. The Postgres integration tier drives a real Node server that has no `ACCOUNTS`
 * Service Binding, so every flow that needs an admin session was unreachable (126 red tests once the full tier ran again on the
 * #367 fold). This module gives that server the two things the identity service provides to the Store: the public key that
 * verifies its tokens, and the session-revocation answer. The tests then mint tokens with the matching private key
 * (tests/helpers/identity-session.ts), which is exactly what the identity service does in production.
 *
 * SAFETY. Fails closed: it installs ONLY when `NODE_ENV === 'test'` AND `EBDA_TEST_IDENTITY_JWK` holds a private key. Production
 * and the Workers shell never set either, and the key is never read anywhere else. The Store's login gates are NOT touched.
 */
import { createPublicKey } from 'node:crypto';
import type { JWK } from 'jose';
import type { AccountsRpc } from '../cf/bindings';
import logger from './logger';
import { configureAccountsVerifier, configureRevocationCheck } from './accounts-token';
import { configureIdentityClient } from './identity-client';

/** sid = `t.<userId>.<issuedAtMs>.<rand>`: revoking a user revokes every session issued up to that instant. */
export function testSessionId(userId: string, issuedAtMs: number, rand: string): string {
  return `t.${userId}.${issuedAtMs}.${rand}`;
}

export function installTestIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'test' || !env.EBDA_TEST_IDENTITY_JWK) return false;
  const priv = JSON.parse(env.EBDA_TEST_IDENTITY_JWK) as JWK;
  const pub = createPublicKey({ key: priv, format: 'jwk' }).export({ format: 'jwk' }) as JWK;
  const publicJwk: JWK = { ...pub, kid: priv.kid, alg: 'ES256', use: 'sig' };

  const revokedUsersAt = new Map<string, number>();
  const revokedSids = new Set<string>();
  const revoked = async (sid: string): Promise<boolean> => {
    if (revokedSids.has(sid)) return true;
    const [, userId, issuedAt] = sid.split('.');
    const at = userId ? revokedUsersAt.get(userId) : undefined;
    return at !== undefined && Number(issuedAt) <= at;
  };

  configureAccountsVerifier(async () => ({ keys: [publicJwk] }));
  configureRevocationCheck(revoked);
  const rpc: AccountsRpc = {
    isRevoked: revoked,
    revokeSession: async sid => void revokedSids.add(sid),
    revokeUser: async userId => void revokedUsersAt.set(userId, Date.now()),
    setStatus: async () => undefined,
    setRole: async () => true,
    deleteStoreClients: async () => ({ clients: 0 }),
  };
  configureIdentityClient(rpc);
  logger.warn('[test-identity] integration identity stand-in installed (NODE_ENV=test only)');
  return true;
}
