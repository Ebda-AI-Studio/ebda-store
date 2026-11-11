import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR R4 (Ruling CF-R4-2): the merchant's manual order on real workerd. Postgres serialised its coupon claim with a
// conditional UPDATE and the per-customer limit with a pg_advisory_xact_lock; here the single DO thread does both, so
// concurrent phone orders can never pass a coupon limit, a per-customer cap or leave a gap in the fiscal numbers.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const admin = (over: object = {}) => ({
  lines: [{ productId: 'p1', quantity: 1 }],
  shippingAddress: { firstName: 'A', lastName: 'B', phone: '01012345678' },
  actorId: 'admin',
  actorRole: 'store_admin',
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

async function seed(store: string, extra = '', stock = 10) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store (a refusal, nothing written)
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      store,
      store
    );
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, ?, 'active')`,
      store,
      stock
    );
    if (extra) for (const q of extra.split(';;')) s.storage.sql.exec(q.replaceAll('$S', store));
  });
  return stub;
}
const coupon = (limit: number, perUser = 0) =>
  `INSERT INTO coupons (id, store_id, code, name, type, value, usage_limit, usage_limit_per_user, scope_product_ids, scope_category_ids) VALUES ('c1', '$S', 'SEVEN', 'x', 'fixed', 100, ${limit}, ${perUser}, '[]', '[]')`;

describe('StoreDO.moneyOp createAdminOrder', () => {
  it('a coupon with 7 uses, 40 concurrent phone orders: exactly 7 get it, the rest are refused, usage_count ends at 7', async () => {
    const stub = await seed('adm-coupon', coupon(7));
    const answers = await Promise.all(
      Array.from({ length: 40 }, () =>
        op(stub, 'adm-coupon', 'createAdminOrder', admin({ couponCode: 'seven' }))
      )
    );
    expect(codes(answers)).toEqual({ ok: 7, COUPON_LIMIT_REACHED: 33 });
    expect(await num(stub, `SELECT usage_count AS n FROM coupons`)).toBe(7);
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE coupon_code = 'SEVEN'`)).toBe(7);
    // an admin order reserves its unit; a refused one (coupon limit) rolls back and takes none
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(3);
  });

  it('a per-customer limit of 1, 25 concurrent phone orders for one guest phone: exactly one gets the coupon', async () => {
    const stub = await seed('adm-peruser', coupon(0, 1));
    const answers = await Promise.all(
      Array.from({ length: 25 }, () =>
        op(stub, 'adm-peruser', 'createAdminOrder', admin({ couponCode: 'SEVEN' }))
      )
    );
    expect(codes(answers)).toEqual({ ok: 1, COUPON_LIMIT_REACHED: 24 });
    expect(await num(stub, `SELECT usage_count AS n FROM coupons`)).toBe(1);
  });

  it('an override races the limit: every permitted override is recorded as an event and counted, none is lost', async () => {
    const stub = await seed('adm-override', coupon(2), 100);
    const answers = await Promise.all(
      Array.from({ length: 12 }, () =>
        op(
          stub,
          'adm-override',
          'createAdminOrder',
          admin({
            couponCode: 'SEVEN',
            overrideCouponRules: true,
            couponOverrideReason: 'phone deal',
          })
        )
      )
    );
    expect(codes(answers)).toEqual({ ok: 12 });
    expect(await num(stub, `SELECT usage_count AS n FROM coupons`)).toBe(12);
    expect(
      await num(stub, `SELECT count(*) AS n FROM order_events WHERE to_status = 'coupon_override'`)
    ).toBe(12);
    // the override is recorded for the 10 orders that broke the limit, and for the 2 that did not (empty violations)
    expect(
      await num(
        stub,
        `SELECT count(*) AS n FROM order_events WHERE json_array_length(json_extract(metadata, '$.violations')) > 0`
      )
    ).toBe(10);
  });

  it('50 concurrent phone orders get 50 consecutive receipt numbers: no gap, no duplicate', async () => {
    const stub = await seed('adm-gapless', '', 100);
    const answers = await Promise.all(
      Array.from({ length: 50 }, () => op(stub, 'adm-gapless', 'createAdminOrder', admin()))
    );
    expect(codes(answers)).toEqual({ ok: 50 });
    const serials = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql
        .exec(`SELECT serial FROM fiscal_documents WHERE doc_type = 'receipt' ORDER BY serial`)
        .toArray()
        .map(r => r.serial as number)
    );
    expect(serials).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(await num(stub, `SELECT count(DISTINCT order_number) AS n FROM orders`)).toBe(50);
  });

  it('phone orders racing checkouts of the last items: one stock decides, never an oversell, every refusal is a clean 4xx', async () => {
    const stub = await seed('adm-mixed');
    const calls = [
      ...Array.from({ length: 30 }, () => op(stub, 'adm-mixed', 'createAdminOrder', admin())),
      ...Array.from({ length: 30 }, () =>
        op(stub, 'adm-mixed', 'createOrder', {
          lines: [{ productId: 'p1', quantity: 1 }],
          shippingAddress: { name: 'A' },
        })
      ),
    ];
    const answers = await Promise.all(calls);
    const c = codes(answers);
    // 10 units, 60 racers (phone orders now reserve like checkout): exactly 10 win, stock ends at 0, never negative
    expect(c.ok).toBe(10);
    expect((c.OUT_OF_STOCK ?? 0) + (c.INSUFFICIENT_STOCK ?? 0)).toBe(50);
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(0);
    expect(await num(stub, `SELECT count(*) AS n FROM orders`)).toBe(10);
    expect(await num(stub, `SELECT count(DISTINCT serial) AS n FROM fiscal_documents`)).toBe(10);
  });

  it('a phone order and a checkout that draw the same order number in one second both succeed, with distinct numbers', async () => {
    const stub = await seed('adm-ordnum');
    const real = crypto.getRandomValues.bind(crypto);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T10:00:00.250Z') }); // one second for both orders
    let forced = 3; // order 1 draws 0; order 2 draws 0 (taken), 0 (taken), then a real one
    const spy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(a: T) => {
        if (a instanceof Uint32Array && a.length === 1 && forced > 0) {
          forced--;
          a[0] = 0;
          return a;
        }
        return real(a as never) as T;
      });
    try {
      const answers = await Promise.all([
        op(stub, 'adm-ordnum', 'createAdminOrder', admin()),
        op(stub, 'adm-ordnum', 'createOrder', {
          lines: [{ productId: 'p1', quantity: 1 }],
          shippingAddress: { name: 'A' },
        }),
      ]);
      expect(codes(answers)).toEqual({ ok: 2 });
      expect(forced).toBe(0);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    const nums = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql
        .exec(`SELECT order_number FROM orders`)
        .toArray()
        .map(r => r.order_number as string)
    );
    expect(new Set(nums).size).toBe(2);
    expect(nums.filter(n => n.endsWith('-00000'))).toHaveLength(1);
    expect(nums.every(n => /^ORD-[0-9A-Z]{6}-[0-9A-Z]{5}$/.test(n))).toBe(true);
  });

  it('a random source that only ever repeats a taken number: a clean 503 refusal, nothing written, no 500', async () => {
    const stub = await seed('adm-ordnum-dead');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T10:00:00.250Z') }); // one second for both orders
    const spy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(a: T) => {
        if (a instanceof Uint32Array) a.fill(0);
        return a;
      });
    let answers: Answer[];
    try {
      answers = [await op(stub, 'adm-ordnum-dead', 'createAdminOrder', admin())];
      answers.push(
        await op(stub, 'adm-ordnum-dead', 'createOrder', {
          lines: [{ productId: 'p1', quantity: 1 }],
          shippingAddress: { name: 'A' },
        })
      );
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(answers[0]!.ok).toBe(true);
    expect(answers[1]).toMatchObject({ ok: false, code: 'ORDER_NUMBER_UNAVAILABLE', status: 503 });
    expect(await num(stub, `SELECT count(*) AS n FROM orders`)).toBe(1);
    // the first (phone) order took its unit; the refused checkout took none
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(9);
  });
});
