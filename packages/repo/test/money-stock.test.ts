// Phase 3: money / stock / coupon / wallet invariants of the DO checkout core (node:sqlite, real StoreDO schema).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { placeOrder, type CheckoutInput } from '../src/do/checkout';
import { MoneyError } from '../src/do/sync-sql';

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1500, 10, 'active')`
  );
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('vprod', 's1', 'Shirt', 'shirt', 0, 0, 'active')`
  );
  raw.exec(
    `INSERT INTO product_variants (id, product_id, title, price, inventory, allow_backorder) VALUES ('v1', 'vprod', 'M', 4000, 3, 0), ('v2', 'vprod', 'L', 4200, 1, 1)`
  );
  const base = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
    storeId: 's1',
    lines: [{ productId: 'sku', quantity: 1 }],
    shippingAddress: { name: 'A' },
    ...over,
  });
  const stock = (t: string, id: string) =>
    (raw.prepare(`SELECT inventory FROM ${t} WHERE id = ?`).get(id) as { inventory: number })
      .inventory;
  const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  return { raw, db, base, stock, count };
}
const err = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a MoneyError');
};

describe('checkout core: stock', () => {
  it('prices come from the row, stock moves once, the ledger and the items agree', () => {
    const { db, base, stock, count } = fixture();
    const o = placeOrder(
      db,
      base({ lines: [{ productId: 'sku', quantity: 3 }], shipping: 500, tax: 100 })
    );
    expect(o).toMatchObject({
      subtotal: 4500,
      total: 5100,
      paymentStatus: 'unpaid',
      replayed: false,
    });
    expect(stock('products', 'sku')).toBe(7);
    expect(
      count(
        `SELECT count(*) n FROM inventory_history WHERE reference = '${o.orderId}' AND previous_stock = 10 AND new_stock = 7 AND quantity = 3`
      )
    ).toBe(1);
    expect(count(`SELECT sum(total) n FROM order_items WHERE order_id = '${o.orderId}'`)).toBe(
      o.subtotal
    );
  });

  it('out of stock rolls the WHOLE order back (an earlier line is not left decremented)', () => {
    const { db, base, stock, count } = fixture();
    const e = err(() =>
      placeOrder(
        db,
        base({
          lines: [
            { productId: 'sku', quantity: 2 },
            { productId: 'vprod', variantId: 'v1', quantity: 9 },
          ],
        })
      )
    );
    expect(e.code).toBe('OUT_OF_STOCK');
    expect(stock('products', 'sku')).toBe(10);
    expect(stock('product_variants', 'v1')).toBe(3);
    expect(count('SELECT count(*) n FROM orders')).toBe(0);
    expect(count('SELECT count(*) n FROM inventory_history')).toBe(0);
  });

  it('variant XOR product row; a variant product needs a variant; backorder floors at 0', () => {
    const { db, base, stock } = fixture();
    expect(
      err(() => placeOrder(db, base({ lines: [{ productId: 'vprod', quantity: 1 }] }))).code
    ).toBe('VARIANT_REQUIRED');
    placeOrder(db, base({ lines: [{ productId: 'vprod', variantId: 'v1', quantity: 2 }] }));
    expect(stock('product_variants', 'v1')).toBe(1);
    expect(stock('products', 'vprod')).toBe(0); // the parent column is untouched
    placeOrder(db, base({ lines: [{ productId: 'vprod', variantId: 'v2', quantity: 5 }] })); // backorder: 1 on hand, 5 ordered
    expect(stock('product_variants', 'v2')).toBe(0);
  });

  it('hostile quantities and amounts are refused', () => {
    const { db, base } = fixture();
    for (const q of [0, -1, 1.5, 1001, NaN, '2' as never])
      expect(
        err(() => placeOrder(db, base({ lines: [{ productId: 'sku', quantity: q }] }))).code
      ).toBe('BAD_QUANTITY');
    expect(err(() => placeOrder(db, base({ shipping: -5 }))).code).toBe('BAD_AMOUNT');
    expect(err(() => placeOrder(db, base({ tax: 1.5 }))).code).toBe('BAD_AMOUNT');
    expect(err(() => placeOrder(db, base({ lines: [] }))).code).toBe('BAD_LINES');
    expect(
      err(() =>
        placeOrder(db, base({ lines: [{ productId: 'other-store-product', quantity: 1 }] }))
      ).code
    ).toBe('PRODUCT_UNAVAILABLE');
  });

  it('idempotency: the same key returns the same order and moves stock once', () => {
    const { db, base, stock } = fixture();
    const a = placeOrder(db, base({ idempotencyKey: 'k-1' }));
    const b = placeOrder(db, base({ idempotencyKey: 'k-1' }));
    expect(b).toMatchObject({ orderId: a.orderId, replayed: true });
    expect(stock('products', 'sku')).toBe(9);
  });
});

describe('checkout core: coupon', () => {
  it('percentage, fixed, cap, minimum, dates, inactive; the total never goes negative', () => {
    const { raw, db, base } = fixture();
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('c10', 's1', 'TEN', 'ten', 'percentage', 10, '[]', '[]')`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, max_discount, scope_product_ids, scope_category_ids) VALUES ('cbig', 's1', 'BIG', 'big', 'fixed', 999999, 300, '[]', '[]')`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, min_order_amount, scope_product_ids, scope_category_ids) VALUES ('cmin', 's1', 'MIN', 'min', 'fixed', 100, 99999, '[]', '[]')`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, is_active, scope_product_ids, scope_category_ids) VALUES ('coff', 's1', 'OFF', 'off', 'fixed', 100, 0, '[]', '[]')`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, expires_at, scope_product_ids, scope_category_ids) VALUES ('cold', 's1', 'OLD', 'old', 'fixed', 100, 1, '[]', '[]')`
    );
    expect(placeOrder(db, base({ couponCode: 'ten' })).couponDiscount).toBe(150); // case-insensitive code
    expect(placeOrder(db, base({ couponCode: 'BIG' })).couponDiscount).toBe(300);
    expect(err(() => placeOrder(db, base({ couponCode: 'MIN' }))).code).toBe('COUPON_MIN_ORDER');
    expect(err(() => placeOrder(db, base({ couponCode: 'OFF' }))).code).toBe('COUPON_INVALID');
    expect(err(() => placeOrder(db, base({ couponCode: 'OLD' }))).code).toBe('COUPON_EXPIRED');
    expect(err(() => placeOrder(db, base({ couponCode: 'NOPE' }))).code).toBe('COUPON_INVALID');
    const big = placeOrder(
      db,
      base({ couponCode: 'BIG', lines: [{ productId: 'sku', quantity: 1 }] })
    );
    expect(big.total).toBeGreaterThanOrEqual(0);
  });

  it('usage limit is claimed atomically and a failed order does NOT burn a use', () => {
    const { raw, db, base } = fixture();
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c2', 's1', 'TWO', 'two', 'fixed', 100, 2, '[]', '[]')`
    );
    expect(
      err(() =>
        placeOrder(db, base({ couponCode: 'TWO', lines: [{ productId: 'sku', quantity: 99 }] }))
      ).code
    ).toBe('OUT_OF_STOCK');
    expect(
      (raw.prepare(`SELECT usage_count n FROM coupons WHERE id = 'c2'`).get() as { n: number }).n
    ).toBe(0);
    placeOrder(db, base({ couponCode: 'TWO' }));
    placeOrder(db, base({ couponCode: 'TWO' }));
    expect(err(() => placeOrder(db, base({ couponCode: 'TWO' }))).code).toBe('COUPON_EXHAUSTED');
    expect(
      (raw.prepare(`SELECT usage_count n FROM coupons WHERE id = 'c2'`).get() as { n: number }).n
    ).toBe(2);
  });
});

describe('checkout core: wallet', () => {
  it('debits at most the total and the balance, records the ledger, can pay in full, never goes negative', () => {
    const { raw, db, base } = fixture();
    raw.exec(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1', 's1', 'cust', 2000)`
    );
    const a = placeOrder(db, base({ customerId: 'cust', walletAmount: 99999 })); // total 1500: capped
    expect(a).toMatchObject({ walletAmount: 1500, total: 1500, paymentStatus: 'paid' });
    expect(
      (raw.prepare(`SELECT balance n FROM customer_wallets WHERE id = 'w1'`).get() as { n: number })
        .n
    ).toBe(500);
    expect(
      (
        raw
          .prepare(
            `SELECT count(*) n FROM wallet_transactions WHERE order_id = '${a.orderId}' AND amount = -1500 AND balance_after = 500`
          )
          .get() as { n: number }
      ).n
    ).toBe(1);
    expect(err(() => placeOrder(db, base({ customerId: 'cust', walletAmount: 1500 }))).code).toBe(
      'INSUFFICIENT_WALLET'
    );
    expect(
      (raw.prepare(`SELECT balance n FROM customer_wallets WHERE id = 'w1'`).get() as { n: number })
        .n
    ).toBe(500);
    expect(err(() => placeOrder(db, base({ walletAmount: 100 }))).code).toBe(
      'WALLET_NEEDS_CUSTOMER'
    );
  });
});
