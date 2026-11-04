/**
 * Ruling NZ-INTEG-1: the merchant analytics aggregates of a store on its Durable Object come from the DO ops and the store's
 * backend reads; Postgres THROWS if any of them reaches it. Shaping (names, percentages, zero-filled buckets) is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
    extra: {
      currentStoreId: () => STORE,
      Prisma: { sql: () => ({}), empty: {}, join: () => ({}) },
    },
  })
);
vi.mock('@api/services/redis.service', () => ({
  redis: { getClient: () => null, isAvailable: () => false },
}));
vi.mock('@api/lib/customer-directory', () => ({
  customerRows: async (_s: string, ids: string[]) =>
    ids.map(id => ({ id, email: `${id}@x.com`, firstName: 'Ann', lastName: id })),
}));
const money = {
  analyticsPeriod: async (a: unknown) => (
    h.calls.push(['period', a]),
    {
      revenue: 5000,
      orders: 3,
      customers: 2,
      profit: 700,
      costedLines: 2,
      missingLines: 0,
      missingRevenue: 0,
    }
  ),
  analyticsSales: async () => [{ key: '2026-10-05', revenue: 900, orders: 2 }],
  analyticsItems: async (a: { by: string }) =>
    a.by === 'priceSource'
      ? [
          { priceSource: null, priceGroupApplied: null, quantity: 3, total: 3000 },
          { priceSource: 'tier', priceGroupApplied: false, quantity: 1, total: 1000 },
        ]
      : [
          { productId: 'p1', quantity: 4, total: 4000 },
          { productId: 'p2', quantity: 1, total: 1000 },
        ],
  analyticsOrdersBy: async (a: { by: string }) =>
    a.by === 'status'
      ? [
          { key: 'delivered', count: 3, total: 0 },
          { key: 'cancelled', count: 1, total: 0 },
        ]
      : [{ key: 'paid', count: 2, total: 800 }],
  analyticsCustomers: async () => ({
    newCustomers: 1,
    returningCustomers: 2,
    top: [
      { customerId: 'u1', total: 900, count: 3 },
      { customerId: null, total: 100, count: 1 },
    ],
  }),
  analyticsLowStock: async () => [
    { id: 'p1', name: 'Lamp', slug: 'lamp', sku: null, inventory: 3, imageUrl: 'https://x/a.jpg' },
    { id: 'p2', name: 'Vase', slug: 'vase', sku: 'V', inventory: 1, imageUrl: null },
  ],
};
const db = {
  product: {
    findMany: async () => [
      { id: 'p1', name: 'Lamp', nameAr: null, slug: 'lamp', images: [{ url: 'https://x/a.jpg' }] },
    ],
  },
  productCategory: {
    findMany: async () => [
      { productId: 'p1', categoryId: 'c1', category: { id: 'c1', name: 'Home', slug: 'home' } },
      { productId: 'p2', categoryId: 'c1', category: { id: 'c1', name: 'Home', slug: 'home' } },
    ],
  },
  order: {
    findMany: async () => [{ id: 'o1', customerId: 'u1', items: [] }],
  },
};
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async () => money,
  storeDb: async () => db,
}));

import { AnalyticsService } from '@api/services/analytics.service';

const range = {
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-31T00:00:00Z'),
};
beforeEach(() => {
  h.calls.length = 0;
});

describe('AnalyticsService on a DO store (Postgres throws)', () => {
  it('distinct customers and the period figures', async () => {
    expect(
      await AnalyticsService.countDistinctCustomers(STORE, range.startDate, range.endDate)
    ).toBe(2);
    expect(h.calls[0][1]).toMatchObject({
      startMs: range.startDate.getTime(),
      nonRevenue: expect.any(Array),
    });
  });

  it('sales chart zero-fills the buckets around the DO rows', async () => {
    const r = await AnalyticsService.getSalesChart(STORE, undefined, range, 0);
    expect(r.granularity).toBe('day');
    expect(r.sales.find(s => s.date === '2026-10-05')).toEqual({
      date: '2026-10-05',
      revenue: 900,
      orders: 2,
    });
    expect(r.sales.find(s => s.date === '2026-10-06')).toEqual({
      date: '2026-10-06',
      revenue: 0,
      orders: 0,
    });
  });

  it('top products, top categories and the price-source split', async () => {
    const top = await AnalyticsService.getTopProducts(STORE, 10, range);
    expect(top).toEqual([
      expect.objectContaining({ id: 'p1', revenue: 4000, quantity: 4, image: 'https://x/a.jpg' }),
    ]);
    const cats = await AnalyticsService.getTopCategories(STORE, 5, range);
    expect(cats).toEqual([
      { id: 'c1', name: 'Home', slug: 'home', revenue: 5000, productCount: 2 },
    ]);
    const src = await AnalyticsService.getRevenueByPriceSource(STORE, range);
    expect(src.retail).toEqual({ revenue: 3000, units: 3 });
    expect(src.wholesale).toEqual({ revenue: 1000, units: 1 });
    expect(src.wholesaleSharePercent).toBe(25);
  });

  it('orders by status and revenue by payment status', async () => {
    expect(await AnalyticsService.getOrdersByStatus(STORE, range)).toEqual([
      { status: 'delivered', count: 3, percentage: 75 },
      { status: 'cancelled', count: 1, percentage: 25 },
    ]);
    expect(await AnalyticsService.getRevenueByPaymentStatus(STORE, range)).toEqual([
      { status: 'paid', revenue: 800, orders: 2, percentage: 100 },
    ]);
  });

  it('customer stats: counts from the DO, names from the customer directory, unknown buyers dropped', async () => {
    const r = await AnalyticsService.getCustomerStats(STORE, range);
    expect(r.newCustomers).toBe(1);
    expect(r.returningCustomers).toBe(2);
    expect(r.topCustomers).toEqual([
      { id: 'u1', name: 'Ann u1', email: 'u1@x.com', totalSpent: 900, orderCount: 3 },
    ]);
  });

  it('recent orders attach the buyer from the directory; low stock keeps the card shape', async () => {
    const orders = await AnalyticsService.getRecentOrders(STORE, 5);
    expect(orders[0]).toMatchObject({
      id: 'o1',
      customer: { firstName: 'Ann', email: 'u1@x.com' },
    });
    const low = await AnalyticsService.getLowStockProducts(STORE, 10);
    expect(low[0]).toEqual({
      id: 'p1',
      name: 'Lamp',
      slug: 'lamp',
      sku: null,
      inventory: 3,
      images: [{ url: 'https://x/a.jpg' }],
    });
    expect(low[1].images).toEqual([]);
  });
});
