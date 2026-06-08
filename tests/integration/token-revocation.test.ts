/**
 * Integration test for Task 5 + Task 6:
 *   - access tokens are stamped with jti + tv at login
 *   - auth middleware enforces JTI denylist revocation
 *   - auth middleware enforces token-version (tv) revocation
 *
 * Tests do NOT rely on Task 7 (logout denylist). Instead they manipulate
 * Redis / Prisma directly to prove the middleware checks work end-to-end.
 *
 * Requires the API to be running on API_HOST (default http://localhost:4000)
 * and the local Postgres + Redis to be accessible.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@force/database';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { redis } from '../../apps/api/src/services/redis.service';

// API_HOST in the root .env is a bare hostname used by the server (e.g.
// "localhost") — not a URL. Importing redis.service triggers dotenv.config()
// which injects it before this const runs, producing an invalid URL like
// "localhost/api/v1". Use a dedicated TEST_API_BASE var with a http:// fallback
// that matches CI (where neither var is set).
const API = `${process.env.TEST_API_BASE || 'http://localhost:4000'}/api/v1`;
const PW = 'Test1234!pw';

/** Track created user IDs for cleanup. */
const createdUserIds: string[] = [];

/**
 * Create a fresh test user and log in.
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
      role: 'super_admin',
      emailVerified: true,
      storeId: null,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`login failed (${r.status}): ${body}`);
  }

  const json = await r.json();
  const token = json.data.accessToken as string;
  const decoded = jwt.decode(token) as { jti?: string } | null;
  if (!decoded?.jti) throw new Error('access token missing jti claim — Task 5 not applied?');

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
    const { token } = await setupAndLogin();
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
