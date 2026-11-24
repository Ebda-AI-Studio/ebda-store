/**
 * A24 access control through the REAL middleware chain: real `authenticate` (ES256 identity token, no role header), real
 * `authorize`, real `requireStoreAccess` (store row + staff membership), real route. Only data sources are stubbed.
 * Proves: the owner reads; a store STAFF member (real membership, role 'staff') gets 403; a store_admin of ANOTHER store gets
 * 403; a store_admin who is merely a staff member of this store (not the owner) gets 403; an unknown store is 404; a platform
 * super admin reads and the read is audited.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

const STORE = '11111111-1111-4111-8111-111111111111';
const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  audit: vi.fn(),
  memberships: new Set<string>(),
  rows: new Map<
    string,
    {
      id: string;
      role: string;
      status: string;
      tokenVersion: number;
      storeId: null;
      deletedAt: null;
    }
  >(),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    isJtiDenied: () => Promise.resolve(false),
    getUserTokenVersion: () => Promise.resolve(0),
    setUserTokenVersion: () => Promise.resolve(),
  },
}));
vi.mock('@api/lib/definer', () => ({ getUserState: async (id: string) => m.rows.get(id) ?? null }));
vi.mock('@api/lib/identity-client', () => ({
  getAccountState: async (id: string) => {
    const r = m.rows.get(id);
    return r ? { id, role: r.role, status: r.status } : null;
  },
  getAccountsBrief: async () => [],
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: m.audit,
  adminReadLimiter: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => false,
  gateRead: async () => ({ store: null, isStaff: false }),
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (tx: any) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          id: STORE,
          ownerId: 'owner-1',
          name: 'S',
          status: 'active',
          billingSuspendedReason: null,
        }),
      },
      storeStaff: {
        findUnique: async (a: any) =>
          m.memberships.has(a.where.userId_storeId.userId) ? { id: 'mem' } : null,
      },
    }),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ auditLog: { findMany: m.findMany } }),
}));

const keys = await generateKeyPair('ES256');
const pub: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };

async function token(sub: string, claims: Record<string, unknown> = {}) {
  return new SignJWT({ sid: `sid-${sub}`, email: `${sub}@example.com`, stores: [], ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setIssuer('https://accounts.ebda.app')
    .setAudience('store')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .setJti(crypto.randomUUID())
    .sign(keys.privateKey);
}

let app: Express;
beforeAll(async () => {
  const { configureAccountsVerifier, configureRevocationCheck } =
    await import('@api/lib/accounts-token');
  configureAccountsVerifier(async () => ({ keys: [pub] }));
  configureRevocationCheck(async () => false);
  const router = (await import('@api/routes/store-activity.routes')).default;
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores/:storeId/activity', router);
  app.use(errorHandler as any);
});

const user = (id: string, role: string) =>
  m.rows.set(id, { id, role, status: 'active', tokenVersion: 0, storeId: null, deletedAt: null });

beforeEach(() => {
  m.findMany.mockReset().mockResolvedValue([]);
  m.audit.mockReset().mockResolvedValue(undefined);
  m.memberships.clear();
  m.rows.clear();
  user('owner-1', 'store_admin');
  user('staff-1', 'staff');
  user('other-owner', 'store_admin');
  user('admin-who-is-staff', 'store_admin');
  user('root-1', 'store_admin'); // profile row; the platform role comes from the token's pa claim
});

const get = async (t: string, store = STORE) =>
  request(app).get(`/stores/${store}/activity`).set('Authorization', `Bearer ${t}`);

describe('A24 store activity access, real middleware', () => {
  it('the store owner reads (200)', async () => {
    const res = await get(await token('owner-1', { stores: [{ id: STORE, role: 'owner' }] }));
    expect(res.status).toBe(200);
    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('a staff member with a REAL membership of this store is refused 403 and nothing is read', async () => {
    m.memberships.add('staff-1');
    const res = await get(await token('staff-1', { stores: [{ id: STORE, role: 'staff' }] }));
    expect(res.status).toBe(403);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it('a store_admin of ANOTHER store is refused 403 (not the owner of this one)', async () => {
    const res = await get(await token('other-owner', { stores: [{ id: 'other', role: 'owner' }] }));
    expect(res.status).toBe(403);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it('a store_admin who is only a staff MEMBER of this store (owner of another) is refused 403', async () => {
    m.memberships.add('admin-who-is-staff');
    const res = await get(
      await token('admin-who-is-staff', {
        stores: [
          { id: 'other', role: 'owner' },
          { id: STORE, role: 'staff' },
        ],
      })
    );
    expect(res.status).toBe(403);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it('no token is 401', async () => {
    expect((await request(app).get(`/stores/${STORE}/activity`)).status).toBe(401);
  });

  it('a platform super admin reads, and the read is audited', async () => {
    const res = await get(
      await token('root-1', {
        stores: [],
        pa: 'super_admin',
        auth_time: Math.floor(Date.now() / 1000),
      })
    );
    expect(res.status).toBe(200);
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][0]).toMatchObject({
      action: 'STORE_ACTIVITY_VIEWED',
      storeId: STORE,
    });
  });
});
