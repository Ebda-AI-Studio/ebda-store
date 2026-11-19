/**
 * Write-time validation for a price tier (docs/plans/done/2026-10-21-b2b-wholesale.md Task 4; Q3, Rulings B2B-3b and B2B-12).
 * Pure, no imports. The resolver stays total on bad data (it drops / orders defensively); this is where bad data is REFUSED,
 * so the merchant sees a clear error instead of a silently ignored row.
 *
 *   TIER_ABOVE_BASE           price >= the base it applies to (a tier equal to base is useless). Base = the variant's price
 *                             (or the product's) for a variant-level tier, the product price for a product-level one.
 *   TIER_NOT_MONOTONE         inside one (variant, group) scope a higher minQty must have a STRICTLY lower price.
 *   TIER_VARIANT_ABOVE_PRODUCT (B2B-12) a variant-level tier may not be priced above a product-level tier of the same audience
 *                             that is already reached at its minQty (the resolver prefers variant-level, so it would make the
 *                             price RISE with quantity).
 *   TIER_DUPLICATE            same scope and minQty already exists (409).
 *   TIER_LIMIT                at most MAX_TIERS_PER_SCOPE tiers per (product, variant, group) scope (anti-abuse).
 * Warning (not blocking): TIER_BELOW_COST when price < costPrice.
 */

export const MAX_TIERS_PER_SCOPE = 10;

export interface TierInput {
  id?: string;
  variantId: string | null;
  groupId: string | null;
  minQty: number;
  priceMinor: number;
}

export type TierErrorCode =
  | 'TIER_ABOVE_BASE'
  | 'TIER_NOT_MONOTONE'
  | 'TIER_VARIANT_ABOVE_PRODUCT'
  | 'TIER_DUPLICATE'
  | 'TIER_LIMIT';

export interface TierValidation {
  errors: Array<{ code: TierErrorCode; message: string }>;
  warnings: Array<{ code: 'TIER_BELOW_COST' | 'TIER_BELOW_MOQ'; message: string }>;
}

export function validateTierWrite(i: {
  tier: TierInput;
  /** The tiers already stored for this PRODUCT (any scope). The tier being updated is excluded by `tier.id`. */
  existing: readonly TierInput[];
  productPriceMinor: number;
  /** The variant's own price when the tier is variant-level and the variant has one. */
  variantPriceMinor?: number | null;
  costPriceMinor?: number | null;
  /** The product's minimum order quantity: a tier whose minQty is below it can never apply (review M5). */
  moq?: number | null;
}): TierValidation {
  const { tier } = i;
  const others = i.existing.filter(e => e.id === undefined || e.id !== tier.id);
  const errors: TierValidation['errors'] = [];
  const warnings: TierValidation['warnings'] = [];

  const base =
    tier.variantId !== null ? (i.variantPriceMinor ?? i.productPriceMinor) : i.productPriceMinor;
  if (tier.priceMinor >= base) {
    errors.push({
      code: 'TIER_ABOVE_BASE',
      message: `A tier price must be below the ${base} base price it applies to.`,
    });
  }

  const sameScope = others.filter(
    e => e.variantId === tier.variantId && e.groupId === tier.groupId
  );
  if (sameScope.some(e => e.minQty === tier.minQty)) {
    errors.push({
      code: 'TIER_DUPLICATE',
      message: 'A tier for this quantity already exists in this scope.',
    });
  }
  if (
    sameScope.length >= MAX_TIERS_PER_SCOPE &&
    !i.existing.some(e => e.id !== undefined && e.id === tier.id)
  ) {
    errors.push({ code: 'TIER_LIMIT', message: `At most ${MAX_TIERS_PER_SCOPE} tiers per scope.` });
  }
  if (
    sameScope.some(
      e =>
        (e.minQty < tier.minQty && e.priceMinor <= tier.priceMinor) ||
        (e.minQty > tier.minQty && e.priceMinor >= tier.priceMinor)
    )
  ) {
    errors.push({
      code: 'TIER_NOT_MONOTONE',
      message: 'A higher quantity must have a strictly lower price within the same scope.',
    });
  }

  const audience = others.filter(e => e.groupId === tier.groupId);
  const violatesAudience =
    tier.variantId !== null
      ? audience.some(
          e => e.variantId === null && e.minQty <= tier.minQty && tier.priceMinor > e.priceMinor
        )
      : audience.some(
          e => e.variantId !== null && tier.minQty <= e.minQty && e.priceMinor > tier.priceMinor
        );
  if (violatesAudience) {
    errors.push({
      code: 'TIER_VARIANT_ABOVE_PRODUCT',
      message:
        'A variant-level tier cannot be priced above the product-level tier of the same audience.',
    });
  }

  if (i.costPriceMinor != null && tier.priceMinor < i.costPriceMinor) {
    warnings.push({ code: 'TIER_BELOW_COST', message: 'This tier price is below the cost price.' });
  }
  if (i.moq != null && tier.minQty < i.moq) {
    warnings.push({
      code: 'TIER_BELOW_MOQ',
      message: `This tier starts at ${tier.minQty} but the minimum order is ${i.moq}, so it can never apply.`,
    });
  }
  return { errors, warnings };
}

/** Tiers priced at or above the CURRENT base are stale (the merchant lowered the price under them): flagged, never silently clamped. */
export function isStaleTier(
  t: TierInput,
  productPriceMinor: number,
  variantPriceMinor?: number | null
): boolean {
  const base = t.variantId !== null ? (variantPriceMinor ?? productPriceMinor) : productPriceMinor;
  return t.priceMinor >= base;
}
