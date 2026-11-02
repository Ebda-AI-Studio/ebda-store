// PR R2 (Ruling CF-R2-1, closes CF-ORDERS-CART-1): the cart rows live on the DO, so `createOrder` claims them in the SAME
// section as the order: what the cart holds now must be what is ordered, and the rows are deleted there.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(
    `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('s1', 'Shop', 'shop', 'o1');
     INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1500, 10, 'active');
     INSERT INTO carts (id, store_id, session_id) VALUES ('cart-1', 's1', 'sess-1');
     INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ('ci-1', 'cart-1', 'sku', 1);`
  );
  const op = (args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, 's1', 'createOrder', args, key) as any;
  const code = (args: Record<string, unknown>, key?: string) => {
    try {
      op(args, key);
    } catch (e) {
      return (e as MoneyError).code;
    }
    return 'no error';
  };
  const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  const order = (over: Record<string, unknown> = {}) => ({
    lines: [{ productId: 'sku', quantity: 1 }],
    shippingAddress: { name: 'A' },
    cart: { id: 'cart-1' },
    ...over,
  });
  return { raw, db, op, code, n, order };
}

describe('cart claim inside createOrder (rows on the DO)', () => {
  it('consumes the cart rows with the order; a second submit of the same cart is CART_CHANGED, no key or another key', () => {
    const r = rig();
    r.op(r.order());
    expect(r.n('SELECT count(*) n FROM cart_items')).toBe(0);
    expect(r.code(r.order())).toBe('CART_CHANGED');
    expect(r.code(r.order(), 'other:key-12345')).toBe('CART_CHANGED');
    expect(r.n('SELECT count(*) n FROM orders')).toBe(1);
    expect(r.n('SELECT inventory n FROM products')).toBe(9);
  });

  it('a refused order keeps the cart (the delete rolled back with the section)', () => {
    const r = rig();
    expect(r.code(r.order({ lines: [{ productId: 'sku', quantity: 99 }] }))).toBe('CART_CHANGED');
    r.raw.exec(`UPDATE cart_items SET quantity = 99 WHERE id = 'ci-1'`);
    expect(r.code(r.order({ lines: [{ productId: 'sku', quantity: 99 }] }))).not.toBe('no error');
    expect(r.n('SELECT count(*) n FROM cart_items')).toBe(1);
    expect(r.n('SELECT count(*) n FROM fiscal_documents')).toBe(0);
  });

  it('a cart refilled after checkout is a new purchase, and a keyed retry of the first is a replay', () => {
    const r = rig();
    const a = r.op(r.order(), 'order:abcdefgh');
    expect(r.op(r.order(), 'order:abcdefgh')).toEqual(a);
    r.raw.exec(
      `INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ('ci-2', 'cart-1', 'sku', 1)`
    );
    r.op(r.order());
    expect(r.n('SELECT count(*) n FROM orders')).toBe(2);
  });

  it("marks the cart's open abandoned-cart row recovered by the order; a guest cart never matches another guest", () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO carts (id, store_id, session_id) VALUES ('cart-2', 's1', 'sess-2');
       INSERT INTO abandoned_carts (id, store_id, cart_id, cart_total, cart_item_count, cart_items, status) VALUES ('ab-1', 's1', 'cart-1', 1500, 1, '[]', 'step1_sent'), ('ab-2', 's1', 'cart-2', 1500, 1, '[]', 'pending')`
    );
    const placed = r.op(r.order());
    const rows = r.raw
      .prepare('SELECT id, status, recovered_order_id FROM abandoned_carts ORDER BY id')
      .all() as any[];
    expect(rows).toEqual([
      { id: 'ab-1', status: 'recovered', recovered_order_id: placed.orderId },
      { id: 'ab-2', status: 'pending', recovered_order_id: null },
    ]);
  });

  it('a quote never touches the cart', () => {
    const r = rig();
    const q = runMoneyOp(r.db, 's1', 'quoteOrder', r.order({ cart: undefined })) as any;
    expect(q.total).toBeGreaterThan(0);
    expect(r.n('SELECT count(*) n FROM cart_items')).toBe(1);
  });
});
