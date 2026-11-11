/**
 * #622 / Ruling CORS-TB-1 — credentialed cross-origin = same-tenant only, identity-service branch.
 *
 * `POST /auth/session` puts a merchant's / staff member's / super_admin's ES256 identity token in
 * the SAME SameSite=None `token` cookie the storefront uses. A page on merchant A's verified
 * domain therefore makes a lured store-B owner's browser send it. From a store origin that token
 * must be NO identity — on every route, because the check lives in the verifiers, not a path list.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: () => Promise.resolve(0),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  getUserState: async () => ({ tokenVersion: 0, status: 'active' }),
  resolveStoreId: async () => null,
  lookupStore: async () => null,
}));
vi.mock('../../apps/api/src/utils/store-helpers', () => ({
  resolvePublicStoreId: async () => undefined,
  getAuthUser: (req: Request) => req.user,
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('../../apps/api/src/lib/accounts-token', () => ({
  isAccountsToken: (t: string) => t.startsWith('es256.'),
  verifyAccountsToken: async () => ({
    sub: 'owner-b',
    email: 'owner@store-b.test',
    sid: 'sid-1',
    jti: 'jti-1',
    stores: [{ id: 'store-b', role: 'owner' }],
    exp: Math.floor(Date.now() / 1000) + 300,
  }),
}));
// Plain reads are non-live: the claims are trusted, no identity RPC (needsLiveIdentity=false).
vi.mock('../../apps/api/src/lib/auth-sensitivity', () => ({ needsLiveIdentity: () => false }));

const { authenticate, optionalAuthenticate } = await import('../../apps/api/src/middleware/auth');

const reqWith = (headers: Record<string, string>): Request =>
  ({
    method: 'GET',
    path: '/api/v1/auth/me',
    headers,
    cookies: { token: 'es256.cookie' },
  }) as unknown as Request;

async function run(req: Request): Promise<Error | undefined> {
  let err: Error | undefined;
  await authenticate(
    req,
    {} as Response,
    ((e?: Error) => {
      err = e;
    }) as NextFunction
  );
  return err;
}

describe('identity-service token vs request origin (#622)', () => {
  it('works from a platform origin (admin app) and with no Origin', async () => {
    for (const headers of [{ origin: 'https://store.ebda.app' }, {}]) {
      const req = reqWith(headers);
      expect(await run(req)).toBeUndefined();
      expect(req.user?.userId).toBe('owner-b');
    }
  });

  it.each([
    'https://shop-a.com', // merchant A's verified custom domain
    'https://shop-a.ebda.app', // a store subdomain
    'https://shop-b.ebda.app', // even the token's own store: a storefront is not an admin surface
    'null',
  ])('is refused from store origin %s', async origin => {
    const req = reqWith({ origin });
    expect(await run(req)).toMatchObject({ statusCode: 401, code: 'TOKEN_INVALID' });
    expect(req.user).toBeUndefined();
  });

  it('optionalAuthenticate treats it as a guest from a store origin', async () => {
    const req = reqWith({ origin: 'https://shop-a.com' });
    const next = vi.fn();
    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });
});
