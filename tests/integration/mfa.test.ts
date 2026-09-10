/**
 * Integration test for Task 8: MFA enroll + login challenge flow.
 *
 * Flow:
 *   1. Create a super_admin user.
 *   2. Normal login → succeeds (no MFA yet), get accessToken.
 *   3. POST /auth/mfa/enroll/begin (authenticated) → receive secret + QR.
 *   4. POST /auth/mfa/enroll/verify (authenticated) → confirm TOTP code, enable MFA.
 *   5. Login again → now returns { mfaRequired: true, challengeToken }, NO accessToken.
 *   6. POST /auth/mfa/verify with challengeToken + fresh code → returns accessToken.
 *
 * Security regression tests (HIGH findings):
 *   - SEC-1: MFA challenge token used as Bearer on /auth/me must return 401 (bypass closed).
 *   - SEC-2: /auth/mfa/enroll/begin while already enrolled without current code → 400 MFA_REAUTH_REQUIRED.
 *   - SEC-3: /auth/mfa/enroll/begin while already enrolled WITH valid current code → 200.
 *
 * Requires the API running on TEST_API_URL (default http://localhost:4000) and local
 * Postgres + Redis accessible.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { API_BASE } from '../helpers/api-base';

// One knob configures the whole suite; see tests/helpers/api-base.ts for why
// it is TEST_API_URL rather than the server's own API_URL or API_HOST (both
// are injected by dotenv.config() at API-module import time, i.e. before any
// const here, and API_URL is an origin that points at production when set).
const API = API_BASE;
const PW = 'Test1234!pw';
const EMAIL = `mfa-${Date.now()}@example.test`;

describe('MFA enroll + login challenge', () => {
  // Clean up before the suite starts (handles leftover rows from a previous
  // aborted run or from vitest's retry:1 policy — the retry reuses the same
  // module-level EMAIL constant, so the user must not exist at test start).
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
  });

  it('enrolls TOTP then requires the challenge at login, then verifies', async () => {
    // Step 1: create test user. Delete first for idempotency under retry:1.
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'M',
        lastName: 'F',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    // Step 2: normal login (MFA not yet enabled) → must return accessToken
    const login1Res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PW }),
    });
    expect(login1Res.status).toBe(200);
    const login1 = await login1Res.json();
    expect(login1.data.accessToken).toBeTruthy();
    const token = login1.data.accessToken as string;

    // Step 3: begin enrollment
    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(beginRes.status).toBe(200);
    const begin = await beginRes.json();
    expect(begin.data.secret).toBeTruthy();
    expect(begin.data.qr).toMatch(/^data:image\//);
    const secret = begin.data.secret as string;

    // Step 4: verify enrollment — confirm a live TOTP code
    const enrollCode = authenticator.generate(secret);
    const verifyEnrollRes = await fetch(`${API}/auth/mfa/enroll/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: enrollCode }),
    });
    expect(verifyEnrollRes.status).toBe(200);
    const verifyEnroll = await verifyEnrollRes.json();
    expect(verifyEnroll.data.backupCodes).toHaveLength(10);

    // Step 5: login again — must return mfaRequired:true + challengeToken, NO accessToken
    const login2Res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PW }),
    });
    expect(login2Res.status).toBe(200);
    const login2 = await login2Res.json();
    expect(login2.data.mfaRequired).toBe(true);
    expect(login2.data.challengeToken).toBeTruthy();
    expect(login2.data.accessToken).toBeUndefined();

    // Step 6: exchange challenge + TOTP code for a real session
    const mfaCode = authenticator.generate(secret);
    const mfaVerifyRes = await fetch(`${API}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: login2.data.challengeToken, code: mfaCode }),
    });
    expect(mfaVerifyRes.status).toBe(200);
    const mfaVerify = await mfaVerifyRes.json();
    expect(mfaVerify.data.accessToken).toBeTruthy();
    expect(mfaVerify.data.user).toBeTruthy();
    expect(mfaVerify.data.user.email).toBe(EMAIL);

    // Confirm the returned accessToken is usable
    const meRes = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${mfaVerify.data.accessToken}` },
    });
    expect(meRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Security regression suite — separate describe blocks with their own users
// so they don't depend on the ordering of the enroll+login flow above.
// ---------------------------------------------------------------------------

describe('SEC-1: MFA challenge token must not bypass authenticate middleware', () => {
  const SEC1_EMAIL = `sec1-mfa-${Date.now()}@example.test`;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: SEC1_EMAIL } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: SEC1_EMAIL } });
  });

  it('a login-issued challengeToken used as Bearer on /auth/me returns 401', async () => {
    // Create user and enroll MFA. Delete first for idempotency under retry:1.
    await prisma.user.deleteMany({ where: { email: SEC1_EMAIL } });
    await prisma.user.create({
      data: {
        email: SEC1_EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'Sec',
        lastName: 'One',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    // Obtain a real access token first to enroll
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SEC1_EMAIL, password: PW }),
    });
    const loginData = await loginRes.json();
    const accessToken = loginData.data.accessToken as string;

    // Enroll MFA
    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const begin = await beginRes.json();
    const secret = begin.data.secret as string;

    const enrollCode = authenticator.generate(secret);
    await fetch(`${API}/auth/mfa/enroll/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ code: enrollCode }),
    });

    // Now log in again — must get a challenge token, not a real access token
    const login2Res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SEC1_EMAIL, password: PW }),
    });
    const login2 = await login2Res.json();
    const challengeToken = login2.data.challengeToken as string;
    expect(challengeToken).toBeTruthy();
    expect(login2.data.accessToken).toBeUndefined();

    // The critical assertion: the challenge token MUST NOT be accepted as a
    // real access token. Before the fix, audience:'force-app' on the challenge
    // token and the missing purpose check in authenticate() let it through.
    const meRes = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${challengeToken}` },
    });
    expect(meRes.status).toBe(401);
    const meBody = await meRes.json();
    // Could be TOKEN_INVALID (audience mismatch) — either confirms bypass is closed.
    expect([401]).toContain(meRes.status);
    expect(meBody.error).toBeTruthy();
  });
});

describe('SEC-2/SEC-3: re-enrollment requires current TOTP code when MFA is active', () => {
  const SEC2_EMAIL = `sec2-mfa-${Date.now()}@example.test`;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: SEC2_EMAIL } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: SEC2_EMAIL } });
  });

  it('re-enroll without current code → 400 MFA_REAUTH_REQUIRED', async () => {
    // Create user and fully enroll MFA. Delete first for idempotency under
    // vitest's retry:1 policy — same module-level email on every retry.
    await prisma.user.deleteMany({ where: { email: SEC2_EMAIL } });
    await prisma.user.create({
      data: {
        email: SEC2_EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'Sec',
        lastName: 'Two',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SEC2_EMAIL, password: PW }),
    });
    const loginData = await loginRes.json();
    const accessToken = loginData.data.accessToken as string;

    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const begin = await beginRes.json();
    const secret = begin.data.secret as string;

    const enrollCode = authenticator.generate(secret);
    await fetch(`${API}/auth/mfa/enroll/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ code: enrollCode }),
    });

    // Attempt re-enrollment WITHOUT providing current code — must be rejected
    const reEnrollNoCodeRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      // no body.code
    });
    expect(reEnrollNoCodeRes.status).toBe(400);
    const reEnrollNoCodeBody = await reEnrollNoCodeRes.json();
    expect(reEnrollNoCodeBody.error.code).toBe('MFA_REAUTH_REQUIRED');
  });

  it('re-enroll WITH valid current code → 200', async () => {
    // Reuse the same user (already enrolled from previous test — fetched fresh)
    const user = await prisma.user.findFirst({
      where: { email: SEC2_EMAIL },
      select: { id: true, mfaSecret: true, mfaEnabled: true },
    });
    expect(user?.mfaEnabled).toBe(true);
    expect(user?.mfaSecret).toBeTruthy();

    // We need a valid access token — log in via MFA challenge
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SEC2_EMAIL, password: PW }),
    });
    const loginData = await loginRes.json();
    // Must be MFA-challenged at this point
    expect(loginData.data.mfaRequired).toBe(true);
    const challengeToken = loginData.data.challengeToken as string;

    // Decode the encrypted secret directly from DB for code generation
    // (encryption.decrypt is server-side only; use the OTP library on the
    // raw secret we saved from the first enrollment in the previous test)
    //
    // We can't access the encrypted secret directly from tests, so instead
    // we'll drive the full MFA verify flow to get a real access token.
    //
    // Get the plaintext secret from DB via the encryption service indirectly:
    // generate a fresh TOTP code using the secret stored during enrollment.
    // Since we don't have the plaintext here, we test re-enroll by calling
    // /auth/mfa/verify to get a full session, then re-enroll with a live code.

    // Import encryption to decrypt — available via the API's service layer.
    // In integration tests we can read+decrypt directly.
    const { encryption } = await import('../../apps/api/src/services/encryption.service');
    const dbUser = await prisma.user.findFirst({
      where: { email: SEC2_EMAIL },
      select: { mfaSecret: true },
    });
    const currentSecret = encryption.decrypt(dbUser!.mfaSecret!);
    const currentCode = authenticator.generate(currentSecret);

    // Complete MFA login to get a real access token
    const mfaVerifyRes = await fetch(`${API}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code: currentCode }),
    });
    expect(mfaVerifyRes.status).toBe(200);
    const mfaVerifyData = await mfaVerifyRes.json();
    const accessToken = mfaVerifyData.data.accessToken as string;

    // Generate a fresh current code (may be same window, otplib handles that)
    const codeForReenroll = authenticator.generate(currentSecret);

    // Re-enrollment WITH current code must succeed
    const reEnrollRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ code: codeForReenroll }),
    });
    expect(reEnrollRes.status).toBe(200);
    const reEnrollBody = await reEnrollRes.json();
    expect(reEnrollBody.data.secret).toBeTruthy();
    expect(reEnrollBody.data.qr).toMatch(/^data:image\//);
  });
});

// ---------------------------------------------------------------------------
// H2: Per-challenge brute-force lockout on /auth/mfa/verify
// ---------------------------------------------------------------------------

describe('H2: per-challenge MFA verify brute-force lockout', () => {
  const H2_EMAIL = `h2-mfa-${Date.now()}@example.test`;
  let h2Secret: string;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: H2_EMAIL } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: H2_EMAIL } });
  });

  it('5 wrong codes lock the challenge, 6th returns 429 MFA_TOO_MANY_ATTEMPTS', async () => {
    // Create + enroll a super_admin. Delete first to stay idempotent under
    // vitest's retry:1 policy — same module-level email is reused on retry.
    await prisma.user.deleteMany({ where: { email: H2_EMAIL } });
    await prisma.user.create({
      data: {
        email: H2_EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'H2',
        lastName: 'Test',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    // Get initial access token (pre-MFA)
    const login1Res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: H2_EMAIL, password: PW }),
    });
    expect(login1Res.status).toBe(200);
    const login1 = await login1Res.json();
    const preToken = login1.data.accessToken as string;

    // Enroll MFA
    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${preToken}` },
    });
    expect(beginRes.status).toBe(200);
    const begin = await beginRes.json();
    h2Secret = begin.data.secret as string;

    const enrollCode = authenticator.generate(h2Secret);
    const verifyEnrollRes = await fetch(`${API}/auth/mfa/enroll/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preToken}` },
      body: JSON.stringify({ code: enrollCode }),
    });
    expect(verifyEnrollRes.status).toBe(200);

    // Login → get a challenge token
    const login2Res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: H2_EMAIL, password: PW }),
    });
    expect(login2Res.status).toBe(200);
    const login2 = await login2Res.json();
    expect(login2.data.mfaRequired).toBe(true);
    const challengeToken = login2.data.challengeToken as string;

    // Drive 5 wrong codes against this challenge
    const WRONG_CODE = '000000';
    let lastStatus = 0;
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(`${API}/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code: WRONG_CODE }),
      });
      lastStatus = r.status;
      const body = await r.json();
      if (i < 5) {
        // Attempts 1-4: should be MFA_BAD_CODE (401) not lockout
        expect(r.status).toBe(401);
        expect(body.error.code).toBe('MFA_BAD_CODE');
      } else {
        // 5th attempt hits the limit
        expect([401, 429]).toContain(r.status);
      }
    }

    // 6th attempt (or any subsequent) must return lockout
    const r6 = await fetch(`${API}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code: WRONG_CODE }),
    });
    expect(r6.status).toBe(429);
    const body6 = await r6.json();
    expect(body6.error.code).toBe('MFA_TOO_MANY_ATTEMPTS');
  });

  it('a correct code on a FRESH challenge still works after the previous challenge was locked', async () => {
    // Get a new challenge (new login → new jti → fresh counter)
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: H2_EMAIL, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    expect(loginData.data.mfaRequired).toBe(true);
    const freshChallenge = loginData.data.challengeToken as string;

    // Use the correct TOTP code
    const correctCode = authenticator.generate(h2Secret);
    const verifyRes = await fetch(`${API}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: freshChallenge, code: correctCode }),
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.data.accessToken).toBeTruthy();
    expect(verifyBody.data.user.email).toBe(H2_EMAIL);
  });
});
