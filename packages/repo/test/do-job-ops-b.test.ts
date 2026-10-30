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
