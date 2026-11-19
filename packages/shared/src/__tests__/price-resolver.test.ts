/**
 * resolveUnitPrice - the one pure place a wholesale/tier price is decided (docs/plans/done/2026-10-21-b2b-wholesale.md,
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
      groupApplied: false,
      belowMoq: false,
      moqRequired: null,
      ladder: expect.any(Array),
      groupPercentMinor: null,
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

describe('Ruling B2B-3b precedence: specificity inside one audience, then the minimum across audiences, no stacking', () => {
  const buyer = group({ pricingMode: 'percent_off', discountBps: 1_000 });
  const line = (over: Partial<ResolveInput>) =>
    input({ qty: 10, variantId: V1, buyerGroup: buyer, ...over });

  it('C2(a): a group tier DEARER than the public tier never makes the wholesaler pay more than a retail buyer (9000 vs 8000)', () => {
    const tiers = [tier(10, 8_000), tier(10, 9_000, { groupId: G })];
    const anon = resolveUnitPrice(input({ qty: 10, tiers }));
    const wholesaler = resolveUnitPrice(input({ qty: 10, tiers, buyerGroup: group() }));
    expect(anon.unitMinor).toBe(8_000);
    expect(wholesaler).toMatchObject({ unitMinor: 8_000, source: 'tier', tierMinQty: 10 });
  });

  it('C2(a) mirror: when the group tier is cheaper the group buyer gets it and the anonymous buyer still pays the public tier', () => {
    const tiers = [tier(10, 8_000), tier(10, 7_000, { groupId: G })];
    expect(resolveUnitPrice(input({ qty: 10, tiers })).unitMinor).toBe(8_000);
    expect(resolveUnitPrice(input({ qty: 10, tiers, buyerGroup: group() }))).toMatchObject({
      unitMinor: 7_000,
      source: 'tier',
    });
  });

  it('C2(b): a STALE tier (>= the lowered base) is dropped, so the group % applies instead of being masked', () => {
    // base was 10000 with a 9000 tier; the merchant lowered the product to 5000. The tier is now above base.
    const g20 = group({ pricingMode: 'percent_off', discountBps: 2_000 });
    const stale = [tier(10, 9_000), tier(10, 9_000, { groupId: G })];
    expect(
      resolveUnitPrice(input({ baseMinor: 5_000, qty: 10, tiers: stale, buyerGroup: g20 }))
    ).toMatchObject({
      unitMinor: 4_000,
      source: 'group',
      tierMinQty: null,
    });
    // ... and for an anonymous buyer the stale tier is simply ignored.
    expect(resolveUnitPrice(input({ baseMinor: 5_000, qty: 10, tiers: stale }))).toMatchObject({
      unitMinor: 5_000,
      source: 'base',
    });
  });

  it('C2(c): a product-level tier does NOT apply to a variant with its own price (XL 12000 stays 12000, not 8000)', () => {
    const tiers = [tier(10, 8_000)];
    const xl = resolveUnitPrice(
      input({ baseMinor: 12_000, productPriceMinor: 10_000, variantId: 'xl', qty: 10, tiers })
    );
    expect(xl).toMatchObject({ unitMinor: 12_000, source: 'base' });
    // a variant priced below the product tier price likewise gets no (non-)break
    const s = resolveUnitPrice(
      input({ baseMinor: 7_000, productPriceMinor: 10_000, variantId: 's', qty: 10, tiers })
    );
    expect(s).toMatchObject({ unitMinor: 7_000, source: 'base' });
  });

  it('C2(c): a variant WITHOUT its own price (base === product price) still gets the product-level tier; a variant tier fixes the XL case', () => {
    const t = [tier(10, 8_000)];
    expect(
      resolveUnitPrice(
        input({
          baseMinor: 10_000,
          productPriceMinor: 10_000,
          variantId: 'plain',
          qty: 10,
          tiers: t,
        })
      ).unitMinor
    ).toBe(8_000);
    const xlTier = [tier(10, 11_000, { variantId: 'xl' })];
    expect(
      resolveUnitPrice(
        input({
          baseMinor: 12_000,
          productPriceMinor: 10_000,
          variantId: 'xl',
          qty: 10,
          tiers: xlTier,
        })
      ).unitMinor
    ).toBe(11_000);
  });

  it('inside ONE audience a variant-level tier beats a product-level one even when dearer; across audiences the minimum still wins', () => {
    const pubTiers = [tier(2, 7_000), tier(2, 9_000, { variantId: V1 })];
    expect(resolveUnitPrice(input({ qty: 5, variantId: V1, tiers: pubTiers })).unitMinor).toBe(
      9_000
    );
    const withGroup = [...pubTiers, tier(2, 6_000, { groupId: G })];
    expect(
      resolveUnitPrice(input({ qty: 5, variantId: V1, tiers: withGroup, buyerGroup: group() }))
        .unitMinor
    ).toBe(6_000);
  });

  it('inside an audience the LOWEST reached price wins (duplicates and non-monotone rows are safe, no throw)', () => {
    const odd = [tier(10, 9_000), tier(50, 9_500), tier(10, 8_000)];
    expect(resolveUnitPrice(input({ qty: 60, tiers: odd })).unitMinor).toBe(8_000);
    expect(resolveUnitPrice(input({ qty: 60, tiers: [...odd].reverse() })).unitMinor).toBe(8_000);
  });

  it('a stale variant-level tier (>= base) is dropped BEFORE specificity, so it cannot mask a cheaper product-level tier', () => {
    const tiers = [tier(2, 12_000, { variantId: V1 }), tier(2, 8_000)];
    expect(resolveUnitPrice(input({ qty: 5, variantId: V1, tiers })).unitMinor).toBe(8_000);
  });

  it('equal prices at different minQty report the smaller minQty (the break the buyer qualified for first)', () => {
    const tiers = [tier(50, 8_000), tier(10, 8_000)];
    expect(resolveUnitPrice(input({ qty: 60, tiers })).tierMinQty).toBe(10);
    expect(resolveUnitPrice(input({ qty: 60, tiers: [...tiers].reverse() })).tierMinQty).toBe(10);
  });

  it('no stacking: the group % is never applied on top of a tier; the lowest single number wins', () => {
    // tier 9000, 10% off 10000 = 9000 (tie) -> group tier absent, % and pub tie: provenance goes to the group %.
    const r = resolveUnitPrice(line({ tiers: [tier(2, 9_000)] }));
    expect(r.unitMinor).toBe(9_000);
    expect(r.source).toBe('group');
    // a public tier of 8000 beats 10% (9000) and is NOT reduced further
    expect(resolveUnitPrice(line({ tiers: [tier(2, 8_000)] }))).toMatchObject({
      unitMinor: 8_000,
      source: 'tier',
    });
  });

  it('provenance tie-break is gTier -> gPct -> pub tier', () => {
    const tiers = [tier(2, 9_000), tier(2, 9_000, { groupId: G })];
    const b = group({ pricingMode: 'percent_off', discountBps: 1_000 }); // 9000 too
    const r = resolveUnitPrice(input({ qty: 5, tiers, buyerGroup: b }));
    expect(r).toMatchObject({ unitMinor: 9_000, source: 'tier', tierMinQty: 2 });
    const noGroupTier = resolveUnitPrice(input({ qty: 5, tiers: [tier(2, 9_000)], buyerGroup: b }));
    expect(noGroupTier.source).toBe('group');
  });

  it('with no tier at all, group percent_off applies to base', () => {
    expect(resolveUnitPrice(line({ tiers: [] }))).toMatchObject({
      unitMinor: 9_000,
      source: 'group',
      tierMinQty: null,
      listMinor: 10_000,
    });
  });

  it('a tier whose minQty is not reached falls through to the percent', () => {
    expect(
      resolveUnitPrice(line({ qty: 1, tiers: [tier(2, 7_000, { variantId: V1, groupId: G })] }))
        .unitMinor
    ).toBe(9_000);
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

describe('groupApplied provenance', () => {
  it('is true for a group tier or the group percent, false for a public tier and for base', () => {
    const gt = [tier(2, 7_000, { groupId: G })];
    expect(resolveUnitPrice(input({ qty: 5, tiers: gt, buyerGroup: group() })).groupApplied).toBe(
      true
    );
    const pct = group({ pricingMode: 'percent_off', discountBps: 1_000 });
    expect(resolveUnitPrice(input({ buyerGroup: pct })).groupApplied).toBe(true);
    expect(
      resolveUnitPrice(input({ qty: 5, tiers: [tier(2, 9_000)], buyerGroup: group() })).groupApplied
    ).toBe(false);
    expect(resolveUnitPrice(input({ buyerGroup: group() })).groupApplied).toBe(false);
    // a public tier that beats the percent is not a group price
    expect(
      resolveUnitPrice(input({ qty: 5, tiers: [tier(2, 8_000)], buyerGroup: pct })).groupApplied
    ).toBe(false);
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

describe('clamp [0, base]: never above retail, never below a merchant-authored price', () => {
  it('a tier priced ABOVE or AT base is dropped (base lowered under an old tier) and reported as base', () => {
    for (const price of [5_000, 9_000]) {
      const r = resolveUnitPrice(input({ baseMinor: 5_000, qty: 10, tiers: [tier(10, price)] }));
      expect(r).toMatchObject({
        unitMinor: 5_000,
        source: 'base',
        tierMinQty: null,
        listMinor: 5_000,
      });
    }
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
    ['float productPriceMinor', { productPriceMinor: 10.5 }],
    ['negative productPriceMinor', { productPriceMinor: -1 }],
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

describe('property tests (seeded, 3,000 cases)', () => {
  // mulberry32: deterministic, no Math.random (a failing seed must reproduce).
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  const randomCase = (r: () => number) => {
    const baseMinor = int(r, 0, 5_000_000);
    const productPriceMinor = r() < 0.6 ? baseMinor : int(r, 0, 5_000_000);
    const mode = r() < 0.5 ? 'percent_off' : 'none';
    const buyerGroup =
      r() < 0.7
        ? group({ pricingMode: mode, discountBps: int(r, 0, 9_000), isActive: r() < 0.9 })
        : null;
    const n = int(r, 0, 7);
    const tiers: PriceTierRow[] = Array.from({ length: n }, () =>
      tier(int(r, 2, 120), int(r, 0, 6_000_000), {
        variantId: r() < 0.4 ? V1 : r() < 0.2 ? V2 : null,
        groupId: r() < 0.4 ? G : r() < 0.15 ? OTHER_G : null,
      })
    );
    const qty = int(r, 0, 150);
    return input({
      baseMinor,
      productPriceMinor,
      qty,
      variantQty: int(r, 0, qty),
      variantId: r() < 0.6 ? V1 : null,
      buyerGroup,
      tiers,
    });
  };

  it('0 <= unit <= base, integer, listMinor == base, idempotent, order-independent', () => {
    const r = rng(20261021);
    for (let i = 0; i < 3_000; i++) {
      const args = randomCase(r);
      const out = resolveUnitPrice(args);
      expect(Number.isInteger(out.unitMinor), `case ${i}`).toBe(true);
      expect(out.unitMinor, `case ${i}`).toBeGreaterThanOrEqual(0);
      expect(out.unitMinor, `case ${i}`).toBeLessThanOrEqual(args.baseMinor);
      expect(out.listMinor).toBe(args.baseMinor);
      expect(resolveUnitPrice(args)).toEqual(out);
      expect(resolveUnitPrice({ ...args, tiers: [...args.tiers].reverse() }), `case ${i}`).toEqual(
        out
      );
      if (out.source === 'base') expect(out.tierMinQty).toBeNull();
      if (out.source === 'tier') expect(out.tierMinQty).not.toBeNull();
      if (out.unitMinor === args.baseMinor) expect(out.source).toBe('base');
    }
  });

  it('a group buyer never pays more than the anonymous buyer at the same quantity', () => {
    const r = rng(77);
    for (let i = 0; i < 3_000; i++) {
      const args = randomCase(r);
      const anon = resolveUnitPrice({ ...args, buyerGroup: null });
      const member = resolveUnitPrice(args);
      expect(member.unitMinor, `case ${i}`).toBeLessThanOrEqual(anon.unitMinor);
    }
  });

  it('the unit is always one of the merchant-authored numbers: base, a tier price, or the group percent price', () => {
    const r = rng(99);
    const pct = (b: number, bps: number) =>
      Number((BigInt(b) * BigInt(10_000 - bps) + 5_000n) / 10_000n);
    for (let i = 0; i < 3_000; i++) {
      const args = randomCase(r);
      const out = resolveUnitPrice(args);
      const allowed = new Set<number>([args.baseMinor, ...args.tiers.map(t => t.priceMinor)]);
      if (args.buyerGroup) allowed.add(pct(args.baseMinor, args.buyerGroup.discountBps));
      expect(allowed.has(out.unitMinor), `case ${i}`).toBe(true);
    }
  });

  it('non-increasing in qty when the tiers sit on ONE level (all product-level, or all variant-level), on arbitrary non-monotone prices', () => {
    const r = rng(7);
    for (let i = 0; i < 400; i++) {
      const baseMinor = int(r, 1_000, 100_000);
      const variantLevel = r() < 0.5;
      const tiers: PriceTierRow[] = Array.from({ length: int(r, 1, 6) }, () =>
        tier(int(r, 2, 60), int(r, 0, 120_000), {
          variantId: variantLevel ? V1 : null,
          groupId: r() < 0.4 ? G : null,
        })
      );
      const buyerGroup =
        r() < 0.5 ? group({ pricingMode: 'percent_off', discountBps: int(r, 0, 9_000) }) : null;
      let prev = Number.POSITIVE_INFINITY;
      for (let q = 0; q <= 70; q++) {
        const u = resolveUnitPrice(
          input({
            baseMinor,
            qty: q,
            variantQty: q,
            variantId: variantLevel ? V1 : null,
            tiers,
            buyerGroup,
          })
        ).unitMinor;
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

describe('ladder: the price breaks this buyer could reach (Task 8b snapshot, cart stepper)', () => {
  it('lists public tiers plus the buyer ACTIVE group tiers in scope, sorted, whatever the quantity; never another audience or an out-of-scope tier', () => {
    const tiers = [
      tier(50, 9_000),
      tier(10, 9_500),
      tier(20, 8_000, { groupId: G }),
      tier(20, 7_000, { groupId: OTHER_G }), // another group's: invisible
      tier(5, 9_900, { variantId: V2 }), // another variant's: out of scope
      tier(5, 10_000), // not below base: not a break
    ];
    const r = resolveUnitPrice(input({ qty: 1, tiers, buyerGroup: group() }));
    expect(r.ladder).toEqual([
      { minQty: 10, priceMinor: 9_500, variant: false, group: false },
      { minQty: 20, priceMinor: 8_000, variant: false, group: true },
      { minQty: 50, priceMinor: 9_000, variant: false, group: false },
    ]);
    const anon = resolveUnitPrice(input({ qty: 1, tiers }));
    expect(anon.ladder).toEqual([
      { minQty: 10, priceMinor: 9_500, variant: false, group: false },
      { minQty: 50, priceMinor: 9_000, variant: false, group: false },
    ]);
    expect(resolveUnitPrice(input({ qty: 1 })).ladder).toEqual([]);
  });
  it('flags a variant-level rung; reports the group-percent price whether or not it won (Ruling B2B-18)', () => {
    const r = resolveUnitPrice(
      input({
        qty: 20,
        variantId: V1,
        tiers: [tier(5, 9_000, { variantId: V1 }), tier(20, 7_000, { groupId: G })],
        buyerGroup: group({ pricingMode: 'percent_off', discountBps: 1_000 }),
      })
    );
    expect(r.ladder.find(x => x.minQty === 5)).toMatchObject({ variant: true, group: false });
    expect(r.unitMinor).toBe(7_000); // the group tier beat the percent ...
    expect(r.groupPercentMinor).toBe(9_000); // ... but the percent price is still reported
    expect(resolveUnitPrice(input({ qty: 1 })).groupPercentMinor).toBeNull();
    expect(
      resolveUnitPrice(
        input({
          buyerGroup: group({ pricingMode: 'percent_off', discountBps: 1_000, isActive: false }),
        })
      ).groupPercentMinor
    ).toBeNull();
  });
  it('an inactive group contributes no rungs; a product tier on a variant with its own price is not offered', () => {
    const t = [tier(20, 8_000, { groupId: G })];
    expect(
      resolveUnitPrice(input({ tiers: t, buyerGroup: group({ isActive: false }) })).ladder
    ).toEqual([]);
    expect(
      resolveUnitPrice(
        input({ baseMinor: 12_000, productPriceMinor: 10_000, tiers: [tier(10, 9_000)] })
      ).ladder
    ).toEqual([]);
  });
});
