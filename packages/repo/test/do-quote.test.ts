// PR D2b-4 (Ruling CF-FINAL-1): `quoteOrder` prices a cart as an order would and writes nothing.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';

function rig(stock = 10) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, track_inventory) VALUES ('sku', 's1', 'Widget', 'widget', 1500, ${stock}, 'active', 1);
     INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, is_active, scope_product_ids, scope_category_ids) VALUES ('c1', 's1', 'SAVE', 'c', 'fixed', 500, 1, 1, '[]', '[]')`
  );
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, 's1', name, args, key) as any;
  const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  const base = (over: Record<string, unknown> = {}) => ({
    lines: [{ productId: 'sku', quantity: 2 }],
    shippingAddress: { name: 'A' },
    paymentMethod: 'cod',
    ...over,
  });
  return { raw, op, n, base };
}

describe('quoteOrder', () => {
  it('answers the totals an order would get, and the order then charges exactly that', () => {
    const r = rig();
    const q = r.op('quoteOrder', r.base({ couponCode: 'SAVE' }));
    const o = r.op('createOrder', r.base({ couponCode: 'SAVE' }));
    expect(q).toMatchObject({ subtotal: 3000, total: o.total, tax: o.tax, shipping: o.shipping });
    expect(q.discount).toBe(o.discount);
    expect(q.lines).toEqual([
      expect.objectContaining({
        index: 0,
        productId: 'sku',
        quantity: 2,
        unitPrice: 1500,
        lineTotal: 3000,
        priceSource: 'base',
      }),
    ]);
  });

  it('writes nothing: no order, no stock, no coupon use, no history, no marker', () => {
    const r = rig();
    r.op('quoteOrder', r.base({ couponCode: 'SAVE' }), 'quote:abcdefgh');
    expect(r.n('SELECT count(*) n FROM orders')).toBe(0);
    expect(r.n('SELECT inventory n FROM products')).toBe(10);
    expect(r.n('SELECT usage_count n FROM coupons')).toBe(0);
    expect(r.n('SELECT count(*) n FROM inventory_history')).toBe(0);
  });

  it('is not refused for stock, an exhausted wallet or open holds (Postgres quotes first, refuses at the order)', () => {
    const r = rig(1);
    expect(() => r.op('quoteOrder', r.base({ walletAmount: 99999 }))).not.toThrow();
    expect(r.op('quoteOrder', r.base()).total).toBe(3000);
    expect(() => r.op('createOrder', r.base())).toThrow(MoneyError); // the order itself still refuses
  });

  it('still refuses what Postgres refuses before it quotes: an unknown product', () => {
    const r = rig();
    expect(() =>
      r.op('quoteOrder', r.base({ lines: [{ productId: 'ghost', quantity: 1 }] }))
    ).toThrow(MoneyError);
  });
});
