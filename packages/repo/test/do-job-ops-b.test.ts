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
