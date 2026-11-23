// Merchant analytics reads on the real StoreDO schema (node:sqlite): the SQLite twins of the Postgres aggregates in
// apps/api/src/services/analytics.service.ts (Ruling NZ-INTEG-1).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';

const NON_REV = ['cancelled', 'refunded', 'awaiting_payment_confirmation'];
const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 5, 12); // Mon 2026-10-05 12:00 UTC

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(`
    INSERT INTO products (id, store_id, name, slug, price, inventory, status, track_inventory) VALUES
      ('p1','s1','Lamp','lamp',1000,3,'active',1),
      ('p2','s1','Vase','vase',2000,50,'active',1),
      ('p3','s1','Var','var',500,0,'active',1);
    UPDATE products SET has_variants = 1 WHERE id = 'p3';
    INSERT INTO product_variants (id, product_id, title, price, inventory, is_active) VALUES
      ('v1','p3','S',500,2,1), ('v2','p3','M',500,100,0);
    INSERT INTO product_images (id, product_id, url, position) VALUES ('i1','p1','https://x/p1.jpg',0);
  `);
  const order = (
    id: string,
    at: number,
    status: string,
    pay: string,
    total: number,
    customer: string | null,
    ship = '{}'
  ) =>
    raw
      .prepare(
        `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address, created_at, updated_at)
         VALUES (?, 's1', ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`
      )
      .run(id, customer, order.n++, status, pay, total, total, ship, at, at);
  order.n = 1;
  const item = (
    id: string,
    orderId: string,
    productId: string,
    qty: number,
    price: number,
    cost: number | null,
    source: string | null = null
  ) =>
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, cost_price, total, price_source)
         VALUES (?, ?, ?, 'n', ?, ?, ?, ?, ?)`
      )
      .run(id, orderId, productId, qty, price, cost, qty * price, source);
  const op = (name: string, args: Record<string, unknown>, store = 's1') =>
    runMoneyOp(db, store, name, args) as any;
  return { raw, op, order, item };
}

describe('registration', () => {
  it.each([
    'analyticsPeriod',
    'analyticsNetRevenue',
    'analyticsNetRevenueDays',
    'analyticsSales',
    'analyticsItems',
    'analyticsOrdersBy',
    'analyticsCustomers',
    'analyticsLowStock',
    'analyticsBuyerIdentities',
  ])('%s is a money op', n => expect(MONEY_OP_NAMES).toContain(n));
});

describe('analyticsPeriod', () => {
  it('counts the revenue population, distinct customer keys and the costed profit lines', () => {
    const { op, order, item } = rig();
    order('o1', T0, 'delivered', 'paid', 3000, 'u1');
    order('o2', T0 + H, 'delivered', 'paid', 1000, 'u1');
    order('o3', T0 + 2 * H, 'cancelled', 'paid', 9999, 'u2'); // not revenue
    order('o4', T0 + 3 * H, 'delivered', 'failed', 7777, 'u3'); // failed payment: not revenue
    order('o5', T0 + 4 * H, 'delivered', 'paid', 500, null, '{"email":"G@Example.com"}');
    order('o6', T0 + 5 * H, 'delivered', 'paid', 500, null, '{"email":"g@example.com"}'); // same guest
    order('o7', T0 - 10 * D, 'delivered', 'paid', 100, 'u9'); // outside the window
    item('a', 'o1', 'p1', 2, 1000, 400); // profit 1200
    item('b', 'o1', 'p2', 1, 1000, null); // no cost
    item('c', 'o3', 'p1', 5, 1000, 100); // cancelled order: excluded
    const r = op('analyticsPeriod', { startMs: T0 - D, endMs: T0 + D, nonRevenue: NON_REV });
    expect(r).toMatchObject({
      revenue: 3000 + 1000 + 500 + 500,
      orders: 4,
      profit: 1200,
      costedLines: 1,
      missingLines: 1,
      missingRevenue: 1000,
    });
    expect(
      op('analyticsPeriod', { startMs: T0 - D, endMs: T0 + D, nonRevenue: NON_REV }, 's2')
    ).toMatchObject({
      revenue: 0,
      orders: 0,
      profit: null,
    });
  });
});

describe('analyticsSales', () => {
  it('buckets by the viewer clock: day, Monday-based week, month', () => {
    const { op, order } = rig();
    // 22:30 UTC on Sun 2026-10-04 is already Mon 2026-10-05 in UTC+3
    const sunLate = Date.UTC(2026, 9, 4, 22, 30);
    order('a', sunLate, 'delivered', 'paid', 100, 'u1');
    order('b', T0, 'delivered', 'paid', 200, 'u1');
    order('c', T0 + 8 * D, 'delivered', 'paid', 300, 'u1');
    const base = { startMs: sunLate - D, endMs: T0 + 9 * D };
    const day0 = op('analyticsSales', { ...base, offsetMinutes: 0, granularity: 'day' });
    expect(day0.map((r: any) => r.key)).toEqual(['2026-10-04', '2026-10-05', '2026-10-13']);
    const day3 = op('analyticsSales', { ...base, offsetMinutes: 180, granularity: 'day' });
    expect(day3[0]).toEqual({ key: '2026-10-05', revenue: 300, orders: 2 });
    const week = op('analyticsSales', { ...base, offsetMinutes: 0, granularity: 'week' });
    expect(week.map((r: any) => r.key)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']); // Mondays
    expect(week[0]).toEqual({ key: '2026-09-28', revenue: 100, orders: 1 });
    const month = op('analyticsSales', { ...base, offsetMinutes: 0, granularity: 'month' });
    expect(month).toEqual([{ key: '2026-10', revenue: 600, orders: 3 }]);
  });
});

describe('analyticsItems, analyticsOrdersBy', () => {
  it('groups lines by product (top first, limited) and by price source', () => {
    const { op, order, item } = rig();
    order('o1', T0, 'delivered', 'paid', 1, 'u1');
    order('o2', T0, 'cancelled', 'paid', 1, 'u1');
    item('a', 'o1', 'p1', 2, 1000, null, 'group');
    item('b', 'o1', 'p2', 3, 1000, null, null);
    item('c', 'o2', 'p2', 9, 1000, null); // cancelled order
    const w = { startMs: T0 - D, endMs: T0 + D, nonRevenue: NON_REV };
    expect(op('analyticsItems', { ...w, by: 'product' })).toEqual([
      { productId: 'p2', quantity: 3, total: 3000 },
      { productId: 'p1', quantity: 2, total: 2000 },
    ]);
    expect(op('analyticsItems', { ...w, by: 'product', limit: 1 })).toHaveLength(1);
    const src = op('analyticsItems', { ...w, by: 'priceSource' });
    expect(src.find((r: any) => r.priceSource === 'group')).toMatchObject({
      quantity: 2,
      total: 2000,
    });
    expect(src.find((r: any) => r.priceSource === null)).toMatchObject({
      quantity: 3,
      total: 3000,
    });
    expect(() => op('analyticsItems', { ...w, by: 'x' })).toThrow();
  });

  it('counts orders by status (all) and by payment status (revenue statuses, failed included)', () => {
    const { op, order } = rig();
    order('o1', T0, 'delivered', 'paid', 1000, 'u1');
    order('o2', T0, 'cancelled', 'paid', 500, 'u1');
    order('o3', T0, 'delivered', 'failed', 300, 'u1');
    const w = { startMs: T0 - D, endMs: T0 + D };
    const st = op('analyticsOrdersBy', { ...w, by: 'status' });
    expect(Object.fromEntries(st.map((r: any) => [r.key, r.count]))).toEqual({
      delivered: 2,
      cancelled: 1,
    });
    const ps = op('analyticsOrdersBy', { ...w, by: 'paymentStatus', nonRevenue: NON_REV });
    expect(Object.fromEntries(ps.map((r: any) => [r.key, [r.count, r.total]]))).toEqual({
      paid: [1, 1000],
      failed: [1, 300],
    });
  });
});

describe('analyticsCustomers', () => {
  it('splits first-time and returning buyers and ranks top spenders', () => {
    const { op, order } = rig();
    order('e1', T0 - 30 * D, 'delivered', 'paid', 100, 'old');
    order('w1', T0, 'delivered', 'paid', 400, 'old'); // returning
    order('w2', T0, 'delivered', 'paid', 900, 'new'); // new
    order('w3', T0, 'delivered', 'paid', 100, 'new');
    const r = op('analyticsCustomers', { startMs: T0 - D, endMs: T0 + D, nonRevenue: NON_REV });
    expect(r.newCustomers).toBe(1);
    expect(r.returningCustomers).toBe(1);
    expect(r.top[0]).toEqual({ customerId: 'new', total: 1000, count: 2 });
    expect(r.top[1]).toEqual({ customerId: 'old', total: 500, count: 2 });
  });
});

describe('analyticsBuyerIdentities (QA98-ALIAS-1)', () => {
  it('returns (customer id, lowercased email, phone) buckets with order counts for both windows', () => {
    const { op, order } = rig();
    order('a1', T0, 'delivered', 'paid', 100, 'cust-1');
    order('a2', T0, 'delivered', 'paid', 100, 'cust-1');
    order('g1', T0, 'pending', 'paid', 100, null, '{"email":"Guest@X.eg","phone":"0100"}');
    order('g2', T0, 'pending', 'paid', 100, null, '{"email":"guest@x.eg","phone":"0100"}');
    order('p1', T0, 'pending', 'unpaid', 100, null, '{"phone":"+201000000001"}');
    const all = op('analyticsBuyerIdentities', {
      mode: 'all',
      startMs: T0 - D,
      endMs: T0 + D,
    }) as Array<{
      customerId: string | null;
      email: string | null;
      phone: string | null;
      n: number;
    }>;
    const by = (f: (r: (typeof all)[number]) => boolean) => all.find(f)?.n;
    expect(by(r => r.customerId === 'cust-1')).toBe(2);
    expect(by(r => r.email === 'guest@x.eg')).toBe(2);
    expect(by(r => r.phone === '+201000000001')).toBe(1);
    const paid = op('analyticsBuyerIdentities', { mode: 'paid', sinceMs: T0 - D }) as typeof all;
    expect(paid.find(r => r.phone === '+201000000001')).toBeUndefined(); // unpaid is not in the paid window
    expect(() => op('analyticsBuyerIdentities', { mode: 'nope' })).toThrow();
  });
});
