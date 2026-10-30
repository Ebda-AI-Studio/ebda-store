// DO promotions + bundles port: node:sqlite on the real StoreDO schema; targeting maths differential vs the
// Postgres original (apps/api/src/services/promotion-targeting.ts, pure).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  cartItemsForTargeting,
  computeDiscount,
  matchesTargeting,
  resolveBestPromotion,
  resolveBundles,
  resolveCustomerContext,
  resolvePromotions,
  type CartItemForTargeting,
} from '../src/do/promotions';
import { resolveCartPrices, type Buyer } from '../src/do/pricing';
import { MoneyError } from '../src/do/sync-sql';
import * as pgTargeting from '../../../apps/api/src/services/promotion-targeting';

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  let n = 0;
  const product = (
    id: string,
    price: number,
    o: {
      store?: string;
      inventory?: number;
      track?: number;
      status?: string;
      audience?: string;
    } = {}
  ) =>
    x(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, track_inventory, status, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.store ?? 's1',
      `P ${id}`,
      `slug-${id}`,
      price,
      o.inventory ?? 100,
      o.track ?? 1,
      o.status ?? 'active',
      o.audience ?? 'public'
    );
  const category = (id: string, productIds: string[]) => {
    x(`INSERT INTO categories (id, store_id, name, slug) VALUES (?, 's1', ?, ?)`, id, id, id);
    for (const p of productIds)
      x(`INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)`, p, id);
  };
  const promo = (
    id: string,
    o: {
      store?: string;
      type?: string;
      value: number;
      max?: number | null;
      priority?: number;
      active?: number;
      starts?: number | null;
      expires?: number | null;
      group?: string | null;
      first?: number;
      minAmount?: number | null;
      minQty?: number | null;
      products?: string[] | string;
      categories?: string[] | string;
    }
  ) =>
    x(
      `INSERT INTO promotions (id, store_id, name, type, value, max_discount, priority, is_active, starts_at, expires_at,
         customer_group_id, first_order_only, min_order_amount, min_quantity, scope_product_ids, scope_category_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.store ?? 's1',
      id,
      o.type ?? 'percentage',
      o.value,
      o.max ?? null,
      o.priority ?? 0,
      o.active ?? 1,
      o.starts ?? null,
      o.expires ?? null,
      o.group ?? null,
      o.first ?? 0,
      o.minAmount ?? null,
      o.minQty ?? null,
      typeof o.products === 'string' ? o.products : JSON.stringify(o.products ?? []),
      typeof o.categories === 'string' ? o.categories : JSON.stringify(o.categories ?? []),
      1000 + n++ // distinct created_at so ordering is by priority then newest
    );
  const group = (id: string) =>
    x(
      `INSERT INTO customer_groups (id, store_id, name, pricing_mode, discount_bps) VALUES (?, 's1', ?, 'none', 0)`,
      id,
      id
    );
  const customer = (id: string, userId: string | null, groupId: string | null) =>
    x(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id, group_id) VALUES (?, 's1', 'A', 'B', ?, ?)`,
      id,
      userId,
      groupId
    );
  const order = (
    id: string,
    o: { customer?: string | null; status?: string; phone?: string; email?: string; store?: string }
  ) =>
    x(
      `INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, status)
       VALUES (?, ?, ?, 1, 1, ?, '{}', ?, ?)`,
      id,
      o.store ?? 's1',
      id,
      JSON.stringify({ phone: o.phone, email: o.email }),
      o.customer ?? null,
      o.status ?? 'pending'
    );
  const items = (...i: Array<[string, number, number, string[]?]>): CartItemForTargeting[] =>
    i.map(([productId, quantity, lineTotal, categoryIds]) => ({
      productId,
      quantity,
      lineTotal,
      categoryIds: categoryIds ?? [],
    }));
  return { raw, db, x, product, category, promo, group, customer, order, items };
}
const err = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a MoneyError');
};
const anon: Buyer = { kind: 'anonymous' };
const NOW = 5_000_000;

describe('DO promotions: discount maths + best-of', () => {
  it('percentage uses Math.round (half up), max_discount caps, fixed clamps to the base', () => {
    const f = fixture();
    f.promo('pct', { value: 15 });
    const ci = f.items(['p', 1, 1005]);
    // 1005 * 15 / 100 = 150.75 -> 151
    expect(
      resolveBestPromotion(
        f.db,
        's1',
        { customerGroupId: null, isFirstOrder: true, cartItems: ci },
        NOW
      )
    ).toEqual({
      promotionId: 'pct',
      discount: 151,
    });
    const g = fixture();
    g.promo('cap', { value: 50, max: 100 });
    g.promo('fixed', { value: 99999, type: 'fixed', priority: -1 });
    const best = resolveBestPromotion(
      g.db,
      's1',
      { customerGroupId: null, isFirstOrder: true, cartItems: g.items(['p', 1, 1000]) },
      NOW
    );
    expect(best).toEqual({ promotionId: 'fixed', discount: 1000 }); // fixed clamps to the 1000 base and beats the capped 100
    expect(computeDiscount('percentage', 15, null, 1005)).toBe(151);
  });

  it('largest discount wins; on an equal discount the higher priority wins; free_shipping/inactive/expired/other-store never resolve', () => {
    const f = fixture();
    f.promo('low-prio-big', { value: 20, priority: 1 });
    f.promo('hi-prio-same', { value: 20, priority: 9 });
    f.promo('smaller', { value: 5, priority: 100 });
    f.promo('ship', { value: 100, type: 'free_shipping', priority: 100 });
    f.promo('off', { value: 90, active: 0 });
    f.promo('expired', { value: 90, expires: NOW - 1 });
    f.promo('future', { value: 90, starts: NOW + 1 });
    f.promo('foreign', { value: 90, store: 's2' });
    const ctx = { customerGroupId: null, isFirstOrder: true, cartItems: f.items(['p', 1, 1000]) };
    expect(resolveBestPromotion(f.db, 's1', ctx, NOW)).toEqual({
      promotionId: 'hi-prio-same',
      discount: 200,
    });
  });

  it('the sale window is inclusive on both ends', () => {
    const f = fixture();
    f.promo('w', { value: 10, starts: NOW, expires: NOW });
    const ctx = { customerGroupId: null, isFirstOrder: true, cartItems: f.items(['p', 1, 1000]) };
    expect(resolveBestPromotion(f.db, 's1', ctx, NOW)?.promotionId).toBe('w');
    expect(resolveBestPromotion(f.db, 's1', ctx, NOW + 1)).toBeNull();
    expect(resolveBestPromotion(f.db, 's1', ctx, NOW - 1)).toBeNull();
  });

  it('targeting: product OR category scope, matching-subtotal base, min amount / quantity', () => {
    const f = fixture();
    f.promo('scoped', {
      value: 10,
      products: ['a'],
      categories: ['cat'],
      minAmount: 500,
      minQty: 2,
    });
    const run = (cartItems: CartItemForTargeting[]) =>
      resolveBestPromotion(
        f.db,
        's1',
        { customerGroupId: null, isFirstOrder: true, cartItems },
        NOW
      );
    expect(run(f.items(['a', 1, 600], ['b', 1, 400]))).toBeNull(); // matching qty 1 < 2
    expect(run(f.items(['a', 2, 600], ['b', 1, 400]))?.discount).toBe(60); // base = matching subtotal only
    expect(run(f.items(['b', 2, 600, ['cat']], ['c', 1, 400]))?.discount).toBe(60); // category match
    expect(run(f.items(['a', 2, 300]))).toBeNull(); // below minAmount 500
    expect(run(f.items(['z', 3, 9000]))).toBeNull(); // nothing in scope
  });

  it('a corrupt scope JSON is SKIPPED, never widened to the whole cart', () => {
    const f = fixture();
    f.raw.exec('PRAGMA ignore_check_constraints = ON'); // the schema would refuse these rows: simulate corruption
    f.promo('bad', { value: 50, products: 'not json' });
    f.promo('badshape', { value: 50, categories: '{"a":1}' });
    const ctx = { customerGroupId: null, isFirstOrder: true, cartItems: f.items(['p', 1, 1000]) };
    expect(resolveBestPromotion(f.db, 's1', ctx, NOW)).toBeNull();
  });

  it('a stored percentage above 100 cannot discount more than the matching subtotal', () => {
    const f = fixture();
    f.promo('wild', { value: 250 });
    const ctx = { customerGroupId: null, isFirstOrder: true, cartItems: f.items(['p', 1, 1000]) };
    expect(resolveBestPromotion(f.db, 's1', ctx, NOW)?.discount).toBe(1000);
  });

  it('hostile cart amounts are refused', () => {
    const f = fixture();
    for (const lineTotal of [-1, 1.5, NaN, 3e9]) {
      expect(
        err(() =>
          resolveBestPromotion(
            f.db,
            's1',
            { customerGroupId: null, isFirstOrder: true, cartItems: f.items(['p', 1, lineTotal]) },
            NOW
          )
        ).code
      ).toBe('BAD_INPUT');
    }
  });
});

describe('DO promotions: customer context (group + first order)', () => {
  it('group targeting needs the buyer IDENTITY: a session member qualifies, a guest never does', () => {
    const f = fixture();
    f.group('vip');
    f.customer('c1', 'u1', 'vip');
    f.promo('vip10', { value: 10, group: 'vip' });
    const base = { storeId: 's1', cartItems: f.items(['p', 1, 1000]), now: NOW };
    expect(
      resolvePromotions(f.db, { ...base, buyer: { kind: 'session', userId: 'u1' } })
        .appliedPromotionId
    ).toBe('vip10');
    // a typed phone/email cannot buy a group benefit
    expect(
      resolvePromotions(f.db, { ...base, buyer: anon, phone: '+201000000000', email: 'vip@x.com' })
        .appliedPromotionId
    ).toBeNull();
    expect(
      resolvePromotions(f.db, { ...base, buyer: { kind: 'session', userId: 'u2' } })
        .appliedPromotionId
    ).toBeNull();
  });

  it('first order: by customer id (cancelled and deleted orders do not count), by session user, by guest phone/email', () => {
    const f = fixture();
    f.customer('c1', 'u1', null);
    // orders carry the shopper's users.id (u1), NOT the CRM row id (c1) (Ruling CF-FIX-2)
    f.order('o1', { customer: 'u1', status: 'cancelled' });
    expect(resolveCustomerContext(f.db, 's1', { customerId: 'u1' }, anon).isFirstOrder).toBe(true);
    f.order('o2', { customer: 'u1' });
    expect(resolveCustomerContext(f.db, 's1', { customerId: 'u1' }, anon).isFirstOrder).toBe(false);
    // a session buyer without a customerId counts its orders by its users.id
    expect(
      resolveCustomerContext(f.db, 's1', {}, { kind: 'session', userId: 'u1' }).isFirstOrder
    ).toBe(false);
    f.raw.exec(`UPDATE orders SET deleted_at = 1 WHERE id = 'o2'`);
    expect(
      resolveCustomerContext(f.db, 's1', {}, { kind: 'session', userId: 'u1' }).isFirstOrder
    ).toBe(true);
    // guest identity by typed phone / email, raw or E.164
    f.order('g1', { phone: '+201001234567', email: 'a@b.com' });
    expect(resolveCustomerContext(f.db, 's1', { phone: '+201001234567' }, anon).isFirstOrder).toBe(
      false
    );
    expect(resolveCustomerContext(f.db, 's1', { phone: '01001234567' }, anon).isFirstOrder).toBe(
      false
    );
    expect(resolveCustomerContext(f.db, 's1', { email: ' A@B.com ' }, anon).isFirstOrder).toBe(
      false
    );
    expect(resolveCustomerContext(f.db, 's1', { phone: '+201009999999' }, anon).isFirstOrder).toBe(
      true
    );
    expect(resolveCustomerContext(f.db, 's1', {}, anon).isFirstOrder).toBe(true);
    // another store's order does not count
    f.order('x', { phone: '+201112223334', store: 's2' });
    expect(resolveCustomerContext(f.db, 's1', { phone: '+201112223334' }, anon).isFirstOrder).toBe(
      true
    );
  });

  it('a first-order-only promotion is refused to a returning customer', () => {
    const f = fixture();
    f.customer('c1', 'u1', null);
    f.order('o', { customer: 'c1' });
    f.promo('welcome', { value: 10, first: 1 });
    const r = resolvePromotions(f.db, {
      storeId: 's1',
      buyer: { kind: 'session', userId: 'u1' },
      customerId: 'c1',
      cartItems: f.items(['p', 1, 1000]),
      now: NOW,
    });
    expect(r.appliedPromotionId).toBeNull();
  });
});

describe('DO promotions: promotion vs coupon (best-of, exact tie, never stack)', () => {
  const setup = () => {
    const f = fixture();
    f.promo('promo', { value: 10 }); // 100 on 1000
    return f;
  };
  const run = (
    f: ReturnType<typeof fixture>,
    couponDiscount: number,
    couponType: 'percentage' | 'fixed' | 'free_shipping' | null
  ) =>
    resolvePromotions(f.db, {
      storeId: 's1',
      buyer: anon,
      cartItems: f.items(['p', 1, 1000]),
      couponDiscount,
      couponType,
      now: NOW,
    });

  it('promotion strictly larger: promotion applies, the coupon is NOT consumed or recorded', () => {
    const r = run(setup(), 50, 'fixed');
    expect(r).toMatchObject({
      primaryDiscount: 100,
      appliedPromotionId: 'promo',
      promotionDiscount: 100,
      couponApplied: false,
      couponDiscount: 0,
    });
  });
  it('EXACT TIE: the promotion wins and the coupon is not double counted', () => {
    const r = run(setup(), 100, 'fixed');
    expect(r).toMatchObject({
      primaryDiscount: 100,
      appliedPromotionId: 'promo',
      promotionDiscount: 100,
      couponApplied: false,
      couponDiscount: 0,
    });
  });
  it('coupon strictly larger: coupon applies, no promotion id and no promotion discount recorded', () => {
    const r = run(setup(), 300, 'percentage');
    expect(r).toMatchObject({
      primaryDiscount: 300,
      appliedPromotionId: null,
      promotionDiscount: 0,
      couponApplied: true,
      couponDiscount: 300,
    });
  });
  it('free_shipping coupon always applies alongside the promotion (acts on the shipping line)', () => {
    const r = run(setup(), 0, 'free_shipping');
    expect(r).toMatchObject({
      appliedPromotionId: 'promo',
      promotionDiscount: 100,
      couponApplied: true,
      couponDiscount: 0,
    });
  });
  it('no promotion: the coupon stands; neither: zeros; negative/float coupon discount is refused', () => {
    const f = fixture();
    expect(run(f, 40, 'fixed')).toMatchObject({
      couponApplied: true,
      couponDiscount: 40,
      appliedPromotionId: null,
    });
    expect(run(f, 0, null)).toMatchObject({
      primaryDiscount: 0,
      couponApplied: false,
      appliedPromotionId: null,
    });
    expect(err(() => run(f, -1, 'fixed')).code).toBe('BAD_INPUT');
    expect(err(() => run(f, 1.5, 'fixed')).code).toBe('BAD_INPUT');
  });
});

describe('DO promotions: priced cart feeds only base-priced lines (Ruling B2B-5)', () => {
  it('a tier-priced line is excluded from the promotion base; categories come from product_categories', () => {
    const f = fixture();
    f.product('a', 1000);
    f.product('b', 1000);
    f.category('cat', ['a']);
    f.x(
      `INSERT INTO product_price_tiers (id, store_id, product_id, min_qty, price_minor) VALUES ('t', 's1', 'b', 2, 800)`
    );
    const priced = resolveCartPrices(f.db, {
      storeId: 's1',
      buyer: anon,
      wholesaleEntitled: true,
      lines: [
        { key: '1', productId: 'a', qty: 1 },
        { key: '2', productId: 'b', qty: 2 },
      ],
    });
    const items = cartItemsForTargeting(f.db, 's1', priced);
    expect(items).toEqual([{ productId: 'a', categoryIds: ['cat'], quantity: 1, lineTotal: 1000 }]);
    f.promo('all', { value: 10 });
    expect(
      resolvePromotions(f.db, { storeId: 's1', buyer: anon, cartItems: items, now: NOW })
        .promotionDiscount
    ).toBe(100);
  });
});

describe('differential: targeting maths vs the Postgres original', () => {
  it('600 random targeting/discount cases agree exactly', () => {
    let seed = 99;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const ids = ['a', 'b', 'c', 'd'];
    const cats = ['x', 'y', 'z'];
    for (let i = 0; i < 600; i++) {
      const t = {
        customerGroupId: rnd(3) === 0 ? 'g' : null,
        firstOrderOnly: rnd(4) === 0,
        minOrderAmount: rnd(3) === 0 ? rnd(3000) : null,
        minQuantity: rnd(3) === 0 ? rnd(6) : null,
        scopeProductIds: ids.filter(() => rnd(5) === 0),
        scopeCategoryIds: cats.filter(() => rnd(6) === 0),
      };
      const ctx = {
        customerGroupId: rnd(2) ? 'g' : null,
        isFirstOrder: rnd(2) === 1,
        cartItems: Array.from({ length: rnd(5) }, () => ({
          productId: ids[rnd(4)],
          categoryIds: cats.filter(() => rnd(3) === 0),
          quantity: 1 + rnd(5),
          lineTotal: rnd(2000),
        })),
      };
      expect(matchesTargeting(t, ctx)).toEqual(pgTargeting.matchesTargeting(t, ctx));
      const type = (['percentage', 'fixed', 'free_shipping'] as const)[rnd(3)];
      const value = type === 'percentage' ? rnd(101) : rnd(3000);
      const max = rnd(3) === 0 ? rnd(500) : null;
      const base = rnd(100000);
      expect(computeDiscount(type, value, max, base)).toBe(
        pgTargeting.computeDiscount(type, value, max, base)
      );
    }
  });
});

describe('DO bundles', () => {
  const setup = () => {
    const f = fixture();
    f.product('a', 1000);
    f.product('b', 500);
    const bundle = (
      id: string,
      type: string,
      value: number,
      items: Array<[string, number, string?]>,
      o: { store?: string; active?: number; starts?: number | null; expires?: number | null } = {}
    ) => {
      f.x(
        `INSERT INTO bundles (id, store_id, name, slug, pricing_type, pricing_value, is_active, starts_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        o.store ?? 's1',
        `B ${id}`,
        id,
        type,
        value,
        o.active ?? 1,
        o.starts ?? null,
        o.expires ?? null
      );
      items.forEach(([productId, quantity, variantId], i) =>
        f.x(
          `INSERT INTO bundle_items (id, bundle_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?, ?)`,
          `${id}-i${i}`,
          id,
          productId,
          variantId ?? null,
          quantity
        )
      );
    };
    return { ...f, bundle };
  };
  const req = (bundleId: string, quantity = 1) => ({
    storeId: 's1',
    bundles: [{ bundleId, quantity }],
    now: NOW,
  });

  it('percentage floors the discount; subtotal and bundleDiscount multiply by the box count; allocation sums to the price', () => {
    const f = setup();
    // components: 1000 + 2*500 = 2000; 12.5% (1250 bps) -> floor(250) = 250 off -> 1750
    f.bundle('pct', 'percentage', 1250, [
      ['a', 1],
      ['b', 2],
    ]);
    const r = resolveBundles(f.db, req('pct', 3));
    expect(r).toMatchObject({ bundlesSubtotal: 5250, bundleDiscount: 750, bundleIds: ['pct'] });
    const box = r.boxes[0];
    expect(box).toMatchObject({ componentSum: 2000, price: 1750, quantity: 3 });
    expect(box.components.reduce((s, c) => s + c.totalAllocated, 0)).toBe(1750);
    expect(box.components.every(c => c.unitAllocated * c.quantity === c.totalAllocated)).toBe(true);
    // floor, not round: 3 piastres * 5000 bps would be 1.5 -> 1
    f.product('t', 3);
    f.bundle('floor', 'percentage', 5000, [['t', 1]]);
    expect(resolveBundles(f.db, req('floor')).boxes[0].price).toBe(2);
  });

  it('fixed (piastres off) and fixed_price, clamped into [0, componentSum]', () => {
    const f = setup();
    f.bundle('fx', 'fixed', 300, [
      ['a', 1],
      ['b', 2],
    ]);
    f.bundle('fp', 'fixed_price', 1500, [
      ['a', 1],
      ['b', 2],
    ]);
    f.bundle('fp-high', 'fixed_price', 99999, [['a', 1]]);
    expect(resolveBundles(f.db, req('fx')).boxes[0].price).toBe(1700);
    expect(resolveBundles(f.db, req('fp')).boxes[0].price).toBe(1500);
    expect(resolveBundles(f.db, req('fp-high')).boxes[0].price).toBe(1000); // never above the components
  });

  it('component prices come from the CURRENT rows (variant price, else product price)', () => {
    const f = setup();
    f.x(
      `INSERT INTO product_variants (id, product_id, title, price, inventory) VALUES ('va', 'a', 'M', 1400, 5)`
    );
    f.product('s', 1000); // a simple product alongside
    f.x(`UPDATE products SET inventory = 0 WHERE id = 'a'`);
    f.bundle('v', 'percentage', 0, [
      ['a', 1, 'va'],
      ['s', 1],
    ]);
    expect(resolveBundles(f.db, req('v')).boxes[0].componentSum).toBe(2400);
    f.x(`UPDATE product_variants SET price = 2000 WHERE id = 'va'`);
    expect(resolveBundles(f.db, req('v')).boxes[0].componentSum).toBe(3000);
  });

  it('reads cart_bundles by cartId, tenant-checked through carts.store_id', () => {
    const f = setup();
    f.bundle('pct', 'percentage', 1000, [['a', 1]]);
    f.x(
      `INSERT INTO carts (id, store_id, session_id) VALUES ('cart1', 's1', 'x'), ('cart2', 's2', 'y')`
    );
    f.x(
      `INSERT INTO cart_bundles (id, cart_id, bundle_id, quantity) VALUES ('cb1', 'cart1', 'pct', 2), ('cb2', 'cart2', 'pct', 5)`
    );
    expect(resolveBundles(f.db, { storeId: 's1', cartId: 'cart1', now: NOW }).bundlesSubtotal).toBe(
      1800
    );
    expect(resolveBundles(f.db, { storeId: 's1', cartId: 'cart2', now: NOW }).boxes).toEqual([]); // other store's cart
    expect(
      err(() => resolveBundles(f.db, { storeId: 's1', cartId: 'cart1', bundles: [], now: NOW }))
        .code
    ).toBe('BAD_INPUT');
  });

  it('refuses (fail closed) when not purchasable: inactive, outside window, sold out, draft/deleted/wholesale component, drifted zero price', () => {
    const f = setup();
    f.bundle('ok', 'percentage', 0, [['a', 1]]);
    f.bundle('off', 'percentage', 0, [['a', 1]], { active: 0 });
    f.bundle('future', 'percentage', 0, [['a', 1]], { starts: NOW + 1 });
    f.bundle('past', 'percentage', 0, [['a', 1]], { expires: NOW - 1 });
    f.bundle('edge', 'percentage', 0, [['a', 1]], { starts: NOW, expires: NOW });
    f.bundle('big', 'percentage', 0, [['a', 101]]);
    f.bundle('zero', 'fixed', 999999, [['a', 1]]); // clamps to 0 over non-free components
    f.product('d', 100, { status: 'draft' });
    f.bundle('draft', 'percentage', 0, [['d', 1]]);
    f.product('w', 100, { audience: 'wholesale_only' });
    f.bundle('whole', 'percentage', 0, [['w', 1]]);
    f.product('gone', 100);
    f.x(`UPDATE products SET deleted_at = 1 WHERE id = 'gone'`);
    f.bundle('del', 'percentage', 0, [['gone', 1]]);
    f.product('vp', 100);
    f.x(
      `INSERT INTO product_variants (id, product_id, title, price, inventory) VALUES ('vv', 'vp', 'M', 100, 5)`
    );
    f.bundle('pinless', 'percentage', 0, [['vp', 1]]); // variant product pinned without a variant
    expect(resolveBundles(f.db, req('ok')).boxes).toHaveLength(1);
    expect(resolveBundles(f.db, req('edge')).boxes).toHaveLength(1); // window inclusive
    for (const id of ['off', 'future', 'past', 'big', 'zero', 'draft', 'whole', 'del', 'pinless'])
      expect(err(() => resolveBundles(f.db, req(id)))).toMatchObject({
        code: 'BUNDLE_NOT_PURCHASABLE',
        status: 409,
      });
    // one bad box fails the whole call
    expect(
      err(() =>
        resolveBundles(f.db, {
          storeId: 's1',
          bundles: [
            { bundleId: 'ok', quantity: 1 },
            { bundleId: 'off', quantity: 1 },
          ],
          now: NOW,
        })
      ).code
    ).toBe('BUNDLE_NOT_PURCHASABLE');
  });

  it("another store's bundle and a component from another store are unusable; hostile quantities are refused", () => {
    const f = setup();
    f.product('foreign', 100, { store: 's2' });
    f.bundle('theirs', 'percentage', 0, [['a', 1]], { store: 's2' });
    f.bundle('mixed', 'percentage', 0, [['foreign', 1]]); // our bundle pointing at their product
    expect(err(() => resolveBundles(f.db, req('theirs'))).code).toBe('NOT_FOUND');
    expect(err(() => resolveBundles(f.db, req('mixed'))).code).toBe('BUNDLE_NOT_PURCHASABLE');
    f.bundle('ok', 'percentage', 0, [['a', 1]]);
    for (const q of [0, -1, 1.5, 1001, NaN])
      expect(err(() => resolveBundles(f.db, req('ok', q))).code).toBe('BAD_QUANTITY');
    expect(err(() => resolveBundles(f.db, req(''))).code).toBe('BAD_INPUT');
  });
});
