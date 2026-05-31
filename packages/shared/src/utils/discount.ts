/**
 * Discount math helpers — centralised so the admin form, API service,
 * and unit tests all share identical rounding/clamping logic.
 *
 * Encoding conventions:
 *   percentage → basis points (percent × 100, range 0–10 000)
 *                e.g. 12.5% is stored as 1250
 *   fixed      → fils   (1 KWD = 1 000 fils)
 *
 * All price amounts in/out of these helpers are in FILS.
 */

export type DiscountType = 'percentage' | 'fixed';

export interface ApplyDiscountResult {
  /** Active selling price in fils. */
  price: number;
  /**
   * "Was" price shown struck-through on the storefront.
   * null when no discount is applied.
   */
  compareAtPrice: number | null;
}

/**
 * Compute the discount amount in fils.
 *
 * - percentage: `round(basisPoints / 10000 × regularPrice)`
 * - fixed:      `value` (already in fils)
 * - Clamped to [0, regularPrice] so we never produce a negative price.
 */
export function computeDiscountAmount(
  regularPriceFils: number,
  type: DiscountType,
  value: number
): number {
  let amount: number;
  if (type === 'percentage') {
    // basisPoints ÷ 10 000 gives the fraction; multiply by regular price.
    amount = Math.round((value / 10000) * regularPriceFils);
  } else {
    amount = value;
  }
  // Clamp: can't be negative or exceed the regular price.
  return Math.max(0, Math.min(amount, regularPriceFils));
}

/**
 * Derive the final price/compareAtPrice pair from a regular price + discount.
 *
 * - If the discount resolves to >0 and <regularPrice:
 *     price        = regularPrice − amount
 *     compareAtPrice = regularPrice
 * - Otherwise (no discount or 100% discount):
 *     price        = regularPrice
 *     compareAtPrice = null
 */
export function applyDiscount(
  regularPriceFils: number,
  type: DiscountType,
  value: number
): ApplyDiscountResult {
  const amount = computeDiscountAmount(regularPriceFils, type, value);
  if (amount > 0 && amount < regularPriceFils) {
    return {
      price: regularPriceFils - amount,
      compareAtPrice: regularPriceFils,
    };
  }
  return {
    price: regularPriceFils,
    compareAtPrice: null,
  };
}

export interface DiscountInput {
  /** The regular (RRP) price the merchant typed, in fils. */
  regularPrice: number;
  /** The discount type, or 'none' when no discount is active. */
  type: DiscountType | 'none';
  /**
   * The raw discount value:
   *   - percentage → basis points (e.g. 1250 for 12.5%)
   *   - fixed      → fils
   *   - none       → 0
   */
  value: number;
}

/**
 * Reverse-engineer the admin discount input fields from stored product data.
 *
 * Three cases handled:
 *  1. New columns present (discountType + discountValue on the product row).
 *  2. Legacy row: compareAtPrice > price but no discount columns — infer a
 *     fixed discount equal to the delta.
 *  3. No discount: regularPrice = price, type = 'none'.
 */
export function deriveDiscountInput(product: {
  price: number;
  compareAtPrice?: number | null;
  discountType?: DiscountType | null;
  discountValue?: number | null;
}): DiscountInput {
  const { price, compareAtPrice, discountType, discountValue } = product;

  // Case 1 — new columns present.
  if (discountType != null && discountValue != null) {
    const regularPrice = compareAtPrice ?? price;
    return { regularPrice, type: discountType, value: discountValue };
  }

  // Case 2 — legacy compareAtPrice > price (admin previously set the raw
  // compare-at field). Treat as a fixed-fils discount so the form
  // is pre-populated rather than blank.
  if (compareAtPrice != null && compareAtPrice > price) {
    return {
      regularPrice: compareAtPrice,
      type: 'fixed',
      value: compareAtPrice - price,
    };
  }

  // Case 3 — no discount.
  return { regularPrice: price, type: 'none', value: 0 };
}
