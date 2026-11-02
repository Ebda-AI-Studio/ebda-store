/**
 * Ruling NZ-D2 (security review 2026-11-02): an unknown user is BLOCKED, never "tokenVersion 0", and nothing is cached for it.
 * HS256 (customer / impersonation) path of `authenticate`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCES_ACCEPTED, JWT_ISSUERS_ACCEPTED } from '@ebda/shared';
import type { Request, Response, NextFunction } from 'express';

const h = vi.hoisted(() => ({
  cachedTv: null as number | null,
  setTv: vi.fn(),
  state: null as null | { tokenVersion: number; status: string; deletedAt: Date | null },
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: async () => false,
    getUserTokenVersion: async () => h.cachedTv,
    setUserTokenVersion: h.setTv,
  },
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('../../apps/api/src/lib/definer', () => ({ getUserState: async () => h.state }));

const { authenticate } = await import('../../apps/api/src/middleware/auth');
const { config } = await import('../../apps/api/src/config');

const token = () =>
  jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'staff', tv: 0 }, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: [...JWT_ISSUERS_ACCEPTED][0],
    audience: [...JWT_AUDIENCES_ACCEPTED][0],
  } as never);

async function run() {
  const next = vi.fn();
  await authenticate(
    {
      method: 'GET',
      originalUrl: '/x',
      headers: { authorization: `Bearer ${token()}` },
      cookies: {},
    } as unknown as Request,
    {} as Response,
    next as unknown as NextFunction
  );
  return next.mock.calls[0]?.[0] as { statusCode?: number } | undefined;
}

beforeEach(() => {
  h.cachedTv = null;
  h.setTv.mockReset();
  h.state = null;
});

describe('HS256 auth: unknown user', () => {
  it('a user the backend does not know is refused (401) and NOTHING is written to the token-version cache', async () => {
    const err = await run();
    expect(err?.statusCode).toBe(401);
    expect(h.setTv).not.toHaveBeenCalled();
  });
  it('a soft-deleted or inactive user is refused too', async () => {
    h.state = { tokenVersion: 0, status: 'active', deletedAt: new Date() };
    expect((await run())?.statusCode).toBe(401);
    h.state = { tokenVersion: 0, status: 'suspended', deletedAt: null };
    expect((await run())?.statusCode).toBe(401);
  });
  it('a known active user passes and its REAL token version is cached', async () => {
    h.state = { tokenVersion: 0, status: 'active', deletedAt: null };
    expect(await run()).toBeUndefined();
    expect(h.setTv).toHaveBeenCalledWith('u1', 0);
  });
});
