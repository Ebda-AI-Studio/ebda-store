/**
 * Identity stage 5 (contract phase): the Store's own HS256 tokens no longer authenticate the admin namespace (merchant owners,
 * staff, super admins). Since stage 3 no path mints one; this closes the verifier, so a token minted before cutover, a leaked
 * old refresh, or a forged one with a stolen secret cannot be used for an admin identity. Customers and impersonation tokens
 * (which carry `impersonatedBy`) stay HS256.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: () => Promise.resolve(0),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('../../apps/api/src/lib/definer', () => ({
  getUserState: async (id: string) => ({
    id,
    role: 'store_admin',
    status: 'active',
    tokenVersion: 0,
    storeId: null,
    deletedAt: null,
  }),
}));
vi.mock('../../apps/api/src/lib/customer-store-binding', () => ({
  customerTokenMatchesRequestStore: async () => true,
}));

const { authenticate, optionalAuthenticate } = await import('../../apps/api/src/middleware/auth');
const { config } = await import('../../apps/api/src/config');
const { JWT_ISSUER, JWT_AUDIENCE } = await import('@ebda/shared');

const sign = (claims: Record<string, unknown>) =>
  jwt.sign({ userId: 'u1', email: 'a@example.com', tv: 0, ...claims }, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '10m',
    jwtid: crypto.randomUUID(),
  });

async function run(fn: typeof authenticate, token: string) {
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as unknown as Request;
  const next = vi.fn();
  await fn(req, {} as Response, next as unknown as NextFunction);
  const err = next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined;
  return { req, err };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EBDA_TEST_ALLOW_LEGACY_ADMIN_HS256 = '0'; // the seam is off: the production behaviour
});

describe('HS256 admin-namespace tokens are refused', () => {
  it.each(['store_admin', 'staff', 'super_admin'])(
    'a legacy %s token (no storeId, no impersonation) gets 401 USE_IDENTITY_SERVICE',
    async role => {
      const { req, err } = await run(authenticate, sign({ role, storeId: null }));
      expect(err).toMatchObject({ statusCode: 401, code: 'USE_IDENTITY_SERVICE' });
      expect(req.user).toBeUndefined();
    }
  );

  it('also when the token has no storeId claim at all (older tokens)', async () => {
    const { err } = await run(authenticate, sign({ role: 'store_admin' }));
    expect(err).toMatchObject({ statusCode: 401, code: 'USE_IDENTITY_SERVICE' });
  });

  it('optionalAuthenticate continues as a guest instead of establishing the admin identity', async () => {
    const { req } = await run(optionalAuthenticate, sign({ role: 'super_admin', storeId: null }));
    expect(req.user).toBeUndefined();
  });
});

describe('what stays HS256', () => {
  it('a customer token is still accepted', async () => {
    const { req, err } = await run(authenticate, sign({ role: 'customer', storeId: 'store-1' }));
    expect(err).toBeUndefined();
    expect(req.user?.role).toBe('customer');
  });

  it('an impersonation token (impersonatedBy) is still accepted', async () => {
    const { req, err } = await run(
      authenticate,
      sign({ role: 'store_admin', storeId: null, impersonatedBy: 'sa-1' })
    );
    expect(err).toBeUndefined();
    expect(req.user?.impersonatedBy).toBe('sa-1');
  });
});

describe('the test seam cannot open production', () => {
  it('is ignored unless NODE_ENV is test', async () => {
    const { isLegacyAdminToken } = await import('../../apps/api/src/lib/legacy-admin-token');
    process.env.EBDA_TEST_ALLOW_LEGACY_ADMIN_HS256 = '1';
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(isLegacyAdminToken({ role: 'super_admin' })).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(isLegacyAdminToken({ role: 'super_admin' })).toBe(false); // in test with the seam on
  });
});
