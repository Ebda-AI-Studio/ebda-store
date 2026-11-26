// Top customers by NET sales run through the store's own backend (storeDb), never raw SQL on public.orders: Postgres is not
// reachable from the Worker for a Durable Object store (POSTGRES_REMOVED). REVENUE-DEF-1.
// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { topCustomersNet, refundedMinorByOrder } from '@api/lib/order-refunds';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

function fakeDb(orders, returns = [], payments = []) {
  const calls = { returnWhere: [] as unknown[] };
  return {
    calls,
    order: {
      findMany: vi.fn(async ({ where, take, cursor, skip }) => {
        const pool = orders
          .filter(o => !where.status.notIn.includes(o.status))
          .filter(o => !where.paymentStatus.notIn.includes(o.paymentStatus))
          .sort((a, b) => a.id.localeCompare(b.id));
        const i = cursor ? pool.findIndex(o => o.id === cursor.id) + (skip ?? 0) : 0;
        return pool.slice(i, i + take);
      }),
    },
    return: {
      groupBy: vi.fn(async ({ where }) => {
        calls.returnWhere.push(where);
        return returns
          .filter(r => where.orderId.in.includes(r.orderId) && where.storeId === 's1')
          .map(r => ({ orderId: r.orderId, _sum: { refundAmount: r.refundAmount } }));
      }),
    },
    payment: {
      groupBy: vi.fn(async ({ where }) =>
        payments
          .filter(p => where.orderId.in.includes(p.orderId))
          .map(p => ({ orderId: p.orderId, _sum: { refundedAmount: p.refundedAmount } }))
      ),
    },
  };
}
const o = (
  id,
  customerId,
  total,
  status = 'delivered',
  paymentStatus = 'paid',
  providers = []
) => ({
  id,
  customerId,
  total,
  status,
  paymentStatus,
  payments: providers.map((provider, i) => ({
    id: `p${i}`,
    provider,
    createdAt: new Date(2026, 10, 1, 0, i),
  })),
});

describe('topCustomersNet', () => {
  it('nets refunds, drops refunded / abandoned-online orders, keeps unpaid COD, ranks by net', async () => {
    const db = fakeDb(
      [
        o('a', 'u1', 5000), // 5000
        o('b', 'u1', 3000), // partial refund 1000 -> 2000
        o('c', 'u2', 4850, 'delivered', 'refunded'), // QA-7: excluded by the query
        o('d', 'u2', 4910, 'pending', 'unpaid', ['paymob']), // abandoned card checkout: 0 and not an order
        o('e', 'u2', 900, 'pending', 'unpaid', ['cod']), // unpaid COD counts
        o('f', 'u3', 100, 'cancelled'), // excluded by the query
        o('g', 'u4', 600, 'pending', 'unpaid', ['paymob', 'cod']), // card failed, then COD: latest is COD -> counts
      ],
      [{ orderId: 'b', refundAmount: 1000 }]
    );
    const top = await topCustomersNet(db, 's1', 10, 2); // page size 2 exercises the keyset loop
    expect(top).toEqual([
      { customerId: 'u1', _sum: { total: 7000 }, _count: 2 },
      { customerId: 'u2', _sum: { total: 900 }, _count: 1 },
      { customerId: 'u4', _sum: { total: 600 }, _count: 1 },
    ]);
    expect(db.order.findMany.mock.calls.length).toBeGreaterThan(1);
  });

  it('limits to the top N', async () => {
    const db = fakeDb([o('a', 'u1', 300), o('b', 'u2', 200), o('c', 'u3', 100)]);
    expect((await topCustomersNet(db, 's1', 2)).map(r => r.customerId)).toEqual(['u1', 'u2']);
  });
});

describe('refundedMinorByOrder tenant guard (R-EBDA-003)', () => {
  it('scopes the returns read by storeId and takes the larger of returns vs payment refunds', async () => {
    const db = fakeDb(
      [],
      [{ orderId: 'x', refundAmount: 500 }],
      [{ orderId: 'x', refundedAmount: 800 }]
    );
    expect((await refundedMinorByOrder(db, 's1', ['x'])).get('x')).toBe(800);
    expect(db.calls.returnWhere[0]).toMatchObject({ storeId: 's1' });
    // another store's return of the same order id is not read
    const other = fakeDb([], [{ orderId: 'x', refundAmount: 500 }]);
    expect((await refundedMinorByOrder(other, 's2', ['x'])).get('x')).toBeUndefined();
  });
});

describe('the top-customers fallback is not raw SQL on public.orders', () => {
  it('analytics.service getCustomerStats uses topCustomersNet(odb, ...) for the non-money backend', () => {
    const src = read('apps/api/src/services/analytics.service.ts');
    expect(src).toContain('topCustomersNet(odb, storeId, 10)');
    expect(src).not.toMatch(/SELECT o\.customer_id, COALESCE\(SUM/);
  });
});
