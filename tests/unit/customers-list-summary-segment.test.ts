/**
 * Customers list (audit 2026-09-30 §10): the store-wide KPI summary and the
 * server-side segment filter on `GET /stores/:storeId/customers`.
 *
 * Mounts the REAL router with the REAL aggregation (`getCached` is a
 * pass-through to the loader) over a mocked order/user/RFM set, so the
 * numbers asserted are the ones the page renders.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  orderFindMany: vi.fn(),
  userFindMany: vi.fn(),
  rfmFindMany: vi.fn(),
  caller: { role: 'store_admin' as string, userId: 'admin-a' },
}));

vi.mock('@force/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@force/database')>();
  return {
    ...actual,
    prisma: {
      order: { findMany: h.orderFindMany },
      user: { findMany: h.userFindMany, findUnique: vi.fn() },
      customerRfmSnapshot: { findMany: h.rfmFindMany },
      store: { findUnique: vi.fn() },
    },
  };
});
vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: h.caller.userId, role: h.caller.role };
      next();
    },
  };
});
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/lib/public-cache', () => ({
  getCached: (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
  customersCacheKey: (storeId: string) => `customers-agg:v2:${storeId}`,
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('exceljs', () => ({ default: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const STORE = '11111111-1111-4111-8111-111111111111';
let app: Express;

function order(
  id: string,
  customerId: string | null,
  total: number,
  status = 'delivered',
  email = `${customerId ?? id}@x.test`
) {
  return {
    id,
    orderNumber: `N-${id}`,
    total,
    status,
    paymentStatus: status === 'cancelled' ? 'unpaid' : 'paid',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    shippingAddress: { email, firstName: 'F', lastName: 'L' },
    payments: [],
    customer: customerId
      ? { id: customerId, email, firstName: 'F', lastName: 'L', phone: null }
      : null,
    items: [],
  };
}

beforeAll(async () => {
  const { default: customersRouter } = await import('@api/routes/customers.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId', customersRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.caller = { role: 'store_admin', userId: 'admin-a' };
  // u1: 3 orders (one cancelled → 2 counted, still a repeat buyer)
  // u2: 1 order · u3: only a refunded order (not a buyer) · guest: 1 order
  h.orderFindMany.mockResolvedValue([
    order('o1', 'u1', 10000),
    order('o2', 'u1', 20000),
    order('o3', 'u1', 99000, 'cancelled'),
    order('o4', 'u2', 6000),
    order('o5', 'u3', 50000, 'refunded'),
    order('o6', null, 4000, 'pending', 'guest@x.test'),
  ]);
  // u4: registered, zero orders.
  h.userFindMany.mockResolvedValue([
    { id: 'u4', email: 'u4@x.test', firstName: 'Z', lastName: 'O', phone: null },
  ]);
  h.rfmFindMany.mockResolvedValue([{ customerId: 'u1' }]);
});

describe('GET /customers — KPI summary', () => {
  it('counts only non-cancelled/refunded orders, store-wide', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?perPage=1`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.summary).toEqual({
      customers: 5,
      guests: 1,
      buyers: 3, // u1, u2, guest — u3 only has a refunded order
      repeatBuyers: 1, // u1
      repeatRate: 1 / 3,
      orders: 4,
      totalSpent: 40000,
      avgOrderValue: 10000,
    });
  });

  it('is unaffected by search, segment and page', async () => {
    const res = await request(app).get(
      `/api/v1/stores/${STORE}/customers?search=nomatch&segment=vip&page=3`
    );
    expect(res.body.data.meta.total).toBe(0);
    expect(res.body.data.meta.summary.customers).toBe(5);
  });

  it('reports unknown (null) rates rather than 0 when nobody has bought', async () => {
    h.orderFindMany.mockResolvedValue([]);
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers`);
    expect(res.body.data.meta.summary).toMatchObject({
      customers: 1,
      buyers: 0,
      repeatRate: null,
      avgOrderValue: null,
      totalSpent: 0,
    });
  });
});

describe('GET /customers?segment=', () => {
  it('filters to the RFM segment server-side, across the whole set', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=vip`);
    expect(h.rfmFindMany).toHaveBeenCalledWith({
      where: { storeId: STORE, isGuest: false, segment: 'vip' },
      select: { customerId: true },
    });
    expect(res.body.data.data.map((c: { id: string }) => c.id)).toEqual(['u1']);
    expect(res.body.data.meta.total).toBe(1);
  });

  it('segment=guest returns guest rows without an RFM query', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=guest`);
    expect(h.rfmFindMany).not.toHaveBeenCalled();
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].isGuest).toBe(true);
  });

  it('ignores an unknown segment (unfiltered list, no 400)', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=bogus`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.total).toBe(5);
    expect(h.rfmFindMany).not.toHaveBeenCalled();
  });

  it('refuses an RFM segment filter to staff (rfm-batch is admin-only)', async () => {
    h.caller = { role: 'staff', userId: 'staff-a' };
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=vip`);
    expect(res.status).toBe(403);
    expect(h.rfmFindMany).not.toHaveBeenCalled();
    // …but staff keep the plain list and the guest filter.
    h.caller = { role: 'staff', userId: 'staff-a' };
    const plain = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=guest`);
    expect(plain.status).toBe(200);
  });
});
