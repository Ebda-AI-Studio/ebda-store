/**
 * Mint the access token the shared identity service would issue (ES256, `aud: store`), for the Postgres integration tier.
 *
 * Merchants, staff and super admins no longer sign in at the Store (Rulings ID-1/ID-2), so a test that needs an admin session
 * creates the user row and asks for a token here instead of POSTing /auth/login. The API server under test verifies it with the
 * matching public key (apps/api/src/lib/test-identity.ts, installed only when NODE_ENV=test and EBDA_TEST_IDENTITY_JWK is set).
 * Private key: `EBDA_TEST_IDENTITY_JWK` (one throw-away P-256 JWK per CI job / local stack; see .github/workflows/ci.yml).
 */
import { SignJWT, importJWK, type JWK } from 'jose';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';

export interface IdentityTokenInput {
  userId: string;
  email?: string;
  /** Platform admin (`pa: super_admin`); needs a fresh `authTime` (default: now). */
  superAdmin?: boolean;
  stores?: Array<{ id: string; role: 'owner' | 'staff' }>;
  emailVerified?: boolean;
  /** Seconds the token lives (default 900, like the identity service). */
  ttlSeconds?: number;
}

function privateJwk(): JWK {
  const raw = process.env.EBDA_TEST_IDENTITY_JWK;
  if (!raw) {
    throw new Error(
      'EBDA_TEST_IDENTITY_JWK is not set: the integration tier mints identity tokens with it (see tests/helpers/identity-session.ts)'
    );
  }
  return JSON.parse(raw) as JWK;
}

export async function mintIdentityToken(i: IdentityTokenInput): Promise<string> {
  const jwk = privateJwk();
  const key = await importJWK(jwk, 'ES256');
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  return new SignJWT({
    sid: `t.${i.userId}.${now}.${randomUUID().slice(0, 8)}`,
    stores: i.stores ?? [],
    ...(i.superAdmin ? { pa: 'super_admin' } : {}),
    auth_time: nowS,
    ...(i.email ? { email: i.email } : {}),
    email_verified: i.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })
    .setIssuer('https://accounts.ebda.app')
    .setAudience('store')
    .setSubject(i.userId)
    .setJti(randomUUID())
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + (i.ttlSeconds ?? 900))
    .sign(key);
}

/** Token for an existing user row: super admins get `pa`, everyone else gets the stores they own or staff. */
export async function identityTokenFor(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, role: true, emailVerified: true },
  });
  const owned = await prisma.store.findMany({
    where: { ownerId: userId, deletedAt: null },
    select: { id: true },
  });
  const staff = await prisma.storeStaff.findMany({ where: { userId }, select: { storeId: true } });
  const seen = new Set(owned.map(s => s.id));
  return mintIdentityToken({
    userId: u.id,
    email: u.email,
    superAdmin: u.role === 'super_admin',
    emailVerified: u.emailVerified,
    stores: [
      ...owned.map(s => ({ id: s.id, role: 'owner' as const })),
      ...staff
        .filter(s => !seen.has(s.storeId))
        .map(s => ({ id: s.storeId, role: 'staff' as const })),
    ],
  });
}

/** Same, by e-mail (the test-created or seeded account, storeId NULL). */
export async function identityTokenForEmail(email: string): Promise<string> {
  const u = await prisma.user.findFirstOrThrow({
    where: { email: email.toLowerCase(), storeId: null },
    select: { id: true },
  });
  return identityTokenFor(u.id);
}
