// PR D2b-2 (Ruling CF-ORDERS-1): createOrder / confirmPayment / cancel / expireHold as named money operations on the real DO
// schema (node:sqlite). The engines are covered by money-stock / do-refund / do-payments; this proves the DOOR: registry,
// argument trust boundary, idempotency marker, one-section rollback, and the invariants the operations promise.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema, createPayment } from '../src/do/payments';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
function rig(stock = 10) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1500, ${stock}, 'active')`
  );
  const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>, key?: string): string => {
    try {
      op(name, args, key);
    } catch (e) {
      return (e as MoneyError).code;
    }
    return 'no error';
  };
  const order = (over: Record<string, unknown> = {}) => ({
    lines: [{ productId: 'sku', quantity: 1 }],
    shippingAddress: { name: 'A' },
    ...over,
  });
  return { raw, db, n, op, code, order };
}

describe('order money operations: the door', () => {
  it('the four operations are registered; storeId and now are never taken from the caller', () => {
    expect(MONEY_OP_NAMES).toEqual(
      expect.arrayContaining(['createOrder', 'confirmPayment', 'cancel', 'expireHold'])
    );
    const r = rig();
    const placed = r.op('createOrder', r.order({ storeId: 'other', now: 1 }));
    expect(
      r.n(`SELECT count(*) n FROM orders WHERE store_id = 's1' AND id = '${placed.orderId}'`)
    ).toBe(1);
    expect(r.n(`SELECT count(*) n FROM orders WHERE store_id = 'other'`)).toBe(0);
    expect(r.n(`SELECT created_at n FROM orders`)).toBeGreaterThan(1_700_000_000_000);
  });

  it('createOrder reserves stock, writes the ledger and the order in one section; a keyed replay writes nothing', () => {
    const r = rig();
    const a = r.op(
      'createOrder',
      r.order({ lines: [{ productId: 'sku', quantity: 3 }] }),
      'order:abcdefgh'
    );
    expect(a).toMatchObject({ subtotal: 4500, paymentStatus: 'unpaid', replayed: false });
    const b = r.op(
      'createOrder',
      r.order({ lines: [{ productId: 'sku', quantity: 3 }] }),
      'order:abcdefgh'
    );
    expect(b).toEqual(a);
    expect(r.n(`SELECT inventory n FROM products`)).toBe(7);
    expect(r.n(`SELECT count(*) n FROM orders`)).toBe(1);
    expect(r.n(`SELECT count(*) n FROM inventory_history`)).toBe(1);
    expect(
      r.code(
        'createOrder',
        r.order({ lines: [{ productId: 'sku', quantity: 1 }] }),
        'order:abcdefgh'
      )
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a refused order leaves nothing behind (no stock, no marker, no coupon use)', () => {
    const r = rig(2);
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c', 's1', 'ONE', 'x', 'fixed', 100, 1, '[]', '[]')`
    );
    expect(
      r.code(
        'createOrder',
        r.order({ couponCode: 'ONE', lines: [{ productId: 'sku', quantity: 5 }] }),
        'order:refused1'
      )
    ).toBe('OUT_OF_STOCK');
    expect(r.n(`SELECT inventory n FROM products`)).toBe(2);
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBe(0);
    expect(r.n(`SELECT count(*) n FROM _money_ops`)).toBe(0);
  });

  it('the last items: N orders for stock S succeed exactly S times and stock never goes negative', () => {
    const r = rig(5);
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      try {
        r.op('createOrder', r.order());
        ok++;
      } catch (e) {
        expect((e as MoneyError).code).toBe('OUT_OF_STOCK');
      }
    }
    expect(ok).toBe(5);
    expect(r.n(`SELECT inventory n FROM products`)).toBe(0);
  });

  it('cancel restores stock and the coupon use exactly once; a replay and a second cancel change nothing', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c', 's1', 'TWO', 'x', 'fixed', 100, 2, '[]', '[]')`
    );
    const o = r.op(
      'createOrder',
      r.order({ couponCode: 'TWO', lines: [{ productId: 'sku', quantity: 2 }] })
    );
    expect(r.n(`SELECT inventory n FROM products`)).toBe(8);
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBe(1);
    expect(r.op('cancel', { orderId: o.orderId })).toMatchObject({
      status: 'cancelled',
      replayed: false,
    });
    expect(r.n(`SELECT inventory n FROM products`)).toBe(10);
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBe(0);
    expect(r.op('cancel', { orderId: o.orderId })).toMatchObject({ replayed: true });
    expect(r.n(`SELECT inventory n FROM products`)).toBe(10);
    expect(r.code('cancel', { orderId: 'missing' })).not.toBe('no error');
    expect(r.code('cancel', {})).toBe('BAD_ARGS');
  });

  it('a delivered order cannot be cancelled (the state machine holds)', () => {
    const r = rig();
    const o = r.op('createOrder', r.order());
    r.raw.exec(`UPDATE orders SET status = 'delivered', payment_status = 'paid'`);
    expect(r.code('cancel', { orderId: o.orderId })).toBe('INVALID_TRANSITION');
    expect(r.n(`SELECT inventory n FROM products`)).toBe(9);
  });

  it('confirmPayment once, expireHold skips a confirmed order, and an expired hold gives its stock back', () => {
    const r = rig();
    const hold = (expiresAt: number) => {
      const o = r.op('createOrder', r.order({ paymentMethod: 'instapay' }));
      r.raw.exec(
        `UPDATE orders SET status = 'awaiting_payment_confirmation', payment_confirmation_expires_at = ${expiresAt} WHERE id = '${o.orderId}'`
      );
      createPayment(r.db, {
        storeId: S,
        orderId: o.orderId,
        provider: 'instapay',
        amount: o.total,
      });
      return o.orderId as string;
    };
    const live = hold(Date.now() + 3_600_000);
    expect(r.op('expireHold', { orderId: live })).toBe('skipped'); // window still open
    expect(r.op('confirmPayment', { orderId: live, actorUserId: 'u1' })).toMatchObject({
      changed: true,
      status: 'confirmed',
    });
    expect(r.op('confirmPayment', { orderId: live })).toMatchObject({ changed: false });
    expect(r.op('expireHold', { orderId: live })).toBe('skipped'); // confirmed meanwhile

    const old = hold(Date.now() - 1000);
    expect(r.n(`SELECT inventory n FROM products`)).toBe(8);
    expect(r.op('expireHold', { orderId: old, proofSubmitted: true })).toBe('skipped'); // proof sent: waits for the merchant
    expect(r.op('expireHold', { orderId: old })).toBe('expired');
    expect(r.n(`SELECT inventory n FROM products`)).toBe(9);
    expect(r.code('confirmPayment', { orderId: old })).toBe('INSTAPAY_ORDER_CANCELLED');
  });

  it('OPUS C4: a logged-in shopper (users.id) checks out and a merchant order is placed for them, with a differing CRM id AND with no CRM row at all', () => {
    const r = rig(100);
    // u-a has a CRM row whose id differs from the user id; u-b has no CRM row on this store at all
    r.raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-a', 's1', 'A', 'B', 'u-a')`
    );
    for (const u of ['u-a', 'u-b']) {
      expect(r.code('createOrder', r.order({ customerId: u, paymentMethod: 'cod' }))).toBe(
        'no error'
      );
      expect(
        r.code('createAdminOrder', {
          lines: [{ productId: 'sku', quantity: 1 }],
          shippingAddress: { firstName: 'A', lastName: 'B', phone: '01012345678' },
          customerId: u,
          actorId: 'admin',
          actorRole: 'store_admin',
        })
      ).toBe('no error');
      expect(r.n(`SELECT count(*) n FROM orders WHERE customer_id = '${u}'`)).toBe(2);
    }
  });

  it('wallet never goes negative and a coupon never passes its limit, across many orders', () => {
    const r = rig(100);
    r.raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', 's1', 'A', 'B', 'cust')`
    );
    r.raw.exec(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1', 's1', 'cust', 4000)`
    );
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c', 's1', 'THREE', 'x', 'fixed', 100, 3, '[]', '[]')`
    );
    for (let i = 0; i < 10; i++)
      try {
        r.op(
          'createOrder',
          r.order({
            customerId: 'cust',
            walletAmount: 1400,
            couponCode: 'THREE',
            paymentMethod: 'card',
          })
        );
      } catch {
        /* refused: fine */
      }
    expect(r.n(`SELECT balance n FROM customer_wallets`)).toBeGreaterThanOrEqual(0);
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBeLessThanOrEqual(3);
    // the wallet (4000) pays two 1400 orders; the third is refused as a whole and burns no coupon use
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBe(2);
    expect(r.n(`SELECT balance n FROM customer_wallets`)).toBe(1200);
    expect(r.n(`SELECT 4000 - balance n FROM customer_wallets`)).toBe(
      r.n(`SELECT -sum(amount) n FROM wallet_transactions`)
    );
  });

  it('the hold cap holds: a third open COD order from one phone is refused and costs no stock', () => {
    const r = rig();
    const o = () =>
      r.order({
        paymentMethod: 'cod',
        shippingAddress: { phone: '01012345678' },
        holdCaps: { manual: 2 },
      });
    r.op('createOrder', o());
    r.op('createOrder', o());
    expect(r.code('createOrder', o())).toBe('TOO_MANY_OPEN_ORDERS');
    expect(r.n(`SELECT inventory n FROM products`)).toBe(8);
  });

  it('cancel with restoreInventory:false keeps the goods out of stock but still releases the coupon, unarmed like Postgres', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c', 's1', 'ONE', 'x', 'fixed', 100, 5, '[]', '[]')`
    );
    const o = r.op(
      'createOrder',
      r.order({ couponCode: 'ONE', lines: [{ productId: 'sku', quantity: 4 }] })
    );
    expect(r.op('cancel', { orderId: o.orderId, restoreInventory: false })).toMatchObject({
      status: 'cancelled',
    });
    expect(r.n(`SELECT inventory n FROM products`)).toBe(6);
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBe(0);
    expect(
      r.n(`SELECT count(*) n FROM orders WHERE refund_reversal_requested_at IS NOT NULL`)
    ).toBe(0);
    expect(r.n(`SELECT count(*) n FROM orders WHERE refund_reversed_at IS NOT NULL`)).toBe(1);
  });

  it('createOrder stamps notes, locale, sms opt-in and source in the same section', () => {
    const r = rig();
    r.op(
      'createOrder',
      r.order({ orderNotes: 'ring', locale: 'ar', smsOptIn: true, source: 'agent' })
    );
    expect(
      r.n(
        `SELECT count(*) n FROM orders WHERE notes = 'ring' AND locale = 'ar' AND sms_opt_in = 1 AND source = 'agent'`
      )
    ).toBe(1);
    r.op('createOrder', r.order());
    expect(
      r.n(`SELECT count(*) n FROM orders WHERE sms_opt_in = 0 AND source = 'web' AND notes IS NULL`)
    ).toBe(1);
  });

  // QA-COUPON-1 / QA-HOLDS-1 on the Durable Object path (the storefront-shaped COD payload).
  it('QA-COUPON-1: a COD order with a percentage coupon is charged EXACTLY the quoted total (cap and expectedTotal agree)', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, max_discount, min_order_amount, scope_product_ids, scope_category_ids) VALUES ('q', 's1', 'QA20', 'x', 'percentage', 20, 30000, 2000, '[]', '[]')`
    );
    const payload = r.order({
      paymentMethod: 'cod',
      couponCode: 'qa20', // storefront sends what the validate response returned; matching is case-insensitive
      shippingAddress: { phone: '01012345678', email: 'a@b.com' },
      lines: [{ productId: 'sku', quantity: 3 }],
    });
    const quote = r.op('quoteOrder', payload);
    const placed = r.op('createOrder', { ...payload, expectedTotal: quote.total });
    expect(quote.discount).toBe(900); // 20% of 4500
    expect(placed.total).toBe(quote.total);
    expect(placed.discount).toBe(quote.discount);
    expect(r.n(`SELECT coupon_discount n FROM orders`)).toBe(900);
    expect(r.n(`SELECT usage_count n FROM coupons`)).toBe(1);
  });

  it('QA-COUPON-1: an expectedTotal that does not match what would be charged is refused, nothing is written', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('q', 's1', 'QA20', 'x', 'percentage', 20, '[]', '[]')`
    );
    // the buyer saw the coupon price (3600); the order is placed WITHOUT the coupon (the dropped-coupon failure)
    const code = r.code(
      'createOrder',
      r.order({
        paymentMethod: 'cod',
        expectedTotal: 3600,
        lines: [{ productId: 'sku', quantity: 3 }],
      })
    );
    expect(code).toBe('PRICE_CHANGED');
    expect(r.n(`SELECT count(*) n FROM orders`)).toBe(0);
    expect(r.n(`SELECT inventory n FROM products`)).toBe(10);
  });

  it('QA-COUPON-1: a percentage coupon stored with value 0 is refused, never silently "applied"', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('z', 's1', 'ZERO', 'x', 'percentage', 0, '[]', '[]')`
    );
    expect(r.code('quoteOrder', r.order({ couponCode: 'ZERO' }))).toBe('COUPON_INVALID');
    expect(r.code('createOrder', r.order({ couponCode: 'ZERO' }))).toBe('COUPON_INVALID');
    expect(r.n(`SELECT count(*) n FROM orders`)).toBe(0);
  });

  it('QA-HOLDS-1: eight COD orders from one egress IP with different phones are accepted; the 40th-window ceiling still refuses', () => {
    const r = rig(100);
    const from = (phone: string) =>
      r.order({
        paymentMethod: 'cod',
        checkoutIp: '41.40.1.1',
        shippingAddress: { phone },
        holdCaps: { manual: 2, ip: 8 },
      });
    for (let i = 0; i < 8; i++)
      r.op('createOrder', { ...from(`0101234567${i}`), holdCaps: { manual: 2, gateway: 5 } });
    expect(r.n(`SELECT count(*) n FROM orders`)).toBe(8); // default ceiling is 40, not 8
    expect(r.code('createOrder', from('01099999999'))).toBe('TOO_MANY_OPEN_ORDERS'); // explicit ceiling of 8
  });

  it('QA-HOLDS-1: holds older than the IP window stop counting toward the IP ceiling (a slow-confirming merchant never blocks today)', () => {
    const r = rig(50);
    const o = (phone: string) =>
      r.order({
        paymentMethod: 'cod',
        checkoutIp: '41.40.1.1',
        shippingAddress: { phone },
        holdCaps: { manual: 2, ip: 3, ipWindowHours: 24 },
      });
    for (let i = 0; i < 3; i++) r.op('createOrder', o(`0101234567${i}`));
    expect(r.code('createOrder', o('01011111111'))).toBe('TOO_MANY_OPEN_ORDERS');
    r.raw.exec(`UPDATE orders SET created_at = created_at - 25 * 3600 * 1000`); // yesterday's, still pending
    expect(r.code('createOrder', o('01011111111'))).toBe('no error');
  });

  describe('#633: a manual (phone) order takes no stock, so its cancel / refund puts none back', () => {
    const admin = (qty: number) => ({
      lines: [{ productId: 'sku', quantity: qty }],
      shippingAddress: { firstName: 'A', lastName: 'B', phone: '01012345678' },
      actorId: 'admin',
      actorRole: 'store_admin',
    });
    const stock = (r: ReturnType<typeof rig>) =>
      r.n(`SELECT inventory n FROM products WHERE id = 'sku'`);

    it('cancel adds nothing back (was +3 phantom units)', () => {
      const r = rig(10);
      const o = r.op('createAdminOrder', admin(3));
      expect(stock(r)).toBe(10);
      r.op('cancel', { orderId: o.orderId });
      expect(stock(r)).toBe(10);
    });

    it('a refund after confirming adds nothing back either; a storefront order still restocks', () => {
      const r = rig(10);
      const o = r.op('createAdminOrder', admin(2));
      r.raw.exec(
        `UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = '${o.orderId}'`
      );
      r.op('refundBook', { orderId: o.orderId });
      expect(stock(r)).toBe(10);
      const s = r.op('createOrder', r.order({ lines: [{ productId: 'sku', quantity: 4 }] }));
      expect(stock(r)).toBe(6);
      r.op('cancel', { orderId: s.orderId });
      expect(stock(r)).toBe(10);
    });
  });
});
