import { describe, it, expect } from 'vitest';
import { validateTierWrite, isStaleTier, MAX_TIERS_PER_SCOPE, type TierInput } from '../pricing';

const t = (minQty: number, priceMinor: number, o: Partial<TierInput> = {}): TierInput => ({
  variantId: null,
  groupId: null,
  minQty,
  priceMinor,
  ...o,
});
const run = (
  tier: TierInput,
  existing: TierInput[] = [],
  o: Partial<Parameters<typeof validateTierWrite>[0]> = {}
) => validateTierWrite({ tier, existing, productPriceMinor: 10_000, ...o });
const codes = (r: ReturnType<typeof run>) => r.errors.map(e => e.code);

describe('validateTierWrite', () => {
  it('accepts a normal public tier', () => expect(codes(run(t(10, 8_000)))).toEqual([]));

  it('TIER_ABOVE_BASE: at or above the base is refused; below is fine', () => {
    expect(codes(run(t(10, 10_000)))).toEqual(['TIER_ABOVE_BASE']);
    expect(codes(run(t(10, 12_000)))).toEqual(['TIER_ABOVE_BASE']);
    expect(codes(run(t(10, 9_999)))).toEqual([]);
  });
  it('a variant-level tier is checked against the VARIANT price when it has one', () => {
    expect(
      codes(run(t(10, 11_000, { variantId: 'v' }), [], { variantPriceMinor: 12_000 }))
    ).toEqual([]);
    expect(
      codes(run(t(10, 12_000, { variantId: 'v' }), [], { variantPriceMinor: 12_000 }))
    ).toEqual(['TIER_ABOVE_BASE']);
  });

  it('TIER_NOT_MONOTONE: higher qty must be strictly cheaper in the same scope (both directions)', () => {
    const ex = [t(10, 9_000), t(50, 8_000)];
    expect(codes(run(t(20, 9_500), ex))).toContain('TIER_NOT_MONOTONE'); // dearer than the 10+ tier
    expect(codes(run(t(20, 9_000), ex))).toContain('TIER_NOT_MONOTONE'); // equal is not strictly lower
    expect(codes(run(t(20, 8_500), ex))).toEqual([]);
    expect(codes(run(t(60, 8_000), ex))).toContain('TIER_NOT_MONOTONE');
    expect(codes(run(t(5, 8_000), ex))).toContain('TIER_NOT_MONOTONE'); // a cheaper low-qty tier than higher-qty ones
  });
  it('different scopes never constrain each other (group vs public, variant vs product)', () => {
    const ex = [t(10, 9_000)];
    expect(codes(run(t(10, 9_500, { groupId: 'g' }), ex))).toEqual([]);
  });

  it('TIER_DUPLICATE: same scope and minQty; an UPDATE of that tier itself is not a duplicate', () => {
    expect(codes(run(t(10, 8_000), [t(10, 9_000)]))).toContain('TIER_DUPLICATE');
    expect(codes(run({ ...t(10, 8_500), id: 'a' }, [{ ...t(10, 9_000), id: 'a' }]))).toEqual([]);
  });

  it('TIER_LIMIT: at most 10 per scope on create, not on update of an existing one', () => {
    const ex = Array.from({ length: MAX_TIERS_PER_SCOPE }, (_, k) => ({
      ...t(2 + k, 9_000 - k * 100),
      id: `i${k}`,
    }));
    expect(codes(run(t(99, 100), ex))).toContain('TIER_LIMIT');
    expect(codes(run({ ...t(2, 9_500), id: 'i0' }, ex))).not.toContain('TIER_LIMIT');
  });

  it('B2B-12 TIER_VARIANT_ABOVE_PRODUCT: a variant tier dearer than a reached product tier of the same audience is refused', () => {
    const product = [t(10, 7_000)];
    expect(
      codes(run(t(10, 9_000, { variantId: 'v' }), product, { variantPriceMinor: 12_000 }))
    ).toEqual(['TIER_VARIANT_ABOVE_PRODUCT']);
    expect(
      codes(run(t(20, 7_000, { variantId: 'v' }), product, { variantPriceMinor: 12_000 }))
    ).toEqual([]); // equal is fine
    expect(
      codes(run(t(20, 6_500, { variantId: 'v' }), product, { variantPriceMinor: 12_000 }))
    ).toEqual([]);
    // a product tier not yet reached at the variant's minQty does not constrain it
    expect(
      codes(run(t(5, 9_000, { variantId: 'v' }), product, { variantPriceMinor: 12_000 }))
    ).toEqual([]);
  });
  it('B2B-12 the same rule when the PRODUCT-level tier is the one being written', () => {
    const variant = [t(20, 9_000, { variantId: 'v' })];
    expect(codes(run(t(10, 8_000), variant))).toEqual(['TIER_VARIANT_ABOVE_PRODUCT']);
    expect(codes(run(t(10, 9_500), variant))).toEqual([]);
  });
  it('B2B-12 compares within an audience only: a group variant tier vs a PUBLIC product tier is not constrained', () => {
    expect(
      codes(
        run(t(10, 9_000, { variantId: 'v', groupId: 'g' }), [t(10, 7_000)], {
          variantPriceMinor: 12_000,
        })
      )
    ).toEqual([]);
  });

  it('warns (does not block) when below cost', () => {
    const r = run(t(10, 800), [], { costPriceMinor: 900 });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map(w => w.code)).toEqual(['TIER_BELOW_COST']);
    expect(run(t(10, 900), [], { costPriceMinor: 900 }).warnings).toEqual([]);
  });

  it('warns (does not block) when minQty is below the product MOQ: the tier could never apply (review M5)', () => {
    const r = run(t(5, 9_000), [], { moq: 12 });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map(w => w.code)).toEqual(['TIER_BELOW_MOQ']);
    expect(run(t(12, 9_000), [], { moq: 12 }).warnings).toEqual([]);
    expect(run(t(5, 9_000), [], { moq: null }).warnings).toEqual([]);
  });
});

describe('isStaleTier', () => {
  it('flags a tier at or above the current base; variant tiers use the variant price', () => {
    expect(isStaleTier(t(10, 9_000), 5_000)).toBe(true);
    expect(isStaleTier(t(10, 4_000), 5_000)).toBe(false);
    expect(isStaleTier(t(10, 9_000, { variantId: 'v' }), 5_000, 12_000)).toBe(false);
  });
});
