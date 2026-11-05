// DO cancel / refund money effects on node:sqlite (real StoreDO schema). Orders are created by the real `placeOrder`.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { placeOrder, type CheckoutInput } from '../src/do/checkout';
import { applyWalletEntry, cancelOrder, refundOrder, reverseOrderPayment } from '../src/do/refund';
import { earnPointsFromPurchase, redeemPoints } from '../src/do/loyalty';
import { MoneyError } from '../src/do/sync-sql';

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const one = <T = Record<string, number>>(sql: string, ...p: unknown[]) =>
    raw.prepare(sql).get(...(p as never[])) as T;
  for (const s of ['s1', 's2']) {
    x(`INSERT INTO store_config (store_id, loyalty_enabled) VALUES (?, 1)`, s);
    x(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku-${s}', ?, 'Widget', 'widget', 1500, 10, 'active')`,
      s
    );
  }
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('vprod', 's1', 'Shirt', 'shirt', 0, 0, 'active')`
  );
  x(
    `INSERT INTO product_variants (id, product_id, title, price, inventory, allow_backorder) VALUES ('v1', 'vprod', 'M', 4000, 5, 0), ('v2', 'vprod', 'L', 4200, 2, 1)`
  );
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, track_inventory, status) VALUES ('free', 's1', 'Untracked', 'untracked', 500, 0, 0, 'active')`
  );
  x(
    `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', 's1', 'A', 'B', 'cust')`
  );
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('x1', 's2', 'E', 'F')`);
  x(
    `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1', 's1', 'cust', 20000)`
  );
  x(
    `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('c1', 's1', 'TEN', 'ten', 'fixed', 100, '[]', '[]')`
  );
  const base = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
    storeId: 's1',
    lines: [{ productId: 'sku-s1', quantity: 1 }],
    shippingAddress: { name: 'A' },
    ...over,
  });
  const stock = (t: string, id: string) =>
    one<{ inventory: number }>(`SELECT inventory FROM ${t} WHERE id = ?`, id).inventory;
  const n = (sql: string, ...p: unknown[]) => one<{ n: number }>(sql, ...p).n;
  const wallet = () => stock('customer_wallets', 'w1') && 0;
  void wallet;
  const bal = () =>
    one<{ balance: number }>(`SELECT balance FROM customer_wallets WHERE id = 'w1'`).balance;
  const coupon = () =>
    one<{ usage_count: number }>(`SELECT usage_count FROM coupons WHERE id = 'c1'`).usage_count;
  const order = (id: string) =>
    one<{ status: string; payment_status: string; refund_reversed_at: number | null }>(
      `SELECT status, payment_status, refund_reversed_at FROM orders WHERE id = ?`,
      id
    );
  const movements = () => n(`SELECT count(*) n FROM inventory_history WHERE type = 'return_stock'`);
  return { raw, db, x, one, base, stock, n, bal, coupon, order, movements };
}
const err = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a MoneyError');
};

describe('cancelOrder', () => {
  it('restocks product and variant lines once, XOR (never both rows), and a second call is a no-op', () => {
    const f = fixture();
    const o = placeOrder(
      f.db,
      f.base({
        lines: [
          { productId: 'sku-s1', quantity: 3 },
          { productId: 'vprod', variantId: 'v1', quantity: 2 },
          { productId: 'free', quantity: 4 },
        ],
      })
    );
    expect(f.stock('products', 'sku-s1')).toBe(7);
    expect(f.stock('product_variants', 'v1')).toBe(3);
    const r = cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(r).toMatchObject({ replayed: false, status: 'cancelled', kind: 'cancel' });
    expect(r.restocked.map(l => l.quantity).sort()).toEqual([2, 3]); // the untracked line moves nothing
    expect(f.stock('products', 'sku-s1')).toBe(10);
    expect(f.stock('product_variants', 'v1')).toBe(5);
    expect(f.stock('products', 'vprod')).toBe(0); // parent column untouched
    expect(f.stock('products', 'free')).toBe(0);
    expect(f.movements()).toBe(2);
    expect(f.order(o.orderId)).toMatchObject({ status: 'cancelled' });
    expect(f.order(o.orderId).refund_reversed_at).not.toBeNull();

    const again = cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(again.replayed).toBe(true);
    expect(again.restocked).toEqual([]);
    expect(f.stock('products', 'sku-s1')).toBe(10);
    expect(f.stock('product_variants', 'v1')).toBe(5);
    expect(f.movements()).toBe(2);
  });

  it('un-claims the coupon use once, floored at 0, only for this order', () => {
    const f = fixture();
    const a = placeOrder(f.db, f.base({ couponCode: 'TEN' }));
    placeOrder(f.db, f.base({ couponCode: 'TEN' }));
    expect(f.coupon()).toBe(2);
    cancelOrder(f.db, { storeId: 's1', orderId: a.orderId });
    expect(f.coupon()).toBe(1);
    cancelOrder(f.db, { storeId: 's1', orderId: a.orderId });
    refundOrder(f.db, { storeId: 's1', orderId: a.orderId }); // cancelled -> refunded must not release it again
    expect(f.coupon()).toBe(1);
    expect(
      f.n(
        `SELECT count(*) n FROM order_events WHERE order_id = ? AND to_status = 'coupon_reversed'`,
        a.orderId
      )
    ).toBe(1);
    // the counter never goes below zero
    const b = placeOrder(f.db, f.base({ couponCode: 'TEN' }));
    f.x(`UPDATE coupons SET usage_count = 0 WHERE id = 'c1'`);
    cancelOrder(f.db, { storeId: 's1', orderId: b.orderId });
    expect(f.coupon()).toBe(0);
  });

  it('puts the wallet spend back exactly once (ledger key), for a cancel and a later refund', () => {
    const f = fixture();
    const o = placeOrder(f.db, f.base({ customerId: 'cust', walletAmount: 1000 }));
    expect(f.bal()).toBe(19000);
    const r = cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(r.walletReversed).toBe(1000);
    expect(f.bal()).toBe(20000);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    refundOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.bal()).toBe(20000);
    expect(
      f.n(
        `SELECT count(*) n FROM wallet_transactions WHERE type = 'order_payment_reversal' AND order_id = ?`,
        o.orderId
      )
    ).toBe(1);
  });

  it('subtracts pro-rata wallet shares already returned by partial returns', () => {
    const f = fixture();
    const o = placeOrder(f.db, f.base({ customerId: 'cust', walletAmount: 1000 }));
    applyWalletEntry(f.db, {
      storeId: 's1',
      customerId: 'cust',
      amount: 400,
      type: 'refund_credit',
      idempotencyKey: 'return-wallet-share:r1',
      orderId: o.orderId,
    });
    expect(f.bal()).toBe(19400);
    const r = reverseOrderPayment(f.db, { storeId: 's1', orderId: o.orderId });
    expect(r).toMatchObject({ amount: 600, replayed: false });
    expect(f.bal()).toBe(20000);
  });

  it('reverses loyalty (earn + redeem) once', () => {
    const f = fixture();
    f.x(
      `INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned) VALUES ('lp', 's1', 'cust', 1000, 1000)`
    );
    const o = placeOrder(
      f.db,
      f.base({ customerId: 'cust', lines: [{ productId: 'sku-s1', quantity: 4 }] })
    ); // 6000
    const F = { storeId: 's1', customerId: 'cust', orderId: o.orderId, featureEnabled: true };
    redeemPoints(f.db, { ...F, points: 600 });
    earnPointsFromPurchase(f.db, F); // bronze->silver at 1000: x1.25 on 60 EGP = 75
    const lp = () =>
      f.one<{ points: number }>(`SELECT points FROM loyalty_points WHERE id = 'lp'`).points;
    expect(lp()).toBe(1000 - 600 + 75);
    const r = cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(r.loyalty).toEqual({ earnedReversed: 75, redeemedRecredited: 600 });
    expect(lp()).toBe(1000);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(lp()).toBe(1000);
  });

  it('cancels open backorder lines and restores only what checkout really took', () => {
    const f = fixture();
    const o = placeOrder(
      f.db,
      f.base({
        lines: [{ productId: 'vprod', variantId: 'v2', quantity: 5 }],
        backorderEnabled: true,
      })
    ); // 2 on hand, 5 ordered: took 2
    expect(f.stock('product_variants', 'v2')).toBe(0);
    const r = cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.stock('product_variants', 'v2')).toBe(2); // 5 - 3 never taken
    expect(r.backorderLinesCancelled).toBe(1);
    expect(
      f.one<{ cancelled_reason: string }>(
        `SELECT cancelled_reason FROM backorder_lines WHERE store_id = 's1'`
      ).cancelled_reason
    ).toBe('Order refunded');
  });

  it('is atomic: a failing restock leaves status, coupon, wallet and stock untouched', () => {
    const f = fixture();
    const o = placeOrder(
      f.db,
      f.base({
        couponCode: 'TEN',
        customerId: 'cust',
        walletAmount: 500,
        lines: [{ productId: 'sku-s1', quantity: 2 }],
      })
    );
    f.x(`UPDATE products SET inventory = 2147483647 WHERE id = 'sku-s1'`); // the restock would overflow int4
    expect(err(() => cancelOrder(f.db, { storeId: 's1', orderId: o.orderId })).code).toBe(
      'RESTOCK_REFUSED'
    );
    expect(f.order(o.orderId).status).not.toBe('cancelled');
    expect(f.order(o.orderId).refund_reversed_at).toBeNull();
    expect(f.coupon()).toBe(1);
    expect(f.bal()).toBe(19500);
    expect(f.n(`SELECT count(*) n FROM order_events WHERE order_id = ?`, o.orderId)).toBe(0);
  });

  it('refuses a delivered order, another store, a missing order and a bad id', () => {
    const f = fixture();
    const o = placeOrder(f.db, f.base());
    f.x(`UPDATE orders SET status = 'delivered' WHERE id = ?`, o.orderId);
    expect(err(() => cancelOrder(f.db, { storeId: 's1', orderId: o.orderId })).code).toBe(
      'INVALID_TRANSITION'
    );
    expect(err(() => cancelOrder(f.db, { storeId: 's1', orderId: 'nope' })).code).toBe(
      'ORDER_NOT_FOUND'
    );
    expect(err(() => cancelOrder(f.db, { storeId: 's1', orderId: '' })).code).toBe('BAD_ID');
    expect(err(() => cancelOrder(f.db, { storeId: '', orderId: o.orderId })).code).toBe('BAD_ID');
  });
});

describe('cross-store isolation', () => {
  it('an order id from another store is refused and nothing of either store moves', () => {
    const f = fixture();
    const mine = placeOrder(f.db, f.base({ couponCode: 'TEN' }));
    const theirs = placeOrder(
      f.db,
      f.base({ storeId: 's2', lines: [{ productId: 'sku-s2', quantity: 3 }] })
    );
    for (const call of [
      () => cancelOrder(f.db, { storeId: 's1', orderId: theirs.orderId }),
      () => refundOrder(f.db, { storeId: 's1', orderId: theirs.orderId }),
      () =>
        refundOrder(f.db, {
          storeId: 's1',
          orderId: theirs.orderId,
          refundKey: 'k',
          lines: [{ orderItemId: 'whatever', quantity: 1 }],
        }),
      () => cancelOrder(f.db, { storeId: 's2', orderId: mine.orderId }),
    ])
      expect(err(call).code).toBe('ORDER_NOT_FOUND');
    expect(f.stock('products', 'sku-s2')).toBe(7);
    expect(f.stock('products', 'sku-s1')).toBe(9);
    expect(f.coupon()).toBe(1);
    expect(f.order(theirs.orderId).status).toBe('pending');
  });

  it("a line of another order cannot be restocked through this order's refund", () => {
    const f = fixture();
    const a = placeOrder(f.db, f.base({ lines: [{ productId: 'sku-s1', quantity: 2 }] }));
    const b = placeOrder(f.db, f.base({ lines: [{ productId: 'sku-s1', quantity: 5 }] }));
    f.x(`UPDATE orders SET status = 'confirmed' WHERE id IN (?, ?)`, a.orderId, b.orderId);
    const foreignItem = f.one<{ id: string }>(
      `SELECT id FROM order_items WHERE order_id = ?`,
      b.orderId
    ).id;
    const before = f.stock('products', 'sku-s1');
    expect(
      err(() =>
        refundOrder(f.db, {
          storeId: 's1',
          orderId: a.orderId,
          refundKey: 'k1',
          lines: [{ orderItemId: foreignItem, quantity: 5 }],
        })
      ).code
    ).toBe('UNKNOWN_LINE');
    expect(f.stock('products', 'sku-s1')).toBe(before);
  });
});

describe('refundOrder', () => {
  it('full refund: status refunded, paid -> refunded, restock + wallet + coupon once, then a no-op', () => {
    const f = fixture();
    const o = placeOrder(
      f.db,
      f.base({
        customerId: 'cust',
        walletAmount: 1500,
        couponCode: 'TEN',
        lines: [{ productId: 'sku-s1', quantity: 2 }],
      })
    ); // total 2900, wallet 1500: not fully paid
    f.x(`UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = ?`, o.orderId);
    const r = refundOrder(f.db, { storeId: 's1', orderId: o.orderId, now: 99 });
    expect(r).toMatchObject({
      kind: 'refund',
      status: 'refunded',
      replayed: false,
      walletReversed: 1500,
      couponUnclaimed: true,
    });
    expect(f.order(o.orderId)).toMatchObject({ status: 'refunded', payment_status: 'refunded' });
    expect(f.stock('products', 'sku-s1')).toBe(10);
    expect(f.bal()).toBe(20000);
    expect(f.coupon()).toBe(0);
    const again = refundOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(again.replayed).toBe(true);
    expect(f.stock('products', 'sku-s1')).toBe(10);
    expect(f.bal()).toBe(20000);
    expect(f.movements()).toBe(1);
    // a cancel arriving after a refund is also a no-op (refunded is terminal)
    expect(cancelOrder(f.db, { storeId: 's1', orderId: o.orderId }).replayed).toBe(true);
    expect(f.order(o.orderId).status).toBe('refunded');
  });

  it('cancel then refund restocks once in total', () => {
    const f = fixture();
    const o = placeOrder(f.db, f.base({ lines: [{ productId: 'sku-s1', quantity: 4 }] }));
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    const r = refundOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(r).toMatchObject({ status: 'refunded', replayed: false, restocked: [] });
    expect(f.stock('products', 'sku-s1')).toBe(10);
    expect(f.movements()).toBe(1);
  });

  it('refuses a never-confirmed order (cancel it instead)', () => {
    const f = fixture();
    const o = placeOrder(f.db, f.base());
    expect(err(() => refundOrder(f.db, { storeId: 's1', orderId: o.orderId })).code).toBe(
      'INVALID_TRANSITION'
    );
  });
});

describe('partial refund', () => {
  function confirmed(f: ReturnType<typeof fixture>, over: Partial<CheckoutInput> = {}) {
    const o = placeOrder(
      f.db,
      f.base({
        customerId: 'cust',
        couponCode: 'TEN',
        walletAmount: 1000,
        lines: [{ productId: 'sku-s1', quantity: 5 }],
        ...over,
      })
    );
    f.x(`UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = ?`, o.orderId);
    const item = f.one<{ id: string }>(
      `SELECT id FROM order_items WHERE order_id = ?`,
      o.orderId
    ).id;
    return { ...o, item };
  }

  it('restocks ONLY the listed quantity, leaves coupon/wallet/status alone, and a replay changes nothing', () => {
    const f = fixture();
    const o = confirmed(f);
    expect(f.stock('products', 'sku-s1')).toBe(5);
    const r = refundOrder(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      refundKey: 'ret-1',
      lines: [{ orderItemId: o.item, quantity: 2 }],
    });
    expect(r).toMatchObject({ kind: 'partial_refund', replayed: false });
    expect(r.restocked).toHaveLength(1);
    expect(f.stock('products', 'sku-s1')).toBe(7);
    expect(f.coupon()).toBe(1);
    expect(f.bal()).toBe(19000);
    expect(f.order(o.orderId)).toMatchObject({ status: 'confirmed', refund_reversed_at: null });
    const again = refundOrder(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      refundKey: 'ret-1',
      lines: [{ orderItemId: o.item, quantity: 2 }],
    });
    expect(again.replayed).toBe(true);
    expect(f.stock('products', 'sku-s1')).toBe(7);
    expect(f.movements()).toBe(1);
  });

  it('a different return restocks its own lines; the total can never exceed the line quantity; the later full cancel restores only the remainder', () => {
    const f = fixture();
    const o = confirmed(f);
    const ret = (key: string, q: number) =>
      refundOrder(f.db, {
        storeId: 's1',
        orderId: o.orderId,
        refundKey: key,
        lines: [{ orderItemId: o.item, quantity: q }],
      });
    ret('a', 2);
    ret('b', 2);
    expect(f.stock('products', 'sku-s1')).toBe(9);
    const c = ret('c', 4); // only 1 unit is left to restore
    expect(c.restocked[0].quantity).toBe(1);
    expect(f.stock('products', 'sku-s1')).toBe(10);
    const d = ret('d', 3); // nothing left
    expect(d.restocked).toEqual([]);
    expect(f.stock('products', 'sku-s1')).toBe(10);
    // full cancel after the partials: restores 0 more
    f.x(`UPDATE orders SET status = 'confirmed' WHERE id = ?`, o.orderId);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.stock('products', 'sku-s1')).toBe(10);
  });

  it('a partial then a full cancel restores exactly the remainder', () => {
    const f = fixture();
    const o = confirmed(f);
    refundOrder(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      refundKey: 'a',
      lines: [{ orderItemId: o.item, quantity: 2 }],
    });
    expect(f.stock('products', 'sku-s1')).toBe(7);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.stock('products', 'sku-s1')).toBe(10);
    expect(f.coupon()).toBe(0);
    expect(f.bal()).toBe(20000);
  });

  it('amount-only refunds move no stock, are bounded by the order total, and replay on the same key', () => {
    const f = fixture();
    const o = confirmed(f); // total 7500 - 100 coupon = 7400
    const r = refundOrder(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      refundKey: 'p1',
      amount: 3000,
    });
    expect(r).toMatchObject({ kind: 'partial_refund', replayed: false, restocked: [] });
    expect(f.stock('products', 'sku-s1')).toBe(5);
    expect(
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'p1', amount: 3000 })
        .replayed
    ).toBe(true);
    expect(
      err(() =>
        refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'p2', amount: 4500 })
      ).code
    ).toBe('REFUND_EXCEEDS_ORDER');
    refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'p3', amount: 4400 });
    expect(
      err(() =>
        refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'p4', amount: 1 })
      ).code
    ).toBe('REFUND_EXCEEDS_ORDER');
  });

  it('store credit lands in the wallet once per refundKey', () => {
    const f = fixture();
    const o = confirmed(f);
    const r = refundOrder(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      refundKey: 'ret-9',
      lines: [{ orderItemId: o.item, quantity: 1 }],
      walletCredit: 1500,
    });
    expect(r.walletCredited).toBe(1500);
    expect(f.bal()).toBe(20500);
    refundOrder(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      refundKey: 'ret-9',
      lines: [{ orderItemId: o.item, quantity: 1 }],
      walletCredit: 1500,
    });
    expect(f.bal()).toBe(20500);
    expect(
      f.n(
        `SELECT count(*) n FROM wallet_transactions WHERE idempotency_key = 'return-credit:ret-9'`
      )
    ).toBe(1);
    expect(
      err(() =>
        refundOrder(f.db, {
          storeId: 's1',
          orderId: o.orderId,
          refundKey: 'big',
          amount: 100,
          walletCredit: 99999,
        })
      ).code
    ).toBe('REFUND_EXCEEDS_ORDER');
  });

  it('refuses hostile input: no key, bad quantities, duplicates, negative amounts, finished orders', () => {
    const f = fixture();
    const o = confirmed(f);
    const L = [{ orderItemId: o.item, quantity: 1 }];
    const run = (over: Record<string, unknown>) =>
      err(() =>
        refundOrder(f.db, {
          storeId: 's1',
          orderId: o.orderId,
          refundKey: 'k',
          lines: L,
          ...over,
        } as never)
      );
    expect(run({ refundKey: undefined }).code).toBe('BAD_REFUND_KEY');
    expect(run({ refundKey: '' }).code).toBe('BAD_REFUND_KEY');
    for (const q of [0, -1, 1.5, NaN, 100001])
      expect(run({ lines: [{ orderItemId: o.item, quantity: q }] }).code).toBe('BAD_QUANTITY');
    expect(run({ lines: [] }).code).toBe('BAD_LINES');
    expect(run({ lines: [L[0], L[0]] }).code).toBe('BAD_LINES');
    for (const amount of [0, -5, 1.5, NaN, Infinity])
      expect(run({ lines: undefined, amount }).code).toBe('BAD_AMOUNT');
    expect(run({ lines: null }).code).toBe('BAD_LINES'); // null is never read as "no lines = full refund"
    expect(run({ lines: undefined, amount: null }).code).toBe('BAD_AMOUNT');
    expect(run({ walletCredit: -1 }).code).toBe('BAD_AMOUNT');
    expect(f.stock('products', 'sku-s1')).toBe(5);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(run({ refundKey: 'late' }).code).toBe('ORDER_ALREADY_REVERSED');
  });
});

describe('wallet entries', () => {
  it('are idempotent, refuse a reused key for a different movement, and never overdraw', () => {
    const f = fixture();
    const e = (over: Record<string, unknown>) =>
      applyWalletEntry(f.db, {
        storeId: 's1',
        customerId: 'cust',
        amount: -500,
        type: 'debit',
        idempotencyKey: 'k1',
        ...over,
      } as never);
    expect(e({}).replayed).toBe(false);
    expect(e({}).replayed).toBe(true);
    expect(f.bal()).toBe(19500);
    expect(err(() => e({ amount: -600 })).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(err(() => e({ idempotencyKey: 'k2', amount: -99999 })).code).toBe(
      'INSUFFICIENT_WALLET_BALANCE'
    );
    expect(f.bal()).toBe(19500);
    for (const amount of [0, 1.5, NaN, 200_000_000])
      expect(err(() => e({ idempotencyKey: 'k3', amount })).code).toBe('INVALID_WALLET_AMOUNT');
    expect(err(() => e({ idempotencyKey: '' })).code).toBe('INVALID_IDEMPOTENCY_KEY');
    // a credit needs NO CRM row (Ruling CF-FIX-2): the wallet is the account's, keyed by the users.id, and is minted for THIS store only
    expect(
      e({ customerId: 'no-crm-user', amount: 100, idempotencyKey: 'k4', type: 'credit' }).balance
    ).toBe(100);
    expect(
      f.one(`SELECT store_id FROM customer_wallets WHERE customer_id = 'no-crm-user'`).store_id
    ).toBe('s1');
  });

  describe('cumulative refund bound and backorder-aware partial restock (controller findings)', () => {
    const paid = (f: ReturnType<typeof fixture>) => {
      // 1,500 paid in full from the wallet: confirmed + paid
      const o = placeOrder(f.db, f.base({ customerId: 'cust', walletAmount: 1500 }));
      expect(o.paymentStatus).toBe('paid');
      return o;
    };

    it('two store credits of 60% each on one paid order: the second is refused', () => {
      const f = fixture();
      const o = paid(f);
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'r1', walletCredit: 900 });
      expect(
        err(() =>
          refundOrder(f.db, {
            storeId: 's1',
            orderId: o.orderId,
            refundKey: 'r2',
            walletCredit: 900,
          })
        ).code
      ).toBe('REFUND_EXCEEDS_ORDER');
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'r3', walletCredit: 600 }); // the exact remainder is allowed
      expect(
        err(() =>
          refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'r4', walletCredit: 1 })
        ).code
      ).toBe('REFUND_EXCEEDS_ORDER');
    });

    it('a provider amount and store credit share ONE ceiling (the sum of every channel cannot pass what was paid)', () => {
      const f = fixture();
      const o = paid(f);
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'a1', amount: 1000 });
      expect(
        err(() =>
          refundOrder(f.db, {
            storeId: 's1',
            orderId: o.orderId,
            refundKey: 'a2',
            walletCredit: 600,
          })
        ).code
      ).toBe('REFUND_EXCEEDS_ORDER');
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'a3', walletCredit: 500 });
    });

    it('partial store credit then a full reversal: the customer ends with exactly what they paid', () => {
      const f = fixture();
      const before = f.bal();
      const o = paid(f);
      expect(f.bal()).toBe(before - 1500);
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId, refundKey: 'p1', walletCredit: 600 });
      refundOrder(f.db, { storeId: 's1', orderId: o.orderId });
      expect(f.bal()).toBe(before); // 600 credited earlier + 900 on the reversal = the 1,500 paid
    });

    it('an unpaid (COD) order has nothing captured: no store credit can be created from it', () => {
      const f = fixture();
      const o = placeOrder(f.db, f.base({ customerId: 'cust' }));
      f.x(`UPDATE orders SET status = 'confirmed' WHERE id = ?`, o.orderId);
      expect(
        err(() =>
          refundOrder(f.db, {
            storeId: 's1',
            orderId: o.orderId,
            refundKey: 'c1',
            walletCredit: 100,
          })
        ).code
      ).toBe('REFUND_EXCEEDS_ORDER');
    });

    it('a partial return of a backordered line restocks only what checkout took', () => {
      const f = fixture();
      const o = placeOrder(
        f.db,
        f.base({
          lines: [{ productId: 'vprod', variantId: 'v2', quantity: 5 }],
          backorderEnabled: true,
        })
      ); // 2 on hand, 5 ordered
      expect(f.stock('product_variants', 'v2')).toBe(0);
      f.x(`UPDATE orders SET status = 'confirmed' WHERE id = ?`, o.orderId);
      const item = f.one<{ id: string }>(
        `SELECT id FROM order_items WHERE order_id = ?`,
        o.orderId
      ).id;
      refundOrder(f.db, {
        storeId: 's1',
        orderId: o.orderId,
        refundKey: 'b1',
        lines: [{ orderItemId: item, quantity: 5 }],
      });
      expect(f.stock('product_variants', 'v2')).toBe(2); // 3 units were never in stock
      refundOrder(f.db, {
        storeId: 's1',
        orderId: o.orderId,
        refundKey: 'b2',
        lines: [{ orderItemId: item, quantity: 5 }],
      });
      expect(f.stock('product_variants', 'v2')).toBe(2); // and a second return adds nothing
    });
  });
});
