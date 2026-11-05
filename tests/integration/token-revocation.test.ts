/**
 * Integration test for Task 5 + Task 6:
 *   - access tokens are stamped with jti + tv at login
 *   - auth middleware enforces JTI denylist revocation
 *   - auth middleware enforces token-version (tv) revocation
 *
 * Tests do NOT rely on Task 7 (logout denylist). Instead they manipulate
 * Redis / Prisma directly to prove the middleware checks work end-to-end.
 *
 * Requires the API to be running on TEST_API_URL (default http://localhost:4000)
 * and the local Postgres + Redis to be accessible.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { redis } from '../../apps/api/src/services/redis.service';
import { API_BASE } from '../helpers/api-base';
import { legacySessionFor } from '../helpers/legacy-session';

// One knob configures the whole suite; see tests/helpers/api-base.ts for why
// it is TEST_API_URL rather than the server's own API_URL or API_HOST. The
// redis.service import above is exactly the hazard: it runs dotenv.config()
// before this line, so root-.env values would win.
const API = API_BASE;
const PW = 'Test1234!pw';

/** Track created user IDs for cleanup. */
const createdUserIds: string[] = [];

/**
 * Create a fresh test user and mint its Store (HS256) session; /auth/login is closed for this role (Rulings ID-1/ID-2), the
 * HS256 shape is what customer and impersonation tokens still use. The ES256 identity-session revocation (revokeUser by sid) is
 * covered end to end in user-status-enforcement.test.ts.
 *
 * Returns the access token, its jti claim, and the user's DB id.
 */
async function setupAndLogin(): Promise<{ token: string; jti: string; userId: string }> {
  // Fresh unique email per call — users table has @@unique([storeId, email]),
  // not a bare email unique, so we can't use upsert; just create fresh.
  const email = `revoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'Rev',
      lastName: 'Oke',
      role: 'store_admin',
      emailVerified: true,
      storeId: null,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const { accessToken: token } = await legacySessionFor(user.id);
  const decoded = jwt.decode(token) as { jti?: string } | null;
  if (!decoded?.jti) throw new Error('access token missing jti claim');

  return { token, jti: decoded.jti, userId: user.id };
}

describe('access-token revocation', () => {
  afterAll(async () => {
    // Clean up Redis tv cache keys for all created users, then delete users.
    await redis.connect();
    const c = redis.getClient();
    if (c) {
      for (const id of createdUserIds) {
        await c.del(`user:tv:${id}`);
      }
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  it('login stamps jti and tv on the access token (Task 5)', async () => {
    // The real Store login path (/auth/login) is still open for customer accounts, so Task 5's stamping is proven there.
    const email = `revoke-cust-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const customer = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'Rev',
        lastName: 'Cust',
        role: 'customer',
        emailVerified: true,
        storeId: null,
      },
      select: { id: true },
    });
    createdUserIds.push(customer.id);
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PW }),
    });
    expect(r.status).toBe(200);
    const token = (await r.json()).data.accessToken as string;
    const decoded = jwt.decode(token) as Record<string, unknown> | null;
    expect(decoded).not.toBeNull();
    // jti must be a UUID
    expect(typeof decoded?.jti).toBe('string');
    expect(decoded?.jti).toMatch(/^[0-9a-f-]{36}$/);
    // tv must be a number (0 for a fresh user)
    expect(typeof decoded?.tv).toBe('number');
    expect(decoded?.tv).toBe(0);
  });

  it('a valid token reaches /auth/me (baseline — middleware passes)', async () => {
    const { token } = await setupAndLogin();
    const res = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects token after its jti is added to the denylist (Task 6 — JTI check)', async () => {
    const { token, jti } = await setupAndLogin();

    // Confirm it works before denylisting
    const before = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    // Manually denylist the jti via the redis helper (120s TTL — above the
    // 120s ESLint floor enforced in this repo)
    await redis.connect();
    await redis.denyJti(jti, 120);

    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    const body = await after.json();
    expect(body.error.code).toBe('TOKEN_REVOKED');
  });

  it('rejects token after tokenVersion is bumped in DB + Redis cache cleared (Task 6 — tv check)', async () => {
    const { token, userId } = await setupAndLogin();

    // Token works initially
    const before = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    // Simulate a logout-all / password change by bumping tokenVersion in DB
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    // Clear the Redis tv cache so the middleware re-reads from DB
    await redis.connect();
    const c = redis.getClient();
    if (c) {
      await c.del(`user:tv:${userId}`);
    }

    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    const body = await after.json();
    expect(body.error.code).toBe('TOKEN_REVOKED');

    // Reset tokenVersion for clean afterAll deletion
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: 0 },
    });
  });
});
