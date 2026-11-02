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
 * Identity model (Rulings ID-1/ID-2): super admins and merchants no longer log in at the Store, so each user here is a row
 * plus the ES256 token the identity service would issue (tests/helpers/identity-session.ts). Two assertions of the old file moved:
 *   - "login -> /auth/mfa/enroll/begin" for a super_admin: enrollment is now managed at the identity service, and the Store
 *     answers 409 USE_IDENTITY_SERVICE (asserted below); the Store-side gate still reads the mirrored `mfaEnabled` flag.
 *   - "enroll + login challenge -> /auth/mfa/verify -> token for an enrolled super_admin": the enrolled state is now set on the
 *     row directly; the Store's TOTP challenge flow itself is covered for customers in mfa.test.ts.
 *
 * Requires the API running on TEST_API_URL (default http://localhost:4000) and
 * local Postgres + Redis accessible.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { API_BASE } from '../helpers/api-base';
import { identityTokenFor } from '../helpers/identity-session';

// One knob configures the whole suite; see tests/helpers/api-base.ts for why
// it is TEST_API_URL rather than the server's own API_URL or API_HOST.
const API = API_BASE;
const PW = 'Test1234!pw';
const SUPER_EMAIL = `mfa-enf-super-${Date.now()}@example.test`;
const STORE_EMAIL = `mfa-enf-store-${Date.now()}@example.test`;
const ENROLLED_SUPER_EMAIL = `mfa-enf-enrolled-${Date.now()}@example.test`;

async function mkUser(email: string, role: 'super_admin' | 'store_admin', mfa = false) {
  await prisma.user.deleteMany({ where: { email } });
  return prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'Mfa',
      lastName: 'Enf',
      role,
      emailVerified: true,
      storeId: null,
      // Mirrored flag the Store's requireMfaEnrolled gate reads (the secret itself lives at the identity service).
      ...(mfa ? { mfaEnabled: true, mfaSecret: 'enc:test-mfa-secret' } : {}),
    },
  });
}

// Clean up before AND after the suite (stale rows from an aborted run).
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
    const u = await mkUser(SUPER_EMAIL, 'super_admin');
    const token = await identityTokenFor(u.id);

    // Hit a protected admin route — must be blocked
    const adminRes = await fetch(`${API}/admin/stores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(adminRes.status).toBe(403);
    const body = await adminRes.json();
    expect(body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('super_admin without MFA can still reach /auth/me (auth route is exempt)', async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { email: SUPER_EMAIL } });
    const token = await identityTokenFor(u.id);

    const meRes = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // /auth/me is on the /auth router — requireMfaEnrolled is never applied
    expect(meRes.status).toBe(200);
  });

  it('super_admin without MFA gets 409 USE_IDENTITY_SERVICE on /auth/mfa/enroll/begin (enrollment moved to the identity service, and the route is not MFA-gated)', async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { email: SUPER_EMAIL } });
    const token = await identityTokenFor(u.id);

    const beginRes = await fetch(`${API}/auth/mfa/enroll/begin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // Not 403 MFA_SETUP_REQUIRED: the enrollment route stays exempt from the gate; it answers with the identity-service rule.
    expect(beginRes.status).toBe(409);
    const beginBody = await beginRes.json();
    expect(beginBody.error.code).toBe('USE_IDENTITY_SERVICE');
  });

  it('store_admin without MFA is NOT blocked by the MFA gate on /admin/stores', async () => {
    const u = await mkUser(STORE_EMAIL, 'store_admin');
    const token = await identityTokenFor(u.id);

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
    const u = await prisma.user.findFirstOrThrow({ where: { email: SUPER_EMAIL } });
    const token = await identityTokenFor(u.id);

    const storesRes = await fetch(`${API}/stores`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(storesRes.status).toBe(403);
    const body = await storesRes.json();
    expect(body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('store_admin without MFA is NOT blocked by MFA gate on GET /stores', async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { email: STORE_EMAIL } });
    const token = await identityTokenFor(u.id);

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
    // Enrolled = the mirrored mfaEnabled flag is set (enrollment itself happens at the identity service).
    const u = await mkUser(ENROLLED_SUPER_EMAIL, 'super_admin', true);
    const enrolledToken = await identityTokenFor(u.id);

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
