# PITFALLS-EXTERNAL — F&B Online-Ordering Platform

**Domain:** restaurant / F&B online-ordering platform (FWB F&B vertical, to compete with Zyda)
**Date mined:** 2026-07-14
**Sources scanned:** 95 repos, 260 issues, 6 HN threads, 0 SO. **11 pitfalls kept, 5 dropped** (unverifiable/backlog/self-referential).
**Primary sources:** `enatega/food-delivery-multivendor` (1.3k★, the goldmine — covers every focus area), `saleor/saleor` (webhook idempotency), `gibouu/workincafe` (loyalty races). All issue URLs verified live via `gh api`.

## ⚠️ The headline lesson (read before designing anything)

**8 of 11 pitfalls are the same class: a business rule enforced only in the client/admin UI, never re-validated at order-create on the server.** Modifiers, minimum order, working hours, coupons, delivery zones — all bypassable by a direct API call, a race, or a stale cart.

→ **Architectural spine for the F&B vertical: ONE server-side `createOrder` validator** that re-checks every rule (modifier cardinality, min order, store-open, zone, coupon, pricing) against the DB config, shared by web, app, POS, and **WhatsApp (WBS)** channels. The client checks are UX niceties only. Build this first.

---

## Pitfalls

### 1. Modifier-group required/max rules enforced only in admin UI [menu-modifiers]

- **What:** Storefront lets checkout proceed without a required addon, or lets the user exceed the configured max-select.
- **Why:** Modifier cardinality (min/max/required) defined once in admin, re-implemented ad hoc per client → drift.
- **Mitigation:** Define modifier-group schema (min/max/required) once server-side; validate every order payload against a Zod schema derived from the DB config inside the order-create resolver. Never trust client pre-filtering.
- **File:** `apps/fwb-api/src/routes/orders/createOrder.schema.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/1901 (4 reports)

### 2. Addon price as flat total, not per-option delta; no bounds [menu-modifiers]

- **What:** Whole-group price charged instead of summing per-option deltas; negative values accepted; paid optional group rejected by single-group cart logic.
- **Why:** Options not modeled as signed, bounded price deltas; cart hardcodes one-group assumption.
- **Mitigation:** Model each option as `{priceDelta: Decimal >= 0, groupId, required, maxSelect}`; enforce with a DB check constraint + Zod `.nonnegative()`; cart holds N modifier groups per line item explicitly.
- **File:** `apps/fwb-api/prisma/schema.prisma`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/2051 (3 reports)

### 3. Order status silently stops updating in real time [order-status]

- **What:** Customer/rider app freezes on stale status after a network blip; correct state only after manual refresh.
- **Why:** Status relies solely on a WebSocket/GraphQL subscription with no liveness check or fallback.
- **Mitigation:** Pair the push channel with a low-freq fallback poll (~15s) while the order is non-terminal; add a subscription heartbeat + force-resubscribe on miss; show a visible "reconnecting" state, never a silent freeze.
- **File:** `apps/fwb-storefront/src/features/fnb/orders/useOrderStatusStream.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/2189 (6 reports)

### 4. Webhook + synchronous completion race → duplicate order/payment [pos-sync]

- **What:** A webhook racing the sync completion path for the same order creates two payment intents / two fulfillments / a duplicate order.
- **Why:** Webhooks are at-least-once and can race a sync call; without an idempotency key both paths pass their own "not processed" check and both write. (Same architecture Deliverect/Foodics integrations use.)
- **Mitigation:** Idempotency key on every webhook + order mutation (unique constraint on `external_event_id` or `(order_id, status_transition)`); wrap state transitions in `SELECT … FOR UPDATE` / serializable tx so both paths serialize on the row.
- **File:** `apps/fwb-api/src/services/pos/webhookIdempotency.ts`
- **Ref:** https://github.com/saleor/saleor/issues/19220 (4 reports)

### 5. Address→delivery-zone matching fails silently or picks wrong zone [delivery-zones]

- **What:** New address resolves to wrong country/zone or none; zone-fetch fails silently; out-of-zone caught only by a cryptic checkout error.
- **Why:** Zone resolution is a client-side lookup, not one server source of truth; fetch failures fail silently.
- **Mitigation:** Resolve address→zone **server-side only** via PostGIS `ST_Contains` point-in-polygon (or H3 cell membership) against the store's zone geometry; return explicit `out_of_zone` / `zone_lookup_failed` the client must handle before checkout. Never let the client infer/cache a zone.
- **File:** `apps/fwb-api/src/services/delivery/resolveZoneForAddress.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/1852 (6 reports)

### 6. Delivery-only fields leak into pickup flow (and vice versa) [order-types]

- **What:** Tip prompts, delivery charges, wrong tax appear on pickup orders; pickup still asks "where to?".
- **Why:** Each screen re-implements its own "is this delivery?" check off no single order-type enum → drift.
- **Mitigation:** Compute the full fee breakdown once server-side keyed off `order.type`; return a discriminated-union `OrderPricingBreakdown`; render every surface (checkout, tracking, receipt) from that one object.
- **File:** `apps/fwb-api/src/services/pricing/computeOrderPricing.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/1613 (5 reports)

### 7. Loyalty/points redemption is check-then-act → double-spend [loyalty]

- **What:** Two concurrent redemptions (double-tap/retry/expiry-cron overlap) both pass the balance check before either writes.
- **Why:** Balance check and decrement are two separate statements (TOCTOU).
- **Mitigation:** One atomic statement — `UPDATE loyalty_balances SET points = points - :cost WHERE points >= :cost RETURNING points` — zero rows updated = insufficient. Never split check and write.
- **File:** `apps/fwb-api/src/services/loyalty/redeemPoints.ts`
- **Ref:** https://github.com/gibouu/workincafe/issues/217 (3 reports)

### 8. Coupon validation gaps: no expiry/limit checks, >100% discount, admin coupon rejected [loyalty]

- **What:** Admin-created coupons rejected on the app; discount silently accepts >100%; no expiry/usage-limit/case/whitespace enforcement.
- **Why:** Coupon validation duplicated between admin-write and customer-apply paths → rules exist on one side only.
- **Mitigation:** One shared `validateAndApplyCoupon(code, cart)` for both admin preview and checkout; enforce bounds server-side (`[0,100]` %, expiry vs `now()`, normalization); increment `usage_count` atomically under a unique constraint on `(coupon_id, redemption_reference)`.
- **File:** `apps/fwb-api/src/services/promotions/validateCoupon.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/1976 (4 reports)

### 9. Courier dispatch race: riders miss orders on availability toggle / matched out of zone [courier]

- **What:** Rider going available mid-window isn't matched until the next cycle; riders assigned outside their zone; pickup status doesn't propagate.
- **Why:** "Find eligible riders" snapshots availability/zone at one point in dispatch time instead of re-evaluating on state change.
- **Mitigation:** Re-run rider matching against live availability + geofence on every relevant event (rider online, order created, decline) via a queue-driven dispatcher; persist rider-status transitions with timestamps so the matcher never reads a stale value.
- **File:** `apps/fwb-api/src/services/dispatch/matchRiderToOrder.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/732 (3 reports)

### 10. Working-hours toggles inverted; orders accepted while "closed" [order-types]

- **What:** Toggling one day's hours flips sibling days; storefront gives no closed indication; orders placeable while closed.
- **Why:** Per-day state stored as a position-indexed array (bug on one day flips another); order-creation gated only by a UI badge.
- **Mitigation:** Store schedule as explicit `{day:'mon'|…, isOpen, openTime, closeTime}[]` keyed by day name (never index); enforce "is store open now" server-side inside order-create, evaluated in the store's timezone.
- **File:** `apps/fwb-api/src/services/store/isStoreOpenNow.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/1667 (3 reports)

### 11. Minimum-order enforced client-side only [delivery-zones]

- **What:** UI disables the button below minimum, but the API accepts sub-minimum orders via direct call / race / stale cart.
- **Why:** Min-order validation lives only in the checkout button-disable logic.
- **Mitigation:** Re-validate `cart.subtotal >= store.minimumOrderAmount` inside the order-create handler; typed error; server check is sole truth, UI disable is a nicety.
- **File:** `apps/fwb-api/src/routes/orders/createOrder.ts`
- **Ref:** https://github.com/enatega/food-delivery-multivendor/issues/691 (3 reports)

---

## Sub-threshold patterns (informational — <3 independent reports)

1. **WhatsApp ordering: cart-state divergence** between an LLM/bot layer and persisted order state (button-payload races, "confirm-add" clobbering) — highly relevant to WBS ordering, but only one internally-audited repo found. **Watch this closely** given WBS is our differentiator: keep the WhatsApp channel writing through the same `createOrder` validator with idempotency.
2. **POS/kiosk modifier-group UI focus bugs** — modifiers not rendering until the UI loses/regains focus (Electron/WebView POS). One verified report.
3. **Geofence design-doc tickets** — PostGIS/H3 zone-matching appears as forward-looking backlog rather than closed bugs → teams know zones need a real geo layer but under-report the failure itself.

---

_Cached at `~/.claude/projects/-Users-ahmadsharaf/memory/ecosystem-research/fnb-ordering-platform.md` (90-day TTL). Regenerate with `/ecosystem-research restaurant f&b online ordering platform --refresh`._
