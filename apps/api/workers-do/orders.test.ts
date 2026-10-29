import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR D2b-2 (Ruling CF-ORDERS-1): order operations on real workerd. The DO is single threaded, so stock, coupon,
// wallet and hold-cap checks and their writes are one step: concurrent orders can never oversell, pass a coupon limit,
// drive a wallet negative or exceed the hold cap, with NO row lock and no advisory lock.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (
  stub: ReturnType<typeof stubFor>,
  store: string,
  name: string,
  args: object,
  key?: string
) => (await stub.moneyOp(store, name, encodeRpc(args), key)) as Answer;
const order = (over: object = {}) => ({
  lines: [{ productId: 'p1', quantity: 1 }],
  shippingAddress: { name: 'A' },
  ...over,
});
const num = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

async function seed(store: string, stock: number, extra = '') {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store (a refusal, nothing written)
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, ?, 'active')`,
      store,
      stock
    );
    if (extra) for (const q of extra.split(';;')) s.storage.sql.exec(q.replaceAll('$S', store));
  });
  return stub;
}

describe('StoreDO.moneyOp orders', () => {
  it('60 concurrent orders for the last 25 items: exactly 25 succeed, stock ends at 0, one ledger row each', async () => {
    const stub = await seed('ord-stock', 25);
    const answers = await Promise.all(
      Array.from({ length: 60 }, () => op(stub, 'ord-stock', 'createOrder', order()))
    );
    expect(codes(answers)).toEqual({ ok: 25, OUT_OF_STOCK: 35 });
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(0);
    expect(await num(stub, `SELECT count(*) AS n FROM orders`)).toBe(25);
    expect(await num(stub, `SELECT count(*) AS n FROM inventory_history`)).toBe(25);
  });

  it('a coupon with 7 uses left, 40 concurrent orders: exactly 7 get it, usage_count never exceeds the limit', async () => {
    const stub = await seed(
      'ord-coupon',
      100,
      `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, scope_product_ids, scope_category_ids) VALUES ('c1', '$S', 'SEVEN', 'x', 'fixed', 100, 7, '[]', '[]')`
    );
    const answers = await Promise.all(
      Array.from({ length: 40 }, () =>
        op(stub, 'ord-coupon', 'createOrder', order({ couponCode: 'SEVEN' }))
      )
    );
    expect(codes(answers)).toEqual({ ok: 7, COUPON_EXHAUSTED: 33 });
    expect(await num(stub, `SELECT usage_count AS n FROM coupons`)).toBe(7);
    // the refused orders took no stock
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(93);
  });

  it('wallet of 5000 against 30 concurrent orders of 1000: 5 are paid from it, the balance ends at 0, never negative', async () => {
    const stub = await seed(
      'ord-wallet',
      100,
      `INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('cust', '$S', 'A', 'B');;INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1', '$S', 'cust', 5000)`
    );
    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        op(
          stub,
          'ord-wallet',
          'createOrder',
          order({ customerId: 'cust', walletAmount: 1000, paymentMethod: 'card' })
        )
      )
    );
    expect(codes(answers)).toEqual({ ok: 5, INSUFFICIENT_WALLET: 25 });
    expect(await num(stub, `SELECT balance AS n FROM customer_wallets`)).toBe(0);
    expect(await num(stub, `SELECT count(*) AS n FROM wallet_transactions`)).toBe(5);
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE payment_status = 'paid'`)).toBe(
      5
    );
  });

  it('hold cap 2 per phone, 20 concurrent COD orders: exactly 2 hold stock', async () => {
    const stub = await seed('ord-hold', 50);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(
          stub,
          'ord-hold',
          'createOrder',
          order({
            paymentMethod: 'cod',
            shippingAddress: { phone: '01012345678' },
            holdCaps: { manual: 2 },
          })
        )
      )
    );
    expect(codes(answers)).toEqual({ ok: 2, TOO_MANY_OPEN_ORDERS: 18 });
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(48);
  });

  it('20 concurrent calls with one key create one order; a cancel racing 20 cancels restores the stock once', async () => {
    const stub = await seed('ord-key', 10);
    const first = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(
          stub,
          'ord-key',
          'createOrder',
          order({ lines: [{ productId: 'p1', quantity: 2 }] }),
          'order:key-0001'
        )
      )
    );
    expect(new Set(first.map(a => (a as { json: string }).json)).size).toBe(1);
    expect(await num(stub, `SELECT count(*) AS n FROM orders`)).toBe(1);
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(8);
    const id = decodeRpc<{ orderId: string }>((first[0] as { json: string }).json).orderId;
    const cancels = await Promise.all(
      Array.from({ length: 20 }, () => op(stub, 'ord-key', 'cancel', { orderId: id }))
    );
    expect(cancels.every(a => a.ok)).toBe(true);
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(10);
    expect(
      await num(stub, `SELECT count(*) AS n FROM inventory_history WHERE type = 'return_stock'`)
    ).toBe(1);
  });

  it('a confirm racing an expiry: one wins, stock is only given back when the expiry wins', async () => {
    const stub = await seed('ord-race', 5);
    const placed = decodeRpc<{ orderId: string; total: number }>(
      (
        (await op(stub, 'ord-race', 'createOrder', order({ paymentMethod: 'instapay' }))) as {
          json: string;
        }
      ).json
    );
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec(
        `UPDATE orders SET status = 'awaiting_payment_confirmation', payment_confirmation_expires_at = ? WHERE id = ?`,
        Date.now() - 1000,
        placed.orderId
      );
      s.storage.sql.exec(
        `INSERT INTO payments (id, order_id, provider, status, amount, currency, metadata, created_at, updated_at) VALUES ('pay1', ?, 'instapay', 'pending', ?, 'EGP', '{}', 1, 1)`,
        placed.orderId,
        placed.total
      );
    });
    const answers = await Promise.all([
      ...Array.from({ length: 10 }, () =>
        op(stub, 'ord-race', 'expireHold', { orderId: placed.orderId })
      ),
      ...Array.from({ length: 10 }, () =>
        op(stub, 'ord-race', 'confirmPayment', { orderId: placed.orderId, proofSubmitted: true })
      ),
    ]);
    const status = await runInDurableObject(
      stub,
      (_i, s) => s.storage.sql.exec(`SELECT status FROM orders`).one().status as string
    );
    const stock = await num(stub, `SELECT inventory AS n FROM products`);
    expect(['cancelled', 'confirmed']).toContain(status);
    expect(stock).toBe(status === 'cancelled' ? 5 : 4);
    expect(answers.length).toBe(20);
  });

  // PR D2b-4 (Ruling CF-FINAL-1)
  it('40 concurrent submits of one cart state create exactly one order (the cart claim, no row lock)', async () => {
    const stub = await seed('ord-cart', 100);
    const answers = await Promise.all(
      Array.from({ length: 40 }, () =>
        op(
          stub,
          'ord-cart',
          'createOrder',
          order({ cartClaim: { id: 'cart-1', fingerprint: 'v1' } })
        )
      )
    );
    expect(codes(answers)).toEqual({ ok: 1, CART_CHANGED: 39 });
    expect(await num(stub, `SELECT count(*) AS n FROM orders`)).toBe(1);
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(99);
    const again = await op(
      stub,
      'ord-cart',
      'createOrder',
      order({ cartClaim: { id: 'cart-1', fingerprint: 'v2' } })
    );
    expect(again.ok).toBe(true); // a changed cart is a new purchase
  });

  it('30 concurrent deliveries of one COD order settle the payment once and write one event', async () => {
    const stub = await seed('ord-deliver', 5);
    const first = await op(stub, 'ord-deliver', 'createOrder', order({ paymentMethod: 'cod' }));
    if (!first.ok) throw new Error('seed order refused');
    const placed = decodeRpc<{ orderId: string; total: number }>(first.json);
    await op(stub, 'ord-deliver', 'paymentCreate', {
      orderId: placed.orderId,
      provider: 'cod',
      amount: placed.total,
    });
    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        op(stub, 'ord-deliver', 'orderStatus', { orderId: placed.orderId, status: 'delivered' })
      )
    );
    expect(answers.every(a => a.ok)).toBe(true);
    expect(
      await num(stub, `SELECT count(*) AS n FROM payment_events WHERE event_type = 'status_change'`)
    ).toBe(1);
    expect(await num(stub, `SELECT count(*) AS n FROM payments WHERE status = 'completed'`)).toBe(
      1
    );
  });
});
