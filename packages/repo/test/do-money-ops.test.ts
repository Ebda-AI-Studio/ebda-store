// PR D2b (Ruling CF-MONEY-1): the money operations on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(`
    INSERT OR REPLACE INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES ('s1', 1, '{}');
    INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address)
      VALUES ('o1', 's1', 'c1', 'N1', 'delivered', 'paid', 10000, 10000, '{}', '{}'), ('o2', 's1', 'c1', 'N2', 'delivered', 'paid', 4000, 4000, '{}', '{}');
  `);
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>, key?: string): string => {
    try {
      op(name, args, key);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  return { raw, db, q, op, code };
}
const earn = { customerId: 'c1', orderId: 'o1', featureEnabled: true };

describe('money operations', () => {
  it('loyaltyEarn credits once per order whatever the key, and an unknown operation is refused', () => {
    const r = rig();
    expect(r.op('loyaltyEarn', earn)).toMatchObject({ pointsEarned: 100, replayed: false });
    expect(r.op('loyaltyEarn', earn)).toMatchObject({ pointsEarned: 0, replayed: true });
    expect(
      r.q('SELECT count(*) AS n FROM loyalty_transactions WHERE type = ?', 'earn_purchase')[0].n
    ).toBe(1);
    expect(r.code('chargeCard', {})).toBe('MONEY_OP_NOT_ALLOWED/400');
    expect(r.code('loyaltyEarn', { customerId: 'c1' })).toBe('BAD_ARGS/400');
  });
  it('a keyed replay returns the first result without a second write; another payload under the key is refused', () => {
    const r = rig();
    const first = r.op('loyaltyEarn', earn, 'earn:o1:abcdef');
    expect(r.op('loyaltyEarn', earn, 'earn:o1:abcdef')).toEqual(first);
    expect(r.code('loyaltyEarn', { ...earn, orderId: 'o2' }, 'earn:o1:abcdef')).toBe(
      'IDEMPOTENCY_KEY_REUSED/409'
    );
    expect(r.code('loyaltyEarn', earn, 'short')).toBe('BAD_IDEMPOTENCY_KEY/400');
  });
  it('a refused operation leaves nothing behind, not even its key', () => {
    const r = rig();
    expect(r.code('loyaltyEarn', { ...earn, orderId: 'nope' }, 'earn:nope:abcdef')).toBe(
      'ORDER_NOT_FOUND/404'
    );
    expect(r.q('SELECT count(*) AS n FROM _money_ops')[0].n).toBe(0);
    expect(r.q('SELECT count(*) AS n FROM loyalty_points')[0].n).toBe(0);
  });
  it('the order must belong to the customer (another customer cannot earn on it)', () => {
    const r = rig();
    expect(r.code('loyaltyEarn', { ...earn, customerId: 'c2' })).toBe('ORDER_NOT_FOUND/404');
  });
  it('a reversal after a spend floors at the balance and still records the full reversal row', () => {
    const r = rig();
    r.op('loyaltyEarn', earn);
    r.raw.exec(`UPDATE loyalty_points SET points = 30 WHERE customer_id = 'c1'`);
    expect(r.op('loyaltyReverseEarned', { orderId: 'o1' })).toMatchObject({
      pointsReversed: 30,
      newBalance: 0,
    });
    expect(r.op('loyaltyReverseEarned', { orderId: 'o1' })).toMatchObject({
      pointsReversed: 0,
      replayed: true,
    });
    expect(r.q('SELECT points FROM loyalty_points')[0].points).toBe(0);
  });
});

describe('keyed-op fingerprint (Opus M1)', () => {
  it('is key-order insensitive and distinguishes different arguments', async () => {
    const { canonicalJson, fingerprint } = await import('../src/do/keyed-op');
    expect(fingerprint(canonicalJson({ a: 1, b: { c: 2, d: [1, 2] } }))).toBe(
      fingerprint(canonicalJson({ b: { d: [1, 2], c: 2 }, a: 1 }))
    );
    expect(fingerprint(canonicalJson({ a: 1 }))).not.toBe(fingerprint(canonicalJson({ a: 2 })));
    expect(fingerprint(canonicalJson({ a: [1, 2] }))).not.toBe(
      fingerprint(canonicalJson({ a: [2, 1] }))
    );
  });
});
