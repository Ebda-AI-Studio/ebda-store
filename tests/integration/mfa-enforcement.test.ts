/**
 * Integration test for MFA enforcement gate (C1 fix).
 *
 * Verified behaviors:
 *   1. super_admin with mfaEnabled=false hits GET /admin/stores → 403 MFA_SETUP_REQUIRED.
 *   2. super_admin (not enrolled) can still reach /auth/me → 200 (auth route exempt).
 *   3. super_admin (not enrolled) can still reach /auth/mfa/enroll/begin → 200 (enrollment exempt).
 *   4. store_admin with mfaEnabled=false hits GET /admin/stores → NOT 403 MFA_SETUP_REQUIRED
 *      (the gate early-returns for non-super_admin roles).
 *   5. (C1) super_admin without MFA hits GET /stores (store.routes) → 403 MFA_SETUP_REQUIRED.
 *   6. (C1) store_admin without MFA hits GET /stores (store.routes) → NOT blocked by MFA gate.
 *   7. (C1) enrolled super_admin hits GET /stores → passes (200).
 *
 * Requires the API running on TEST_API_URL (default http://localhost:4000) and
 * local Postgres + Redis accessible.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { encryption } from '../../apps/api/src/services/encryption.service';
import { MfaService } from '../../apps/api/src/services/mfa.service';
import { API_BASE } from '../helpers/api-base';

// One knob configures the whole suite; see tests/helpers/api-base.ts for why
// it is TEST_API_URL rather than the server's own API_URL or API_HOST. The
// encryption.service import above is exactly the hazard: it runs
// dotenv.config() before this line, so root-.env values would win.
const API = API_BASE;
const PW = 'Test1234!pw';
const SUPER_EMAIL = `mfa-enf-super-${Date.now()}@example.test`;
const STORE_EMAIL = `mfa-enf-store-${Date.now()}@example.test`;
const ENROLLED_SUPER_EMAIL = `mfa-enf-enrolled-${Date.now()}@example.test`;

// Clean up before AND after the suite. The beforeAll handles stale rows from
// a previous aborted run or from vitest's retry:1 policy (module-level
// constants reuse the same email on every retry within the same run).
beforeAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [SUPER_EMAIL, STORE_EMAIL, ENROLLED_SUPER_EMAIL] } },
  });
});
afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [SUPER_EMAIL, STORE_EMAIL, ENROLLED_SUPER_EMAIL] } },
  });
});

describe('Task 9: super_admin MFA enforcement (admin.routes)', () => {
  it('super_admin without MFA is blocked (403 MFA_SETUP_REQUIRED) on a protected admin route', async () => {
    // Create super_admin — mfaEnabled defaults false. Delete first for
    // idempotency under vitest's retry:1 policy.
    await prisma.user.deleteMany({ where: { email: SUPER_EMAIL } });
    await prisma.user.create({
      data: {
        email: SUPER_EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'Super',
        lastName: 'NoMfa',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    // Login (no MFA enrolled → normal token issued)
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPER_EMAIL, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const { data } = await loginRes.json();
    const token = data.accessToken as string;
    expect(token).toBeTruthy();

    // Hit a protected admin route — must be blocked
    const adminRes = await fetch(`${API}/admin/stores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(adminRes.status).toBe(403);
    const body = await adminRes.json();
    expect(body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('super_admin without MFA can still reach /auth/me (auth route is exempt)', async () => {
    // Re-login to get a fresh token for the same user
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPER_EMAIL, password: PW }),
    });
    const { data } = await loginRes.json();
    const token = data.accessToken as string;

    const meRes = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // /auth/me is on the /auth router — requireMfaEnrolled is never applied
    expect(meRes.status).toBe(200);
  });

  it('super_admin without MFA can still reach /auth/mfa/enroll/begin (enrollment route is exempt)', async () => {
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPER_EMAIL, password: PW }),
    });
    const { data } = await loginRes.json();
    const token = data.accessToken as string;

    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // Must succeed (200) — not gated by requireMfaEnrolled
    expect(beginRes.status).toBe(200);
    const beginBody = await beginRes.json();
    expect(beginBody.data.secret).toBeTruthy();
  });

  it('store_admin without MFA is NOT blocked by the MFA gate on /admin/stores', async () => {
    // Create store_admin — mfaEnabled defaults false. Delete first for idempotency.
    await prisma.user.deleteMany({ where: { email: STORE_EMAIL } });
    await prisma.user.create({
      data: {
        email: STORE_EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'Store',
        lastName: 'Admin',
        role: 'store_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: STORE_EMAIL, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const { data } = await loginRes.json();
    const token = data.accessToken as string;

    const adminRes = await fetch(`${API}/admin/stores`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // The gate passes store_admin through — it should get a normal authorized
    // response (200) for GET /admin/stores (store_admin can list their own stores).
    // The key assertion: it must NOT be 403 MFA_SETUP_REQUIRED.
    expect(adminRes.status).not.toBe(403);
    if (adminRes.status === 403) {
      const body = await adminRes.json();
      expect(body.error?.code).not.toBe('MFA_SETUP_REQUIRED');
    }
    // Also assert it's a successful response (200 OK with their store list)
    expect(adminRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// C1: Broadened enforcement on store.routes (GET /stores — super_admin endpoint)
// ---------------------------------------------------------------------------

describe('C1: MFA enforcement on store.routes', () => {
  it('un-enrolled super_admin is blocked (403 MFA_SETUP_REQUIRED) on GET /stores', async () => {
    // Re-use the un-enrolled super_admin created in the block above.
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPER_EMAIL, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const { data } = await loginRes.json();
    const token = data.accessToken as string;

    const storesRes = await fetch(`${API}/stores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(storesRes.status).toBe(403);
    const body = await storesRes.json();
    expect(body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('store_admin without MFA is NOT blocked by MFA gate on GET /stores', async () => {
    // Re-use the store_admin from above.
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: STORE_EMAIL, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const { data } = await loginRes.json();
    const token = data.accessToken as string;

    const storesRes = await fetch(`${API}/stores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // store_admin must NOT get MFA_SETUP_REQUIRED
    expect(storesRes.status).not.toBe(403);
    if (storesRes.status === 403) {
      const body = await storesRes.json();
      expect(body.error?.code).not.toBe('MFA_SETUP_REQUIRED');
    }
    expect(storesRes.status).toBe(200);
  });

  it('enrolled super_admin is NOT blocked on GET /stores', async () => {
    // Create a fresh super_admin to enroll from scratch. Delete first to keep
    // this test idempotent under vitest's retry:1 policy (same email reused
    // per module-load within a single vitest run).
    await prisma.user.deleteMany({ where: { email: ENROLLED_SUPER_EMAIL } });
    const user = await prisma.user.create({
      data: {
        email: ENROLLED_SUPER_EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'Enrolled',
        lastName: 'Super',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });

    // Login → get access token (no MFA yet)
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ENROLLED_SUPER_EMAIL, password: PW }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    const token = loginData.data.accessToken as string;

    // Begin MFA enrollment
    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(beginRes.status).toBe(200);
    const begin = await beginRes.json();
    const secret = begin.data.secret as string;

    // Confirm enrollment with a valid TOTP code
    const enrollCode = authenticator.generate(secret);
    const verifyEnrollRes = await fetch(`${API}/auth/mfa/enroll/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: enrollCode }),
    });
    expect(verifyEnrollRes.status).toBe(200);

    // Login again → MFA challenge required
    const login2Res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ENROLLED_SUPER_EMAIL, password: PW }),
    });
    expect(login2Res.status).toBe(200);
    const login2 = await login2Res.json();
    expect(login2.data.mfaRequired).toBe(true);
    const challengeToken = login2.data.challengeToken as string;

    // Complete MFA → get real access token
    const mfaCode = authenticator.generate(secret);
    const mfaVerifyRes = await fetch(`${API}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code: mfaCode }),
    });
    expect(mfaVerifyRes.status).toBe(200);
    const mfaVerify = await mfaVerifyRes.json();
    const enrolledToken = mfaVerify.data.accessToken as string;

    // Enrolled super_admin must reach /stores without MFA block
    const storesRes = await fetch(`${API}/stores`, {
      headers: { Authorization: `Bearer ${enrolledToken}` },
    });
    // Must NOT be 403 MFA_SETUP_REQUIRED
    expect(storesRes.status).not.toBe(403);
    if (storesRes.status === 403) {
      const body = await storesRes.json();
      expect(body.error?.code).not.toBe('MFA_SETUP_REQUIRED');
    }
    expect(storesRes.status).toBe(200);
  });
});
