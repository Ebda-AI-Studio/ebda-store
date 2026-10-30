// Ruling CF-JOBS-4: the once-only order stamp the non-money jobs use, on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'W', 'w', 1000, 20, 'active');
     INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('s1', 0);`
  );
  const op = (name: string, args: Record<string, unknown>, store = 's1') =>
    runMoneyOp(db, store, name, args) as any;
  const o = op('createOrder', {
    lines: [{ productId: 'sku', quantity: 1 }],
    shippingAddress: { phone: '01000000001' },
  });
  return { raw, op, orderId: o.orderId as string };
}

describe('orderStamp (Ruling CF-JOBS-4)', () => {
  it('is registered', () => expect(MONEY_OP_NAMES).toContain('orderStamp'));

  it('stamps once: the second call (a double delivery) loses', () => {
    const { raw, op, orderId } = rig();
    const args = { orderId, stamp: 'reviewRequestSentAt' };
    expect(op('orderStamp', args)).toEqual({ stamped: true });
    const at = (
      raw.prepare('SELECT review_request_sent_at AS t FROM orders WHERE id = ?').get(orderId) as any
    ).t;
    expect(at).toBeGreaterThan(0);
    expect(op('orderStamp', args)).toEqual({ stamped: false });
    expect(
      (
        raw
          .prepare('SELECT review_request_sent_at AS t FROM orders WHERE id = ?')
          .get(orderId) as any
      ).t
    ).toBe(at);
  });

  it("cannot stamp another store's order, and only a named stamp is accepted", () => {
    const { op, orderId } = rig();
    expect(op('orderStamp', { orderId, stamp: 'reviewRequestSentAt' }, 's2')).toEqual({
      stamped: false,
    });
    expect(() => op('orderStamp', { orderId, stamp: 'status' })).toThrow();
  });
});

describe('orderAnonymize (Ruling CF-JOBS-4B)', () => {
  it('scrubs the personal snapshots once; a second run finds nothing; another store is untouched', () => {
    const { raw, op, orderId } = rig();
    const cutoffMs = Date.now() + 60_000;
    const row = () =>
      raw
        .prepare(
          'SELECT customer_id, shipping_address AS s, billing_address AS b, customer_notes, buyer_key, area_key FROM orders WHERE id = ?'
        )
        .get(orderId) as any;
    raw
      .prepare(
        "UPDATE orders SET customer_notes = 'ring twice', buyer_key = '" +
          'a'.repeat(64) +
          "', area_key = 'a' WHERE id = ?"
      )
      .run(orderId);
    expect(op('orderAnonymize', { cutoffMs, limit: 10 }, 's2')).toEqual({ anonymized: 0 });
    expect(row().customer_notes).toBe('ring twice');
    expect(op('orderAnonymize', { cutoffMs, limit: 10 })).toEqual({ anonymized: 1 });
    expect(row()).toMatchObject({
      customer_id: null,
      s: '{"anonymized":true}',
      b: '{"anonymized":true}',
      customer_notes: null,
      buyer_key: null,
      area_key: null,
    });
    expect(op('orderAnonymize', { cutoffMs, limit: 10 })).toEqual({ anonymized: 0 });
  });

  it('leaves a recent order alone and refuses bad arguments', () => {
    const { op } = rig();
    expect(op('orderAnonymize', { cutoffMs: 1, limit: 10 })).toEqual({ anonymized: 0 });
    expect(() => op('orderAnonymize', { cutoffMs: 'x', limit: 10 })).toThrow();
    expect(() => op('orderAnonymize', { cutoffMs: 1, limit: 0 })).toThrow();
  });
});

describe('lastPaidSales and usageCounts (Ruling CF-JOBS-4B)', () => {
  it('lastPaidSales lists only paid sales of this store, per product', () => {
    const { raw, op, orderId } = rig();
    expect(op('lastPaidSales', { productIds: ['sku'] })).toEqual({ sales: {} });
    raw
      .prepare("UPDATE orders SET payment_status = 'paid', created_at = 1700000000000 WHERE id = ?")
      .run(orderId);
    expect(op('lastPaidSales', { productIds: ['sku', 'nope'] })).toEqual({
      sales: { sku: 1700000000000 },
    });
    expect(op('lastPaidSales', { productIds: ['sku'] }, 's2')).toEqual({ sales: {} });
    expect(op('lastPaidSales', { productIds: [] })).toEqual({ sales: {} });
    expect(() => op('lastPaidSales', { productIds: Array(91).fill('x') })).toThrow();
  });

  it('usageCounts counts the catalogue now and the period commerce', () => {
    const { raw, op, orderId } = rig();
    raw
      .prepare(
        "UPDATE orders SET payment_status = 'paid', total = 12345, created_at = 1700000000000 WHERE id = ?"
      )
      .run(orderId);
    const inPeriod = op('usageCounts', { startMs: 1699999999000, endMs: 1700000001000 });
    expect(inPeriod).toMatchObject({
      products: 1,
      productsActive: 1,
      orders: 1,
      revenueFils: 12345,
    });
    const outside = op('usageCounts', { startMs: 0, endMs: 1000 });
    expect(outside).toMatchObject({ products: 1, orders: 0, revenueFils: 0 });
    raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    expect(op('usageCounts', { startMs: 1699999999000, endMs: 1700000001000 }).revenueFils).toBe(0);
    expect(op('usageCounts', { startMs: 0, endMs: 1 << 30 }, 's2')).toMatchObject({
      products: 0,
      orders: 0,
    });
  });
});

describe('expenseDraft (Ruling CF-JOBS-4B)', () => {
  function exp() {
    const r = rig();
    r.raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type) VALUES
         ('a-cash', 's1', '1000', 'Cash', 'asset'), ('a-inv', 's1', '1200', 'Inventory', 'asset'),
         ('a-exp', 's1', '5990', 'Misc', 'expense'), ('a-other', 's2', '5990', 'Misc', 'expense')`
    );
    const args = (over: Record<string, unknown> = {}) => ({
      expenseAccountId: 'a-exp',
      paidFromAccountId: 'a-cash',
      amount: 1000,
      taxAmount: 140,
      total: 1140,
      currency: 'EGP',
      fxRate: 1,
      originalAmount: 1140,
      expenseDate: Date.UTC(2026, 9, 29),
      receiptImageUrl: 'https://r2.example/r.jpg',
      notes: 'n',
      ocr: { json: { vendor: 'X' }, confidence: 0.9, modelVersion: 'm', processedAtMs: 5 },
      ...over,
    });
    return { ...r, args };
  }

  it('creates a numbered draft with its OCR metadata, and numbers the next one', () => {
    const { raw, op, args } = exp();
    const first = op('expenseDraft', args());
    expect(first.expenseNumber).toMatch(/^EXP-\d{4}-000001$/);
    expect(op('expenseDraft', args()).expenseNumber).toMatch(/-000002$/);
    expect(
      raw
        .prepare(
          'SELECT status, total, fx_rate, ocr_json, category_ai_confidence FROM expenses WHERE id = ?'
        )
        .get(first.expenseId)
    ).toMatchObject({
      status: 'draft',
      total: 1140,
      fx_rate: 100000000,
      ocr_json: '{"vendor":"X"}',
      category_ai_confidence: 0.9,
    });
  });

  it("refuses a paid-from account that is not cash or bank, another store's account, and a total that does not add up", () => {
    const { op, args } = exp();
    expect(() => op('expenseDraft', args({ paidFromAccountId: 'a-inv' }))).toThrow(/cash or bank/);
    expect(() => op('expenseDraft', args({ expenseAccountId: 'a-other' }))).toThrow(
      /Expense account/
    );
    expect(() => op('expenseDraft', args({ total: 1 }))).toThrow();
    expect(() => op('expenseDraft', args(), 's2')).toThrow();
  });
});

describe('webhookEndpointCreate and r2References (Ruling CF-JOBS-4B)', () => {
  const ep = (i: number) => ({
    maxEndpoints: 2,
    url: `https://h.example/${i}`,
    description: null,
    events: ['order.created'],
    includeCustomer: false,
    secretEnc: 'enc',
    secretHint: 'abcd',
    createdBy: 'u',
  });

  it('counts and inserts in one call: the cap holds, per store', () => {
    const { op } = rig();
    op('webhookEndpointCreate', ep(1));
    op('webhookEndpointCreate', ep(2));
    expect(() => op('webhookEndpointCreate', ep(3))).toThrow(/limit/);
    expect(op('webhookEndpointCreate', ep(1), 's2')).toHaveProperty('id');
  });

  it('r2References pages a registry column, refuses odd identifiers and reports a missing table', () => {
    const { raw, op } = rig();
    raw.exec(
      `INSERT INTO product_images (id, product_id, url, position) VALUES ('i1', 'sku', 'https://r2/a.jpg', 0), ('i2', 'sku', 'https://r2/b.jpg', 1)`
    );
    const p1 = op('r2References', { table: 'product_images', columns: ['url'], limit: 1 });
    expect(p1).toMatchObject({
      missing: false,
      rows: [{ id: 'i1', url: 'https://r2/a.jpg' }],
      last: 'i1',
    });
    const p2 = op('r2References', {
      table: 'product_images',
      columns: ['url'],
      after: 'i1',
      limit: 5,
    });
    expect(p2.rows).toHaveLength(1);
    expect(p2.last).toBeNull();
    expect(op('r2References', { table: 'no_such_table', columns: ['url'], limit: 5 }).missing).toBe(
      true
    );
    expect(
      op('r2References', { table: 'product_images', columns: ['nope'], limit: 5 }).missing
    ).toBe(true);
    expect(() =>
      op('r2References', { table: 'orders; DROP TABLE orders', columns: ['url'], limit: 5 })
    ).toThrow();
    expect(() =>
      op('r2References', { table: 'product_images', columns: ['url"--'], limit: 5 })
    ).toThrow();
  });
});

describe('the R2 reference registry against the DO schema (Ruling CF-JOBS-4B)', () => {
  it('every registered table that is store data exists in the DO with all its registered columns', async () => {
    const { R2_REFERENCE_COLUMNS, PLATFORM_R2_TABLES } =
      await import('../../../apps/api/src/lib/r2-references');
    const { op } = rig();
    const byTable = new Map<string, string[]>();
    for (const c of R2_REFERENCE_COLUMNS)
      if (!PLATFORM_R2_TABLES.includes(c.table))
        byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.column]);
    expect(byTable.size).toBeGreaterThan(10);
    for (const [table, columns] of byTable)
      expect({ table, missing: op('r2References', { table, columns, limit: 1 }).missing }).toEqual({
        table,
        missing: false,
      });
  });
});
