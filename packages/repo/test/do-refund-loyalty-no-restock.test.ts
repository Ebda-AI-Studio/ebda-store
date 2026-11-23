// REFUND-988-REV-1 R1: the loyalty clawback of a partial refund is priced from the REFUNDED quantities, not the
// restocked ones. A line the merchant will not put back on the shelf (skipRestock) is still refunded money.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { earnPointsFromPurchase } from '../src/do/loyalty';
import { refundOrder } from '../src/do/refund';

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const one = (sql: string, ...p: unknown[]) => raw.prepare(sql).get(...(p as never[])) as any;
  x(
    `INSERT INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES ('s1', 1, ?)`,
    JSON.stringify({
      pointsPerEgp: 1,
      expirationMonths: 12,
      minRedeemPoints: 1,
      maxRedeemPercent: 100,
    })
  );
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('c1', 's1', 'A', 'B')`);
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'P', 'p', 50000, 10, 'active')`
  );
  x(
    `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, status, payment_status, shipping_address, billing_address) VALUES ('o1', 's1', 'c1', 'N1', 100000, 100000, 'confirmed', 'paid', '{}', '{}')`
  );
  x(
    `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total) VALUES ('i1', 'o1', 'p1', 'P', 2, 50000, 100000)`
  );
  const earned = earnPointsFromPurchase(db, {
    storeId: 's1',
    customerId: 'c1',
    orderId: 'o1',
    featureEnabled: true,
    now: Date.UTC(2026, 0, 1),
  }).pointsEarned;
  const bal = () =>
    one(`SELECT points FROM loyalty_points WHERE customer_id = 'c1'`).points as number;
  return { db, earned, bal, one };
}

describe('partial refund loyalty clawback is independent of restock (R1)', () => {
  it('refund half of a line WITHOUT restock claws back half the earn', () => {
    const f = fixture();
    expect(f.earned).toBe(1000);
    const r = refundOrder(f.db, {
      storeId: 's1',
      orderId: 'o1',
      refundKey: 'ret-1',
      lines: [{ orderItemId: 'i1', quantity: 1 }],
      amount: 50000,
      skipRestock: new Set(['i1']),
    });
    expect(r.restocked).toEqual([]);
    expect(r.loyalty.earnedReversed).toBe(500);
    expect(f.bal()).toBe(500);
  });

  it('with restock the clawback is the same (restock never changes the loyalty value)', () => {
    const f = fixture();
    const r = refundOrder(f.db, {
      storeId: 's1',
      orderId: 'o1',
      refundKey: 'ret-1',
      lines: [{ orderItemId: 'i1', quantity: 1 }],
      amount: 50000,
    });
    expect(r.restocked).toHaveLength(1);
    expect(r.loyalty.earnedReversed).toBe(500);
    expect(f.bal()).toBe(500);
  });
});
