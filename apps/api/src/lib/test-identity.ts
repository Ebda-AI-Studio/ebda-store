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
import { withUser } from '@ebda/database';
import { getUserState } from './definer';

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
    // The live identity check (Ruling NZ-D2) asks the identity service for account state. In the Postgres integration tier the
    // users table IS the identity store, so answer from it: unknown / erased -> null (blocked), same as the real service.
    getAccountState: async userId => {
      const u = await getUserState(userId);
      if (!u || u.deletedAt) return null;
      // The row IS the identity here, so the account facts are the row's: with no cutover marker set the answer must equal
      // what the Postgres path reads (`require-mfa`, `require-verified-email`). A hard-coded `mfaEnabled: false` made an
      // enrolled super admin look un-enrolled the moment the live check started feeding those gates.
      const facts = await withUser(userId, tx =>
        tx.user.findUnique({
          where: { id: userId },
          select: { mfaEnabled: true, emailVerified: true },
        })
      );
      return {
        id: u.id,
        email: '',
        emailVerified: facts?.emailVerified ?? false,
        mfaEnabled: facts?.mfaEnabled ?? false,
        mfaEnrolledAt: null,
        status: u.status as 'active' | 'inactive' | 'suspended',
        role: u.role as 'customer' | 'store_admin' | 'super_admin' | 'staff',
        firstName: '',
        lastName: '',
        phone: null,
        language: 'en',
      };
    },
  };
  configureIdentityClient(rpc);
  logger.warn('[test-identity] integration identity stand-in installed (NODE_ENV=test only)');
  return true;
}
