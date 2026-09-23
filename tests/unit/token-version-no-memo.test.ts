/**
 * Token-version resolution must NOT be memoised in-process.
 *
 * `authenticate` compares the JWT's `tv` claim against the user's current
 * tokenVersion, which is how logout-all and password-change revoke every
 * outstanding access token before it expires. Redis caches that value, and
 * revocation CLEARS the key — so the next request reads Postgres and sees the
 * bump immediately.
 *
 * A second-tier in-process cache was added here to bound the DB stampede when
 * Redis is unavailable (`getUserTokenVersion` returns null for both a miss and
 * an outage). It kept revoked tokens working for its whole TTL, on every API
 * instance, because nothing clears an in-process map and — being per-process —
 * nothing could: a bump handled by one instance cannot evict another's copy.
 *
 * tests/integration/token-revocation.test.ts catches this, but only with
 * Postgres and Redis running. This is the same guarantee as a unit test, so a
 * reintroduction fails in seconds rather than at the end of the pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

/** Simulates Redis MISS / outage on every call — the path that hits Postgres. */
const getUserTokenVersion = vi.fn(() => Promise.resolve<number | null>(null));
/** The authoritative value. Bumped mid-test to simulate a logout-all. */
let dbTokenVersion = 0;
// `status` is included because the real `users` row always has one (NOT
// NULL, default 'active' — schema.prisma) — this mock simulates that row,
// and omitting the field is not a real state the DB path ever sees. S3-1,
// 2026-09-22 security audit: `authenticate`'s DB-fallback path now also
// reads `status` on the same query these tests already mock.
const findUnique = vi.fn(() => Promise.resolve({ tokenVersion: dbTokenVersion, status: 'active' }));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: (...a: unknown[]) => getUserTokenVersion(...(a as [])),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));

vi.mock('@force/database', () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...(a as [])) } },
}));

const { authenticate } = await import('../../apps/api/src/middleware/auth');
const { config } = await import('../../apps/api/src/config');

const USER_ID = 'user-1';

function tokenWithTv(tv: number): string {
  return jwt.sign(
    { userId: USER_ID, email: 'u@example.test', role: 'customer', tv },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      issuer: 'force-api',
      audience: 'force-app',
      expiresIn: '30m',
    }
  );
}

async function callAuthenticate(token: string): Promise<Error | null> {
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as unknown as Request;
  const res = {} as Response;
  return new Promise(resolve => {
    authenticate(req, res, ((err?: Error) => resolve(err ?? null)) as NextFunction);
  });
}

describe('token-version resolution is never memoised in-process', () => {
  beforeEach(() => {
    dbTokenVersion = 0;
    getUserTokenVersion.mockClear();
    findUnique.mockClear();
  });

  it('rejects a token as soon as the DB tokenVersion is bumped, with no TTL window', async () => {
    const token = tokenWithTv(0);

    // Redis is missing/down, so this reads Postgres and the token is valid.
    expect(await callAuthenticate(token)).toBeNull();

    // logout-all / password change bumps the authoritative value.
    dbTokenVersion = 1;

    // The very next request must reject. An in-process memo returned the stale
    // 0 here and kept the revoked session alive for its whole TTL.
    const err = await callAuthenticate(token);
    expect(err, 'a revoked token must fail on the NEXT request, not after a TTL').toBeTruthy();
    expect((err as { statusCode?: number })?.statusCode).toBe(401);
  });

  it('reads the database on every Redis miss — no local copy short-circuits it', async () => {
    const token = tokenWithTv(0);

    await callAuthenticate(token);
    await callAuthenticate(token);
    await callAuthenticate(token);

    // Three misses, three reads. Any caching layer between Redis and Postgres
    // is a revocation window nothing can invalidate across instances.
    expect(findUnique).toHaveBeenCalledTimes(3);
    expect(getUserTokenVersion).toHaveBeenCalledTimes(3);
  });

  it('still honours the Redis value when the cache HAS one (the normal path)', async () => {
    getUserTokenVersion.mockResolvedValueOnce(5);
    const token = tokenWithTv(5);

    expect(await callAuthenticate(token)).toBeNull();
    // Cache hit: Postgres is not touched.
    expect(findUnique).not.toHaveBeenCalled();
  });
});
