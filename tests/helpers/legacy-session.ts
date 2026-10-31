/**
 * Mint the Store's own HS256 session (what `AuthService.generateTokens` produces) for a user row, for the integration tests of
 * the Store-side revocation machinery: the per-token `jti` denylist and the per-user `tokenVersion`.
 *
 * Merchants, staff and super admins no longer get this session from /auth/login (Rulings ID-1/ID-2: it answers 409
 * USE_IDENTITY_SERVICE), but the same HS256 shape is still what customer and impersonation tokens use, and `authenticate`
 * checks the denylist and `tv` on all of them. A store_admin-shaped token (storeId null) is used so no customer store-binding
 * (F-01) is involved. Signed with the server's own JWT_SECRET, issuer and audience, exactly as the server does.
 */
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { JWT_AUDIENCE, JWT_ISSUER } from '@ebda/shared';

const SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-ci-only-32chars';

export async function legacySessionFor(
  userId: string
): Promise<{ accessToken: string; refreshToken: string; jti: string }> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, role: true, storeId: true, tokenVersion: true },
  });
  const payload = { userId: u.id, email: u.email, role: u.role, storeId: u.storeId };
  const jti = crypto.randomUUID();
  const common = {
    algorithm: 'HS256' as const,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: u.id,
  };
  const accessToken = jwt.sign({ ...payload, tv: u.tokenVersion }, SECRET, {
    ...common,
    expiresIn: '15m',
    jwtid: jti,
  });
  const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, SECRET, {
    ...common,
    expiresIn: '30d',
    jwtid: crypto.randomUUID(),
  });
  await prisma.refreshToken.create({
    data: {
      token: crypto.createHash('sha256').update(refreshToken).digest('hex'),
      userId: u.id,
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
    },
  });
  return { accessToken, refreshToken, jti };
}
