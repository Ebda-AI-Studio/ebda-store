# Feature Flag Enforcement Audit — 2026-05-28

**Trigger**: Ahmad toggled OFF the `inventory.backorder` feature for Wady Aljuz and observed
that backorder logic still ran in the background — only the UI was hidden. The API, Inngest
jobs, and DB-write paths were not enforcing the flag.

**Feature key audited**: `inventory.backorder`  
**Resolver**: `featureService.isFeatureEnabled(storeId, 'inventory.backorder')`  
**Middleware**: `requireFeature('inventory.backorder')` (Express middleware, fail-closed)

---

## Backorder code path inventory

| Path                                             | File                          | Gap before fix                                                       | Fix applied                                                                                                 |
| ------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GET `/:storeId/backorders`                       | `routes/backorders.routes.ts` | No feature check                                                     | Added `requireFeature('inventory.backorder')`                                                               |
| POST `/:storeId/backorders/:id/cancel`           | `routes/backorders.routes.ts` | No feature check                                                     | Added `requireFeature('inventory.backorder')`                                                               |
| POST `/bulk-set-backorder`                       | `routes/product.routes.ts`    | No feature check                                                     | Added `requireFeature('inventory.backorder')`                                                               |
| `CartService.addItem`                            | `services/cart.service.ts`    | Respected `product.allowBackorder` without checking store-level flag | Resolves `backorderFeatureEnabled` before transaction; uses `effectiveAllowBackorder = flag && per-product` |
| `CartService.addItems`                           | `services/cart.service.ts`    | Same gap                                                             | Same fix                                                                                                    |
| `CartService.updateItem`                         | `services/cart.service.ts`    | Same gap                                                             | Same fix                                                                                                    |
| `OrderService.create` — variant inventory lock   | `services/order.service.ts`   | Checked only `allow_backorder` DB column                             | Added `backorderFeatureEnabled &&` before accepting backorder                                               |
| `OrderService.create` — product inventory lock   | `services/order.service.ts`   | Same gap                                                             | Same fix                                                                                                    |
| WA bridge `POST /cart/from-wa` — inventory check | `routes/wa-bridge.routes.ts`  | Same gap                                                             | Added `backorderFeatureEnabled` check before `!product.allowBackorder`                                      |

### Display-only paths (no enforcement gap — read-only)

WA bridge product catalog endpoints (`/products/search`, `/products/by-category`, `/store-catalog`)
return `inStock` computed from `allowBackorder`. These are display metadata for the WBS bot.
The actual order path is gated, so these display values are cosmetic. The bot may show a
product as "in stock" when it isn't if `allowBackorder=true` and the feature is disabled, but
the order will be rejected at the now-fixed `POST /cart/from-wa` path. Not a billing/security
gap — noted as cosmetic improvement for follow-up.

### Inngest / background jobs

- `accounting-post-po-receive-journal.ts` — fires AFTER a PO receipt, processes already-committed
  `backorderLine` rows. Downstream accounting only; does not create new backorder demand.
- All other Inngest functions: no direct backorder logic.

**Conclusion**: No Inngest function needs additional enforcement.

---

## Other features with potential enforcement gaps (follow-up PRs)

| Feature key           | Route file                 | Status                                                          |
| --------------------- | -------------------------- | --------------------------------------------------------------- |
| `coupons`             | `coupon.routes.ts`         | Needs audit — no `requireFeature` found                         |
| `loyalty`             | `loyalty.routes.ts`        | Has `requireFeature('loyalty')` on some routes                  |
| `returns`             | `return.routes.ts`         | Has `requireFeature('returns')` on all routes                   |
| `reviews`             | `review.routes.ts`         | Needs audit                                                     |
| `inventory.basic`     | `inventory.routes.ts`      | Has `router.use(requireFeature('inventory'))` — uses parent key |
| `inventory.backorder` | `backorders.routes.ts`     | **Fixed this PR**                                               |
| `bulk_operations`     | `bulk.routes.ts`           | Has `router.use(requireFeature('bulk_operations'))`             |
| `abandoned_cart`      | `abandoned-cart.routes.ts` | Has `requireFeature` on all routes                              |
| `affiliate`           | `affiliate.routes.ts`      | Has `requireFeature('affiliate')` on routes                     |
| `marketing_pixels`    | `store.routes.ts`          | Has `requireFeature('marketing_pixels')` on route               |
| `upsell_crosssell`    | `recommendation.routes.ts` | Has `requireFeature` on all routes                              |
| `pwa`                 | `pwa.routes.ts`            | Has `requireFeature('pwa')` on routes                           |

**Priority follow-up**: `coupons`, `reviews`.

---

## Wady Aljuz verification

Wady Aljuz is on the `professional` plan. Per `PLAN_BASELINE`:

```ts
const PROFESSIONAL_ADDITIONS: FeatureKey[] = [
  'inventory.stock_alerts',
  'inventory.backorder',  // ← included
  ...
];
```

`inventory.backorder` is included in the professional baseline. Ahmad's test toggle-off created
a `StoreFeature` override row with `enabled=false`. Per the resolver, the override wins.

**Before shipping**, the override row MUST be cleared via:

- Super-admin → Stores → Wady Aljuz → Features → Clear override for `inventory.backorder`
- OR: `node scripts/verify-wady-aljuz-backorder.mjs --fix`
- OR: `DELETE FROM store_features WHERE store_id = '<wj-id>' AND feature_key = 'inventory.backorder'`

After clearing, `isFeatureEnabled` resolves to `true` (plan baseline = professional includes backorder).

The PR description includes the verification result.
