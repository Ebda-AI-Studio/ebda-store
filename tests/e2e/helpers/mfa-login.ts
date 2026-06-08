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
import request from 'supertest';
import { authenticator } from 'otplib';
import { prisma } from '@force/database';
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
export async function loginAsSuperAdmin(
  app: Express,
  email: string,
  password: string
): Promise<string> {
  // Step 1: password auth → expect mfaRequired challenge
  const loginRes = await request(app).post('/auth/login').send({ email, password });

  if (!loginRes.body.data?.mfaRequired || !loginRes.body.data?.challengeToken) {
    // If we got an accessToken directly (mfa not triggered), return it.
    // This handles the unlikely case where the user was created without mfaEnabled.
    if (loginRes.body.data?.accessToken) {
      return loginRes.body.data.accessToken;
    }
    throw new Error(
      `E2E MFA login step 1 failed — expected mfaRequired=true. ` +
        `Status: ${loginRes.status}, body: ${JSON.stringify(loginRes.body)}`
    );
  }

  const { challengeToken } = loginRes.body.data;

  // Step 2: generate current TOTP and exchange for a real session
  // authenticator.generate uses the same window:1 that MfaService.verifyCode allows.
  const totpCode = authenticator.generate(E2E_MFA_SECRET);

  const verifyRes = await request(app)
    .post('/auth/mfa/verify')
    .send({ challengeToken, code: totpCode });

  if (!verifyRes.body.data?.accessToken) {
    throw new Error(
      `E2E MFA login step 2 (verify) failed — no accessToken. ` +
        `Status: ${verifyRes.status}, body: ${JSON.stringify(verifyRes.body)}`
    );
  }

  return verifyRes.body.data.accessToken;
}
