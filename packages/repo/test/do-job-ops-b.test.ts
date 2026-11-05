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

describe('expenseTransition (Ruling CF-EXP-1)', () => {
  function drafted() {
    const r = rig();
    r.raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type) VALUES
         ('a-cash', 's1', '1000', 'Cash', 'asset'), ('a-exp', 's1', '5990', 'Misc', 'expense')`
    );
    const made = r.op('expenseDraft', {
      expenseAccountId: 'a-exp',
      paidFromAccountId: 'a-cash',
      amount: 1000,
      taxAmount: 0,
      total: 1000,
      currency: 'EGP',
      fxRate: 1,
      originalAmount: 1000,
      expenseDate: Date.UTC(2026, 9, 29),
    });
    const status = () =>
      r.raw.prepare('SELECT status, approved_by, posted_at FROM expenses').get() as any;
    return { ...r, id: made.expenseId as string, status };
  }

  it('draft -> approved -> posted, in order; posting an unapproved expense or approving a posted one changes nothing', () => {
    const { op, id, status } = drafted();
    expect(op('expenseTransition', { expenseId: id, action: 'post' })).toEqual({
      found: true,
      changed: false,
      status: 'draft',
    });
    expect(op('expenseTransition', { expenseId: id, action: 'approve', userId: 'u1' })).toEqual({
      found: true,
      changed: true,
      status: 'approved',
    });
    expect(status().approved_by).toBe('u1');
    expect(op('expenseTransition', { expenseId: id, action: 'post' }).status).toBe('posted');
    expect(status().posted_at).toBeGreaterThan(0);
    // a second click (or a retried request) moves nothing
    expect(op('expenseTransition', { expenseId: id, action: 'post' }).changed).toBe(false);
    expect(op('expenseTransition', { expenseId: id, action: 'approve' }).changed).toBe(false);
    expect(op('expenseTransition', { expenseId: id, action: 'reject' }).changed).toBe(false);
  });

  it('the two-step rule parks it in pending, the second approver approves it; reject works from draft or pending only', () => {
    const { op, id, status } = drafted();
    expect(
      op('expenseTransition', { expenseId: id, action: 'approve', userId: 'u1', pending: true })
        .status
    ).toBe('pending');
    expect(status().approved_by).toBeNull();
    expect(op('expenseTransition', { expenseId: id, action: 'approve', userId: 'u2' }).status).toBe(
      'approved'
    );
    expect(op('expenseTransition', { expenseId: id, action: 'reject' }).changed).toBe(false);
    const other = drafted();
    expect(other.op('expenseTransition', { expenseId: other.id, action: 'reject' }).status).toBe(
      'rejected'
    );
  });

  it('is store-scoped and refuses a bad action; an unknown id says not found', () => {
    const { op, id } = drafted();
    expect(op('expenseTransition', { expenseId: id, action: 'approve' }, 's2')).toEqual({
      found: false,
      changed: false,
      status: null,
    });
    expect(op('expenseTransition', { expenseId: 'nope', action: 'post' }).found).toBe(false);
    expect(() => op('expenseTransition', { expenseId: id, action: 'delete' })).toThrow();
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

describe('vectorPlan / vectorCommit / vectorStale (Ruling CF-JOBS-4B)', () => {
  async function vrig() {
    const { VECTOR_STATEMENTS } = await import('../src/do/search-vectors');
    const r = rig();
    for (const st of VECTOR_STATEMENTS) r.raw.exec(st);
    r.raw.exec(`UPDATE products SET name = 'Lamp', description = 'A brass lamp' WHERE id = 'sku'`);
    return r;
  }

  it('vectorStatus counts indexable / ready / stale / failed (Ruling NZ-PG-7)', async () => {
    const { op } = await vrig();
    expect(op('vectorStatus', {})).toEqual({ products: 1, indexed: 0, stale: 1, failed: 0 });
    const plan = op('vectorPlan', { limit: 10 });
    op('vectorCommit', { ready: plan.work, failures: [], forget: [], texts: 1 });
    expect(op('vectorStatus', {})).toEqual({ products: 1, indexed: 1, stale: 0, failed: 0 });
  });

  it('plans the stale product, commits it against the current text, then has nothing left', async () => {
    const { op } = await vrig();
    expect(op('vectorStale', {})).toEqual({ stale: true });
    const plan = op('vectorPlan', { limit: 10 });
    expect(plan.work).toHaveLength(1);
    expect(plan.work[0]).toMatchObject({ productId: 'sku', needDoc: true });
    const done = op('vectorCommit', { ready: plan.work, failures: [], forget: [], texts: 1 });
    expect(done).toMatchObject({ embedded: 1, cleanup: [] });
    expect(op('vectorStale', {})).toEqual({ stale: false });
    expect(op('vectorPlan', { limit: 10 }).work).toHaveLength(0);
    // a double delivery of the same commit changes nothing
    expect(
      op('vectorCommit', { ready: plan.work, failures: [], forget: [], texts: 0 }).embedded
    ).toBe(1);
    expect(op('vectorPlan', { limit: 10 }).work).toHaveLength(0);
  });

  it('vectorVisible: only an active, public, vectored product is visible to the storefront (Ruling CF-VEC-1)', async () => {
    const { raw, op } = await vrig();
    const plan = op('vectorPlan', { limit: 10 });
    op('vectorCommit', { ready: plan.work, failures: [], forget: [], texts: 1 });
    expect(op('vectorVisible', { ids: ['sku', 'foreign-id'] })).toEqual({ ids: ['sku'] });
    raw.exec(`UPDATE products SET status = 'draft' WHERE id = 'sku'`);
    expect(op('vectorVisible', { ids: ['sku'] })).toEqual({ ids: [] });
    raw.exec(`UPDATE products SET status = 'active', audience = 'wholesale_only' WHERE id = 'sku'`);
    expect(op('vectorVisible', { ids: ['sku'] })).toEqual({ ids: [] });
    expect(() => op('vectorVisible', { ids: 'sku' })).toThrow();
  });

  it('an edit between plan and commit leaves the product stale', async () => {
    const { raw, op } = await vrig();
    const plan = op('vectorPlan', { limit: 10 });
    raw.exec(`UPDATE products SET description = 'A different lamp' WHERE id = 'sku'`);
    expect(
      op('vectorCommit', { ready: plan.work, failures: [], forget: [], texts: 1 }).embedded
    ).toBe(0);
    expect(op('vectorStale', {})).toEqual({ stale: true });
  });

  it('a rejected text is quarantined until the text changes; the daily budget trims the plan', async () => {
    const { raw, op } = await vrig();
    const plan = op('vectorPlan', { limit: 10 });
    op('vectorCommit', {
      ready: [],
      failures: [{ work: plan.work[0], kind: 'input' }],
      forget: [],
      texts: 0,
    });
    expect(op('vectorPlan', { limit: 10 }).work).toHaveLength(0);
    raw.exec(`UPDATE products SET description = 'Changed text' WHERE id = 'sku'`);
    expect(op('vectorPlan', { limit: 10 }).work).toHaveLength(1);
    const capped = op('vectorPlan', { limit: 10, dailyCap: 0 });
    expect(capped).toMatchObject({ work: [], capped: true });
  });
});

describe('codMarkPaid (NEON-ZERO-1 group A, Ruling NZ-A-2)', () => {
  const addCod = (raw: any, orderId: string, id = 'pay-cod') =>
    raw
      .prepare(
        "INSERT INTO payments (id, order_id, provider, amount, currency, status, created_at, updated_at) VALUES (?, ?, 'cod', 1000, 'EGP', 'cod_pending', 1, 1)"
      )
      .run(id, orderId);
  const order = (raw: any, id: string) =>
    raw.prepare('SELECT status, payment_status FROM orders WHERE id = ?').get(id) as any;

  it('is registered', () => expect(MONEY_OP_NAMES).toContain('codMarkPaid'));

  it('completes the COD payment, marks the order paid, confirms a pending one, and a repeat books nothing', () => {
    const { raw, op, orderId } = rig();
    addCod(raw, orderId);
    const r = op('codMarkPaid', { orderIds: [orderId] });
    expect(r.updated).toHaveLength(1);
    expect(order(raw, orderId)).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
    expect(
      (raw.prepare("SELECT status FROM payments WHERE id = 'pay-cod'").get() as any).status
    ).toBe('completed');
    expect(op('codMarkPaid', { orderIds: [orderId] }).updated).toHaveLength(0);
  });

  it('keeps a further-along status, skips cancelled and non-COD orders, and refuses another store', () => {
    const { raw, op, orderId } = rig();
    addCod(raw, orderId);
    raw.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId);
    expect(op('codMarkPaid', { orderIds: [orderId] }, 's2').updated).toHaveLength(0);
    expect(op('codMarkPaid', { orderIds: [orderId] }).updated).toHaveLength(1);
    expect(order(raw, orderId)).toMatchObject({ status: 'shipped', payment_status: 'paid' });
    const b = rig();
    addCod(b.raw, b.orderId);
    b.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(b.orderId);
    expect(b.op('codMarkPaid', { orderIds: [b.orderId] }).updated).toHaveLength(0);
    const c = rig();
    expect(c.op('codMarkPaid', { orderIds: [c.orderId] }).updated).toHaveLength(0);
    expect(() => c.op('codMarkPaid', { orderIds: [] })).toThrow();
  });
});
