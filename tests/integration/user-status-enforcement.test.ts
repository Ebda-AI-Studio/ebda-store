/**
 * S3-1 / S3-2 (2026-09-22 security audit): `status` (active/inactive/
 * suspended) was recorded on every user but never enforced anywhere, and a
 * role change never revoked the outstanding token carrying the old role.
 *
 * Before this fix:
 *   - `login()` filtered only `deletedAt: null` — a suspended user could log
 *     in again with their own password.
 *   - `refreshTokens()` never read `status` — an already-open session kept
 *     refreshing forever regardless of status.
 *   - `authenticate` never read `status` at all.
 *   - `PUT /admin/users/:id` accepted a status/role change and audited it,
 *     but never called `revokeAllSessions` — an admin who "locked out" a
 *     compromised or departing account left every existing session live.
 *
 * These tests hit the real HTTP server (TEST_API_URL) because the bug lives
 * partly in route wiring (`admin.routes.ts` PUT handler), not only in
 * AuthService — the same reasoning `token-revocation-logout.test.ts` and
 * `token-revocation.test.ts` use for the sibling revocation paths.
 *
 * Requires the API running on TEST_API_URL (default http://localhost:4000)
 * and local Postgres + Redis accessible.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { redis } from '../../apps/api/src/services/redis.service';
import { AuthService } from '../../apps/api/src/services/auth.service';
import { API_BASE } from '../helpers/api-base';
import { identityTokenFor } from '../helpers/identity-session';

const API = API_BASE;
const PW = 'Test1234!pw';

const createdUserIds: string[] = [];

async function createUser(opts: {
  role: 'customer' | 'store_admin' | 'super_admin';
  status?: 'active' | 'inactive' | 'suspended';
}): Promise<{ id: string; email: string }> {
  const email = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'Status',
      lastName: 'Test',
      role: opts.role,
      status: opts.status ?? 'active',
      emailVerified: true,
      storeId: null,
      // requireMfaEnrolled 403s any super_admin without MFA enrolled before
      // they reach an /admin/* route. Irrelevant to what these tests cover
      // (status/role revocation, not MFA), so pre-enroll super_admin actors —
      // `sessionForActor` mints their session directly (bypassing the
      // login()-time MFA-challenge branch), so this only needs to satisfy
      // requireMfaEnrolled's DB read, not a real TOTP flow.
      ...(opts.role === 'super_admin'
        ? { mfaEnabled: true, mfaSecret: 'enc:test-mfa-secret' }
        : {}),
    },
    select: { id: true, email: true },
  });
  createdUserIds.push(user.id);
  return user;
}

async function login(email: string): Promise<{ token: string; refreshToken: string }> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!r.ok) throw new Error(`login failed (${r.status}): ${await r.text()}`);
  const json = await r.json();
  return { token: json.data.accessToken, refreshToken: json.data.refreshToken };
}

/**
 * Platform admins and merchants sign in at the identity service, not the Store (Rulings ID-1/ID-2), so the acting
 * super_admin and the target merchant get the ES256 token the identity service would have issued (test stand-in).
 */
async function sessionForActor(actor: { id: string; email: string }): Promise<string> {
  return identityTokenFor(actor.id);
}

describe('S3-1: suspended/inactive users are rejected', () => {
  afterAll(async () => {
    await redis.connect();
    const c = redis.getClient();
    if (c) {
      for (const id of createdUserIds) await c.del(`user:tv:${id}`);
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  it('a suspended user cannot log in', async () => {
    const u = await createUser({ role: 'customer', status: 'suspended' });
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: PW }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('an inactive user cannot log in', async () => {
    const u = await createUser({ role: 'customer', status: 'inactive' });
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: PW }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('the MFA-verify session mint refuses an account suspended after its challenge (#1864)', async () => {
    // /auth/mfa/verify calls issueSessionFor with a row it re-reads AFTER the
    // TOTP check — up to 5 minutes after login()'s own status gate passed.
    const u = await createUser({ role: 'customer' });
    await prisma.user.update({ where: { id: u.id }, data: { status: 'suspended' } });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });

    await expect(AuthService.issueSessionFor(row)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
    expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(0);
  });

  it('a suspended user cannot refresh an already-open session', async () => {
    const u = await createUser({ role: 'customer' });
    const { refreshToken } = await login(u.email);

    // Suspend AFTER the session was already issued — this is the "already
    // logged in, then suspended" case, distinct from the login-time check.
    await prisma.user.update({ where: { id: u.id }, data: { status: 'suspended' } });

    const r = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('a live access token is rejected on the very next request once an admin suspends the account', async () => {
    // Two actors: a super_admin who performs the suspension, and the target
    // whose session must die. This exercises the PUT /admin/users/:id ->
    // revokeAllSessions wiring end to end, not just AuthService in isolation.
    const actor = await createUser({ role: 'super_admin' });
    // store_admin, not customer: a customer token is bound to a store (F-01,
    // Ruling S11-1) and this fixture user has none; the revocation path is role-agnostic.
    const target = await createUser({ role: 'store_admin' });
    const actorToken = await sessionForActor(actor);
    const targetToken = await identityTokenFor(target.id);

    // Confirm the target's session works before the suspension.
    const before = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    expect(before.status).toBe(200);

    const putRes = await fetch(`${API}/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}` },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(putRes.status).toBe(200);

    // No delay, no cache-clear — revokeAllSessions writes the bumped tv
    // straight into the Redis cache, so this must reject immediately.
    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    expect(after.status).toBe(401);
    const afterBody = await after.json();
    expect(afterBody.error.code).toBe('TOKEN_REVOKED');
  });
});

describe('S3-2: a role change revokes the outstanding token', () => {
  afterAll(async () => {
    await redis.connect();
    const c = redis.getClient();
    if (c) {
      for (const id of createdUserIds) await c.del(`user:tv:${id}`);
    }
    // This describe's own users (pushed onto the shared module-level
    // `createdUserIds` by `createUser()` above) were never deleted — the
    // S3-1 describe's afterAll only clears the ids it saw BEFORE it ran.
    // Missing this leaked a `role: 'super_admin'` row per test run, which
    // then poisoned `api.test.ts`'s admin-login test: seed.ts's
    // `findFirst({ where: { role: 'super_admin' } })` picked up the FIRST
    // ever super_admin row (an orphan from this file, at an unknown
    // password) instead of creating the one seeded with ADMIN_PASSWORD.
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  it('demoting a user rejects their pre-existing access token on the next request', async () => {
    const actor = await createUser({ role: 'super_admin' });
    // A super_admin demoted to store_admin: the one role change the Store's admin API still performs on an identity-managed account
    // (store_admin -> staff is not in its schema, ->customer is refused below, ->super_admin is OPERATOR_ONLY).
    const target = await createUser({ role: 'super_admin' });
    const actorToken = await sessionForActor(actor);
    const targetToken = await identityTokenFor(target.id);

    const before = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    expect(before.status).toBe(200);

    const putRes = await fetch(`${API}/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}` },
      body: JSON.stringify({ role: 'store_admin' }),
    });
    expect(putRes.status).toBe(200);

    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    expect(after.status).toBe(401);
    const afterBody = await after.json();
    expect(afterBody.error.code).toBe('TOKEN_REVOKED');
  });

  it('demoting an identity-managed account to customer is refused (MANAGED_BY_IDENTITY) and leaves the session live', async () => {
    // Rulings ID-1/ID-2: a merchant/staff/super_admin account (storeId NULL) cannot be turned into a customer row from the Store.
    const actor = await createUser({ role: 'super_admin' });
    const target = await createUser({ role: 'store_admin' });
    const actorToken = await sessionForActor(actor);
    const targetToken = await identityTokenFor(target.id);

    const putRes = await fetch(`${API}/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}` },
      body: JSON.stringify({ role: 'customer' }),
    });
    expect(putRes.status).toBe(409);
    expect((await putRes.json()).error.code).toBe('MANAGED_BY_IDENTITY');

    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    expect(after.status).toBe(200);
  });

  it('a no-op PUT (no status/role change) does NOT revoke the live session', async () => {
    // Negative control — the fix must not revoke on every PUT, only on a
    // real status/role transition.
    const actor = await createUser({ role: 'super_admin' });
    const target = await createUser({ role: 'store_admin' });
    const actorToken = await sessionForActor(actor);
    const targetToken = await identityTokenFor(target.id);

    const putRes = await fetch(`${API}/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}` },
      body: JSON.stringify({ firstName: 'Renamed' }),
    });
    expect(putRes.status).toBe(200);

    const after = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    expect(after.status).toBe(200);
  });
});
