/**
 * ID-05 / Ruling CORS-TB-2 — `/auth/logout` from a STORE origin ends only that store's own
 * customer session.
 *
 * Logout is CSRF-exempt, reads the ambient SameSite=None cookies, and every verified merchant
 * domain is CORS-credentialed. A page on merchant A's domain could otherwise log out a lured
 * store-B owner (revoking their identity session suite-wide) or another store's shopper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const { mockLogout, mockRevokeIdentity, mockDenyJti } = vi.hoisted(() => ({
  mockLogout: vi.fn(async () => undefined),
  mockRevokeIdentity: vi.fn(async () => undefined),
  mockDenyJti: vi.fn(async () => undefined),
}));

vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { logout: mockLogout },
  GENERIC_RESEND_VERIFICATION_RESULT: { success: true, message: 'x' },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    denyJti: mockDenyJti,
    isJtiDenied: async () => false,
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getClient: vi.fn(() => null),
  },
}));
vi.mock('@api/lib/identity-client', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  revokeIdentitySession: mockRevokeIdentity,
}));
vi.mock('@api/lib/accounts-token', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  isAccountsToken: (t: string) => t.startsWith('es256.'),
  verifyAccountsToken: async () => ({ sid: 'sid-owner-b', sub: 'owner-b' }),
}));
vi.mock('@api/lib/definer', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  resolveStoreId: async (m: { slug?: string; domain?: string }) =>
    (({ 'shop-a': 'store-a', 'shop-b': 'store-b' }) as Record<string, string>)[m.slug ?? ''] ??
    ({ 'shop-a.com': 'store-a' } as Record<string, string>)[m.domain ?? ''] ??
    null,
}));
vi.mock('@api/utils/store-helpers', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  resolvePublicStoreId: async () => undefined,
}));

import authRoutes from '@api/routes/auth.routes';
import { config } from '@api/config';
import { clearOriginStoreCache } from '@api/lib/customer-store-binding';

type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
function logoutHandler(): Handler {
  const layers = (
    authRoutes as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Handler }>;
        };
      }>;
    }
  ).stack;
  const layer = layers.find(l => l.route?.path === '/logout' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /logout not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const sign = (claims: Record<string, unknown>, refresh = false) =>
  jwt.sign(
    { email: 'u@example.test', tv: 0, ...claims, ...(refresh ? { type: 'refresh' } : {}) },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      issuer: 'ebda-api',
      audience: 'ebda-app',
      expiresIn: '30m',
      jwtid: crypto.randomUUID(),
    }
  );

async function logout(headers: Record<string, string>, cookies: Record<string, string>) {
  const cleared: string[] = [];
  const out: { status: number; body?: unknown } = { status: 200 };
  const res = {
    clearCookie: (n: string) => cleared.push(n),
    status(code: number) {
      out.status = code;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  };
  let err: unknown;
  await logoutHandler()({ headers, cookies, body: {}, path: '/logout' }, res, e => (err = e));
  return { ...out, cleared, err };
}

// An identity-service (ES256) session as the mocked isAccountsToken sees it (prefix `es256.`).
const IDENTITY_SESSION = ['es256', 'owner-b'].join('.');

const customer = (storeId: string, refresh = false) =>
  sign({ userId: `cust-${storeId}`, role: 'customer', storeId }, refresh);

beforeEach(() => {
  clearOriginStoreCache();
  mockLogout.mockClear();
  mockRevokeIdentity.mockClear();
  mockDenyJti.mockClear();
});

describe('POST /auth/logout from a store origin (ID-05)', () => {
  it("refuses store A's custom domain logging out a store-B owner (identity session)", async () => {
    const r = await logout({ origin: 'https://shop-a.com' }, { token: IDENTITY_SESSION });
    expect(r.status).toBe(403);
    expect(r.cleared).toEqual([]);
    expect(mockRevokeIdentity).not.toHaveBeenCalled();
  });

  it("refuses store A's origin logging out a store-B shopper (access + refresh cookies)", async () => {
    const r = await logout(
      { origin: 'https://shop-a.ebda.app' },
      { token: customer('store-b'), refresh_token: customer('store-b', true) }
    );
    expect(r.status).toBe(403);
    expect(r.cleared).toEqual([]);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockDenyJti).not.toHaveBeenCalled();
  });

  it('refuses a merchant/staff HS256 session (e.g. impersonation) from a store origin', async () => {
    const r = await logout(
      { origin: 'https://shop-a.com' },
      { token: sign({ userId: 'u', role: 'store_admin', storeId: null, impersonatedBy: 'sa' }) }
    );
    expect(r.status).toBe(403);
    expect(r.cleared).toEqual([]);
  });

  it('refuses when only the refresh cookie belongs to another store', async () => {
    const r = await logout(
      { origin: 'https://shop-a.com' },
      { refresh_token: customer('store-b', true) }
    );
    expect(r.status).toBe(403);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("logs out the origin store's own customer (subdomain and custom domain)", async () => {
    for (const origin of ['https://shop-a.ebda.app', 'https://shop-a.com']) {
      mockLogout.mockClear();
      const r = await logout(
        { origin },
        { token: customer('store-a'), refresh_token: customer('store-a', true) }
      );
      expect(r.status, origin).toBe(200);
      expect(r.cleared.sort()).toEqual(['refresh_token', 'token']);
      expect(mockLogout).toHaveBeenCalledOnce();
      expect(mockDenyJti).toHaveBeenCalled();
    }
  });

  it('still clears a dead (unverifiable) cookie from a store origin (#1531 heal)', async () => {
    const r = await logout(
      { origin: 'https://shop-a.com' },
      { token: 'garbage', refresh_token: 'garbage' }
    );
    expect(r.status).toBe(200);
    expect(r.cleared.sort()).toEqual(['refresh_token', 'token']);
  });

  it('a merchant logs out from the admin app (platform origin) and with no Origin', async () => {
    for (const headers of [{ origin: 'https://store.ebda.app' }, {}]) {
      mockRevokeIdentity.mockClear();
      const r = await logout(headers, { token: IDENTITY_SESSION });
      expect(r.status).toBe(200);
      expect(r.cleared.sort()).toEqual(['refresh_token', 'token']);
      expect(mockRevokeIdentity).toHaveBeenCalledWith('sid-owner-b', 'logout');
    }
  });
});
