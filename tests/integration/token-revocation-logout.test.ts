/**
 * Integration test for Task 7:
 *   - POST /auth/logout denylists the access-token jti so subsequent
 *     requests with the same token are rejected (401 TOKEN_REVOKED).
 *   - POST /auth/logout-all bumps the user's tokenVersion so ALL
 *     outstanding access tokens are rejected (401 TOKEN_REVOKED).
 *
 * Requires the API running on API_HOST (default http://localhost:4000)
 * and local Postgres + Redis accessible.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@force/database';
import bcrypt from 'bcryptjs';
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
 * Create a fresh test user, log in, and return the access token + user id.
 */
async function setupAndLogin(): Promise<{ token: string; userId: string; refreshToken: string }> {
  const email = `logout-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'Log',
      lastName: 'Out',
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
  const refreshToken = json.data.refreshToken as string;

  return { token, userId: user.id, refreshToken };
}

describe('logout jti denylist (Task 7)', () => {
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

  it('POST /auth/logout denylists the jti — same token 401 on /auth/me afterwards', async () => {
    const { token } = await setupAndLogin();

    // Token works before logout
    const before = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    // Logout with the Bearer token (optional-auth path)
    const logoutRes = await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    expect(logoutRes.status).toBe(200);
    const logoutBody = await logoutRes.json();
    expect(logoutBody.success).toBe(true);

    // Same token is now rejected
    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    const afterBody = await after.json();
    expect(afterBody.error.code).toBe('TOKEN_REVOKED');
  });

  it('POST /auth/logout without a token still clears session (200, no jti denylist attempt)', async () => {
    // Regression guard: unauthenticated logout must not 401
    const logoutRes = await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(logoutRes.status).toBe(200);
    const body = await logoutRes.json();
    expect(body.success).toBe(true);
  });

  it('POST /auth/logout-all bumps tokenVersion — same token 401 on /auth/me afterwards', async () => {
    const { token } = await setupAndLogin();

    // Token works before logout-all
    const before = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    // Logout-all (requires a valid Bearer token — strict auth)
    const logoutAllRes = await fetch(`${API}/auth/logout-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    expect(logoutAllRes.status).toBe(200);
    const logoutAllBody = await logoutAllRes.json();
    expect(logoutAllBody.success).toBe(true);

    // The same token is rejected because tokenVersion was bumped
    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    const afterBody = await after.json();
    expect(afterBody.error.code).toBe('TOKEN_REVOKED');
  });

  it('POST /auth/logout-all also revokes refresh tokens in DB', async () => {
    const { token, userId } = await setupAndLogin();

    // Verify the user has at least one active refresh token
    const before = await prisma.refreshToken.count({
      where: { userId, revokedAt: null },
    });
    expect(before).toBeGreaterThan(0);

    await fetch(`${API}/auth/logout-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    const after = await prisma.refreshToken.count({
      where: { userId, revokedAt: null },
    });
    expect(after).toBe(0);
  });
});
