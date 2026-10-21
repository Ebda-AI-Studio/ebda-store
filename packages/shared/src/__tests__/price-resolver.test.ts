/**
 * resolveUnitPrice - the one pure place a wholesale/tier price is decided (docs/plans/2026-10-21-b2b-wholesale.md,
 * Task 2; Rulings B2B-3 resolution order, B2B-4 quantity scope, B2B-5 provenance). Written BEFORE the implementation.
 *
 * Each describe block is named after the Review Focus item it pins (RF1..RF13). RF items that need a cart, an order, an
 * HTTP route or a cache cannot be proven in a pure function; they are listed at the bottom with the file that owns them,
 * so a reader can see the full 13-case map and that none was silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { resolveUnitPrice, type ResolveInput, type PriceTierRow } from '../pricing';

const G = 'group-wholesale';
const OTHER_G = 'group-other';
const V1 = 'variant-1';
const V2 = 'variant-2';

const group = (over: Partial<NonNullable<ResolveInput['buyerGroup']>> = {}) => ({
  id: G,
  pricingMode: 'none' as const,
  discountBps: 0,
  isActive: true,
  ...over,
});
const tier = (minQty: number, priceMinor: number, o: Partial<PriceTierRow> = {}): PriceTierRow => ({
  variantId: null,
  groupId: null,
  minQty,
  priceMinor,
  ...o,
});
const input = (o: Partial<ResolveInput> = {}): ResolveInput => ({
  baseMinor: 10_000,
  qty: 1,
  variantId: null,
  buyerGroup: null,
  tiers: [],
  ...o,
});

describe('RF4 tier boundary and quantity change', () => {
  const tiers = [tier(10, 8_000)];
  it.each([
    [1, 10_000],
    [9, 10_000],
    [10, 8_000],
    [11, 8_000],
    [500, 8_000],
  ])('qty %i -> %i (public tier from 10)', (qty, unit) => {
    expect(resolveUnitPrice(input({ qty, tiers })).unitMinor).toBe(unit);
  });

  it('crossing the boundary and back reverts (10 -> 9)', () => {
    expect(resolveUnitPrice(input({ qty: 10, tiers })).unitMinor).toBe(8_000);
    expect(resolveUnitPrice(input({ qty: 9, tiers })).unitMinor).toBe(10_000);
  });

  it('the largest minQty <= qty wins within a level', () => {
    const t = [tier(10, 9_000), tier(50, 8_000), tier(100, 7_000)];
    expect(resolveUnitPrice(input({ qty: 49, tiers: t })).unitMinor).toBe(9_000);
    expect(resolveUnitPrice(input({ qty: 50, tiers: t })).unitMinor).toBe(8_000);
    expect(resolveUnitPrice(input({ qty: 99, tiers: t })).unitMinor).toBe(8_000);
    expect(resolveUnitPrice(input({ qty: 100, tiers: t })).unitMinor).toBe(7_000);
  });

  it('reports tierMinQty and source for the tier that applied, base otherwise', () => {
    const hit = resolveUnitPrice(input({ qty: 12, tiers }));
    expect(hit).toEqual({
      unitMinor: 8_000,
      source: 'tier',
      tierMinQty: 10,
      listMinor: 10_000,
      belowMoq: false,
      moqRequired: null,
    });
    const miss = resolveUnitPrice(input({ qty: 3, tiers }));
    expect(miss).toMatchObject({ unitMinor: 10_000, source: 'base', tierMinQty: null });
  });

  it('input order of tiers never changes the answer (deterministic)', () => {
    const t = [tier(10, 9_000), tier(50, 8_000), tier(100, 7_000), tier(5, 9_500)];
    const want = resolveUnitPrice(input({ qty: 60, tiers: t }));
    const rev = [...t].reverse();
    const rot = [...t.slice(2), ...t.slice(0, 2)];
    expect(resolveUnitPrice(input({ qty: 60, tiers: rev }))).toEqual(want);
    expect(resolveUnitPrice(input({ qty: 60, tiers: rot }))).toEqual(want);
  });

  it('two tiers with the same scope and minQty (the DB forbids it) resolve to the LOWER price, in any order', () => {
    const a = [tier(10, 8_000), tier(10, 7_000)];
    expect(resolveUnitPrice(input({ qty: 10, tiers: a })).unitMinor).toBe(7_000);
    expect(resolveUnitPrice(input({ qty: 10, tiers: [...a].reverse() })).unitMinor).toBe(7_000);
  });
});

describe('RF4 quantity scope (Ruling B2B-4): product-level tiers use the product total, variant-level tiers the variant total', () => {
  it('a product-level tier uses `qty` (the product total across variants)', () => {
    // 6 of V1 + 6 of V2 = 12 of the product: a product tier from 10 applies to each line.
    const t = [tier(10, 8_000)];
    expect(
      resolveUnitPrice(input({ qty: 12, variantQty: 6, variantId: V1, tiers: t })).unitMinor
    ).toBe(8_000);
  });
  it('a variant-level tier uses `variantQty`, so 6 + 6 across two variants does NOT reach a variant tier from 10', () => {
    const t = [tier(10, 8_000, { variantId: V1 })];
    expect(
      resolveUnitPrice(input({ qty: 12, variantQty: 6, variantId: V1, tiers: t })).unitMinor
    ).toBe(10_000);
    expect(
      resolveUnitPrice(input({ qty: 12, variantQty: 10, variantId: V1, tiers: t })).unitMinor
    ).toBe(8_000);
  });
  it('variantQty defaults to qty (single-variant or variant-less products)', () => {
    const t = [tier(10, 8_000, { variantId: V1 })];
    expect(resolveUnitPrice(input({ qty: 10, variantId: V1, tiers: t })).unitMinor).toBe(8_000);
  });
  it('a tier for another variant, or a variant tier on a variant-less line, never applies', () => {
    const t = [tier(2, 1_000, { variantId: V2 })];
    expect(resolveUnitPrice(input({ qty: 5, variantId: V1, tiers: t })).unitMinor).toBe(10_000);
    expect(resolveUnitPrice(input({ qty: 5, variantId: null, tiers: t })).unitMinor).toBe(10_000);
  });
});

describe('Ruling B2B-3 resolution order: (variant,group) > (product,group) > (variant,all) > (product,all), then group percent, then base', () => {
  const buyer = group({ pricingMode: 'percent_off', discountBps: 1_000 });
  const all = (over: Partial<ResolveInput>) =>
    input({ qty: 10, variantId: V1, buyerGroup: buyer, ...over });
  const lvl4 = tier(2, 9_000);
  const lvl3 = tier(2, 8_500, { variantId: V1 });
  const lvl2 = tier(2, 8_000, { groupId: G });
  const lvl1 = tier(2, 7_000, { variantId: V1, groupId: G });

  it('level 1 beats everything', () => {
    const r = resolveUnitPrice(all({ tiers: [lvl4, lvl3, lvl2, lvl1] }));
    expect(r).toMatchObject({ unitMinor: 7_000, source: 'tier', tierMinQty: 2, listMinor: 10_000 });
  });
  it('level 2 beats 3 and 4 (a LESS specific but cheaper public tier still loses: not "lowest wins")', () => {
    const cheapPublic = tier(2, 5_000);
    expect(resolveUnitPrice(all({ tiers: [cheapPublic, lvl3, lvl2] })).unitMinor).toBe(8_000);
  });
  it('level 3 beats 4', () => {
    expect(resolveUnitPrice(all({ tiers: [lvl4, lvl3] })).unitMinor).toBe(8_500);
  });
  it('level 4 beats group percent (a matching tier wins over the percent)', () => {
    expect(resolveUnitPrice(all({ tiers: [lvl4] })).unitMinor).toBe(9_000);
  });
  it('with no tier at all, group percent_off applies to base', () => {
    expect(resolveUnitPrice(all({ tiers: [] }))).toMatchObject({
      unitMinor: 9_000,
      source: 'group',
      tierMinQty: null,
      listMinor: 10_000,
    });
  });
  it('a tier whose minQty is not reached falls through to the next level / percent', () => {
    expect(resolveUnitPrice(all({ qty: 1, tiers: [lvl1] })).unitMinor).toBe(9_000);
  });
  it('within a level the qty is applied first: a deeper tier of a LOWER level never beats a reached higher level', () => {
    const t = [tier(100, 1_000, { variantId: V1, groupId: G }), tier(2, 8_000, { groupId: G })];
    expect(resolveUnitPrice(all({ qty: 10, tiers: t })).unitMinor).toBe(8_000);
  });
});

describe('RF2 / identity inputs: only a matching, active buyer group sees a group price', () => {
  const groupTier = tier(2, 6_000, { groupId: G });
  it('no buyer group (guest, non-member, unapproved) never sees a group tier', () => {
    expect(resolveUnitPrice(input({ qty: 5, buyerGroup: null, tiers: [groupTier] }))).toMatchObject(
      {
        unitMinor: 10_000,
        source: 'base',
      }
    );
  });
  it('a tier for a DIFFERENT group is ignored even if the loader handed it over', () => {
    expect(
      resolveUnitPrice(input({ qty: 5, buyerGroup: group({ id: OTHER_G }), tiers: [groupTier] }))
        .unitMinor
    ).toBe(10_000);
  });
  it('the buyer sees public tiers regardless of group, and the group tier beats them', () => {
    const t = [tier(2, 9_000), groupTier];
    expect(resolveUnitPrice(input({ qty: 5, buyerGroup: group(), tiers: t })).unitMinor).toBe(
      6_000
    );
    expect(resolveUnitPrice(input({ qty: 5, buyerGroup: null, tiers: t })).unitMinor).toBe(9_000);
  });
});

describe('RF10 inactive group returns the buyer to retail', () => {
  it('isActive=false ignores group tiers AND group percent, but public tiers still apply', () => {
    const inactive = group({ isActive: false, pricingMode: 'percent_off', discountBps: 2_000 });
    const t = [tier(2, 9_000), tier(2, 6_000, { groupId: G })];
    expect(resolveUnitPrice(input({ qty: 5, buyerGroup: inactive, tiers: t })).unitMinor).toBe(
      9_000
    );
    expect(resolveUnitPrice(input({ qty: 5, buyerGroup: inactive, tiers: [] }))).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
    });
  });
});

describe('RF5 rounding: integer piastres, half-up, no float drift', () => {
  const pct = (baseMinor: number, discountBps: number) =>
    resolveUnitPrice(
      input({ baseMinor, buyerGroup: group({ pricingMode: 'percent_off', discountBps }) })
    ).unitMinor;

  it('12.5% off 9999 -> 8749 (8749.125 rounds down)', () => {
    expect(pct(9_999, 1_250)).toBe(8_749);
  });
  it('exact halves round UP: 1 piastre at 50% -> 1, 3 at 50% -> 2, 5 at 10% -> 5 (4.5)', () => {
    expect(pct(1, 5_000)).toBe(1);
    expect(pct(3, 5_000)).toBe(2);
    expect(pct(5, 1_000)).toBe(5);
  });
  it('just below a half rounds down (14 at 12.5% off = 12.25 -> 12)', () => {
    expect(pct(14, 1_250)).toBe(12);
  });
  it('0 bps is exactly base and reported as base, not group', () => {
    const r = resolveUnitPrice(
      input({ buyerGroup: group({ pricingMode: 'percent_off', discountBps: 0 }) })
    );
    expect(r).toMatchObject({ unitMinor: 10_000, source: 'base', tierMinQty: null });
  });
  it('pricingMode "none" ignores discountBps entirely', () => {
    expect(
      resolveUnitPrice(input({ buyerGroup: group({ pricingMode: 'none', discountBps: 5_000 }) }))
        .unitMinor
    ).toBe(10_000);
  });
  it('large base values stay exact (Int4 max: no float drift)', () => {
    // 2_147_483_647 * 0.875 = 1_879_048_191.125 -> 1_879_048_191 (cross-checked with BigInt, which has no float path)
    const big = (b: bigint, bps: bigint) => Number((b * (10_000n - bps) + 5_000n) / 10_000n);
    expect(pct(2_147_483_647, 1_250)).toBe(1_879_048_191);
    expect(pct(2_147_483_647, 1_250)).toBe(big(2_147_483_647n, 1_250n));
    for (const [b, bps] of [
      [2_147_483_646n, 3n],
      [1_999_999_999n, 8_999n],
      [123_456_789n, 4_321n],
    ] as const) {
      expect(pct(Number(b), Number(bps))).toBe(big(b, bps));
    }
  });
  it('sum of line totals equals subtotal: unit * qty is exact integer arithmetic for every group-priced line', () => {
    for (let base = 1; base <= 400; base++) {
      const r = resolveUnitPrice(
        input({
          baseMinor: base,
          qty: 7,
          buyerGroup: group({ pricingMode: 'percent_off', discountBps: 1_250 }),
        })
      );
      expect(Number.isInteger(r.unitMinor)).toBe(true);
      expect(Number.isInteger(r.unitMinor * 7)).toBe(true);
    }
  });
});

describe('clamp [0, base] (Ruling B2B-3)', () => {
  it('a tier priced ABOVE base is clamped to base (base later lowered under an old tier)', () => {
    const r = resolveUnitPrice(input({ baseMinor: 5_000, qty: 10, tiers: [tier(10, 9_000)] }));
    expect(r.unitMinor).toBe(5_000);
  });
  it('a clamped tier carries no discount, so it is reported as base (no coupon exclusion for a non-discount)', () => {
    const r = resolveUnitPrice(input({ baseMinor: 5_000, qty: 10, tiers: [tier(10, 9_000)] }));
    expect(r).toMatchObject({
      unitMinor: 5_000,
      source: 'base',
      tierMinQty: null,
      listMinor: 5_000,
    });
  });
  it('a tier of 0 is a legal free price', () => {
    expect(resolveUnitPrice(input({ qty: 10, tiers: [tier(10, 0)] })).unitMinor).toBe(0);
  });
  it('a free base (0) stays 0 with a tier and with a group percent', () => {
    expect(
      resolveUnitPrice(input({ baseMinor: 0, qty: 10, tiers: [tier(10, 100)] })).unitMinor
    ).toBe(0);
    expect(
      resolveUnitPrice(
        input({ baseMinor: 0, buyerGroup: group({ pricingMode: 'percent_off', discountBps: 900 }) })
      ).unitMinor
    ).toBe(0);
  });
});

describe('MOQ (Review Focus 7): the price is still resolved below MOQ; the caller decides to refuse', () => {
  it('flags belowMoq with the required quantity, counted on the product total (`qty`)', () => {
    expect(resolveUnitPrice(input({ qty: 3, moq: 6 }))).toMatchObject({
      belowMoq: true,
      moqRequired: 6,
      unitMinor: 10_000,
    });
    expect(
      resolveUnitPrice(input({ qty: 12, variantQty: 4, variantId: V1, moq: 6 }))
    ).toMatchObject({
      belowMoq: false,
      moqRequired: 6,
    });
  });
  it('at exactly MOQ it is satisfied', () => {
    expect(resolveUnitPrice(input({ qty: 6, moq: 6 })).belowMoq).toBe(false);
  });
  it('no MOQ (null / undefined) never flags', () => {
    expect(resolveUnitPrice(input({ qty: 1, moq: null }))).toMatchObject({
      belowMoq: false,
      moqRequired: null,
    });
    expect(resolveUnitPrice(input({ qty: 1 }))).toMatchObject({
      belowMoq: false,
      moqRequired: null,
    });
  });
  it('MOQ does not change the price: a below-MOQ line with a tier on a lower qty still prices by qty', () => {
    expect(resolveUnitPrice(input({ qty: 3, moq: 6, tiers: [tier(2, 9_000)] })).unitMinor).toBe(
      9_000
    );
  });
});

describe('totality and input validation', () => {
  it('qty 0 is valid and prices as base', () => {
    expect(resolveUnitPrice(input({ qty: 0, tiers: [tier(2, 1)] })).unitMinor).toBe(10_000);
  });
  it.each<[string, Partial<ResolveInput>]>([
    ['float base', { baseMinor: 99.5 }],
    ['negative base', { baseMinor: -1 }],
    ['NaN base', { baseMinor: Number.NaN }],
    ['Infinity base', { baseMinor: Number.POSITIVE_INFINITY }],
    ['base above Int4', { baseMinor: 2_147_483_648 }],
    ['float qty', { qty: 1.5 }],
    ['negative qty', { qty: -1 }],
    ['float variantQty', { variantQty: 2.5 }],
    ['negative variantQty', { variantQty: -2 }],
    ['float tier price', { tiers: [tier(10, 8_000.5)] }],
    ['negative tier price', { tiers: [tier(10, -1)] }],
    ['float tier minQty', { tiers: [tier(10.5, 8_000)] }],
    ['tier minQty below 2', { tiers: [tier(1, 8_000)] }],
    ['float discountBps', { buyerGroup: group({ pricingMode: 'percent_off', discountBps: 12.5 }) }],
    [
      'negative discountBps',
      { buyerGroup: group({ pricingMode: 'percent_off', discountBps: -1 }) },
    ],
    [
      'discountBps over 10000',
      { buyerGroup: group({ pricingMode: 'percent_off', discountBps: 10_001 }) },
    ],
    ['float moq', { moq: 2.5 }],
    ['negative moq', { moq: -2 }],
  ])('throws RangeError on %s', (_n, over) => {
    expect(() => resolveUnitPrice(input(over))).toThrow(RangeError);
  });
  it('validates tiers it would have skipped (a corrupt row is a loud error, not a silent pass)', () => {
    expect(() => resolveUnitPrice(input({ qty: 1, tiers: [tier(1_000, -5)] }))).toThrow(RangeError);
  });
  it('does not mutate its input', () => {
    const tiers = [tier(10, 9_000), tier(5, 9_500)];
    const frozen = JSON.stringify(tiers);
    Object.freeze(tiers);
    tiers.forEach(Object.freeze);
    resolveUnitPrice(input({ qty: 10, tiers }));
    expect(JSON.stringify(tiers)).toBe(frozen);
  });
});

describe('RF4 property tests (seeded, 2,000 cases): 0 <= unit <= base, listMinor == base, idempotent, monotone within a level', () => {
  // mulberry32: deterministic, no Math.random (a failing seed must reproduce).
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  it('holds for random tiers, groups and quantities', () => {
    const r = rng(20261021);
    for (let i = 0; i < 2_000; i++) {
      const baseMinor = int(r, 0, 5_000_000);
      const mode = r() < 0.5 ? 'percent_off' : 'none';
      const buyerGroup =
        r() < 0.7
          ? group({ pricingMode: mode, discountBps: int(r, 0, 9_000), isActive: r() < 0.9 })
          : null;
      const n = int(r, 0, 6);
      const tiers: PriceTierRow[] = Array.from({ length: n }, () =>
        tier(int(r, 2, 120), int(r, 0, 6_000_000), {
          variantId: r() < 0.4 ? V1 : r() < 0.2 ? V2 : null,
          groupId: r() < 0.4 ? G : r() < 0.15 ? OTHER_G : null,
        })
      );
      const qty = int(r, 0, 150);
      const args = input({
        baseMinor,
        qty,
        variantQty: int(r, 0, qty),
        variantId: r() < 0.6 ? V1 : null,
        buyerGroup,
        tiers,
      });
      const out = resolveUnitPrice(args);
      expect(Number.isInteger(out.unitMinor), `seed case ${i}`).toBe(true);
      expect(out.unitMinor, `seed case ${i}`).toBeGreaterThanOrEqual(0);
      expect(out.unitMinor, `seed case ${i}`).toBeLessThanOrEqual(baseMinor);
      expect(out.listMinor).toBe(baseMinor);
      expect(resolveUnitPrice(args)).toEqual(out); // idempotent / pure
      if (out.source === 'base') expect(out.tierMinQty).toBeNull();
      if (out.source === 'tier') expect(out.tierMinQty).not.toBeNull();
    }
  });

  it('is non-increasing in qty within one level when tier prices fall as minQty rises', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const baseMinor = int(r, 1_000, 100_000);
      // strictly increasing minQty, non-increasing price, all <= base
      let minQty = 1;
      let price = baseMinor;
      const tiers: PriceTierRow[] = [];
      for (let k = 0; k < int(r, 1, 5); k++) {
        minQty += int(r, 1, 20);
        price = Math.max(0, price - int(r, 0, 2_000));
        tiers.push(tier(minQty, price));
      }
      let prev = Number.POSITIVE_INFINITY;
      for (let q = 0; q <= minQty + 5; q++) {
        const u = resolveUnitPrice(input({ baseMinor, qty: q, tiers })).unitMinor;
        expect(u, `case ${i} qty ${q}`).toBeLessThanOrEqual(prev);
        prev = u;
      }
    }
  });
});

describe('Review Focus map: items not provable in a pure function and where they are pinned', () => {
  it('lists the owner of every RF item (kept in the test so the 13-case map cannot silently shrink)', () => {
    const owners: Record<string, string> = {
      RF1: 'tests/integration/b2b-price-cache-isolation.test.ts (Task 3/4: cache + edge)',
      RF2: 'tests/unit/price-resolver-service.test.ts + tests/integration/b2b-price-identity.test.ts (Task 2 loader: identity = session user only)',
      RF3: 'tests/integration/b2b-price-parity.test.ts (Task 3)',
      RF4: 'this file',
      RF5: 'this file',
      RF6: 'tests/integration/b2b-price-parity.test.ts (Task 3: re-resolve at checkout)',
      RF7: 'this file (belowMoq flag) + b2b-price-parity.test.ts (Task 3: 422 BELOW_MOQ)',
      RF8: 'tests/integration/b2b-applications.test.ts (Task 5)',
      RF9: 'tests/integration/b2b-wholesale-only-visibility.test.ts (Task 6)',
      RF10: 'this file (inactive group) + tests/unit/price-resolver-service.test.ts (unassign / cross-store)',
      RF11: 'existing return tests (Task 3)',
      RF12: 'tests/integration/b2b-price-parity.test.ts (Task 3: VAT base)',
      RF13: 'tests/unit/price-resolver-service.test.ts (feature off => base)',
    };
    expect(Object.keys(owners)).toHaveLength(13);
  });
});
