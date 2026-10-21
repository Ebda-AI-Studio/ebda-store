/**
 * Wholesale routes at the HTTP edge (B2B Task 5): the applicant is ALWAYS the signed-in customer (a body can never name another
 * user, Zod strict), guests are 401, merchant decisions are guarded and strict, impersonated apply is refused.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  apply: vi.fn(),
  status: vi.fn(),
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  revoke: vi.fn(),
  gates: [] as string[],
}));
vi.mock('@api/services/wholesale-application.service', () => ({ WholesaleApplicationService: m }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _r: any, n: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    n();
  },
  authorize: () => (_q: any, _r: any, n: any) => n(),
  optionalAuthenticate: (req: any, _r: any, n: any) => {
    const u = req.headers['x-test-user'];
    if (u)
      req.user = {
        userId: u,
        role: req.headers['x-test-role'] ?? 'customer',
        impersonatedBy: req.headers['x-test-imp'],
      };
    n();
  },
  customerUserId: (req: any) => (req.user?.role === 'customer' ? req.user.userId : undefined),
  rejectImpersonated: (req: any, res: any, n: any) =>
    req.user?.impersonatedBy
      ? res.status(403).json({ error: { code: 'IMPERSONATION_FORBIDDEN' } })
      : n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({ writeLimiter: (_q: any, _r: any, n: any) => n() }));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: (k: string) => (_q: any, _r: any, n: any) => {
    m.gates.push(k);
    n();
  },
}));
vi.mock('@api/utils/store-helpers', () => ({
  getStoreIdFromRequest: async () => S,
  getAuthUser: (req: any) => req.user,
}));

const S = '11111111-1111-1111-1111-111111111111';
const A = '22222222-2222-2222-2222-222222222222';
const G = '33333333-3333-3333-3333-333333333333';
let app: express.Express;

beforeAll(async () => {
  const { publicWholesaleRouter, merchantWholesaleRouter } =
    await import('@api/routes/wholesale.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/public', publicWholesaleRouter);
  app.use('/stores', merchantWholesaleRouter);
  app.use(errorHandler);
});
beforeEach(() => {
  for (const f of [m.apply, m.status, m.list, m.approve, m.reject, m.revoke])
    f.mockReset().mockResolvedValue({});
  m.gates.length = 0;
});

describe('shopper routes', () => {
  const body = { businessName: 'Cairo Traders', phone: '+201000000123' };
  it('apply: the applicant is the session user; a guest is 401; an impersonation session is refused', async () => {
    expect((await request(app).post('/public/wholesale/apply').send(body)).status).toBe(401);
    const ok = await request(app)
      .post('/public/wholesale/apply')
      .set('x-test-user', 'user-1')
      .send(body);
    expect(ok.status).toBe(201);
    expect(m.apply).toHaveBeenCalledWith(S, 'user-1', body);
    m.apply.mockClear();
    const imp = await request(app)
      .post('/public/wholesale/apply')
      .set('x-test-user', 'user-1')
      .set('x-test-imp', 'admin-9')
      .send(body);
    expect(imp.status).toBe(403);
    expect(m.apply).not.toHaveBeenCalled();
    // a merchant token is not a customer
    expect(
      (
        await request(app)
          .post('/public/wholesale/apply')
          .set('x-test-user', 'm1')
          .set('x-test-role', 'store_admin')
          .send(body)
      ).status
    ).toBe(401);
  });
  it.each([
    ['userId', { ...body, userId: A }],
    ['storeId', { ...body, storeId: A }],
    ['status', { ...body, status: 'approved' }],
    ['groupId', { ...body, groupId: G }],
    ['short name', { ...body, businessName: 'x' }],
    ['long notes', { ...body, notes: 'n'.repeat(1001) }],
  ])('apply rejects %s with 400 before the service', async (_n, b) => {
    const res = await request(app)
      .post('/public/wholesale/apply')
      .set('x-test-user', 'user-1')
      .send(b);
    expect(res.status).toBe(400);
    expect(m.apply).not.toHaveBeenCalled();
  });
  it("status is the caller's own, private/no-store, and 401 for a guest", async () => {
    expect((await request(app).get('/public/wholesale/status')).status).toBe(401);
    const res = await request(app).get('/public/wholesale/status').set('x-test-user', 'user-1');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(m.status).toHaveBeenCalledWith(S, 'user-1');
  });
});

describe('merchant routes', () => {
  const url = `/stores/${S}/wholesale-applications`;
  it('approve needs a uuid groupId, is strict, and is plan-gated; reject / revoke take an optional note', async () => {
    expect((await request(app).post(`${url}/${A}/approve`).send({})).status).toBe(400);
    expect((await request(app).post(`${url}/${A}/approve`).send({ groupId: 'x' })).status).toBe(
      400
    );
    expect(
      (await request(app).post(`${url}/${A}/approve`).send({ groupId: G, userId: A })).status
    ).toBe(400);
    m.gates.length = 0;
    expect((await request(app).post(`${url}/${A}/approve`).send({ groupId: G })).status).toBe(200);
    expect(m.approve).toHaveBeenCalledWith(S, A, G, 'admin-1');
    expect(m.gates).toEqual(['b2b.wholesale']);
    expect((await request(app).post(`${url}/${A}/reject`).send({ note: 'no' })).status).toBe(200);
    expect(m.reject).toHaveBeenCalledWith(S, A, 'no', 'admin-1');
    expect(
      (
        await request(app)
          .post(`${url}/${A}/revoke`)
          .send({ note: 'x'.repeat(501) })
      ).status
    ).toBe(400);
    expect((await request(app).post(`${url}/${A}/revoke`).send({})).status).toBe(200);
  });
  it('list validates status / limit / cursor', async () => {
    expect((await request(app).get(`${url}?status=bogus`)).status).toBe(400);
    expect((await request(app).get(`${url}?limit=1000`)).status).toBe(400);
    expect((await request(app).get(`${url}?status=pending&limit=10`)).status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(S, { status: 'pending', limit: 10 });
  });
});
