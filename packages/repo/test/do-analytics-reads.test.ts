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
    'analyticsSales',
    'analyticsItems',
    'analyticsOrdersBy',
    'analyticsCustomers',
    'analyticsLowStock',
    'analyticsRepeatBuyers',
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
      customers: 4, // u1, u2 (cancelled still counts as a customer), u3, one guest
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
      customers: 0,
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

describe('analyticsRepeatBuyers', () => {
  it('keys buyers like customerKeyOf (id, lowercased email, verbatim phone), paid orders in the window only', () => {
    const { op, order } = rig();
    order('a1', T0, 'delivered', 'paid', 100, 'cust-1');
    order('a2', T0, 'delivered', 'paid', 100, 'cust-1'); // repeat (registered)
    order('g1', T0, 'pending', 'paid', 100, null, '{"email":"Guest@X.eg"}');
    order('g2', T0, 'pending', 'paid', 100, null, '{"email":"guest@x.eg"}'); // repeat (email lowercased)
    order('p1', T0, 'pending', 'paid', 100, null, '{"phone":"+201000000001"}'); // one order only
    order('n1', T0, 'pending', 'paid', 100, null, '{"phone":123}'); // not a string: no key, skipped
    order('u1', T0, 'pending', 'failed', 100, 'cust-2'); // unpaid: not counted
    order('o1', T0 - 40 * D, 'delivered', 'paid', 100, 'cust-3'); // before the window
    expect(op('analyticsRepeatBuyers', { sinceMs: T0 - D })).toEqual({ repeat: 2, buyers: 3 });
    expect(op('analyticsRepeatBuyers', { sinceMs: T0 + D })).toEqual({ repeat: 0, buyers: 0 });
    expect(() => op('analyticsRepeatBuyers', {})).toThrow();
  });
});

describe('analyticsLowStock', () => {
  it('is variant-aware: active variants only, disabled ones are not stock', () => {
    const { op } = rig();
    const r = op('analyticsLowStock', { threshold: 10 });
    expect(r.map((x: any) => [x.id, x.inventory])).toEqual([
      ['p3', 2],
      ['p1', 3],
    ]);
    expect(r[1].imageUrl).toBe('https://x/p1.jpg');
    expect(op('analyticsLowStock', { threshold: 2 }).map((x: any) => x.id)).toEqual(['p3']);
    expect(op('analyticsLowStock', { threshold: 10 }, 's2')).toEqual([]);
  });
});

describe('analyticsStock', () => {
  it('values stock with the variant rule and totals the open backorders at cost', () => {
    const { raw, op } = rig();
    raw.exec('PRAGMA foreign_keys = OFF'); // the backorder rows point at order lines this test does not need
    raw.exec(`
      UPDATE products SET cost_price = 100 WHERE id IN ('p1','p2');
      UPDATE products SET cost_price = 50 WHERE id = 'p3';
      UPDATE product_variants SET cost_price = 70 WHERE id = 'v1';
      INSERT INTO backorder_lines (id, store_id, order_item_id, product_id, qty) VALUES ('b1','s1','x1','p1',4);
      INSERT INTO backorder_lines (id, store_id, order_item_id, product_id, qty, cancelled_at) VALUES ('b2','s1','x2','p1',9,1);
    `);
    // p1: 3 x 100, p2: 50 x 100, p3: only the ACTIVE variant v1: 2 x 70
    expect(op('analyticsStock', {})).toEqual({
      stockValue: 300 + 5000 + 140,
      backorderCount: 1,
      backorderValue: 400,
    });
    expect(op('analyticsStock', {}, 's2')).toEqual({
      stockValue: 0,
      backorderCount: 0,
      backorderValue: 0,
    });
  });
});

describe('analyticsCashflow', () => {
  it('sums debit minus credit of the cash accounts per UTC day, posted and reversed entries only', () => {
    const { raw, op } = rig();
    raw.exec(`
      INSERT INTO accounts (id, store_id, code, name_en, name_ar, type) VALUES
        ('a1','s1','1000','Cash','x','asset'), ('a2','s1','4000','Sales','x','revenue');
    `);
    const entry = (id: string, n: number, at: number, status: string) =>
      raw
        .prepare(
          "INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, status) VALUES (?, 's1', ?, ?, 'order', ?)"
        )
        .run(id, n, at, status);
    const line = (id: string, e: string, acct: string, debit: number, credit: number) =>
      raw
        .prepare(
          "INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, currency) VALUES (?, ?, ?, ?, ?, 'EGP')"
        )
        .run(id, e, acct, debit, credit);
    entry('e1', 1, T0, 'posted');
    line('l1', 'e1', 'a1', 1000, 0);
    line('l2', 'e1', 'a2', 0, 1000);
    entry('e2', 2, T0 + H, 'reversed');
    line('l3', 'e2', 'a1', 0, 300);
    entry('e3', 3, T0 + 2 * H, 'draft');
    line('l4', 'e3', 'a1', 5000, 0);
    entry('e4', 4, T0 + D, 'posted');
    line('l5', 'e4', 'a1', 200, 0);
    const day = Math.floor(T0 / D) * D;
    expect(op('analyticsCashflow', { fromMs: T0 - D, toMs: T0 + 2 * D })).toEqual([
      { dayMs: day, net: 700 },
      { dayMs: day + D, net: 200 },
    ]);
  });
});

// STORE-QA-7: a refunded order is not revenue (full refund excluded, partial refund netted), on every DO revenue read.
describe('refunds are not revenue (STORE-QA-7)', () => {
  const refund = (raw: any, id: string, orderId: string, amount: number, status = 'completed') =>
    raw
      .prepare(
        `INSERT INTO returns (id, store_id, order_id, customer_id, return_number, type, status, reason, refund_amount)
         VALUES (?, 's1', ?, 'u1', ?, 'return', ?, 'r', ?)`
      )
      .run(id, orderId, `R-${id}`, status, amount);
  const pay = (raw: any, id: string, orderId: string, refunded: number) =>
    raw
      .prepare(
        `INSERT INTO payments (id, order_id, provider, status, amount, refunded_amount) VALUES (?, ?, 'cod', 'completed', 5000, ?)`
      )
      .run(id, orderId, refunded);
  const win = { startMs: T0 - D, endMs: T0 + D, nonRevenue: NON_REV };

  it('a delivered order whose payment is refunded counts as 0 in every revenue read', () => {
    const { op, order, item } = rig();
    order('ok', T0, 'delivered', 'paid', 1000, 'u1');
    order('qa7', T0 + H, 'delivered', 'refunded', 4850, 'u2'); // the Amelia order: delivered + payment refunded
    item('a', 'ok', 'p1', 1, 1000, null);
    item('b', 'qa7', 'p2', 1, 4850, null);
    expect(op('analyticsPeriod', win)).toMatchObject({ revenue: 1000, orders: 1 });
    expect(
      op('analyticsSales', { ...win, offsetMinutes: 0, granularity: 'day' }).map(
        (r: any) => r.revenue
      )
    ).toEqual([1000]);
    expect(op('analyticsItems', { ...win, by: 'product' })).toEqual([
      { productId: 'p1', quantity: 1, total: 1000 },
    ]);
    expect(op('analyticsCustomers', win).top).toEqual([
      { customerId: 'u1', total: 1000, count: 1 },
    ]);
    expect(op('analyticsNetRevenue', {})).toEqual({ revenue: 1000, orders: 1 });
    expect(op('analyticsNetRevenue', { paidOnly: true })).toEqual({ revenue: 1000, orders: 1 });
  });

  it('a PARTIAL refund is netted: completed non-exchange returns count, pending/cancelled ones do not', () => {
    const { raw, op, order } = rig();
    order('o1', T0, 'delivered', 'paid', 5000, 'u1');
    refund(raw, 'r1', 'o1', 1200);
    refund(raw, 'r2', 'o1', 300);
    refund(raw, 'r3', 'o1', 9999, 'pending'); // not refunded yet
    refund(raw, 'r4', 'o1', 9999, 'cancelled');
    expect(op('analyticsPeriod', win)).toMatchObject({ revenue: 5000 - 1500, orders: 1 });
    expect(op('analyticsSales', { ...win, offsetMinutes: 0, granularity: 'day' })[0].revenue).toBe(
      3500
    );
    expect(op('analyticsCustomers', win).top[0].total).toBe(3500);
    expect(op('analyticsNetRevenue', { paidOnly: true }).revenue).toBe(3500);
  });

  it('one refund recorded on BOTH the return and the payment is subtracted once (GREATEST, not +)', () => {
    const { raw, op, order } = rig();
    order('o1', T0, 'delivered', 'paid', 5000, 'u1');
    refund(raw, 'r1', 'o1', 2000);
    pay(raw, 'p1', 'o1', 2000);
    expect(op('analyticsPeriod', win).revenue).toBe(3000);
  });

  it('a payment-only partial refund (provider dashboard) is netted; the refund is capped at the order total', () => {
    const { raw, op, order } = rig();
    order('o1', T0, 'delivered', 'paid', 5000, 'u1');
    pay(raw, 'p1', 'o1', 700);
    expect(op('analyticsPeriod', win).revenue).toBe(4300);
    pay(raw, 'p2', 'o1', 99999);
    expect(op('analyticsPeriod', win).revenue).toBe(0);
  });

  it('per-line revenue nets a partial refund pro rata and the lines add back to the order net (no piastre lost)', () => {
    const { raw, op, order, item } = rig();
    order('o1', T0, 'delivered', 'paid', 3000, 'u1');
    item('a', 'o1', 'p1', 1, 1000, null); // 1/3
    item('b', 'o1', 'p2', 1, 2000, null); // 2/3
    refund(raw, 'r1', 'o1', 1000);
    const by = Object.fromEntries(
      op('analyticsItems', { ...win, by: 'product' }).map((r: any) => [r.productId, r.total])
    );
    expect(by.p1 + by.p2).toBe(2000); // == the order net (analyticsPeriod)
    expect(op('analyticsPeriod', win).revenue).toBe(2000);
    expect(by).toEqual({ p1: 667, p2: 1333 });
    // price-source buckets use the same net lines
    const src = op('analyticsItems', { ...win, by: 'priceSource' });
    expect(src.reduce((n: number, r: any) => n + r.total, 0)).toBe(2000);
  });

  it('a fully refunded order has no line revenue; an unrefunded order is unchanged', () => {
    const { raw, op, order, item } = rig();
    order('o1', T0, 'delivered', 'paid', 1000, 'u1');
    item('a', 'o1', 'p1', 1, 1000, null);
    order('o2', T0 + H, 'delivered', 'paid', 500, 'u2');
    item('b', 'o2', 'p2', 1, 500, null);
    pay(raw, 'pm', 'o1', 99999);
    expect(op('analyticsItems', { ...win, by: 'product' })).toEqual([
      { productId: 'p2', quantity: 1, total: 500 }, // top first
      { productId: 'p1', quantity: 1, total: 0 }, // fully refunded: no line revenue
    ]);
  });

  it('gross mode (the GL reconciliation) keeps whole-order totals but still drops refunded/cancelled populations', () => {
    const { raw, op, order } = rig();
    order('o1', T0, 'delivered', 'paid', 5000, 'u1');
    refund(raw, 'r1', 'o1', 1500);
    order('o2', T0 + H, 'delivered', 'refunded', 700, 'u2');
    expect(op('analyticsNetRevenue', { paidOnly: true, gross: true })).toEqual({
      revenue: 5000,
      orders: 1,
    });
    expect(op('analyticsNetRevenue', { paidOnly: true })).toEqual({ revenue: 3500, orders: 1 });
  });

  it('line allocation never goes negative: refund > line sum (shipping in the refund) leaves every line at 0', () => {
    const { raw, op, order, item } = rig();
    // total 4910 = lines 4850 + 60 shipping; the full 4910 is recorded on the payment while payment_status is still 'paid'
    order('o1', T0, 'delivered', 'paid', 4910, 'u1');
    item('a', 'o1', 'p1', 1, 1850, null);
    item('b', 'o1', 'p2', 1, 3000, null);
    pay(raw, 'pm', 'o1', 4910);
    const rows = op('analyticsItems', { ...win, by: 'product' });
    expect(rows.map((r: any) => r.total)).toEqual([0, 0]);
    expect(
      op('analyticsItems', { ...win, by: 'priceSource' }).reduce(
        (n: number, r: any) => n + r.total,
        0
      )
    ).toBe(0);
  });

  it('refund exactly equal to the line sum leaves every line at 0', () => {
    const { raw, op, order, item } = rig();
    order('o1', T0, 'delivered', 'paid', 4850, 'u1');
    item('a', 'o1', 'p1', 1, 1850, null);
    item('b', 'o1', 'p2', 1, 3000, null);
    refund(raw, 'r1', 'o1', 4850);
    expect(op('analyticsItems', { ...win, by: 'product' }).map((r: any) => r.total)).toEqual([
      0, 0,
    ]);
  });

  it('STORE-QA-54: one unpaid COD + one paid: sales surfaces count both, paid surfaces count the paid one only', () => {
    const { op, order } = rig();
    order('paid', T0, 'delivered', 'paid', 4850, 'u1');
    order('cod', T0 + H, 'pending', 'unpaid', 4910, 'u2'); // pending unpaid COD
    // "sales" (analytics KPI, chart): base definition, unpaid COD included
    expect(op('analyticsPeriod', win)).toMatchObject({ revenue: 9760, orders: 2 });
    expect(op('analyticsNetRevenue', {})).toEqual({ revenue: 9760, orders: 2 });
    // "paid" / cash surfaces (rollups, usage snapshot, insights, platform dashboards): paidOnly
    expect(op('analyticsNetRevenue', { paidOnly: true })).toEqual({ revenue: 4850, orders: 1 });
  });
});
