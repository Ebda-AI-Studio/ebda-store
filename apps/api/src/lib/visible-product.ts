/**
 * The ONE Prisma fragment that says "a product an anonymous shopper may see". Spread it into every storefront product read AND
 * into the `targetProduct` / `product1` / `product2` relation filters of recommendation-shaped reads, so a related-product
 * hydration can never forget the audience (the C1 leak: manual cross-sell, AI recs, FBT and upsell hydrated the target
 * with no audience filter). Merchant surfaces do not use it.
 */
export function visibleProductWhere(): { audience: 'public' } {
  return { audience: 'public' };
}
