// DO pricing port (tiers, group pricing, wholesale audience, MOQ): node:sqlite on the real StoreDO schema, plus a
// differential run against the Postgres original's pure `resolveUnitPrice` (packages/shared).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  assertMoqSatisfied,
  canSeeWholesaleOnly,
  resolveCartPrices,
  resolveLinePrice,
  type Buyer,
  type PricingCtx,
} from '../src/do/pricing';
import { MoneyError } from '../src/do/sync-sql';
import { resolveUnitPrice, type PriceTierRow } from '../../shared/src/pricing/resolve-unit-price';

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const product = (
    id: string,
    price: number,
    o: { store?: string; moq?: number | null; audience?: string; status?: string } = {}
  ) =>
    x(
      `INSERT INTO products (id, store_id, name, slug, price, moq, audience, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.store ?? 's1',
      `P ${id}`,
      `slug-${id}`,
      price,
      o.moq ?? null,
      o.audience ?? 'public',
      o.status ?? 'active'
    );
  const variant = (id: string, productId: string, price: number | null, active = 1) =>
    x(
      `INSERT INTO product_variants (id, product_id, title, price, is_active) VALUES (?, ?, ?, ?, ?)`,
      id,
      productId,
      `V ${id}`,
      price,
      active
    );
  const group = (
    id: string,
    o: { store?: string; mode?: string; bps?: number; active?: number; wholesale?: number } = {}
  ) =>
    x(
      `INSERT INTO customer_groups (id, store_id, name, pricing_mode, discount_bps, is_active, is_wholesale) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.store ?? 's1',
      `G ${id}`,
      o.mode ?? 'percent_off',
      o.bps ?? 0,
      o.active ?? 1,
      o.wholesale ?? 0
    );
  const customer = (id: string, userId: string | null, groupId: string | null, store = 's1') =>
    x(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id, group_id) VALUES (?, ?, 'A', 'B', ?, ?)`,
      id,
      store,
      userId,
      groupId
    );
  const tier = (
    id: string,
    productId: string,
    minQty: number,
    price: number,
    o: { variant?: string | null; group?: string | null; store?: string } = {}
  ) =>
    x(
      `INSERT INTO product_price_tiers (id, store_id, product_id, variant_id, group_id, min_qty, price_minor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.store ?? 's1',
      productId,
      o.variant ?? null,
      o.group ?? null,
      minQty,
      price
    );
  const ctx = (lines: PricingCtx['lines'], over: Partial<PricingCtx> = {}): PricingCtx => ({
    storeId: 's1',
    buyer: { kind: 'anonymous' },
    wholesaleEntitled: true,
    lines,
    ...over,
  });
  return { raw, db, x, product, variant, group, customer, tier, ctx };
}
const err = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a MoneyError');
};
const session = (userId: string): Buyer => ({ kind: 'session', userId });

describe('DO pricing: tiers', () => {
  it('anonymous pays the public tier once the PRODUCT quantity (summed across lines) reaches it', () => {
    const f = fixture();
    f.product('p', 1000);
    f.tier('t1', 'p', 5, 900);
    f.tier('t2', 'p', 10, 800);
    const one = f.ctx([{ key: 'a', productId: 'p', qty: 4 }]);
    expect(resolveCartPrices(f.db, one).lines[0].resolved).toMatchObject({
      unitMinor: 1000,
      source: 'base',
    });
    const split = f.ctx([
      { key: 'a', productId: 'p', qty: 3 },
      { key: 'b', productId: 'p', qty: 2 },
    ]);
    const out = resolveCartPrices(f.db, split);
    expect(out.lines.map(l => l.resolved.unitMinor)).toEqual([900, 900]);
    expect(out.lines[0]).toMatchObject({
      snapshot: {
        listPrice: 1000,
        priceSource: 'tier',
        priceTierMinQty: 5,
        priceGroupApplied: false,
      },
      couponEligible: false,
    });
    expect(out.looseSubtotal).toBe(4500);
    expect(out.couponBasisSubtotal).toBe(0);
    expect(
      resolveLinePrice(f.db, { ...f.ctx([]), line: { productId: 'p', qty: 12 } }).unitMinor
    ).toBe(800);
  });

  it('variant tiers use the VARIANT quantity; a product tier is skipped when the variant has its own price', () => {
    const f = fixture();
    f.product('p', 1000);
    f.variant('v1', 'p', 1200);
    f.variant('v2', 'p', null);
    f.tier('pt', 'p', 2, 500); // product-level, below both
    f.tier('vt', 'p', 3, 1000, { variant: 'v1' });
    const c = f.ctx([
      { key: 'a', productId: 'p', variantId: 'v1', qty: 2 },
      { key: 'b', productId: 'p', variantId: 'v2', qty: 1 },
    ]);
    const out = resolveCartPrices(f.db, c);
    // v1 has its own price (1200): the absolute product tier must not apply; variant qty 2 < 3 so no variant tier
    expect(out.byKey.get('a')!.resolved.unitMinor).toBe(1200);
    // v2 inherits the product price: product qty is 3 (>= 2) so the product tier applies
    expect(out.byKey.get('b')!.resolved).toMatchObject({ unitMinor: 500, tierMinQty: 2 });
  });

  it('plan off (wholesaleEntitled not literally true): tiers and group price are dropped', () => {
    const f = fixture();
    f.product('p', 1000);
    f.tier('t1', 'p', 2, 700);
    f.group('g', { bps: 2000 });
    f.customer('c1', 'u1', 'g');
    for (const entitled of [false, 'true' as unknown as boolean, undefined as unknown as boolean]) {
      const out = resolveCartPrices(
        f.db,
        f.ctx([{ key: 'a', productId: 'p', qty: 5 }], {
          wholesaleEntitled: entitled,
          buyer: session('u1'),
        })
      );
      expect(out.lines[0].resolved).toMatchObject({ unitMinor: 1000, source: 'base' });
      expect(out.priceGroupName).toBeNull();
    }
  });
});

describe('DO pricing: customer groups', () => {
  it('a session buyer linked through customers.user_id gets the percent_off price (exact half-up, no float)', () => {
    const f = fixture();
    f.product('p', 999);
    f.group('g', { bps: 1250 }); // 12.5%: 999 * 0.875 = 874.125 -> 874
    f.customer('c1', 'u1', 'g');
    const out = resolveCartPrices(
      f.db,
      f.ctx([{ key: 'a', productId: 'p', qty: 1 }], { buyer: session('u1') })
    );
    expect(out.lines[0].resolved).toMatchObject({
      unitMinor: 874,
      source: 'group',
      groupApplied: true,
      listMinor: 999,
    });
    expect(out.lines[0].snapshot).toMatchObject({ priceSource: 'group', priceGroupApplied: true });
    expect(out.priceGroupName).toBe('G g');
    // 1 piastre rounding: base 1000, 1250 bps = 875 exactly; base 1 at 5000 bps = 0.5 -> 1 (half-up)
    f.product('q', 1);
    f.group('half', { bps: 5000 });
    f.customer('c2', 'u2', 'half');
    expect(
      resolveLinePrice(f.db, {
        ...f.ctx([], { buyer: session('u2') }),
        line: { productId: 'q', qty: 1 },
      }).unitMinor
    ).toBe(1);
  });

  it('other users, inactive groups, other-store groups and mode none are retail', () => {
    const f = fixture();
    f.product('p', 1000);
    f.group('g', { bps: 3000 });
    f.group('off', { bps: 3000, active: 0 });
    f.group('none', { bps: 3000, mode: 'none' });
    f.group('foreign', { bps: 3000, store: 's2' });
    f.customer('c1', 'u1', 'g');
    f.customer('c2', 'u2', 'off');
    f.customer('c3', 'u3', 'none');
    f.customer('c4', 'u4', 'foreign');
    for (const u of ['u9', 'u2', 'u3', 'u4']) {
      expect(
        resolveLinePrice(f.db, {
          ...f.ctx([], { buyer: session(u) }),
          line: { productId: 'p', qty: 1 },
        }).unitMinor
      ).toBe(1000);
    }
    expect(
      resolveLinePrice(f.db, {
        ...f.ctx([], { buyer: session('u1') }),
        line: { productId: 'p', qty: 1 },
      }).unitMinor
    ).toBe(700);
  });

  it('a customer row of another store never leaks its group in', () => {
    const f = fixture();
    f.product('p', 1000);
    f.group('g', { bps: 3000 });
    f.customer('c1', 'u1', 'g', 's2'); // same user id, other store
    expect(
      resolveLinePrice(f.db, {
        ...f.ctx([], { buyer: session('u1') }),
        line: { productId: 'p', qty: 1 },
      }).unitMinor
    ).toBe(1000);
  });

  it('merchant-selected buyer is priced by the picked customer row (same store only)', () => {
    const f = fixture();
    f.product('p', 1000);
    f.group('g', { bps: 1000 });
    f.customer('c1', null, 'g');
    f.customer('cx', null, 'g', 's2');
    const price = (customerId: string) =>
      resolveLinePrice(f.db, {
        ...f.ctx([], { buyer: { kind: 'merchant-selected', customerId } }),
        line: { productId: 'p', qty: 1 },
      }).unitMinor;
    expect(price('c1')).toBe(900);
    expect(price('cx')).toBe(1000);
  });

  it('lowest wins across audiences; a tie reports the group tier first (provenance drives coupon exclusion)', () => {
    const f = fixture();
    f.product('p', 1000);
    f.group('g', { bps: 2000 }); // 800
    f.customer('c1', 'u1', 'g');
    f.tier('pub', 'p', 2, 900);
    f.tier('gt', 'p', 2, 800, { group: 'g' });
    const r = resolveCartPrices(
      f.db,
      f.ctx([{ key: 'a', productId: 'p', qty: 2 }], { buyer: session('u1') })
    ).lines[0].resolved;
    expect(r).toMatchObject({ unitMinor: 800, source: 'tier', groupApplied: true, tierMinQty: 2 });
    // anonymous only sees the public tier
    expect(
      resolveLinePrice(f.db, { ...f.ctx([]), line: { productId: 'p', qty: 2 } }).unitMinor
    ).toBe(900);
    // another group's tier is never applied
    f.group('g2', { bps: 0 });
    f.tier('g2t', 'p', 2, 100, { group: 'g2' });
    expect(
      resolveLinePrice(f.db, {
        ...f.ctx([], { buyer: session('u1') }),
        line: { productId: 'p', qty: 2 },
      }).unitMinor
    ).toBe(800);
  });
});

describe('DO pricing: wholesale audience (fail closed)', () => {
  const setup = () => {
    const f = fixture();
    f.product('w', 500, { audience: 'wholesale_only' });
    f.product('pub', 500);
    f.group('wg', { wholesale: 1, bps: 0 });
    f.group('retail', { wholesale: 0 });
    f.group('wOff', { wholesale: 1, active: 0 });
    f.customer('c1', 'member', 'wg');
    f.customer('c2', 'plain', 'retail');
    f.customer('c3', 'lapsed', 'wOff');
    return f;
  };
  const line = [{ key: 'a', productId: 'w', qty: 1 }];

  it('refuses anonymous, ungrouped, non-wholesale and inactive-wholesale buyers with the no-oracle 409', () => {
    const f = setup();
    for (const buyer of [
      { kind: 'anonymous' } as Buyer,
      session('nobody'),
      session('plain'),
      session('lapsed'),
      { kind: 'merchant-selected', customerId: 'c2' } as Buyer,
    ]) {
      const e = err(() => resolveCartPrices(f.db, f.ctx(line, { buyer })));
      expect(e).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', status: 409 });
    }
  });

  it('admits an active wholesale member, also when the plan feature is off (visibility is a restriction)', () => {
    const f = setup();
    expect(
      resolveCartPrices(f.db, f.ctx(line, { buyer: session('member') })).lines[0].resolved.unitMinor
    ).toBe(500);
    expect(
      resolveCartPrices(f.db, f.ctx(line, { buyer: session('member'), wholesaleEntitled: false }))
        .lines[0].resolved.unitMinor
    ).toBe(500);
    expect(canSeeWholesaleOnly(f.db, 's1', session('member'))).toBe(true);
    expect(canSeeWholesaleOnly(f.db, 's1', session('lapsed'))).toBe(false);
    expect(canSeeWholesaleOnly(f.db, 's1', { kind: 'anonymous' })).toBe(false);
  });

  it('one wholesale line poisons a mixed cart for a non-member, and an unknown audience is refused', () => {
    const f = setup();
    const mixed = [
      { key: 'a', productId: 'pub', qty: 1 },
      { key: 'b', productId: 'w', qty: 1 },
    ];
    expect(err(() => resolveCartPrices(f.db, f.ctx(mixed))).meta).toEqual({ productIds: ['w'] });
    f.raw.exec('PRAGMA ignore_check_constraints = ON'); // simulate a hostile / corrupt row the schema would refuse
    f.raw.exec(`UPDATE products SET audience = 'weird' WHERE id = 'pub'`);
    expect(
      err(() => resolveCartPrices(f.db, f.ctx([{ key: 'a', productId: 'pub', qty: 1 }]))).code
    ).toBe('PRODUCT_UNAVAILABLE');
  });
});

describe('DO pricing: MOQ', () => {
  it('reports belowMoq, and assertMoqSatisfied refuses with every offender once (MOQ ignores the plan)', () => {
    const f = fixture();
    f.product('a', 100, { moq: 5 });
    f.product('b', 100, { moq: 3 });
    f.product('c', 100);
    const c = f.ctx(
      [
        { key: '1', productId: 'a', qty: 2 },
        { key: '2', productId: 'a', qty: 2 },
        { key: '3', productId: 'b', qty: 3 },
        { key: '4', productId: 'c', qty: 1 },
      ],
      { wholesaleEntitled: false }
    );
    const priced = resolveCartPrices(f.db, c);
    expect(priced.lines.map(l => l.resolved.belowMoq)).toEqual([true, true, false, false]);
    const e = err(() => assertMoqSatisfied(priced.lines));
    expect(e).toMatchObject({ code: 'BELOW_MOQ', status: 422 });
    expect(e.meta).toEqual({
      lines: [{ productId: 'a', name: 'P a', nameAr: null, required: 5, current: 4 }],
    });
    const ok = resolveCartPrices(f.db, f.ctx([{ key: '1', productId: 'a', qty: 5 }]));
    expect(() => assertMoqSatisfied(ok.lines)).not.toThrow();
  });
});

describe('DO pricing: tenancy + hostile input', () => {
  it('another store product, a foreign variant, a draft/deleted product and a foreign-store tier are all unusable', () => {
    const f = fixture();
    f.product('p', 1000);
    f.product('other', 1000, { store: 's2' });
    f.product('draft', 1000, { status: 'draft' });
    f.product('gone', 1000);
    f.raw.exec(`UPDATE products SET deleted_at = 1 WHERE id = 'gone'`);
    f.variant('vx', 'other', 10);
    f.tier('foreign', 'p', 2, 1, { store: 's2' }); // a tier row that carries ANOTHER store's id
    for (const l of [
      { key: 'a', productId: 'other', qty: 1 },
      { key: 'a', productId: 'draft', qty: 1 },
      { key: 'a', productId: 'gone', qty: 1 },
      { key: 'a', productId: 'p', variantId: 'vx', qty: 1 },
      { key: 'a', productId: 'p', variantId: 'missing', qty: 1 },
      { key: 'a', productId: 'nope', qty: 1 },
    ]) {
      expect(err(() => resolveCartPrices(f.db, f.ctx([l]))).code).toBe('PRODUCT_UNAVAILABLE');
    }
    expect(
      resolveLinePrice(f.db, { ...f.ctx([]), line: { productId: 'p', qty: 9 } }).unitMinor
    ).toBe(1000);
    expect(
      err(() =>
        resolveCartPrices(f.db, f.ctx([{ key: 'a', productId: 'p', qty: 1 }], { storeId: 's2' }))
      ).code
    ).toBe('PRODUCT_UNAVAILABLE');
  });

  it('rejects hostile quantities, ids and shapes before touching money', () => {
    const f = fixture();
    f.product('p', 1000);
    const q = (qty: unknown) =>
      err(() => resolveCartPrices(f.db, f.ctx([{ key: 'a', productId: 'p', qty: qty as number }])));
    for (const bad of [0, -1, 1.5, NaN, Infinity, 1_000_001, '5', null])
      expect(q(bad).code).toBe('BAD_QUANTITY');
    expect(err(() => resolveCartPrices(f.db, f.ctx([]))).code).toBe('EMPTY_CART');
    expect(
      err(() =>
        resolveCartPrices(
          f.db,
          f.ctx([
            { key: 'a', productId: 'p', qty: 1 },
            { key: 'a', productId: 'p', qty: 1 },
          ])
        )
      ).code
    ).toBe('BAD_ID');
    expect(
      err(() => resolveCartPrices(f.db, f.ctx([{ key: 'a', productId: '', qty: 1 }]))).code
    ).toBe('BAD_ID');
    expect(
      err(() =>
        resolveCartPrices(f.db, f.ctx([{ key: 'a', productId: 'p', qty: 1 }], { storeId: '' }))
      ).code
    ).toBe('BAD_ID');
  });

  it('a corrupt stored price / tier / moq is a loud 500, not a silent price', () => {
    const f = fixture();
    f.product('p', 1000);
    f.raw.exec('PRAGMA ignore_check_constraints = ON');
    f.raw.exec(`UPDATE products SET price = -5 WHERE id = 'p'`);
    expect(
      err(() => resolveLinePrice(f.db, { ...f.ctx([]), line: { productId: 'p', qty: 1 } }))
    ).toMatchObject({
      code: 'PRICE_DATA_CORRUPT',
      status: 500,
    });
    const g = fixture();
    g.product('p', 1000);
    g.raw.exec('PRAGMA ignore_check_constraints = ON');
    g.raw.exec(`UPDATE products SET moq = 0 WHERE id = 'p'`);
    expect(
      err(() => resolveLinePrice(g.db, { ...g.ctx([]), line: { productId: 'p', qty: 1 } })).code
    ).toBe('PRICE_DATA_CORRUPT');
  });
});

describe('DO pricing: differential vs the Postgres original (resolveUnitPrice)', () => {
  it('300 random carts: DO unit price, source, tier, ladder and group flag equal the pure original on the same inputs', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const f = fixture();
      const basePrice = 100 + rnd(5000);
      f.product('p', basePrice, { moq: rnd(3) === 0 ? 2 + rnd(5) : null });
      const vPrice = rnd(2) ? null : 50 + rnd(5000);
      f.variant('v', 'p', vPrice);
      f.variant('v2', 'p', null);
      const bps = rnd(3) === 0 ? 0 : rnd(9001);
      const active = rnd(5) === 0 ? 0 : 1;
      f.group('g', { bps, active, mode: rnd(6) === 0 ? 'none' : 'percent_off' });
      const member = rnd(2) === 1;
      f.customer('c', 'u', member ? 'g' : null);
      const tiers: PriceTierRow[] = [];
      const nTiers = rnd(5);
      for (let i = 0; i < nTiers; i++) {
        const t: PriceTierRow = {
          variantId: rnd(3) === 0 ? 'v' : null,
          groupId: rnd(2) ? 'g' : null,
          minQty: 2 + rnd(9),
          priceMinor: rnd(6000),
        };
        try {
          f.tier(`t${i}`, 'p', t.minQty, t.priceMinor, { variant: t.variantId, group: t.groupId });
          tiers.push(t); // a duplicate scope+minQty is refused by the schema's unique index: not a fixture
        } catch {
          /* skip */
        }
      }
      const qV = 1 + rnd(12);
      const qV2 = rnd(4);
      const lines = [{ key: 'a', productId: 'p', variantId: 'v', qty: qV }];
      if (qV2 > 0) lines.push({ key: 'b', productId: 'p', variantId: 'v2', qty: qV2 });
      const entitled = rnd(6) !== 0;
      const ctx = f.ctx(lines, { buyer: session('u'), wholesaleEntitled: entitled });
      const out = resolveCartPrices(f.db, ctx);
      const groupRow = member
        ? ({
            id: 'g',
            pricingMode: (
              f.raw.prepare(`SELECT pricing_mode m FROM customer_groups WHERE id='g'`).get() as {
                m: string;
              }
            ).m as 'none' | 'percent_off',
            discountBps: bps,
            isActive: active === 1,
          } as const)
        : null;
      const productQty = qV + qV2;
      for (const l of lines) {
        const expected = resolveUnitPrice({
          baseMinor: l.variantId === 'v' ? (vPrice ?? basePrice) : basePrice,
          productPriceMinor: basePrice,
          qty: productQty,
          variantQty: l.qty,
          variantId: l.variantId,
          buyerGroup: entitled && groupRow && groupRow.pricingMode ? groupRow : null,
          tiers: entitled ? tiers : [],
          moq: (
            f.raw.prepare(`SELECT moq FROM products WHERE id='p'`).get() as { moq: number | null }
          ).moq,
        });
        const got = out.byKey.get(l.key)!.resolved;
        expect(got).toEqual(expected);
      }
    }
  });
});
