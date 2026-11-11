/**
 * Pure targeting/discount math shared by coupons (code-based) and promotions
 * (automatic), by apps/api and the Durable Object twins (single source, Ruling PRICE-1). No DB access: callers
 * pass a fully-resolved context so this stays trivially testable and safe to run in the order transaction.
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

/**
 * ONE discount formula for every pricing entry point (Ruling PRICE-1): coupon checkout, the cart quote, admin order
 * create, the promotions preview, and the Durable Object twins all call this function. A result is always a whole
 * number of piastres in [0, base]: a negative or non-finite stored value yields 0 (never a surcharge), and a percentage
 * or fixed value above the goods is capped at the goods.
 */
export function computeDiscount(
  type: 'percentage' | 'fixed' | 'free_shipping',
  value: number,
  maxDiscount: number | null,
  base: number
): number {
  if (!Number.isFinite(value) || !Number.isFinite(base) || value <= 0 || base <= 0) return 0;
  if (type === 'percentage') {
    const d = Math.min(base, Math.round((base * value) / 100)); // never more than the goods (a legacy value above 100)
    // A cap of 0 (or less) is "no cap", exactly as the admin form says for a blank field (QA-COUPON-1).
    return maxDiscount != null && maxDiscount > 0 && d > maxDiscount ? maxDiscount : d;
  }
  if (type === 'fixed') return Math.min(value, base);
  return 0; // free_shipping is handled on the shipping line, not here
}

export interface CouponDiscountInput extends Targeting {
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  maxDiscount: number | null;
}

/**
 * The coupon discount for a resolved cart, for EVERY entry point (checkout, quote, admin order create, DO twins).
 *
 * Rules enforced (default): targeting is evaluated and the discount is computed over the matching subtotal only.
 * Rules overridden (Ruling M-OVR-1, admin order create): the eligibility gates are ignored; a scoped coupon still
 * discounts only its in-scope lines when the order has any, otherwise the whole `overrideBase` (the scope rule is
 * the one being overridden). `free_shipping` always returns 0: its benefit is the shipping line.
 */
export function couponCartDiscount(
  coupon: CouponDiscountInput,
  ctx: TargetingCtx,
  opts: { override?: boolean; overrideBase?: number } = {}
): { eligible: boolean; discount: number } {
  if (!opts.override) {
    const r = matchesTargeting(coupon, ctx);
    if (!r.eligible) return { eligible: false, discount: 0 };
    return {
      eligible: true,
      discount: computeDiscount(coupon.type, coupon.value, coupon.maxDiscount, r.matchingSubtotal),
    };
  }
  const scopeOnly = matchesTargeting(
    {
      customerGroupId: null,
      firstOrderOnly: false,
      minOrderAmount: null,
      minQuantity: null,
      scopeProductIds: coupon.scopeProductIds,
      scopeCategoryIds: coupon.scopeCategoryIds,
    },
    ctx
  );
  const base = scopeOnly.eligible ? scopeOnly.matchingSubtotal : (opts.overrideBase ?? 0);
  return {
    eligible: true,
    discount: computeDiscount(coupon.type, coupon.value, coupon.maxDiscount, base),
  };
}
