/**
 * Price-tier routes at the HTTP edge (B2B Task 4): Zod `.strict()` bodies (an unknown key, including any price-shaped one,
 * is a 400 and never reaches the service), integer-only bounds, the plan gate on writes only, and the guard chain.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  gateCalls: [] as string[],
  authorizeCalls: [] as string[][],
}));

vi.mock('@api/services/price-tier.service', () => ({ PriceTierService: m }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (...roles: string[]) =>
    (_req: any, _res: any, next: any) => {
      m.authorizeCalls.push(roles);
      next();
    },
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _r: any, n: any) => n(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: (key: string) => (_req: any, _res: any, next: any) => {
    m.gateCalls.push(`${key}`);
    next();
  },
}));

const S = '11111111-1111-1111-1111-111111111111';
const P = '22222222-2222-2222-2222-222222222222';
const T = '33333333-3333-3333-3333-333333333333';
const URL = `/stores/${S}/products/${P}/price-tiers`;
let app: express.Express;

beforeAll(async () => {
  const { default: router } = await import('@api/routes/price-tier.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', router);
  app.use(errorHandler);
});
beforeEach(() => {
  m.create.mockReset().mockResolvedValue({ tier: { id: T }, warnings: [] });
  m.update.mockReset().mockResolvedValue({ tier: { id: T }, warnings: [] });
  m.remove.mockReset().mockResolvedValue(undefined);
  m.list.mockReset().mockResolvedValue([]);
  m.gateCalls.length = 0;
});

describe('POST price-tiers', () => {
  it('accepts a valid body and forwards exactly the parsed fields', async () => {
    const res = await request(app).post(URL).send({ minQty: 10, priceMinor: 8000 });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith(S, P, { minQty: 10, priceMinor: 8000 });
    expect(m.gateCalls).toEqual(['b2b.wholesale']);
  });
  it.each([
    ['price', { minQty: 10, priceMinor: 8000, price: 1 }],
    ['unitPrice', { minQty: 10, priceMinor: 8000, unitPrice: 1 }],
    ['storeId', { minQty: 10, priceMinor: 8000, storeId: 'other' }],
    ['id', { minQty: 10, priceMinor: 8000, id: T }],
  ])('rejects an unknown key (%s) with 400 before the service', async (_n, body) => {
    const res = await request(app).post(URL).send(body);
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });
  it.each([
    ['minQty 1', { minQty: 1, priceMinor: 100 }],
    ['float minQty', { minQty: 2.5, priceMinor: 100 }],
    ['float price', { minQty: 5, priceMinor: 99.5 }],
    ['negative price', { minQty: 5, priceMinor: -1 }],
    ['price over Int4', { minQty: 5, priceMinor: 2_147_483_648 }],
    ['string price', { minQty: 5, priceMinor: '100' }],
    ['non-uuid variant', { minQty: 5, priceMinor: 100, variantId: 'x' }],
    ['missing price', { minQty: 5 }],
  ])('rejects %s with 400', async (_n, body) => {
    expect((await request(app).post(URL).send(body)).status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });
  it('accepts variantId / groupId uuids and nulls', async () => {
    const res = await request(app)
      .post(URL)
      .send({ minQty: 5, priceMinor: 100, variantId: T, groupId: null });
    expect(res.status).toBe(201);
    expect(m.create.mock.calls[0]![2]).toEqual({
      minQty: 5,
      priceMinor: 100,
      variantId: T,
      groupId: null,
    });
  });
});

describe('PUT / DELETE / GET', () => {
  it('PUT is strict, needs at least one field, and is plan-gated', async () => {
    expect((await request(app).put(`${URL}/${T}`).send({})).status).toBe(400);
    expect(
      (await request(app).put(`${URL}/${T}`).send({ priceMinor: 100, variantId: T })).status
    ).toBe(400);
    m.gateCalls.length = 0;
    const ok = await request(app).put(`${URL}/${T}`).send({ priceMinor: 100 });
    expect(ok.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(S, P, T, { priceMinor: 100 });
    expect(m.gateCalls).toEqual(['b2b.wholesale']);
  });
  it('GET and DELETE are NOT plan-gated (a downgraded merchant can still see and clean up their tiers)', async () => {
    expect((await request(app).get(URL)).status).toBe(200);
    expect((await request(app).delete(`${URL}/${T}`)).status).toBe(200);
    expect(m.gateCalls).toEqual([]);
  });
  it('every route requires store_admin / super_admin', async () => {
    expect(m.authorizeCalls.length).toBeGreaterThan(0);
    for (const roles of m.authorizeCalls) expect(roles).toEqual(['store_admin', 'super_admin']);
  });
});
