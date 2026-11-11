// taxReportLines on the real StoreDO schema (node:sqlite): the SQLite twin of the raw query in
// apps/api/src/services/accounting/tax-report.service.ts (Ruling NZ-ACCT-1).
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
      .run(id, customer, String(order.n++), status, pay, total, total, ship, at, at);
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

function books() {
  const r = rig();
  r.raw.exec(`
    INSERT INTO accounts (id, store_id, code, name_en, name_ar, type) VALUES
      ('a-tax','s1','2100','Tax','x','liability'), ('a-rev','s1','4000','Sales','x','revenue'),
      ('a-cash','s1','1000','Cash','x','asset'),
      ('x-tax','s2','2100','Tax','x','liability'), ('x-rev','s2','4000','Sales','x','revenue');
    INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('c1','s1','Mona','Ali','u-mona');
  `);
  let n = 0;
  const entry = (
    id: string,
    at: number,
    sourceId: string,
    status = 'posted',
    source = 'order',
    store = 's1'
  ) =>
    r.raw
      .prepare(
        'INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, store, `${store}-${++n}`, at, source, sourceId, status);
  const line = (id: string, e: string, acct: string, debit: number, credit: number) =>
    r.raw
      .prepare(
        "INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, currency) VALUES (?, ?, ?, ?, ?, 'EGP')"
      )
      .run(id, e, acct, debit, credit);
  return { ...r, entry, line };
}

const WIN = { fromMs: T0 - D, toMs: T0 + D };

describe('taxReportLines', () => {
  it('is registered as a read op', () => {
    expect(MONEY_OP_NAMES).toContain('taxReportLines');
  });

  it('returns a sale row: tax 2100, base 4000, order total, customer by user id', () => {
    const { op, order, entry, line } = books();
    order('o1', T0, 'delivered', 'paid', 1140, 'u-mona');
    entry('e1', T0, 'o1');
    line('l1', 'e1', 'a-tax', 0, 140);
    line('l2', 'e1', 'a-rev', 0, 1000);
    line('l3', 'e1', 'a-cash', 1140, 0);
    expect(op('taxReportLines', WIN)).toEqual([
      {
        postedAtMs: T0,
        orderNumber: '1',
        customerName: 'Mona Ali',
        taxDelta: 140,
        baseDelta: 1000,
        orderTotal: 1140,
        isSale: true,
      },
    ]);
  });

  it('reversal and partial-return entries (source_id o1:suffix) join the same order, as negative non-sale rows', () => {
    const { op, order, entry, line } = books();
    order('o1', T0, 'delivered', 'paid', 1140, null);
    entry('e1', T0, 'o1', 'reversed');
    line('l1', 'e1', 'a-tax', 0, 140);
    line('l2', 'e1', 'a-rev', 0, 1000);
    entry('e2', T0 + H, 'o1:reversal', 'posted');
    line('l3', 'e2', 'a-tax', 140, 0);
    line('l4', 'e2', 'a-rev', 1000, 0);
    entry('e3', T0 + 2 * H, 'o1:return-9', 'posted');
    line('l5', 'e3', 'a-tax', 14, 0);
    line('l6', 'e3', 'a-rev', 100, 0);
    const rows = op('taxReportLines', WIN);
    expect(rows.map((r: any) => [r.isSale, r.taxDelta, r.baseDelta])).toEqual([
      [true, 140, 1000],
      [false, -140, -1000],
      [false, -14, -100],
    ]);
  });

  it('falls back to the shipping-address snapshot for a guest, and to null when it has no usable name', () => {
    const { op, order, entry, line } = books();
    order('o1', T0, 'delivered', 'paid', 1140, null, '{"firstName":"Nour","lastName":"Buyer"}');
    order('o2', T0 + H, 'delivered', 'paid', 1140, null, '{"firstName":7}');
    order('o3', T0 + 2 * H, 'delivered', 'paid', 1140, null, '{}');
    for (const [i, id] of ['o1', 'o2', 'o3'].entries()) {
      entry(`e${i}`, T0 + i * H, id);
      line(`la${i}`, `e${i}`, 'a-tax', 0, 140);
      line(`lb${i}`, `e${i}`, 'a-rev', 0, 1000);
    }
    expect(op('taxReportLines', WIN).map((r: any) => r.customerName)).toEqual([
      'Nour Buyer',
      null,
      null,
    ]);
  });

  it('excludes entries with no tax movement, other sources, drafts, outside the window and other stores', () => {
    const { op, order, entry, line } = books();
    order('o1', T0, 'delivered', 'paid', 1000, null);
    entry('e-zero', T0, 'o1');
    line('z1', 'e-zero', 'a-rev', 0, 1000);
    entry('e-manual', T0, 'o1', 'posted', 'manual');
    line('m1', 'e-manual', 'a-tax', 0, 50);
    entry('e-draft', T0, 'o1:draft', 'draft');
    line('d1', 'e-draft', 'a-tax', 0, 50);
    entry('e-old', T0 - 5 * D, 'o1:old');
    line('o11', 'e-old', 'a-tax', 0, 50);
    entry('e-other', T0, 'o1', 'posted', 'order', 's2');
    line('x1', 'e-other', 'x-tax', 0, 50);
    expect(op('taxReportLines', WIN)).toEqual([]);
  });

  it('an empty window returns no rows', () => {
    expect(books().op('taxReportLines', WIN)).toEqual([]);
  });

  it('refuses bad args and an inverted window', () => {
    const { op } = books();
    for (const bad of [
      {},
      { fromMs: 'a', toMs: 1 },
      { fromMs: 1.5, toMs: 2 },
      { fromMs: -1, toMs: 2 },
      { fromMs: 5, toMs: 1 },
    ])
      expect(() => op('taxReportLines', bad as Record<string, unknown>)).toThrow(/fromMs|toMs/);
  });
});
