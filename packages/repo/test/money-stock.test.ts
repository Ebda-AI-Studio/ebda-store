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
/** Delivery fee (first-zone fallback) and a verified 2% VAT profile: the engines compute these now, the caller cannot. */
function fees(raw: ReturnType<typeof openSqlite>, shipping: number, vatPercent = 0) {
  if (shipping > 0)
    raw.exec(
      `INSERT INTO shipping_zones (id, store_id, name, areas, delivery_fee) VALUES ('z1', 's1', 'All', '[]', ${shipping})`
    );
  if (vatPercent > 0) {
    raw.exec(`INSERT OR IGNORE INTO store_config (store_id) VALUES ('s1')`);
    raw.exec(`UPDATE store_config SET tax_enabled = 1 WHERE store_id = 's1'`);
    raw.exec(
      `INSERT INTO tax_rates (id, store_id, name, rate) VALUES ('t1', 's1', 'VAT', ${vatPercent * 100})`
    );
    raw.exec(
      `INSERT INTO store_tax_profiles (id, store_id, status, tax_registration_number, legal_name) VALUES ('p1', 's1', 'verified', '123456789', 'Seller LLC')`
    );
  }
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
    const { raw, db, base, stock, count } = fixture();
    fees(raw, 500, 2);
    const o = placeOrder(db, base({ lines: [{ productId: 'sku', quantity: 3 }] }));
    expect(o).toMatchObject({
      subtotal: 4500,
      total: 5100,
      paymentStatus: 'unpaid',
      replayed: false,
    });
    expect(stock('products', 'sku')).toBe(7);
    expect(
      count(
        `SELECT count(*) n FROM inventory_history WHERE reference = '${o.orderId}' AND previous_stock = 10 AND new_stock = 7 AND quantity = -3`
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
    placeOrder(
      db,
      base({
        lines: [{ productId: 'vprod', variantId: 'v2', quantity: 5 }],
        backorderEnabled: true,
      })
    ); // backorder: 1 on hand, 5 ordered
    expect(stock('product_variants', 'v2')).toBe(0);
  });

  it('hostile quantities and amounts are refused', () => {
    const { db, base } = fixture();
    for (const q of [0, -1, 1.5, 1001, NaN, '2' as never])
      expect(
        err(() => placeOrder(db, base({ lines: [{ productId: 'sku', quantity: q }] }))).code
      ).toBe('BAD_QUANTITY');
    expect(err(() => placeOrder(db, base({ walletAmount: -5 }))).code).toBe('BAD_AMOUNT');
    expect(err(() => placeOrder(db, base({ walletAmount: 1.5 }))).code).toBe('BAD_AMOUNT');
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

describe('checkout core: cart claim (P07 / M-012)', () => {
  function withCart() {
    const f = fixture();
    f.raw.exec(
      `INSERT INTO carts (id, store_id, session_id) VALUES ('cart1', 's1', 'sess1'), ('cart2', 's2', 'sess2')`
    );
    f.raw.exec(
      `INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ('ci1', 'cart1', 'sku', 1)`
    );
    return f;
  }
  it('a second checkout of the same cart (different key or none) fails; one order, stock moved once', () => {
    const { db, base, stock, count } = withCart();
    const cart = { id: 'cart1' };
    const a = placeOrder(db, base({ cart, idempotencyKey: 'k-a' }));
    expect(a.replayed).toBe(false);
    expect(err(() => placeOrder(db, base({ cart, idempotencyKey: 'k-b' }))).code).toBe(
      'CART_CHANGED'
    );
    expect(err(() => placeOrder(db, base({ cart }))).code).toBe('CART_CHANGED');
    expect(count('SELECT count(*) AS n FROM orders')).toBe(1);
    expect(count('SELECT count(*) AS n FROM cart_items')).toBe(0);
    expect(stock('products', 'sku')).toBe(9);
  });
  it('the same key after the claim returns the first order, not CART_CHANGED', () => {
    const { db, base, stock } = withCart();
    const cart = { id: 'cart1' };
    const a = placeOrder(db, base({ cart, idempotencyKey: 'k-a' }));
    const b = placeOrder(db, base({ cart, idempotencyKey: 'k-a' }));
    expect(b).toMatchObject({ orderId: a.orderId, replayed: true });
    expect(stock('products', 'sku')).toBe(9);
  });
  it('a cart whose LINES differ from the ones ordered (same count) is CART_CHANGED and keeps its rows', () => {
    const { raw, db, base, count } = withCart();
    // the cart holds sku x1; the shopper priced sku x5 (another tab changed the quantity)
    expect(
      err(() =>
        placeOrder(db, base({ cart: { id: 'cart1' }, lines: [{ productId: 'sku', quantity: 5 }] }))
      ).code
    ).toBe('CART_CHANGED');
    expect(count('SELECT count(*) AS n FROM cart_items')).toBe(1);
    expect(count('SELECT count(*) AS n FROM orders')).toBe(0);
    expect(raw).toBeTruthy();
  });
  it('an idempotency key is scoped to its cart: another cart with the same key gets its OWN order, never the first one', () => {
    const { raw, db, base } = withCart();
    raw.exec(`INSERT INTO carts (id, store_id, session_id) VALUES ('cart3', 's1', 'sess3')`);
    raw.exec(
      `INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ('ci3', 'cart3', 'sku', 1)`
    );
    const a = placeOrder(db, base({ cart: { id: 'cart1' }, idempotencyKey: 'shared-key' }));
    const b = placeOrder(db, base({ cart: { id: 'cart3' }, idempotencyKey: 'shared-key' }));
    expect(b.orderId).not.toBe(a.orderId);
    expect(b.replayed).toBe(false);
  });
  it('a changed cart, another store cart, or a failed order leaves the cart claimable', () => {
    const { raw, db, base, count } = withCart();
    // another tab added a second line after the shopper priced one
    raw.exec(
      `INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ('ci9', 'cart1', 'vprod', 1)`
    );
    expect(err(() => placeOrder(db, base({ cart: { id: 'cart1' } }))).code).toBe('CART_CHANGED');
    raw.exec(`DELETE FROM cart_items WHERE id = 'ci9'`);
    expect(err(() => placeOrder(db, base({ cart: { id: 'cart2' } }))).code).toBe('CART_CHANGED');
    // an order that fails AFTER the claim (more than the shelf holds) rolls the claim back with it
    raw.exec(`UPDATE cart_items SET quantity = 99 WHERE id = 'ci1'`);
    const failed = err(() =>
      placeOrder(db, base({ cart: { id: 'cart1' }, lines: [{ productId: 'sku', quantity: 99 }] }))
    );
    expect(failed.code).not.toBe('CART_CHANGED');
    expect(count('SELECT count(*) AS n FROM cart_items')).toBe(1); // rolled back with the failed order
    expect(count('SELECT count(*) AS n FROM orders')).toBe(0);
    expect(raw).toBeTruthy();
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
    expect(placeOrder(db, base({ couponCode: 'BIG' })).couponDiscount).toBe(1500); // fixed: capped at the subtotal; max_discount is for percentages (Postgres parity)
    expect(err(() => placeOrder(db, base({ couponCode: 'MIN' }))).code).toBe('MIN_ORDER_NOT_MET');
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
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', 's1', 'A', 'B', 'cust')`
    );
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

describe('checkout core: review fixes (coupon identity, targeting, trust boundary)', () => {
  const coupon = (
    raw: ReturnType<typeof fixture>['raw'],
    id: string,
    extra: string,
    vals: string
  ) =>
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids${extra}) VALUES ('${id}', 's1', '${id.toUpperCase()}', 'x', 'fixed', 100, '[]', '[]'${vals})`
    );

  it('a one-per-customer coupon is enforced for GUESTS by normalised phone or email; a different guest is allowed', () => {
    const { raw, db, base } = fixture();
    coupon(raw, 'once', ', usage_limit_per_user', ', 1');
    const guest = (phone: string, email: string) =>
      base({ couponCode: 'ONCE', shippingAddress: { name: 'g', phone, email } });
    placeOrder(db, guest('01012345678', 'A@x.com'));
    expect(err(() => placeOrder(db, guest('+201012345678', 'other@x.com'))).code).toBe(
      'COUPON_USER_LIMIT'
    ); // same phone, other spelling
    expect(err(() => placeOrder(db, guest('01099999999', ' a@X.com '))).code).toBe(
      'COUPON_USER_LIMIT'
    ); // same email, other case
    placeOrder(db, guest('01011112222', 'different@x.com')); // a different guest
  });

  it('a guest with NO phone and NO email cannot use a per-customer coupon (no stable key): clear error, nothing burned', () => {
    const { raw, db, base } = fixture();
    coupon(raw, 'once', ', usage_limit_per_user', ', 1');
    expect(
      err(() => placeOrder(db, base({ couponCode: 'ONCE', shippingAddress: { name: 'anon' } })))
        .code
    ).toBe('COUPON_NEEDS_CONTACT');
    expect(
      (raw.prepare(`SELECT usage_count n FROM coupons WHERE id = 'once'`).get() as { n: number }).n
    ).toBe(0);
  });

  it('cancelled orders do not count against the per-customer limit', () => {
    const { raw, db, base } = fixture();
    coupon(raw, 'once', ', usage_limit_per_user', ', 1');
    const o = placeOrder(
      db,
      base({ couponCode: 'ONCE', shippingAddress: { phone: '01012345678' } })
    );
    raw.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(o.orderId);
    placeOrder(db, base({ couponCode: 'ONCE', shippingAddress: { phone: '01012345678' } }));
  });

  it('a limit of 0 means unlimited (Postgres truthiness)', () => {
    const { raw, db, base } = fixture();
    coupon(raw, 'zero', ', usage_limit, usage_limit_per_user', ', 0, 0');
    for (let i = 0; i < 3; i++)
      placeOrder(
        db,
        base({
          couponCode: 'ZERO',
          holdCaps: { manual: 99 },
          shippingAddress: { phone: '01012345678' },
        })
      );
  });

  it('targeting: product scope, customer group, first-order-only and min quantity are enforced; the discount base is the matching subtotal', () => {
    const { raw, db, base } = fixture();
    raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('other', 's1', 'Other', 'other', 1000, 10, 'active')`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('scoped', 's1', 'SCOPED', 'x', 'percentage', 10, '["sku"]', '[]')`
    );
    const o = placeOrder(
      db,
      base({
        couponCode: 'SCOPED',
        lines: [
          { productId: 'sku', quantity: 1 },
          { productId: 'other', quantity: 1 },
        ],
      })
    );
    expect(o.couponDiscount).toBe(150); // 10% of the sku line only (1500), not of 2500
    expect(
      err(() =>
        placeOrder(db, base({ couponCode: 'SCOPED', lines: [{ productId: 'other', quantity: 1 }] }))
      ).code
    ).toBe('COUPON_NOT_ELIGIBLE');
    raw.exec(`INSERT INTO customer_groups (id, store_id, name) VALUES ('vip', 's1', 'VIP')`);
    raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, group_id, user_id) VALUES ('crm-vip', 's1', 'V', 'I', 'vip', 'vipc'), ('crm-plain', 's1', 'P', 'L', NULL, 'plain')`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, customer_group_id, scope_product_ids, scope_category_ids) VALUES ('vipc1', 's1', 'VIPONLY', 'x', 'fixed', 100, 'vip', '[]', '[]')`
    );
    placeOrder(db, base({ couponCode: 'VIPONLY', customerId: 'vipc' }));
    expect(
      err(() => placeOrder(db, base({ couponCode: 'VIPONLY', customerId: 'plain' }))).code
    ).toBe('COUPON_NOT_ELIGIBLE');
    expect(err(() => placeOrder(db, base({ couponCode: 'VIPONLY' }))).code).toBe(
      'COUPON_NOT_ELIGIBLE'
    ); // a guest is in no group
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, first_order_only, min_quantity, scope_product_ids, scope_category_ids) VALUES ('first', 's1', 'FIRST', 'x', 'fixed', 100, 1, 2, '[]', '[]')`
    );
    expect(err(() => placeOrder(db, base({ couponCode: 'FIRST', customerId: 'plain' }))).code).toBe(
      'COUPON_NOT_ELIGIBLE'
    ); // quantity 1 < 2
    placeOrder(
      db,
      base({ couponCode: 'FIRST', customerId: 'plain', lines: [{ productId: 'sku', quantity: 2 }] })
    );
    expect(
      err(() =>
        placeOrder(
          db,
          base({
            couponCode: 'FIRST',
            customerId: 'plain',
            lines: [{ productId: 'sku', quantity: 2 }],
          })
        )
      ).code
    ).toBe('COUPON_NOT_ELIGIBLE'); // no longer a first order
  });

  it('free_shipping zeroes the shipping line (and uses one redemption); expectedTotal gates a changed price', () => {
    const { raw, db, base } = fixture();
    fees(raw, 4000);
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('fs', 's1', 'SHIPFREE', 'x', 'free_shipping', 0, '[]', '[]')`
    );
    expect(placeOrder(db, base({ couponCode: 'SHIPFREE' }))).toMatchObject({
      shipping: 0,
      total: 1500,
    });
    expect(err(() => placeOrder(db, base({ expectedTotal: 1500 }))).code).toBe('PRICE_CHANGED');
    expect(placeOrder(db, base({ expectedTotal: 5500 })).total).toBe(5500);
  });

  it('a variant without its own price inherits the product price; untracked products are not decremented', () => {
    const { raw, db, base, stock } = fixture();
    raw.exec(`UPDATE product_variants SET price = NULL WHERE id = 'v1'`);
    raw.exec(`UPDATE products SET price = 777 WHERE id = 'vprod'`);
    expect(
      placeOrder(db, base({ lines: [{ productId: 'vprod', variantId: 'v1', quantity: 1 }] }))
        .subtotal
    ).toBe(777);
    raw.exec(`UPDATE products SET track_inventory = 0 WHERE id = 'vprod'`);
    placeOrder(db, base({ lines: [{ productId: 'vprod', variantId: 'v1', quantity: 5 }] })); // 2 left, ordering 5: allowed, nothing decremented
    expect(stock('product_variants', 'v1')).toBe(2);
  });

  it('backorder only when the store feature is on; a customer id is a users.id (no CRM row needed); a key reused for a different order conflicts', () => {
    const { db, base } = fixture();
    expect(
      err(() =>
        placeOrder(db, base({ lines: [{ productId: 'vprod', variantId: 'v2', quantity: 5 }] }))
      ).code
    ).toBe('OUT_OF_STOCK');
    // the customer id is the shopper's users.id: no CRM row is needed, and nothing is looked up in `customers` by it
    expect(placeOrder(db, base({ customerId: 'user-without-crm-row' })).orderNumber).toBeTruthy();
    expect(err(() => placeOrder(db, base({ customerId: '' }))).code).toBe('BAD_ARGS');
    placeOrder(db, base({ idempotencyKey: 'dup-key' }));
    expect(
      err(() =>
        placeOrder(
          db,
          base({ idempotencyKey: 'dup-key', lines: [{ productId: 'sku', quantity: 2 }] })
        )
      ).code
    ).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('stock-hold cap: a third open COD order from one phone is refused; a gateway label has the looser cap; paid orders do not count', () => {
    const { raw, db, base } = fixture();
    raw.exec(`UPDATE products SET inventory = 100 WHERE id = 'sku'`);
    const o = (pm: string) =>
      base({ paymentMethod: pm, shippingAddress: { phone: '01012345678' } });
    placeOrder(db, o('cod'));
    placeOrder(db, o('cod'));
    expect(err(() => placeOrder(db, o('cod'))).code).toBe('TOO_MANY_OPEN_ORDERS');
    placeOrder(db, o('card')); // gateway cap is 5, 2 open
    const ipA = (i: number) =>
      base({
        paymentMethod: 'cod',
        checkoutIp: '9.9.9.9',
        shippingAddress: { phone: `0101000000${i}` },
        // QA-HOLDS-1: the COD IP ceiling default is now 40 per 24 h; this pins the engine's counting at an explicit 8
        holdCaps: { ip: 8 },
      });
    for (let i = 0; i < 8; i++) placeOrder(db, ipA(i));
    expect(err(() => placeOrder(db, ipA(9))).code).toBe('TOO_MANY_OPEN_ORDERS');
  });

  it('a 100% coupon with a wallet request does not write a zero wallet transaction', () => {
    const { raw, db, base } = fixture();
    raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', 's1', 'A', 'B', 'cust')`
    );
    raw.exec(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1', 's1', 'cust', 500)`
    );
    raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('full', 's1', 'FULL', 'x', 'percentage', 100, '[]', '[]')`
    );
    const o = placeOrder(db, base({ customerId: 'cust', couponCode: 'FULL', walletAmount: 300 }));
    expect(o).toMatchObject({ total: 0, walletAmount: 0 });
    expect(
      (raw.prepare(`SELECT balance n FROM customer_wallets WHERE id = 'w1'`).get() as { n: number })
        .n
    ).toBe(500);
  });

  it('stock-hold cap counts a FAILED-payment order as an open hold (Ruling INV-AUDIT-2): declined cards cannot pin stock past the cap', () => {
    const { raw, db, base } = fixture();
    raw.exec(`UPDATE products SET inventory = 100 WHERE id = 'sku'`);
    const o = () => base({ paymentMethod: 'cod', shippingAddress: { phone: '01012345678' } });
    placeOrder(db, o());
    placeOrder(db, o());
    // both orders' payments were declined: the webhook moved them unpaid -> failed, and they still hold their units
    raw.exec(`UPDATE orders SET payment_status = 'failed'`);
    expect(err(() => placeOrder(db, o())).code).toBe('TOO_MANY_OPEN_ORDERS');
    // a PAID order is still not a hold
    raw.exec(`UPDATE orders SET payment_status = 'paid'`);
    expect(placeOrder(db, o()).orderNumber).toBeTruthy();
  });

  it('the hold cap is decided from the FINAL payment state: a token wallet amount does not exempt, a full wallet payment does, an omitted method is capped strictly', () => {
    const { raw, db, base } = fixture();
    raw.exec(`UPDATE products SET inventory = 100 WHERE id = 'sku'`);
    raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', 's1', 'A', 'B', 'cust')`
    );
    raw.exec(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1', 's1', 'cust', 100000)`
    );
    const phone = { phone: '01012345678' };
    placeOrder(db, base({ paymentMethod: 'cod', shippingAddress: phone }));
    placeOrder(db, base({ paymentMethod: 'cod', shippingAddress: phone }));
    // 1 EGP (100 piastres) from the wallet + COD remainder is still capped
    const e = err(() =>
      placeOrder(
        db,
        base({
          paymentMethod: 'cod',
          customerId: 'cust',
          walletAmount: 100,
          shippingAddress: phone,
        })
      )
    );
    expect(e.code).toBe('TOO_MANY_OPEN_ORDERS');
    expect(
      (raw.prepare(`SELECT balance n FROM customer_wallets WHERE id = 'w1'`).get() as { n: number })
        .n
    ).toBe(100000); // the refused order took nothing
    // the method omitted: the strict (cod) cap applies
    expect(err(() => placeOrder(db, base({ shippingAddress: phone }))).code).toBe(
      'TOO_MANY_OPEN_ORDERS'
    );
    // a wallet that pays IN FULL is exempt (nothing is held unpaid)
    const full = placeOrder(
      db,
      base({ paymentMethod: 'cod', customerId: 'cust', walletAmount: 1500, shippingAddress: phone })
    );
    expect(full).toMatchObject({ paymentStatus: 'paid', walletAmount: 1500 });
  });
});
