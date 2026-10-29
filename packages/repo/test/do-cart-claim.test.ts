// PR D2b-4 (Ruling CF-FINAL-1, closes CF-ORDERS-CART-1): the cart claim is atomic with the order, whatever holds the cart rows.
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
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1500, 10, 'active')`
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
  const order = (fp: string, over: Record<string, unknown> = {}) => ({
    lines: [{ productId: 'sku', quantity: 1 }],
    shippingAddress: { name: 'A' },
    cartClaim: { id: 'cart-1', fingerprint: fp },
    ...over,
  });
  return { raw, op, code, n, order };
}

describe('cart claim inside createOrder', () => {
  it('the second checkout of one cart state is CART_CHANGED, with no key, or another key', () => {
    const r = rig();
    r.op(r.order('v1'));
    expect(r.code(r.order('v1'))).toBe('CART_CHANGED');
    expect(r.code(r.order('v1'), 'other:key-12345')).toBe('CART_CHANGED');
    expect(r.n('SELECT count(*) n FROM orders')).toBe(1);
    expect(r.n('SELECT inventory n FROM products')).toBe(9);
  });

  it('a changed cart (new fingerprint) is a new purchase, and a keyed retry of the first is a replay', () => {
    const r = rig();
    const a = r.op(r.order('v1'), 'order:abcdefgh');
    expect(r.op(r.order('v1'), 'order:abcdefgh')).toEqual(a);
    r.op(r.order('v2'));
    expect(r.n('SELECT count(*) n FROM orders')).toBe(2);
  });

  it('a refused order releases the claim (it rolled back with the section)', () => {
    const r = rig();
    expect(r.code(r.order('v1', { lines: [{ productId: 'sku', quantity: 99 }] }))).not.toBe(
      'no error'
    );
    expect(r.n('SELECT count(*) n FROM _cart_claims')).toBe(0);
    expect(r.code(r.order('v1'))).toBe('no error');
  });

  it('an idempotency-key replay of the same order is not blocked by its own claim', () => {
    const r = rig();
    r.op(r.order('v1'), 'order:abcdefgh');
    expect(r.code(r.order('v1'), 'order:abcdefgh')).toBe('no error');
  });

  it('a quote never takes the claim', () => {
    const r = rig();
    const q = runMoneyOp(nodeSyncSql(r.raw), 's1', 'quoteOrder', r.order('v1')) as any;
    expect(q.total).toBeGreaterThan(0);
    expect(r.n('SELECT count(*) n FROM _cart_claims')).toBe(0);
  });
});
