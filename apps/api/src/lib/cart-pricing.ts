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
 * RETAIL ONLY, on purpose (Ruling B2B-8: bundle components are priced at base; also the display price of an unavailable
 * line). Every charged or customer-visible LOOSE-line price goes through `PriceResolver`
 * (apps/api/src/services/price-resolver.service.ts); `tests/unit/b2b-no-direct-price-reads.test.ts` enforces that.
 */
export function retailUnitPrice(item: {
  variant?: { price?: number | null } | null;
  product: { price: number };
}): number {
  // Delegates to the one resolver with NO tiers and NO buyer group: the RETAIL shelf price of one unit.
  return resolveUnitPrice({
    baseMinor: item.variant?.price ?? item.product.price,
    qty: 1,
    variantId: null,
    buyerGroup: null,
    tiers: [],
  }).unitMinor;
}
