/**
 * resolveUnitPrice - the ONE pure place a tier / wholesale unit price is decided.
 * docs/plans/done/2026-10-21-b2b-wholesale.md, Task 2 + design review 2026-10-21. Rulings B2B-3b (precedence), B2B-4 (quantity
 * scope), B2B-5 (provenance drives coupon exclusion), B2B-2c (identity is decided by the LOADER through
 * customers.user_id; this function only receives the already-bound buyer's group, or null).
 *
 * PURITY CONTRACT (enforced by the `no-restricted-imports` override in packages/shared/eslint.config.mjs for this
 * folder): no imports at all, no Date, no Math.random, no I/O, no mutation of inputs. Every number is an integer
 * number of piastres (or a quantity / basis-point count); the arithmetic below stays inside Number.MAX_SAFE_INTEGER
 * because every input is capped at Int4 (2_147_483_647), so no float ever touches a money value.
 *
 * Ruling B2B-3b - the lowest merchant-authored price visible to this buyer at this quantity. Specificity decides only
 * WITHIN one audience; nothing stacks.
 *   candidate tier : its minQty is reached (variant tier: variantQty; product tier: qty) AND its price is < base AND, for
 *                    a product-level tier, base === the product's own price (a variant with its own price needs
 *                    variant-level tiers: an absolute product tier would otherwise misprice it)
 *   pub            : among candidate PUBLIC tiers (groupId null) - variant-level beats product-level; within a level the
 *                    LOWEST price (equal prices: the smaller minQty). None -> base. This is exactly what an anonymous buyer pays.
 *   gTier          : same selection over the buyer's ACTIVE group's tiers (groupId === group.id). Only if there is a group.
 *   gPct           : base * (10000 - bps) / 10000, exact integer round-half-up, if the active group is percent_off, bps > 0.
 *   unit           : min(pub, gTier, gPct), clamped to [0, base]. Hence unit(group buyer) <= unit(anonymous) always, and
 *                    unit is always one of the merchant's own numbers (base, a tier price, base minus the group percent).
 *   source         : the winner; ties break gTier -> gPct -> pub. unit === base reports 'base' (no discount => no coupon
 *                    exclusion, Ruling B2B-5).
 *
 * MOQ is reported, never enforced here: below MOQ the price is still resolved (the shopper builds the cart up) and the
 * caller refuses at order / payment-link / admin-order time.
 */

export type PriceSource = 'base' | 'tier' | 'group';

export interface PriceTierRow {
  variantId: string | null;
  groupId: string | null;
  minQty: number;
  priceMinor: number;
}

export interface BuyerGroup {
  id: string;
  pricingMode: 'none' | 'percent_off';
  /** Basis points, 1250 = 12.5%. */
  discountBps: number;
  isActive: boolean;
}

export interface ResolveInput {
  /** variant.price ?? product.price, in piastres. */
  baseMinor: number;
  /**
   * The PRODUCT's own price in piastres (default: baseMinor, i.e. the line has no variant price of its own). A product-level
   * tier only applies when baseMinor === productPriceMinor.
   */
  productPriceMinor?: number;
  /** Total quantity of this PRODUCT across the cart (Ruling B2B-4). Tiers with variantId null and MOQ use this. */
  qty: number;
  /** Total quantity of this VARIANT across the cart. Variant-level tiers use it. Defaults to `qty`. */
  variantQty?: number;
  variantId: string | null;
  /** The authenticated buyer's group, or null (guest, non-member, not approved). Never derived from a typed phone/email. */
  buyerGroup: BuyerGroup | null;
  /** Only this product's tier rows. */
  tiers: readonly PriceTierRow[];
  /** Product minimum order quantity (null / undefined = none). */
  moq?: number | null;
}

export interface Resolved {
  unitMinor: number;
  source: PriceSource;
  /** The minQty of the tier that applied; null unless source === 'tier'. */
  tierMinQty: number | null;
  /** The retail unit price (== baseMinor) this was resolved from. */
  listMinor: number;
  /** True when the winning price came from the buyer's GROUP (a group tier or the group percent), not a public tier. */
  groupApplied: boolean;
  /** True when qty is below the product MOQ. The price above is still valid. */
  belowMoq: boolean;
  moqRequired: number | null;
  /**
   * The price breaks THIS buyer could reach for this line: public tiers plus the active group's tiers that are in scope for
   * the line (variant tier for this variant; product tier only when base === the product's price) and below base, sorted by
   * minQty then price, whatever the current quantity. Persisted on the order line (Task 8b) so a later partial return
   * reprices the kept units from what was on offer at sale time, and read by the cart to know how high a stepper may go.
   * `variant` = a variant-level tier (reached on the VARIANT quantity, else on the PRODUCT quantity); `group` = the buyer's
   * group tier (else public). Both are needed to re-run the B2B-3b selection on a kept quantity (Ruling B2B-17).
   */
  ladder: Array<{ minQty: number; priceMinor: number; variant: boolean; group: boolean }>;
  /**
   * The group-percent price (base minus the active group's percent_off), whether or not it won at this quantity; null when
   * the buyer has no active percent_off group. Quantity-independent, so a partial return reprices kept units no higher than
   * this (Ruling B2B-18).
   */
  groupPercentMinor: number | null;
}

const INT4_MAX = 2_147_483_647;
const BPS_FULL = 10_000;

function assertInt(
  name: string,
  v: unknown,
  min: number,
  max: number = INT4_MAX
): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(
      `resolveUnitPrice: ${name} must be an integer in [${min}, ${max}], got ${String(v)}`
    );
  }
}

/** Exact integer round-half-up of base * (10000 - bps) / 10000. No float is involved. */
function applyPercentOff(baseMinor: number, discountBps: number): number {
  const numerator = baseMinor * (BPS_FULL - discountBps) + BPS_FULL / 2; // <= 2.2e13, exact in a double
  return (numerator - (numerator % BPS_FULL)) / BPS_FULL;
}

export function resolveUnitPrice(i: ResolveInput): Resolved {
  assertInt('baseMinor', i.baseMinor, 0);
  assertInt('qty', i.qty, 0);
  const variantQty = i.variantQty ?? i.qty;
  assertInt('variantQty', variantQty, 0);
  if (i.moq !== undefined && i.moq !== null) assertInt('moq', i.moq, 1);
  const group = i.buyerGroup;
  if (group !== null) {
    if (group.pricingMode !== 'none' && group.pricingMode !== 'percent_off') {
      throw new RangeError(`resolveUnitPrice: unknown pricingMode ${String(group.pricingMode)}`);
    }
    assertInt('discountBps', group.discountBps, 0, BPS_FULL);
  }
  // Validate EVERY tier up front, including ones that will be skipped: a corrupt row must be loud, not silently ignored.
  for (const t of i.tiers) {
    assertInt('tier.minQty', t.minQty, 2);
    assertInt('tier.priceMinor', t.priceMinor, 0);
  }

  const base = i.baseMinor;
  const activeGroupId = group !== null && group.isActive ? group.id : null;
  const moqRequired = i.moq ?? null;
  const belowMoq = moqRequired !== null && i.qty < moqRequired;
  const productPriceForLadder = i.productPriceMinor ?? base;
  const ladder = i.tiers
    .filter(t => {
      if (t.priceMinor >= base) return false;
      if (t.groupId !== null && t.groupId !== activeGroupId) return false;
      if (t.variantId !== null) return t.variantId === i.variantId;
      return base === productPriceForLadder;
    })
    .map(t => ({
      minQty: t.minQty,
      priceMinor: t.priceMinor,
      variant: t.variantId !== null,
      group: t.groupId !== null,
    }))
    .sort((a, b) => a.minQty - b.minQty || a.priceMinor - b.priceMinor);
  const groupPercentMinor =
    group !== null && group.isActive && group.pricingMode === 'percent_off' && group.discountBps > 0
      ? Math.min(applyPercentOff(base, group.discountBps), base)
      : null;
  const out = (
    unitMinor: number,
    source: PriceSource,
    tierMinQty: number | null,
    groupApplied = false
  ): Resolved => ({
    unitMinor,
    source,
    tierMinQty,
    listMinor: base,
    groupApplied,
    belowMoq,
    moqRequired,
    ladder,
    groupPercentMinor,
  });

  const productPrice = i.productPriceMinor ?? base;
  assertInt('productPriceMinor', productPrice, 0);

  /** Best candidate of one audience: variant-level beats product-level, then lowest price, then smaller minQty. */
  const pick = (audience: string | null): PriceTierRow | null => {
    let best: PriceTierRow | null = null;
    for (const t of i.tiers) {
      if (t.groupId !== audience) continue;
      if (t.priceMinor >= base) continue;
      if (t.variantId !== null) {
        if (t.variantId !== i.variantId || t.minQty > variantQty) continue;
      } else if (base !== productPrice || t.minQty > i.qty) {
        continue;
      }
      if (best === null) {
        best = t;
        continue;
      }
      const tv = t.variantId !== null ? 0 : 1;
      const bv = best.variantId !== null ? 0 : 1;
      if (
        tv < bv ||
        (tv === bv &&
          (t.priceMinor < best.priceMinor ||
            (t.priceMinor === best.priceMinor && t.minQty < best.minQty)))
      ) {
        best = t;
      }
    }
    return best;
  };

  const pubTier = pick(null);
  const gTier = activeGroupId !== null ? pick(activeGroupId) : null;
  const gPct = groupPercentMinor;

  // min across audiences; on a tie the order gTier -> gPct -> pub decides the provenance.
  let unit = base;
  let source: PriceSource = 'base';
  let tierMinQty: number | null = null;
  let groupApplied = false;
  if (gTier !== null && gTier.priceMinor < unit) {
    unit = gTier.priceMinor;
    source = 'tier';
    tierMinQty = gTier.minQty;
    groupApplied = true;
  }
  if (gPct !== null && gPct < unit) {
    unit = gPct;
    source = 'group';
    tierMinQty = null;
    groupApplied = true;
  }
  if (pubTier !== null && pubTier.priceMinor < unit) {
    unit = pubTier.priceMinor;
    source = 'tier';
    tierMinQty = pubTier.minQty;
    groupApplied = false;
  }
  return out(unit, source, tierMinQty, groupApplied);
}
