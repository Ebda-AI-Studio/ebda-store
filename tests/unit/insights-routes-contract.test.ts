/**
 * Insights routes return the contract the admin pages read.
 *
 * 1. GET /insights/products (Product Velocity). The page was built against
 *    unitsSold7d / unitsSold30d / velocityPerDay / avgSellingPriceFils /
 *    stockOnHand / costPriceFils, and the route returned none of them (it sent
 *    an all-time revenue ranking with the parent `inventory` column), so every
 *    column rendered blank or 0 (2026-09-30 audit, finding 2). The response is
 *    parsed here with the SAME Zod schema the page's types come from
 *    (`productVelocityResponseSchema`, @ebda/shared). Stock must be the
 *    variant-aware effective stock, never `products.inventory`
 *    (docs/architecture/inventory-model.md).
 *
 * 2. GET /insights/dashboard. `yesterdayFunnel.conversionRate` was read by the
 *    page but never existed (always 0.0%) — now derived as `cartToOrderRate`
 *    (ruling AN-5: `conversionRate` means view→order on /analytics); `repeatPurchaseRate` counted only
 *    registered customers (always 0% on guest-checkout stores) and was sent as
 *    an integer percent that the page multiplied by 100 again. Both are now a
 *    fraction, or null when unknowable — never a fabricated 0.
 *
 * Mutation proof: in insights.routes.ts replace `effectiveInventory(product)`
 * with `product.inventory` → the variant-stock assertion goes red.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { productVelocityResponseSchema } from '../../packages/shared/src/schemas/analytics';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    orderItem: { groupBy: vi.fn() },
    product: { findMany: vi.fn() },
    order: { aggregate: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    customerRfmSnapshot: { groupBy: vi.fn() },
    funnelSnapshot: { findFirst: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  currentStoreId: () => '11111111-1111-4111-8111-111111111111',
  RfmSegment: {
    vip: 'vip',
    loyal: 'loyal',
    potential: 'potential',
    new_customer: 'new_customer',
    at_risk: 'at_risk',
    hibernating: 'hibernating',
    lost: 'lost',
  },
}));

// the snapshot reads follow the store's backend (Ruling CF-JOBS-4); a Postgres store reads `prisma`
// the Postgres-store leg (storeMoney null): the DO leg is proven on workerd by workers-test/merchant-orders-do.test.ts
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => mockPrisma,
  storeMoney: async () => null,
}));
// REVENUE-DEF-1: the 30d / previous-30d revenue totals come from the shared net-revenue read (proven in revenue-definition.test.ts
// and packages/repo/test/do-analytics-reads.test.ts); these cases are about the derived rates, so the totals are zero here
vi.mock('@api/services/revenue.service', () => ({
  netRevenue: async () => ({ revenue: 0, orders: 0 }),
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_storeId: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
// Analytics-tier gate is proven in plan-gates.test.ts; pass-through here.
vi.mock('@api/middleware/analytics-tier', () => ({
  requireAnalyticsTier: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/accounting/insights-narration.service', () => ({
  generateInsightNarration: vi.fn(async () => null),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE = '11111111-1111-4111-8111-111111111111';
let app: Express;

beforeAll(async () => {
  const { default: router } = await import('@api/routes/insights.routes');
  app = express();
  app.use(express.json());
  app.use('/stores', router);
});

beforeEach(() => {
  for (const model of Object.values(mockPrisma)) {
    if (typeof model === 'function') {
      (model as ReturnType<typeof vi.fn>).mockReset(); // $queryRaw
      continue;
    }
    for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
});

describe('GET /insights/products — product velocity contract', () => {
  beforeEach(() => {
    mockPrisma.orderItem.groupBy
      // 1st call: 30-day ranking
      .mockResolvedValueOnce([
        { productId: 'p-variant', _sum: { quantity: 30, total: 30_000 } },
        { productId: 'p-untracked', _sum: { quantity: 3, total: 4_500 } },
        { productId: 'p-deleted', _sum: { quantity: 1, total: 900 } },
      ])
      // 2nd call: 7-day units for those products
      .mockResolvedValueOnce([{ productId: 'p-variant', _sum: { quantity: 7 } }]);
    mockPrisma.product.findMany.mockResolvedValue([
      {
        id: 'p-variant',
        name: 'Variant product',
        nameAr: 'منتج',
        sku: 'VAR-1',
        costPrice: 400,
        trackInventory: true,
        allowBackorder: false,
        // Parent column is unused for a variant product (held at 0).
        inventory: 0,
        variants: [
          { inventory: 5, allowBackorder: false, isActive: true },
          { inventory: 100, allowBackorder: false, isActive: false }, // disabled → not stock
          { inventory: 3, allowBackorder: false, isActive: true },
        ],
      },
      {
        id: 'p-untracked',
        name: 'Untracked',
        nameAr: null,
        sku: null,
        costPrice: null,
        trackInventory: false,
        allowBackorder: false,
        inventory: 0,
        variants: [],
      },
    ]);
  });

  it('matches the shared schema and computes every column the page reads', async () => {
    const res = await request(app).get(`/stores/${STORE}/insights/products?perPage=50`);
    expect(res.status).toBe(200);

    const body = productVelocityResponseSchema.parse(res.body.data);
    expect(body.windowDays).toBe(30);
    expect(body.products.map(p => p.productId)).toEqual(['p-variant', 'p-untracked', 'p-deleted']);

    const [variant, untracked, deleted] = body.products;
    expect(variant).toMatchObject({
      rank: 1,
      unitsSold7d: 7,
      unitsSold30d: 30,
      velocityPerDay: 1,
      avgSellingPriceFils: 1000,
      costPriceFils: 400,
    });
    // Effective stock = active variants only (5 + 3), not products.inventory.
    expect(variant.stockOnHand).toBe(8);

    // Untracked stock and a missing cost are UNKNOWN (null), not 0.
    expect(untracked).toMatchObject({ unitsSold7d: 0, stockOnHand: null, costPriceFils: null });
    expect(untracked.avgSellingPriceFils).toBe(1500);

    // A product deleted since it sold still ranks, with unknown details.
    expect(deleted).toMatchObject({ name: null, stockOnHand: null, costPriceFils: null });
  });

  it('ranks by 30-day units sold and asks Prisma for the variants', async () => {
    await request(app).get(`/stores/${STORE}/insights/products`);
    const rankingArgs = mockPrisma.orderItem.groupBy.mock.calls[0][0];
    expect(rankingArgs.orderBy[0]).toEqual({ _sum: { quantity: 'desc' } });
    expect(rankingArgs.where.order.createdAt.gte).toBeInstanceOf(Date);
    const select = mockPrisma.product.findMany.mock.calls[0][0].select;
    expect(select.variants).toBeDefined();
  });
});

describe('GET /insights/dashboard — derived rates', () => {
  function stubDashboard({
    funnel,
    orders,
  }: {
    funnel: Record<string, number> | null;
    orders: Array<{ customerId: string | null; shippingAddress: unknown }>;
  }) {
    mockPrisma.order.aggregate.mockResolvedValue({
      _avg: { total: 0 },
      _sum: { total: 0 },
      _count: 0,
    });
    mockPrisma.customerRfmSnapshot.groupBy.mockResolvedValue([]);
    mockPrisma.funnelSnapshot.findFirst.mockResolvedValue(funnel);
    mockPrisma.orderItem.groupBy.mockResolvedValue([]);
    mockPrisma.product.findMany.mockResolvedValue([]);
    // Issue 2260: the repeat rate is aggregated in Postgres now. The unit
    // harness answers the SQL with the JS reference (`computeRepeatPurchase`,
    // which the SQL mirrors key-for-key); the SQL itself is proven against a
    // real database in tests/integration/insights-product-velocity.test.ts.
    mockPrisma.$queryRaw.mockImplementation(async () => {
      const { computeRepeatPurchase } = await import('@api/routes/insights.routes');
      const r = computeRepeatPurchase(orders);
      return [
        {
          buyers: r.identifiedBuyers,
          repeat: Math.round((r.repeatPurchaseRate ?? 0) * r.identifiedBuyers),
        },
      ];
    });
    // Issue 2257: guestCheckout is the SAME any-guest-order probe the funnel
    // uses, over ALL orders in the window (paid or not).
    mockPrisma.order.findFirst.mockResolvedValue(
      orders.some(o => o.customerId === null) ? { id: 'guest-order' } : null
    );
    mockPrisma.order.findMany.mockResolvedValue([]);
  }

  it('derives cartToOrderRate = ordersCompleted / cartsCreated', async () => {
    stubDashboard({
      funnel: { cartsCreated: 40, checkoutsStarted: 0, ordersCompleted: 10 },
      orders: [],
    });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.data.yesterdayFunnel.cartToOrderRate).toBe(0.25);
    // Not called `conversionRate`: that name is the analytics view→order rate.
    expect(res.body.data.yesterdayFunnel).not.toHaveProperty('conversionRate');
  });

  it('cartToOrderRate is null (unknown), not 0, when no cart was created', async () => {
    stubDashboard({
      funnel: { cartsCreated: 0, checkoutsStarted: 0, ordersCompleted: 0 },
      orders: [],
    });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(res.body.data.yesterdayFunnel.cartToOrderRate).toBeNull();
  });

  it('counts guest buyers by customerKeyOf: a guest-only store gets a real repeat rate', async () => {
    stubDashboard({
      funnel: null,
      orders: [
        // Same email (case-folded), new phone → ONE buyer, exactly as the
        // Customers page and RFM group them (lib/customer-key.ts).
        { customerId: null, shippingAddress: { email: 'A@x.com', phone: '9651' } },
        { customerId: null, shippingAddress: { email: 'a@x.com', phone: '9999' } },
        { customerId: null, shippingAddress: { email: 'b@x.com', phone: '' } },
        { customerId: null, shippingAddress: {} }, // no contact → not a buyer
      ],
    });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    // 2 identifiable buyers, 1 of them ordered twice → 0.5 (a FRACTION).
    expect(res.body.data.repeatPurchaseRate).toBe(0.5);
    expect(res.body.data.repeatPurchaseBuyers).toBe(2);
  });

  it('flags guestCheckout when the 30d orders include a guest order', async () => {
    stubDashboard({
      funnel: { cartsCreated: 5, checkoutsStarted: 0, ordersCompleted: 2 },
      orders: [{ customerId: null, shippingAddress: { email: 'g@x.com' } }],
    });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(res.body.data.guestCheckout).toBe(true);
  });

  it('guestCheckout is false for a registered-only store', async () => {
    stubDashboard({
      funnel: null,
      orders: [{ customerId: 'c1', shippingAddress: {} }],
    });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(res.body.data.guestCheckout).toBe(false);
  });

  it('guestCheckout comes from the unpaid-inclusive guest probe — a COD-only guest store reads true (issue 2257)', async () => {
    stubDashboard({ funnel: null, orders: [] }); // no PAID orders at all
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'unpaid-cod-guest-order' });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(res.body.data.guestCheckout).toBe(true);
    const where = mockPrisma.order.findFirst.mock.calls.at(-1)?.[0].where;
    expect(where.customerId).toBeNull();
    expect(where).not.toHaveProperty('paymentStatus');
  });

  it('never loads the window orders into memory for the repeat rate (issue 2260)', async () => {
    stubDashboard({ funnel: null, orders: [{ customerId: 'c1', shippingAddress: {} }] });
    await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('repeatPurchaseRate is null (unknown) when no buyer is identifiable', async () => {
    stubDashboard({ funnel: null, orders: [{ customerId: null, shippingAddress: {} }] });
    const res = await request(app).get(`/stores/${STORE}/insights/dashboard`);
    expect(res.body.data.repeatPurchaseRate).toBeNull();
  });
});

describe('GET /insights/funnel — guest checkout flag', () => {
  it('reports guestCheckout from a guest-order probe over the same window', async () => {
    mockPrisma.funnelSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'guest-order' });
    const res = await request(app).get(`/stores/${STORE}/insights/funnel?window=30`);
    expect(res.status).toBe(200);
    expect(res.body.data.guestCheckout).toBe(true);
    const where = mockPrisma.order.findFirst.mock.calls[0][0].where;
    expect(where.customerId).toBeNull();
    const windowMs = Date.now() - where.createdAt.gte.getTime();
    expect(Math.round(windowMs / (24 * 60 * 60 * 1000))).toBe(30);
  });

  it('guestCheckout false when no guest order exists', async () => {
    mockPrisma.funnelSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.order.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/stores/${STORE}/insights/funnel?window=7`);
    expect(res.body.data.guestCheckout).toBe(false);
  });
});
