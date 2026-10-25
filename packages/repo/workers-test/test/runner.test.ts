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
});
