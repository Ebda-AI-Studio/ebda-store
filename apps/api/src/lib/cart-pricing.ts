/**
 * Unit price (in fils) for a single cart / order line.
 *
 * When the line has a chosen variant, the customer is charged THAT variant's
 * price; only variant-less products fall back to the parent product price.
 * Using the parent `product.price` for a variant line charged every variant at
 * the parent's (typically lowest) price — a real undercharge that shipped
 * across the cart subtotal, the order subtotal, and the persisted OrderItem.
 *
 * Nullish-coalescing (not `||`) on purpose: a genuinely free variant with
 * `price === 0` stays 0, rather than falling through to the parent price.
 */
export function cartLineUnitPrice(item: {
  variant?: { price?: number | null } | null;
  product: { price: number };
}): number {
  return item.variant?.price ?? item.product.price;
}
