# Promotions Engine + Coupon Targeting — Design (Core + targeting)

_2026-07-22 · branch `feat/promotions` (stacked on `feat/customer-groups`/#874)._

## Goal

Close the OSOSS promotions/coupon-targeting gap with **one shared targeting model
and evaluator**, used by BOTH:

- the existing code-based **`Coupon`** (adding the targeting it lacks today), and
- a new automatic **`Promotion`** (applies with no code when conditions match).

Discount types stay `percentage / fixed / free_shipping`. This is the dependency
root the customer-groups work (#874) was built to unblock: promotions/coupons can
now target a customer group.

Out of scope for this PR (explicit, per the "close the credibility floor, don't
rebuild OSOSS's ERP" strategy): BOGO (buy-X-get-Y), tiered / spend-more-save-more,
lifetime purchase-history conditions, per-group base **price lists**. Each is a
clean fast-follow on top of this shared model.

## Decisions locked (from brainstorm)

1. **Parallel structure, not a rewrite.** Keep the working `Coupon` table, admin UI,
   and `order.couponCode/couponDiscount` fields intact. Add a new `Promotion` model.
   The "shared model" is a shared **targeting field set + a pure evaluator service**,
   not a unified table. (Unifying coupons into one table with an optional `code` was
   rejected: a data migration + rewrites of every coupon consumer for no user-facing
   gain.)
2. **Scope via scalar `String[]` arrays, not join tables.** `scopeProductIds` /
   `scopeCategoryIds` on both models; empty (both) = whole cart. No FK integrity, but a
   stale id simply never matches — acceptable for a scope filter, and it avoids four join
   tables plus cascade handling. **When both facets are set they combine as a UNION**
   (an item is in scope if it matches the product scope OR the category scope — "these
   specific products, plus everything in these categories"); a single-facet scope reduces
   to that one facet. (Decided 2026-07-22; matches Shopify/OSOSS product+collection scope
   semantics.)
3. **Stacking = best-of(coupon, best auto-promotion), not additive.** Safe by
   construction (never over-discounts). Loyalty continues to stack on the remainder,
   unchanged. Per-promotion opt-in stacking is a later PR.

## Data model

### Shared targeting fields (added to `Coupon`; present on `Promotion`)

| Field              | Type                                  | Meaning                         |
| ------------------ | ------------------------------------- | ------------------------------- |
| `customerGroupId`  | `String?` → `CustomerGroup` (SetNull) | null = all customers            |
| `firstOrderOnly`   | `Boolean @default(false)`             | customer's first order only     |
| `minQuantity`      | `Int?`                                | min total qty of matching items |
| `scopeProductIds`  | `String[]`                            | empty = all products            |
| `scopeCategoryIds` | `String[]`                            | empty = all categories          |

`Coupon` already has `minOrderAmount`, `startsAt`, `expiresAt` — reused as-is.

### New `Promotion` model

```
id, storeId, name, nameAr?, description?, descriptionAr?
type CouponType (percentage | fixed | free_shipping)   // reuse existing enum
value Int                                                // % (0-100) or fils
maxDiscount Int?                                         // cap for percentage
priority Int @default(0)                                 // higher wins ties
isActive Boolean @default(true)
startsAt DateTime?  expiresAt DateTime?
+ shared targeting fields above
createdAt / updatedAt
@@index([storeId, isActive])   @@map("promotions")
```

No usage-limit / usage-count in Core (YAGNI for automatic promotions).

### `Order` audit columns (new)

- `promotionDiscount Int @default(0)` — fils, mirrors `couponDiscount`.
- `appliedPromotionId String?` → `Promotion` (SetNull) — which auto-promo applied.

### Migration

`ALTER TABLE coupons ADD COLUMN` for the five targeting fields (nullable / default,
so backward-compatible — existing coupons target everyone). `CREATE TABLE promotions`
with **FORCE ROW LEVEL SECURITY** and the canonical per-command hybrid policies
(copied verbatim from `20260609000000` / the `customer_groups` migration —
`current_store_id() IS NULL OR bypass_rls='true' OR store_id = current_store_id()`,
one policy per command; bypass value is `'true'` not `'on'`). `promotions.customer_group_id`
and `orders.applied_promotion_id` FKs are `ON DELETE SET NULL`. `ADD COLUMN` on
`orders` for `promotion_discount` / `applied_promotion_id`.

## Shared evaluator — `promotion-targeting.ts` (pure, no DB)

```ts
interface TargetingCtx {
  customerGroupId: string | null;
  isFirstOrder: boolean;
  cartItems: { productId: string; categoryIds: string[]; quantity: number; lineTotal: number }[];
}
interface Targeting {
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}

matchesTargeting(t: Targeting, ctx: TargetingCtx):
  { eligible: boolean; matchingSubtotal: number; matchingQty: number };

computeDiscount(type, value, maxDiscount, base): number;   // generalizes CouponService.calculateDiscount
```

Rules: when a scope is set, a cart item matches when its id ∈ scopeProductIds OR one of
its categoryIds ∈ scopeCategoryIds (UNION; a single-facet scope reduces to that facet;
empty both = whole cart). Eligible requires:
group matches (or no group targeting), first-order satisfied, `matchingSubtotal ≥
minOrderAmount`, `matchingQty ≥ minQuantity`, and `matchingSubtotal > 0` when any
scope is set. Discount is computed against `matchingSubtotal` (whole subtotal when no
scope).

## Checkout wiring — `order.service.ts` (server-authoritative)

Slots into the existing discount block (currently coupon → loyalty):

1. **Customer context**: resolve the customer's group via the phone→email identity
   bridge from #874 (reuse the same lookup), and `isFirstOrder` (no prior non-cancelled
   order for this identity). Guests with no phone/email → group null, isFirstOrder true.
2. **Coupon** (if `couponCode`): `getByCode` → **run `matchesTargeting`** → if
   ineligible, throw a specific 400 (`COUPON_NOT_ELIGIBLE`) → discount on
   `matchingSubtotal` (not the whole subtotal). `free_shipping` unchanged.
3. **Promotions** (new): load active auto-promos for the store within their date
   window → filter by `matchesTargeting` → pick the highest `priority` eligible (ties:
   larger discount). Compute its discount.
4. **Best-of**: `primaryDiscount = max(couponDiscount, promotionDiscount)`; record
   which one won (`appliedPromotionId` set only if the promo won). `free_shipping`
   coupon still zeroes shipping independently.
5. `discount = primaryDiscount + loyaltyDiscount` (loyalty caps against the remainder,
   as today). `total = max(0, subtotal + tax + shipping − discount)` — clamp unchanged.
6. Persist `promotionDiscount` + `appliedPromotionId` on the order.

## Preview / storefront

- Extend `POST /coupons/validate` to accept the cart + customer identity and run
  targeting, so an ineligible code is rejected in-cart (not just at order creation).
- Add `POST /stores/:storeId/promotions/preview` → given cart + identity, returns the
  best applicable automatic promotion (id, name, discount) for display.
- Web checkout (`OrderSummary` / `CheckoutClient`) shows the applied promotion as its
  own discount line; the auto-promo preview runs alongside the existing coupon/summary
  fetch.

## Admin

- **Coupons form**: add the targeting controls — customer-group dropdown (from the
  `/customer-groups` list), product/category scope pickers, min-quantity, first-order-only.
- **New `/stores/[id]/promotions` page**: list + create/edit automatic promotions with
  the same targeting controls plus type/value/maxDiscount/priority/date window/active.
  Bilingual name fields; mirrors the customer-groups page structure. Satisfies the
  "every data has a UI" gate for the `promotions` table.
- Both surfaces are ungated (like customer groups) — promotions are core commerce
  structure, not a sold add-on.

## Testing

- **Evaluator unit tests** (pure, no DB): group match / mismatch; first-order gate;
  product-scope and category-scope matching + partial-cart subtotal; min-order and
  min-quantity gates; empty-scope = whole cart; `computeDiscount` percentage cap +
  fixed clamp.
- **Service/integration**: coupon rejected when targeting fails; best-of selection
  (coupon vs promo, both directions); auto-promo applied with no code; over-discount
  clamp (`discount ≤ matchingSubtotal`, `total ≥ 0`); `appliedPromotionId` persisted
  only when the promo wins.
- **RLS**: cross-tenant promotion id 404s; per-command policy present (no silent
  deny-all).

## Money-integrity guardrails (from memory)

- Server computes every discount; client-asserted discounts are never trusted (matches
  existing coupon handling).
- Discount can never exceed the matching subtotal; total clamped at 0.
- Coupon usage-count increment stays atomic inside the order transaction (unchanged).
- Order carries `couponDiscount` + `promotionDiscount` separately for an auditable
  breakdown.

## Blast-radius surfaces to sweep at PR time

`Promotion` · `promotions` · `promotionDiscount` · `appliedPromotionId` ·
`scopeProductIds` · `scopeCategoryIds` · `customerGroupId` (new coupon consumers) ·
every reader of the order discount breakdown (invoice, order-confirmation email,
accounting `order-posting`, admin order view, refund gating) — a new discount channel
must appear in each place `couponDiscount` already does.
