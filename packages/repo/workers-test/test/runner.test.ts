import { computeGoldUnitPrice } from '../../../shared/src/commerce/gold-price';
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

const fresh = async (name: string) => {
  const s = env.LITE_DO.get(env.LITE_DO.idFromName(`${name}-${Math.random()}`));
  await (s as any).seed();
  return s as any;
};

describe('prisma-lite on a real Durable Object (workerd)', () => {
  it('basic write + read through the DO runner', async () => {
    const s = await fresh('basic');
    expect(await s.names()).toEqual({ p1: 'alpha', p2: 'beta' });
  });

  it('an unrelated request that runs while an interactive transaction waits on a timer is NOT rolled back with it', async () => {
    const s = await fresh('interleave');
    const [a, b] = await Promise.all([s.txThatFailsAfterTimer(), s.unrelatedWrite()]);
    expect(a).toBe('A fails');
    expect(b).toBe('ok');
    const names = await s.names();
    expect(names.p1).toBe('alpha'); // A rolled back
    expect(names.p2).toBe('OUTSIDE'); // B survived
  });

  it('a failing nested create leaves nothing behind and maps the unique violation with plain column names', async () => {
    const s = await fresh('nested');
    const r = await s.nestedAtomicity();
    expect(r.startsWith('P2002|')).toBe(true);
    expect(r).not.toContain('SQLITE_CONSTRAINT');
    expect(await s.exists('half')).toBe(false);
  });

  it('an error caught inside an interactive transaction leaves no half-applied nested write', async () => {
    const s = await fresh('caught');
    expect(await s.caughtInsideTx()).toBe(0);
    expect(await s.exists('after')).toBe(true);
    expect(await s.exists('half2')).toBe(false);
  });

  it("the DO refuses a write that carries another store's id", async () => {
    const s = await fresh('store');
    expect(await s.foreignStoreWrite()).toMatch(/this store/);
  });
});

describe('phase 3 on a real Durable Object: money and stock under 100 parallel checkouts', () => {
  const stub = (n: string) =>
    env.LITE_DO.get(env.LITE_DO.idFromName(`${n}-${Math.random()}`)) as any;
  const line = { productId: 'sku', quantity: 1 };

  it('100 parallel checkouts on one SKU with 30 in stock: exactly 30 orders, stock 0, no oversell, ledger matches', async () => {
    const s = stub('stock');
    await s.seedMoney(30, 1000, 0);
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        s.checkout({ lines: [line], shippingAddress: { i }, idempotencyKey: `k-${i}` })
      )
    );
    const ms = Date.now() - t0;
    const ok = results.filter((r: any) => r.ok).length;
    const codes = results.filter((r: any) => !r.ok).map((r: any) => r.code);
    expect(ok).toBe(30);
    expect(codes.length).toBe(70);
    expect(new Set(codes)).toEqual(new Set(['OUT_OF_STOCK']));
    const snap = await s.snapshot();
    expect(snap).toMatchObject({ stock: 0, orders: 30, items: 30, sold: 30, orderNumbers: 30 });
    console.log(
      `100 parallel checkouts on one SKU: ${ms} ms total (${(ms / 100).toFixed(1)} ms each, local workerd)`
    );
  });

  it('100 parallel checkouts using a coupon with 10 uses: exactly 10 orders carry it, and failed orders did not burn a use', async () => {
    const s = stub('coupon');
    await s.seedMoney(1000, 10, 0);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        s.checkout({ lines: [line], couponCode: 'SALE', shippingAddress: {} })
      )
    );
    expect(results.filter((r: any) => r.ok).length).toBe(10);
    expect(new Set(results.filter((r: any) => !r.ok).map((r: any) => r.code))).toEqual(
      new Set(['COUPON_EXHAUSTED'])
    );
    const snap = await s.snapshot();
    expect(snap).toMatchObject({ couponUsed: 10, couponOrders: 10, orders: 10, stock: 990 }); // the 90 refused orders returned their stock
  });

  it('100 parallel wallet payments of 1,500 against a 15,000 balance: exactly 10 succeed, the balance ends at 0, never negative', async () => {
    const s = stub('wallet');
    await s.seedMoney(1000, 1000, 15000);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        s.checkout({ lines: [line], customerId: 'cust', walletAmount: 1500, shippingAddress: {} })
      )
    );
    expect(results.filter((r: any) => r.ok).length).toBe(10);
    const snap = await s.snapshot();
    expect(snap).toMatchObject({ wallet: 0, walletSpent: 15000, orders: 10, stock: 990 });
  });

  it('the same idempotency key sent 50 times in parallel creates ONE order and moves stock once', async () => {
    const s = stub('idem');
    await s.seedMoney(10, 1000, 0);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        s.checkout({ lines: [line], idempotencyKey: 'same-key', shippingAddress: {} })
      )
    );
    expect(new Set(results.map((r: any) => r.orderId)).size).toBe(1);
    expect(await s.snapshot()).toMatchObject({ orders: 1, stock: 9 });
  });

  it('guest per-customer coupon at limit-1: 50 parallel redemptions by the SAME phone (spelled two ways) -> exactly one wins; other guests are unaffected', async () => {
    const s = stub('guestcoupon');
    await s.seedMoney(1000, 1000, 0);
    await s.seedPerUserCoupon();
    const phones = ['01012345678', '+201012345678'];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        s.checkout({ lines: [line], couponCode: 'ONCE', shippingAddress: { phone: phones[i % 2] } })
      )
    );
    expect(results.filter((r: any) => r.ok).length).toBe(1);
    expect(new Set(results.filter((r: any) => !r.ok).map((r: any) => r.code))).toEqual(
      new Set(['COUPON_USER_LIMIT'])
    );
    const other = await s.checkout({
      lines: [line],
      couponCode: 'ONCE',
      shippingAddress: { phone: '01099998888' },
    });
    expect(other.ok).toBe(true);
    expect(await s.snapshot()).toMatchObject({ orders: 2 });
  });

  // 2026-10-25: a 67-byte GLOB in this CHECK failed EVERY swatch insert on a real DO ("pattern too complex",
  // workerd caps LIKE/GLOB at 50 bytes) while node:sqlite accepted it. Only a real workerd run can see it.
  it('the generated schema accepts a swatch colour on a real DO and still refuses a malformed one', async () => {
    const s = await fresh('swatch');
    for (const good of ['#a1b2c3', '#A1B2C3', null]) expect(await s.insertSwatch(good)).toBe('ok');
    for (const bad of ['#a1b2c', '#a1b2c3d', '#g1b2c3', 'a1b2c3d'])
      expect(await s.insertSwatch(bad)).toMatch(/CHECK|constraint/i);
  });
});

describe('gold rate write concurrent with checkouts on a real Durable Object', () => {
  const stub = () => env.LITE_DO.get(env.LITE_DO.idFromName(`gold-${Math.random()}`)) as any;
  const unit = (rate: number) =>
    computeGoldUnitPrice(
      {
        karat: 21,
        weightMg: 10_000,
        makingChargeType: 'fixed',
        makingChargeValue: 50_000,
        marginBps: 500,
      },
      rate,
      100
    ).unitPrice;

  it('50 checkouts interleaved with 10 rate writes: every order is priced with a rate that was current at its commit', async () => {
    const s = stub();
    await s.seedGold(100);
    const rates = Array.from({ length: 10 }, (_, i) => 300_000 + (i + 1) * 5_000); // +1.6% each, under the 5% gate
    const calls: Promise<any>[] = [];
    for (let i = 0; i < 50; i++) {
      calls.push(
        s.checkout({
          lines: [{ productId: 'ring', quantity: 1 }],
          customerId: 'cust',
          shippingAddress: { i },
          idempotencyKey: `g-${i}`,
          goldRequireQuote: false,
        })
      );
      if (i % 5 === 2) calls.push(s.applyRate(rates[Math.floor(i / 5)]));
    }
    const res = await Promise.all(calls);
    expect(res.filter(r => r.ok === false).map(r => r.code)).toEqual([]);
    const orders = await s.goldOrders();
    expect(orders).toHaveLength(50);
    // price == formula(rate stamped on the line), exact piastres
    for (const o of orders) expect(o.price).toBe(unit(o.rate));
    // rates only ever rose, so commit order must see a non-decreasing rate: no order priced with a rate that had already been replaced
    for (let i = 1; i < orders.length; i++)
      expect(orders[i].rate).toBeGreaterThanOrEqual(orders[i - 1].rate);
    // non-vacuous: the writes really interleaved with the checkouts
    expect(new Set(orders.map(o => o.rate)).size).toBeGreaterThanOrEqual(5);
    // the rates seen are all real ones
    const real = new Set([300_000, ...rates]);
    for (const o of orders) expect(real.has(o.rate)).toBe(true);
    const st = await s.goldState();
    expect(st).toMatchObject({ stock: 50, rate: rates[9], price: unit(rates[9]) });
  });

  it('with a shopper quote: a rate write between quote and commit is refused PRICE_CHANGED, never charged the old price', async () => {
    const s = stub();
    await s.seedGold(100);
    const quote = unit(300_000);
    const calls: Promise<any>[] = [];
    for (let i = 0; i < 50; i++) {
      calls.push(
        s.checkout({
          lines: [{ productId: 'ring', quantity: 1, quotedUnitPrice: quote }],
          customerId: 'cust',
          shippingAddress: { i },
          idempotencyKey: `q-${i}`,
        })
      );
      if (i === 24) calls.push(s.applyRate(310_000));
    }
    const res = await Promise.all(calls);
    const orders = await s.goldOrders();
    const refused = res.filter(r => r.ok === false);
    expect(refused.every(r => r.code === 'PRICE_CHANGED')).toBe(true);
    expect(orders.length + refused.length).toBe(50);
    for (const o of orders) {
      expect(o.rate).toBe(300_000);
      expect(o.price).toBe(quote);
    }
  });
});

describe('product search on a real Durable Object (FTS5 trigram)', () => {
  it('FTS5 + trigram works inside workerd: substring, short-word start, Arabic folding, no drift', async () => {
    const s = env.LITE_DO.get(env.LITE_DO.idFromName(`search-${Math.random()}`)) as any;
    expect(
      await s.searchSeed([
        ['a', 'Black crepe abaya', 'عباية كريب سوداء'],
        ['b', 'Navy chiffon abaya', 'عباية شيفون كحلي'],
        ['c', 'Leather boots', 'بوت جلد'],
        ['d', 'Gas cooker', 'بوتاجاز'],
      ])
    ).toBe(4);
    expect((await s.search('abaya')).sort()).toEqual(['a', 'b']);
    expect(await s.search('عبايه سوداء')).toEqual(['a']); // folded: ه for ة, no hamza
    expect((await s.search('بوت')).sort()).toEqual(['c', 'd']); // substring, like pg_trgm LIKE
    expect(await s.search('ch')).toEqual(['b']); // all words under 3 chars: word-start mode
    expect(await s.search('rep')).toEqual(['a']);
    expect(await s.searchDrift()).toEqual({ missing: [], orphaned: [], stale: [] });
  });
});

describe('refund, loyalty and hold-cap races on a real Durable Object', () => {
  const stub = async () => {
    const s = env.LITE_DO.get(env.LITE_DO.idFromName(`race-${Math.random()}`)) as any;
    await s.seedMoney(10, 1000, 20_000); // sku x10 @1500, coupon SALE (-100), wallet 20,000 for cust
    return s;
  };
  const base = { customerId: 'cust', shippingAddress: { name: 'A' } };

  it('30 parallel cancel + full-refund calls on one order: stock back ONCE, coupon released ONCE, wallet reversed ONCE', async () => {
    const s = await stub();
    const orderId = await s.placeRaw({
      ...base,
      lines: [{ productId: 'sku', quantity: 3 }],
      couponCode: 'SALE',
      walletAmount: 1000,
    });
    expect(await s.sqlOne(`SELECT inventory AS n FROM products WHERE id='sku'`)).toEqual({ n: 7 });
    const res = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? s.cancel(orderId) : s.refund({ orderId })))
    );
    // cancelled -> refunded is legal, so some of these succeed and some are refused; the money effects never repeat
    expect(res.some(r => r.ok)).toBe(true);
    expect(await s.sqlOne(`SELECT inventory AS n FROM products WHERE id='sku'`)).toEqual({ n: 10 });
    expect(await s.sqlOne(`SELECT usage_count AS n FROM coupons WHERE id='c'`)).toEqual({ n: 0 });
    expect(await s.sqlOne(`SELECT balance AS n FROM customer_wallets WHERE id='w'`)).toEqual({
      n: 20_000,
    });
    expect(
      await s.sqlOne(
        `SELECT count(*) AS n FROM wallet_transactions WHERE type='order_payment_reversal'`
      )
    ).toEqual({ n: 1 });
    expect(
      await s.sqlOne(`SELECT count(*) AS n FROM inventory_history WHERE type='return_stock'`)
    ).toEqual({ n: 1 });
  });

  it('20 parallel one-unit partial returns (distinct keys) of a 5-unit line restock exactly 5 (never more); a repeated key is a replay', async () => {
    const s = await stub();
    const orderId = await s.placeRaw({ ...base, lines: [{ productId: 'sku', quantity: 5 }] });
    await s.sqlRun(`UPDATE orders SET status = 'confirmed' WHERE id = ?`, orderId);
    const itemId = (await s.sqlOne(
      `SELECT id AS n FROM order_items WHERE order_id = ?`,
      orderId
    )) as any;
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.refund({
          orderId,
          refundKey: `r-${i % 10}`,
          lines: [{ orderItemId: itemId.n ?? itemId.id, quantity: 1 }],
        })
      )
    );
    // 10 distinct keys were processed once each (the other 10 calls are replays); only 5 units could ever come back
    expect(res.filter(r => r.ok && !r.replayed).length).toBe(10);
    expect(res.filter(r => r.ok && r.replayed).length).toBe(10);
    expect(await s.sqlOne(`SELECT inventory AS n FROM products WHERE id='sku'`)).toEqual({ n: 10 });
    expect(
      await s.sqlOne(
        `SELECT coalesce(sum(quantity),0) AS n FROM inventory_history WHERE type='return_stock'`
      )
    ).toEqual({ n: 5 });
  });

  it('amount-only partial refunds in parallel never exceed the order total (cumulative cap)', async () => {
    const s = await stub();
    const orderId = await s.placeRaw({ ...base, lines: [{ productId: 'sku', quantity: 2 }] }); // total 3000
    await s.sqlRun(
      `UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = ?`,
      orderId
    );
    const total = (await s.sqlOne(`SELECT total AS n FROM orders WHERE id = ?`, orderId)).n;
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.refund({ orderId, refundKey: `a-${i}`, amount: Math.floor(total / 4) })
      )
    );
    expect(res.filter(r => r.ok && !r.replayed).length).toBe(4);
    expect(res.filter(r => !r.ok).length).toBe(16);
  });

  it('loyalty: 30 parallel checkouts each redeeming 1,000 of 5,000 points never overdraw; points burned == points on orders', async () => {
    const s = await stub();
    await s.sqlRun(`INSERT INTO store_config (store_id, loyalty_enabled) VALUES ('s1', 1)`);
    await s.sqlRun(
      `INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned) VALUES ('lp', 's1', 'cust', 5000, 5000)`
    );
    await s.sqlRun(`UPDATE products SET inventory = 1000 WHERE id = 'sku'`);
    const res = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        s.checkout({
          ...base,
          lines: [{ productId: 'sku', quantity: 4 }],
          pointsToRedeem: 1000,
          loyaltyFeatureEnabled: true,
          idempotencyKey: `l-${i}`,
        })
      )
    );
    expect(res.filter(r => !r.ok).map(r => r.code)).toEqual([]);
    const bal = await s.sqlOne(`SELECT points AS n FROM loyalty_points WHERE id='lp'`);
    const onOrders = await s.sqlOne(
      `SELECT coalesce(sum(loyalty_points_redeemed),0) AS n FROM orders`
    );
    expect(bal.n).toBeGreaterThanOrEqual(0);
    expect(bal.n + onOrders.n).toBe(5000);
    expect(onOrders.n).toBe(5000); // all 5 redemptions that fit were granted, none more
  });

  it('hold cap: 20 parallel COD checkouts from one phone admit exactly 2', async () => {
    const s = await stub();
    await s.sqlRun(`UPDATE products SET inventory = 100 WHERE id = 'sku'`);
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.checkout({
          lines: [{ productId: 'sku', quantity: 1 }],
          paymentMethod: 'cod',
          shippingAddress: { phone: '01012345678', i },
          idempotencyKey: `h-${i}`,
        })
      )
    );
    expect(res.filter(r => r.ok).length).toBe(2);
    expect(new Set(res.filter(r => !r.ok).map(r => r.code))).toEqual(
      new Set(['TOO_MANY_OPEN_ORDERS'])
    );
  });
});
