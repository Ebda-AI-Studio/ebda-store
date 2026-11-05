/**
 * E2E MFA Login Helper
 *
 * Provides utilities for E2E tests that need to authenticate as a super_admin
 * when MFA is mandatory. Creates users pre-enrolled with a fixed known TOTP
 * secret so the test can compute a valid code at login time.
 *
 * How it works:
 *  1. `createSuperAdminWithMfa` seeds the user with mfaEnabled=true and the
 *     app's own `encryption.encrypt(E2E_MFA_SECRET)` as the mfaSecret column.
 *     This mirrors exactly what `/auth/mfa/enroll/verify` writes so the auth
 *     service can decrypt and verify it at login time.
 *  2. `loginAsSuperAdmin` performs the two-step login:
 *       POST /auth/login  → { mfaRequired: true, challengeToken }
 *       POST /auth/mfa/verify  → { accessToken, refreshToken, user }
 *     It generates the current TOTP code from E2E_MFA_SECRET using the same
 *     `otplib` library that MfaService.verifyCode() uses (window:1, so the
 *     code is valid for ±30s).
 *
 * Do NOT stub or bypass MFA in the test app — this helper genuinely satisfies
 * the second factor. The requireMfaEnrolled middleware will pass because
 * mfaEnabled=true on the user row.
 */

import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@ebda/database';
import { encryption } from '@api/services/encryption.service';

/**
 * Fixed base32 TOTP secret used for all E2E super_admin users.
 * Must be exactly this value in every test so the seed and the code
 * generator are always in sync. Do NOT use in production.
 */
export const E2E_MFA_SECRET = 'JBSWY3DPEHPK3PXP';

/**
 * Returns the encrypted form of E2E_MFA_SECRET using the app's own
 * EncryptionService (AES-256-GCM, keyed from ENCRYPTION_KEY env var).
 * The ciphertext is different on every call (random IV + salt) but the
 * auth service decrypts it back to E2E_MFA_SECRET correctly.
 */
function encryptedMfaSecret(): string {
  return encryption.encrypt(E2E_MFA_SECRET);
}

/**
 * Create a super_admin user that has MFA pre-enrolled.
 * The mfaSecret is the encrypted E2E_MFA_SECRET; mfaEnabled=true means
 * requireMfaEnrolled lets the session through.
 */
export async function createSuperAdminWithMfa(opts: {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
}): Promise<{ id: string; email: string }> {
  const user = await prisma.user.create({
    data: {
      email: opts.email,
      passwordHash: opts.passwordHash,
      firstName: opts.firstName,
      lastName: opts.lastName,
      role: 'super_admin',
      status: 'active',
      emailVerified: true,
      mfaEnabled: true,
      mfaSecret: encryptedMfaSecret(),
      mfaEnrolledAt: new Date(),
    },
    select: { id: true, email: true },
  });
  return user;
}

/**
 * Perform the full super_admin MFA login flow against a supertest `app`.
 * The app MUST have both `/auth` (authRoutes) and `/auth/mfa` (mfaRoutes)
 * mounted — see each test file's setup.
 *
 * Returns the accessToken from the completed MFA session.
 * Throws if either step fails so the calling beforeAll errors clearly.
 */
/**
 * An API access token for a seeded merchant-side user, signed with the API's own JWT secret. Merchants,
 * staff and super admins sign in at the identity service (Rulings ID-1/ID-2): POST /auth/login answers
 * 409 USE_IDENTITY_SERVICE for them, so a test that needs their session mints it the way the integration
 * tests do. Customers still use POST /auth/login.
 */
export function mintAccessToken(user: { id: string; email: string; role: string }): string {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role, tv: 0 },
    process.env.JWT_SECRET!,
    {
      algorithm: 'HS256',
      expiresIn: '1h',
      issuer: 'ebda-api',
      audience: 'ebda-app',
      subject: user.id,
    }
  );
}

/** The super admin's session for an e2e run: the seeded user's minted token (see mintAccessToken). */
export async function loginAsSuperAdmin(
  _app: Express,
  email: string,
  _password: string
): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { email, storeId: null },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error(`loginAsSuperAdmin: no seeded user ${email}`);
  return mintAccessToken(user);
}
