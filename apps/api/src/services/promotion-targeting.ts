/**
 * Pure targeting/discount math shared by coupons (code-based) and promotions
 * (automatic). No DB access — callers pass a fully-resolved context so this
 * stays trivially testable and safe to run in the order transaction.
 */
export interface CartItemForTargeting {
  productId: string;
  categoryIds: string[];
  quantity: number;
  lineTotal: number; // piastres
}

export interface TargetingCtx {
  customerGroupId: string | null;
  isFirstOrder: boolean;
  cartItems: CartItemForTargeting[];
}

export interface Targeting {
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}

export interface TargetingResult {
  eligible: boolean;
  matchingSubtotal: number;
  matchingQty: number;
}

function itemInScope(item: CartItemForTargeting, t: Targeting): boolean {
  // Union semantics: an item is in scope if it matches the product scope OR the
  // category scope ("these specific products, plus everything in these
  // categories"). Only ever called when at least one facet is set (see the
  // `scoped` guard in matchesTargeting), so a single-facet scope reduces to
  // that one facet — the other's `.includes`/`.some` over an empty list is
  // simply false and doesn't veto the match.
  const productMatch = t.scopeProductIds.includes(item.productId);
  const categoryMatch = item.categoryIds.some(c => t.scopeCategoryIds.includes(c));
  return productMatch || categoryMatch;
}

export function matchesTargeting(t: Targeting, ctx: TargetingCtx): TargetingResult {
  const miss: TargetingResult = { eligible: false, matchingSubtotal: 0, matchingQty: 0 };

  if (t.customerGroupId && t.customerGroupId !== ctx.customerGroupId) return miss;
  if (t.firstOrderOnly && !ctx.isFirstOrder) return miss;

  const scoped = t.scopeProductIds.length > 0 || t.scopeCategoryIds.length > 0;
  const matching = scoped ? ctx.cartItems.filter(i => itemInScope(i, t)) : ctx.cartItems;

  const matchingSubtotal = matching.reduce((s, i) => s + i.lineTotal, 0);
  const matchingQty = matching.reduce((s, i) => s + i.quantity, 0);

  if (scoped && matchingSubtotal <= 0) return miss;
  if (t.minOrderAmount != null && matchingSubtotal < t.minOrderAmount) return miss;
  if (t.minQuantity != null && matchingQty < t.minQuantity) return miss;

  return { eligible: true, matchingSubtotal, matchingQty };
}

export function computeDiscount(
  type: 'percentage' | 'fixed' | 'free_shipping',
  value: number,
  maxDiscount: number | null,
  base: number
): number {
  if (type === 'percentage') {
    const d = Math.min(base, Math.round((base * value) / 100)); // never more than the goods (a legacy value above 100)
    // A cap of 0 (or less) is "no cap", exactly as the admin form says for a blank field: QA-COUPON-1 found validate
    // (calculateDiscount) ignoring a 0 cap while the order capped the discount AT 0, so the shopper was shown a
    // discount the order never gave.
    return maxDiscount != null && maxDiscount > 0 && d > maxDiscount ? maxDiscount : d;
  }
  if (type === 'fixed') {
    return value > base ? base : value;
  }
  return 0; // free_shipping is handled on the shipping line, not here
}
