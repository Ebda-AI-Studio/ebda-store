// #631: the loyalty ledger is lot-aware. A refund reversal takes back the FULL earn (spent points become debt, paid by
// the next earns), and expiry only expires what is LEFT of the expiring lots, never again what was already redeemed,
// reversed or used to pay a debt. node:sqlite on the real StoreDO schema.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  earnPointsFromPurchase,
  expirePoints,
  lotRemaining,
  redeemPoints,
  reverseEarnedPointsFromOrder,
} from '../src/do/loyalty';

const MONTH = 30 * 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const one = (sql: string, ...p: unknown[]) => raw.prepare(sql).get(...(p as never[])) as any;
  // 1 point per EGP, expire after 12 months, redeem from 1 point, up to 100% of the order
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
  let n = 0;
  const order = (totalEgp: number) => {
    const id = `o${++n}`;
    x(
      `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address) VALUES (?, 's1', 'c1', ?, ?, ?, '{}', '{}')`,
      id,
      `N${n}`,
      totalEgp * 100,
      totalEgp * 100
    );
    return id;
  };
  const earn = (totalEgp: number, now: number) => {
    const o = order(totalEgp);
    const r = earnPointsFromPurchase(db, {
      storeId: 's1',
      customerId: 'c1',
      orderId: o,
      featureEnabled: true,
      now,
    });
    return { o, pts: r.pointsEarned };
  };
  const bal = () =>
    one(`SELECT points FROM loyalty_points WHERE customer_id = 'c1'`).points as number;
  const expireAll = (now: number) => expirePoints(db, { storeId: 's1', now });
  return { db, x, one, order, earn, bal, expireAll };
}

describe('loyalty lots (#631)', () => {
  it('earn 1000 on A, refund A, earn 800: A expiring later takes NOTHING from the 800', () => {
    const f = fixture();
    const a = f.earn(1000, T0);
    expect(a.pts).toBe(1000);
    reverseEarnedPointsFromOrder(f.db, { storeId: 's1', orderId: a.o, now: T0 + MONTH });
    f.earn(800, T0 + 2 * MONTH);
    expect(f.bal()).toBe(800);
    const r = f.expireAll(T0 + 13 * MONTH); // A's lot is past its expiry, B's is not
    expect(r.expired).toBe(0);
    expect(f.bal()).toBe(800);
  });

  it('earn 5000 on A, redeem 5000 on B, refund A: the 5000 is clawed back as debt (no free discount)', () => {
    const f = fixture();
    const a = f.earn(5000, T0);
    const b = f.order(6000);
    redeemPoints(f.db, {
      storeId: 's1',
      customerId: 'c1',
      orderId: b,
      points: 5000,
      featureEnabled: true,
      now: T0 + 1000,
    });
    expect(f.bal()).toBe(0);
    const r = reverseEarnedPointsFromOrder(f.db, { storeId: 's1', orderId: a.o, now: T0 + 2000 });
    expect(r).toMatchObject({ pointsReversed: 5000, debt: 5000 });
    expect(f.bal()).toBe(-5000);
    // the debt is paid by the next earn before anything else, and those points cannot expire twice
    const c = f.earn(800, T0 + MONTH);
    expect(f.bal()).toBe(-5000 + c.pts);
    expect(f.expireAll(T0 + 14 * MONTH).expired).toBe(0);
    expect(f.bal()).toBe(-5000 + c.pts);
  });

  it('earn 1000, redeem 1000, earn 500: the first lot expiring takes nothing from the 500', () => {
    const f = fixture();
    f.earn(1000, T0);
    const b = f.order(2000);
    redeemPoints(f.db, {
      storeId: 's1',
      customerId: 'c1',
      orderId: b,
      points: 1000,
      featureEnabled: true,
      now: T0 + 1000,
    });
    const c = f.earn(500, T0 + 3 * MONTH); // silver tier by now: 1.25x
    expect(f.expireAll(T0 + 12 * MONTH + 10 * 86_400_000).expired).toBe(0);
    expect(f.bal()).toBe(c.pts);
  });

  it('a partly used lot expires only its remainder, once', () => {
    const f = fixture();
    const a = f.earn(1000, T0);
    const b = f.order(400);
    redeemPoints(f.db, {
      storeId: 's1',
      customerId: 'c1',
      orderId: b,
      points: 400,
      featureEnabled: true,
      now: T0 + 1000,
    });
    expect(
      lotRemaining(f.db, 's1', 'c1').get(
        f.one(
          `SELECT id FROM loyalty_transactions WHERE order_id = ? AND type = 'earn_purchase'`,
          a.o
        ).id
      )
    ).toBe(600);
    expect(f.expireAll(T0 + 13 * MONTH).expired).toBe(600);
    expect(f.bal()).toBe(0);
    expect(f.expireAll(T0 + 14 * MONTH).expired).toBe(0);
  });
});
