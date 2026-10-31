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
  rfmGroupBy: vi.fn(),
  // the SQL customer match behind `?search=` (Search P2: matchingCustomers, a store-scoped definer)
  matching: vi.fn(),
  // The store's snapshot rows; the two mocks below query them faithfully.
  rfmRows: [] as Array<{ customerId: string; segment: string }>,
  caller: { role: 'store_admin' as string, userId: 'admin-a' },
}));

vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...actual,
    currentStoreId: () => '11111111-1111-4111-8111-111111111111',
    prisma: {
      order: { findMany: h.orderFindMany },
      user: { findMany: h.userFindMany, findUnique: vi.fn() },
      customerRfmSnapshot: { findMany: h.rfmFindMany, groupBy: h.rfmGroupBy },
      store: { findUnique: vi.fn() },
      smsMarketingConsent: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
});
// the RFM snapshot reads follow the store's backend (Ruling CF-JOBS-4); a Postgres store reads the same mocks
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    customerRfmSnapshot: { findMany: h.rfmFindMany, groupBy: h.rfmGroupBy },
  }),
}));
vi.mock('@api/services/admin-search.service', () => ({
  matchingCustomers: (...a: unknown[]) => h.matching(...a),
}));
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
  customersCacheKey: (storeId: string) => `customers-agg:v4:${storeId}`,
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('exceljs', () => ({ default: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const STORE = '11111111-1111-4111-8111-111111111111';
// The RFM key the rollup stores for the guest row below — computed with the
// SAME helper, so this test fails if the list and the rollup ever key guests
// differently again (analytics audit 2026-09-30 §4).
import { rfmKeyFor } from '@api/lib/customer-key';
import { MAX_ZERO_ORDER_CUSTOMERS } from '@api/services/customer-aggregate.service';
const GUEST_RFM_KEY = rfmKeyFor('guest@x.test', true);
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

/** An order mock that honours the search scope (`where.OR` of customer ids / order ids). */
function scopedOrders(rows: any[]) {
  return async (args?: { where?: { OR?: any[] } }) => {
    const or = args?.where?.OR;
    if (!or) return rows;
    const users: string[] = or[0]?.customerId?.in ?? [];
    const orders: string[] = or[1]?.id?.in ?? [];
    return rows.filter(o => users.includes(o.customer?.id) || orders.includes(o.id));
  };
}
const noMatches = {
  userIds: [] as string[],
  guestOrderIds: [] as string[],
  truncated: false,
  usersTruncated: false,
  guestsTruncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.matching.mockResolvedValue(noMatches);
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
  h.rfmRows = [
    { customerId: 'u1', segment: 'vip' },
    { customerId: GUEST_RFM_KEY, segment: 'at_risk' },
  ];
  h.rfmFindMany.mockImplementation(
    async ({ where }: { where: { segment?: string; customerId?: { in: string[] } } }) =>
      h.rfmRows.filter(
        r =>
          (where.segment === undefined || r.segment === where.segment) &&
          (where.customerId === undefined || where.customerId.in.includes(r.customerId))
      )
  );
  h.rfmGroupBy.mockImplementation(async () =>
    Array.from(new Set(h.rfmRows.map(r => r.segment))).map(segment => ({ segment }))
  );
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

  // issue 2235 (owner 2026-10-01, ruling AUI-1a): a FAILED payment is not
  // spend; an unpaid COD order (payment not failed) still is. Mutation-proof:
  // dropping the paymentStatus check from countsTowardSpend reddens this.
  it('excludes failed-payment orders but still counts unpaid COD', async () => {
    h.orderFindMany.mockResolvedValue([
      { ...order('p1', 'u1', 10000), paymentStatus: 'failed' },
      { ...order('p2', 'u1', 10000), paymentStatus: 'failed' },
      { ...order('p3', 'u2', 7000, 'pending'), paymentStatus: 'unpaid' }, // COD, not delivered
    ]);
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?perPage=1`);
    expect(res.body.data.meta.summary).toMatchObject({
      buyers: 1, // only u2 — u1's two failed attempts are not purchases
      repeatBuyers: 0,
      orders: 1,
      totalSpent: 7000,
    });
  });

  it('is unaffected by search, segment and page', async () => {
    h.orderFindMany.mockImplementation(scopedOrders(await h.orderFindMany({})));
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
    // Issue 2243: the filter reads that segment's members only — never the
    // store's whole snapshot table.
    expect(h.rfmFindMany).toHaveBeenCalledWith({
      where: { storeId: STORE, segment: 'vip' },
      select: { customerId: true },
    });
    for (const [args] of h.rfmFindMany.mock.calls) {
      expect(args.where.segment ?? args.where.customerId).toBeDefined();
    }
    expect(res.body.data.data.map((c: { id: string }) => c.id)).toEqual(['u1']);
    expect(res.body.data.meta.total).toBe(1);
  });

  it('resolves a GUEST segment member to its Customers-page row (shared key)', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=at_risk`);
    expect(res.status).toBe(200);
    expect(res.body.data.data.map((c: { id: string }) => c.id)).toEqual(['guest@x.test']);
    expect(res.body.data.data[0].segment).toBe('at_risk');
  });

  it('a snapshot keyed the pre-2026-09-30 way (hash of email:phone) matches nothing', async () => {
    const { createHash } = await import('node:crypto');
    const legacy = `GUEST:${createHash('sha256').update('guest@x.test:').digest('hex')}`;
    h.rfmRows = [{ customerId: legacy, segment: 'lost' }];
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=lost`);
    expect(res.body.data.meta.total).toBe(0);
  });

  it('attaches each row its segment and lists the segments present', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?perPage=100`);
    const byId = Object.fromEntries(
      res.body.data.data.map((c: { id: string; segment: string | null }) => [c.id, c.segment])
    );
    expect(byId).toMatchObject({ u1: 'vip', 'guest@x.test': 'at_risk', u2: null });
    expect(res.body.data.meta.segments).toEqual(['vip', 'at_risk']);
  });

  it('segment=guest returns guest rows only', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=guest`);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].isGuest).toBe(true);
  });

  it('ignores an unknown segment (unfiltered list, no 400)', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=bogus`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.total).toBe(5);
  });

  it('refuses an RFM segment filter to staff, and never sends staff segments', async () => {
    h.caller = { role: 'staff', userId: 'staff-a' };
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=vip`);
    expect(res.status).toBe(403);
    // …but staff keep the plain list and the guest filter, with no segments.
    const plain = await request(app).get(`/api/v1/stores/${STORE}/customers?segment=guest`);
    expect(plain.status).toBe(200);
    expect(h.rfmFindMany).not.toHaveBeenCalled();
    expect(plain.body.data.meta.segments).toBeUndefined();
    expect(plain.body.data.data[0]).not.toHaveProperty('segment');
  });
});

describe('zero-order union (issue 2051)', () => {
  it('does not add a phantom zero-order row for a user who checked out as a guest', async () => {
    // u5 has an account but only a guest-checkout order under the same email.
    h.orderFindMany.mockResolvedValue([order('o9', null, 5000, 'delivered', 'u5@x.test')]);
    h.userFindMany.mockResolvedValue([
      { id: 'u5', email: 'U5@x.test', firstName: 'F', lastName: 'L', phone: null },
    ]);
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers`);
    expect(res.body.data.data.map((c: { id: string }) => c.id)).toEqual(['u5@x.test']);
  });

  // Issue 2045: the exclusion is a NOT EXISTS on the user's own orders — exact
  // whatever the order scan's cap, and no id list at all (it used to be an
  // up-to-20k-element NOT IN), plus a bounded `take`.
  it('selects zero-order users exactly (NOT EXISTS), bounded, with no id list', async () => {
    await request(app).get(`/api/v1/stores/${STORE}/customers`);
    const args = h.userFindMany.mock.calls[0][0];
    expect(args.where.id).toBeUndefined();
    expect(args.where.orders).toEqual({ none: { storeId: STORE, deletedAt: null } });
    expect(args.take).toBe(MAX_ZERO_ORDER_CUSTOMERS + 1);
  });

  it('reports a capped zero-order union through meta.truncated, never silently', async () => {
    h.orderFindMany.mockResolvedValue([]);
    h.userFindMany.mockResolvedValue(
      Array.from({ length: MAX_ZERO_ORDER_CUSTOMERS + 1 }, (_, i) => ({
        id: `z${i}`,
        email: `z${i}@x.test`,
        firstName: 'Z',
        lastName: `${i}`,
        phone: null,
      }))
    );
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers`);
    expect(res.body.data.meta.truncated).toBe(true);
    expect(res.body.data.meta.total).toBe(MAX_ZERO_ORDER_CUSTOMERS);
  });

  it('still unions zero-order users when the ORDER scan was truncated (the query is exact)', async () => {
    // 20,001 rows = the scan cap + 1, so `ordersTruncated` is true.
    h.orderFindMany.mockResolvedValue(
      Array.from({ length: 20001 }, (_, i) =>
        order(`o${i}`, null, 100, 'delivered', `g${i}@x.test`)
      )
    );
    h.userFindMany.mockResolvedValue([
      { id: 'z1', email: 'z1@x.test', firstName: 'Z', lastName: '1', phone: null },
    ]);
    h.orderFindMany.mockImplementation(scopedOrders(await h.orderFindMany({})));
    h.matching.mockResolvedValue({ ...noMatches, userIds: ['z1'] });
    const res = await request(app).get(`/api/v1/stores/${STORE}/customers?search=z1@x.test`);
    expect(h.matching).toHaveBeenCalledWith(STORE, 'z1@x.test');
    expect(res.body.data.meta.truncated).toBe(true);
    expect(res.body.data.data.map((c: { id: string }) => c.id)).toContain('z1');
  });
});

describe('GET /customers — segment reads are bounded (issue 2243)', () => {
  it('reads per-row segments for the returned page only', async () => {
    await request(app).get(`/api/v1/stores/${STORE}/customers?perPage=1`);
    const pageRead = h.rfmFindMany.mock.calls.find(([a]) => a.where.customerId);
    expect(pageRead?.[0].where.customerId.in).toHaveLength(1);
    // No unbounded read of every snapshot in the store.
    for (const [args] of h.rfmFindMany.mock.calls) {
      expect(args.where.segment ?? args.where.customerId).toBeDefined();
    }
  });
});
