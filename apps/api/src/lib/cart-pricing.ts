import { resolveUnitPrice } from '@ebda/shared';

/**
 * Unit price (in piastres) for a single cart / order line.
 *
 * When the line has a chosen variant, the customer is charged THAT variant's
 * price; only variant-less products fall back to the parent product price.
 * Using the parent `product.price` for a variant line charged every variant at
 * the parent's (typically lowest) price — a real undercharge that shipped
 * across the cart subtotal, the order subtotal, and the persisted OrderItem.
 *
 * Nullish-coalescing (not `||`) on purpose: a genuinely free variant with
 * `price === 0` stays 0, rather than falling through to the parent price.
 *
 * @deprecated Retail-only. Use `PriceResolver` (tiers, group price, MOQ). Kept so existing callers behave identically
 * until Task 3 of the B2B wholesale plan migrates them.
 */
export function cartLineUnitPrice(item: {
  variant?: { price?: number | null } | null;
  product: { price: number };
}): number {
  // Delegates to the one resolver with NO tiers and NO buyer group, so the answer is the retail price exactly as
  // before. Task 3 of docs/plans/2026-10-21-b2b-wholesale.md migrates every caller to `PriceResolver`
  // (apps/api/src/services/price-resolver.service.ts) and deletes this wrapper.
  return resolveUnitPrice({
    baseMinor: item.variant?.price ?? item.product.price,
    qty: 1,
    variantId: null,
    buyerGroup: null,
    tiers: [],
  }).unitMinor;
}
