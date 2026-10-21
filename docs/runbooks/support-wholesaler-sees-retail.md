# Support: "a wholesaler sees the retail price"

Check in this order; each step is a read.

1. **Is the store on the plan?** Admin > Features: `b2b.wholesale` must be on (Business or comped). Without it tiers and group prices are not applied (MOQ and wholesale-only visibility still are).
2. **Is the buyer signed in?** Wholesale prices follow the SIGNED-IN account only. A phone or email typed at checkout never unlocks them (Ruling B2B-2c). The PDP paints the buyer's price after load from `POST /public/pricing/resolve`; the first server-rendered HTML is always retail.
3. **Is the application approved and the group wholesale and active?** Admin > Sales > Wholesale applications (status approved) and Customer groups (wholesale ticked, active). A group that was deactivated or a buyer moved to a non-wholesale group by hand ends the prices.
4. **Is the account linked?** The customer profile shows the group; the link is `customers.user_id`. A guest checkout, or an account of a different store, has no link.
5. **Is a tier actually lower?** Product > Wholesale pricing: a break at or above the current price is marked *not applied*; a break below the minimum order never applies; a variant with its own price needs variant-level breaks.
6. **Is the line eligible?** Coupon / promotion / loyalty lines are excluded on tier and group lines, so the order total can look "retail" only for those parts.
7. **Cache?** Every tier, group, membership, MOQ and audience change drops the pricing caches in the same request. If a price is stale after a change, look for a writer that skipped `invalidateB2bPricing` (`tests/unit/b2b-invalidate-callsites.test.ts` lists the writers).

Order totals are fixed at order creation (`expectedTotal` / 409 `PRICE_CHANGED`); a shopper who saw a different number before placing the order reloads the cart.
