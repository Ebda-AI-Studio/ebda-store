# Mutate-in-Place vs Append-Only History Audit

**Date:** 2026-05-28
**Scope:** `packages/database/prisma/schema.prisma` + all `apps/api/src` routes and services
**Status:** READ-ONLY — no code changes

---

## Executive Summary

`Payment` was the first gap closed (→ `PaymentEvent` append-only log, 2026-05-28). This audit found **4 P0 gaps** and **4 P1 gaps** across 8 models. The most critical are: (1) `Order.status` transitions driven by the shipping carrier service bypass the only `audit_log` action that records the previous state; (2) `StoreFeature` feature-flag toggles and plan changes (`setStorePlan`) have **zero** audit log coverage despite controlling billing-gated features; (3) `Affiliate` status transitions (pending → approved → suspended) have **zero** audit log or event log coverage despite holding money owed to affiliates; (4) `LoyaltyPoints.tier` and `LoyaltyPoints.points` mutate in place against 9 `prisma.loyaltyPoints.update` sites with no audit trail. `Return` has good per-action `audit_log` coverage for its major transitions but lacks a `shipped` → state event. `Shipment` stores history as a JSON column (`statusHistory`) which is queryable but not relational. Cheapest fix across all 8 is extending `audit_log` writes in the service layer before committing any new event tables.

---

## P0 Gaps

---

### 1. Order — shipping-carrier-driven status transitions

**Model:** `Order`
**Risk tier:** P0

**What gets mutated in place:**

- `Order.status` (enum: `pending → confirmed → processing → shipped → delivered → cancelled → refunded`)
- `Order.paymentStatus` (enum: `unpaid → paid → failed → refunded → disputed`)

Both fields are plain columns that flip on `prisma.order.update`. There is no `order_events` table.

**Today's audit trail:**

The route `PUT /stores/:storeId/orders/:id/status` wraps `OrderService.updateStatus()` and writes a single `audit_log` row with `action: 'order.status.updated'` including `previousStatus` and `newStatus`:

- `apps/api/src/routes/order.routes.ts` line 203

However, three additional `Order.status` mutation sites exist **with no matching `audit_log` write**:

| Site                              | What it mutates                                      | Audit? |
| --------------------------------- | ---------------------------------------------------- | ------ |
| `shipping-carrier.service.ts:410` | `status: 'processing'` (cancel shipment side-effect) | none   |
| `shipping-carrier.service.ts:481` | `status: 'shipped'`, `shippedAt`                     | none   |
| `shipping-carrier.service.ts:575` | `status` + `deliveredAt` (tracking poll)             | none   |

The `PaymentEvent` log is written for COD and webhook payment state changes, but the `Order.status` field that piggybacks on those flows (e.g. `webhook.routes.ts:80` sets `idempotencyKey`/`webhookProcessedAt` but not `status`) does not get an event row.

**Gap impact:**
If a merchant disputes "my order was marked delivered but it wasn't" and the state flip came from a carrier tracking poll (`updateShipmentStatus`), there is no audit trail linking the status change to the specific carrier API response that triggered it. A 6-month-old dispute has no reconstruction path.

**Recommended fix:**
Extend `audit_log` writes at the three `shipping-carrier.service.ts` mutation sites. No new table needed — add `auditLog({ action: 'order.status.changed_by_carrier', ... details: { carrier, trackingNumber, fromStatus, toStatus } })` after each `prisma.order.update`. **Effort: S (~30 min)**

---

### 2. StoreFeature / Plan — feature toggle and plan change have zero audit coverage

**Model:** `StoreFeature`, `Store.plan`
**Risk tier:** P0

**What gets mutated in place:**

- `StoreFeature.enabled` / `enabledAt` / `enabledBy` — boolean override per feature key, upserted per row
- `Store.plan` — `free | starter | professional | enterprise` string column

`featureService.updateStoreFeatures()`, `featureService.setFeature()`, `featureService.clearFeatureOverride()`, `featureService.resetAllOverrides()`, and `featureService.setStorePlan()` all mutate these fields. None of them call `auditLog`.

The routes in `feature.routes.ts` also have no `auditLog` call:

- `apps/api/src/routes/feature.routes.ts` lines 82–113 (`PUT /admin/stores/:id/features` bulk)
- `apps/api/src/routes/feature.routes.ts` lines 119–162 (`PUT /admin/stores/:id/features/:featureKey` single)
- `apps/api/src/routes/feature.routes.ts` lines 169–197 (`DELETE /admin/stores/:id/features/:featureKey` clear override)
- `apps/api/src/routes/feature.routes.ts` lines 205–221 (`DELETE /admin/stores/:id/features` reset all)
- `apps/api/src/routes/feature.routes.ts` lines 231–267 (`PUT /admin/stores/:id/plan` plan change)

`apps/api/src/services/feature.service.ts` — zero `auditLog` calls.

**Gap impact:**
If a merchant disputes their billing tier ("I was on `professional` but got charged for `enterprise`") or a feature gate ("my analytics feature stopped working on day X"), there is no record of who changed the plan or toggled the override, or when. Super-admin actions on these routes are completely untracked. Plan changes are the billing-gating mechanism per `feedback-plan-baseline-override-pattern.md`.

**Recommended fix:**
Add `auditLog` calls in `feature.routes.ts` (not the service — routes have `req.user`) at all 5 write endpoints. Include `{ featureKey, enabled, previousEnabled }` or `{ oldPlan, newPlan }` in `details`. No new table. **Effort: S (~30 min)**

---

### 3. Affiliate — approve / reject / suspend have zero audit coverage

**Model:** `Affiliate`, `AffiliateReferral`, `AffiliatePayout`
**Risk tier:** P0

**What gets mutated in place:**

- `Affiliate.status` — `"pending" | "approved" | "rejected" | "suspended"` (plain String, not enum)
- `Affiliate.totalEarned`, `Affiliate.totalPaid`, `Affiliate.pendingBalance` — running money totals that increment/decrement on each commission event
- `AffiliateReferral.status` — `"clicked" | "converted" | "commission_paid" | "refunded"`
- `AffiliatePayout.status` — `"pending" | "paid"`

Mutation sites in `affiliate.service.ts`:

- Line 290: `approve()` → `status: 'approved'`
- Line 310: `reject()` → `status: 'rejected'`
- Line 323: `suspend()` → `status: 'suspended'`
- Lines 460, 464: commission payment atomically flips referral + updates `totalEarned`/`pendingBalance`/`totalPaid`
- Lines 505, 509: refund reversal flips referral `status: 'refunded'` and deducts from balances

`apps/api/src/routes/affiliate.routes.ts` — zero `auditLog` calls.
`apps/api/src/services/affiliate.service.ts` — zero `auditLog` calls.

**Gap impact:**
Affiliates are owed real money. If a dispute arises ("I was approved then suspended without notice" or "my commission was marked refunded but the customer didn't return the product"), there is no record of who performed the action, when, or with what justification. `approvedBy` stores the userId but no timestamp of the reject/suspend transitions. Running balance mutations are done atomically with referral status flips but have no log.

**Recommended fix:**
Add `auditLog` in the three route handlers for approve/reject/suspend. For the money flows (commission payment, refund reversal), add `auditLog` inside `affiliate.service.ts` — those are service-level actions with no corresponding route handlers. No new table. **Effort: S–M (~1 hr)**

---

### 4. LoyaltyPoints — tier upgrades and manual adjustments mutate in place

**Model:** `LoyaltyPoints`
**Risk tier:** P0 (customer trust + potential money equivalent)

**What gets mutated in place:**

- `LoyaltyPoints.points` — current balance, updated by 9 call sites across `loyalty-automation.service.ts`
- `LoyaltyPoints.tier` — `"bronze" | "silver" | "gold" | "platinum"`, silently upgraded/downgraded by the automation cron (lines 213, 386 in `loyalty-automation.service.ts`)
- `LoyaltyPoints.totalEarned`, `LoyaltyPoints.totalRedeemed` — running lifetime counters

**Today's audit trail:**
`LoyaltyTransaction` is an append-only table (one row per earn/redeem/expire/adjust event) — this is the existing history log. Mutation sites in `loyalty-automation.service.ts` do create `LoyaltyTransaction` rows alongside `LoyaltyPoints` updates.

However the **tier column** is NOT covered. `LoyaltyTransaction.type` has no `tier_upgrade` / `tier_downgrade` enum value, and the automation service at lines 213 and 386 (which may change the tier after recalculating) does **not** create a `LoyaltyTransaction` row for the tier change itself — only for the points adjustment that triggered the recalculation.

Manual loyalty adjustments via `loyalty.routes.ts` have no `auditLog` call.

**Gap impact:**
A customer who was downgraded from `gold` to `silver` cannot reconstruct when that happened or why. The `LoyaltyTransaction` log proves points changed but not that the tier changed simultaneously. A dispute "I lost my gold benefits overnight" has no answer.

**Recommended fix:**
Add a `tier_upgrade` / `tier_downgrade` `LoyaltyTransactionType` enum value and write a `LoyaltyTransaction` row whenever the tier field changes in `loyalty-automation.service.ts`. Additionally add `auditLog` to `loyalty.routes.ts` manual-adjust endpoints. **Effort: M (~2 hrs for schema migration + service update)**

---

## P1 Gaps

---

### 5. Return — missing audit for `shipped` transition

**Model:** `Return`
**Risk tier:** P1

**What gets mutated in place:**

- `Return.status` — `pending → approved → rejected → shipped → received → inspecting → completed → cancelled`

**Today's audit trail:**
`return.routes.ts` has `auditLog` for 5 of 8 transitions:

- `return.created` (line 100)
- `return.approved` (line 242)
- `return.rejected` (line 286)
- `return.received` (line 321)
- `return.completed` (line 370)

**Missing:** `shipped` (customer ships item back), `inspecting`, `cancelled` transitions — no `auditLog` write.

**Gap impact:**
If a return reaches `received` but there is no record of the `shipped` step (customer claims they shipped, merchant claims item never arrived), the state history has a gap. The `shippedAt` timestamp exists on the row but no audit log records who set it.

**Recommended fix:**
Add `auditLog({ action: 'return.shipped', ... })` and `return.cancelled` + `return.inspecting` entries in the relevant route handlers. **Effort: S (~30 min)**

---

### 6. Shipment — statusHistory is JSON, not relational; no auditLog writes

**Model:** `Shipment`
**Risk tier:** P1

**What gets mutated in place:**

- `Shipment.status` (plain String: `"created" | "shipped" | "in_transit" | "delivered" | "cancelled"`)
- `Shipment.statusHistory` — `Json @default("[]")` column that stores an array of `{ status, timestamp, description }` objects

`apps/api/src/services/shipping-carrier.service.ts` appends to `statusHistory` on every `prisma.shipment.update` — so a partial history exists. However:

1. History lives inside the parent row, not in a sibling table — it cannot be queried via Prisma joins, filtered by time range, or indexed.
2. `statusHistory` is replaced atomically with the full array — a concurrent write (e.g. polling race) can silently drop events.
3. No `auditLog` writes anywhere in `shipping-carrier.service.ts`.

**Gap impact:**
A merchant investigation ("when did my shipment stall at in_transit?") requires reading the JSON blob on the `Shipment` row and parsing it application-side. If two carrier poll calls race, one history entry can be lost. No `audit_log` query can answer "what shipments changed status today."

**Recommended fix:**
Keep `statusHistory` JSON for backward compatibility but add `auditLog({ action: 'shipment.status_changed', ... })` at all three `prisma.shipment.update` call sites. Future: migrate `statusHistory` to a `shipment_events` table for relational queryability. **Effort: S for auditLog writes; L for full migration**

---

### 7. Review — approval/rejection have no audit coverage

**Model:** `Review`
**Risk tier:** P1

**What gets mutated in place:**

- `Review.status` — `pending | approved | rejected | hidden` (inferred from `review.service.ts` approve/reject/hide methods)
- `Review.moderationReason` — updated in place on rejection

Mutation sites:

- `apps/api/src/routes/review.routes.ts:398` — manual admin approval/rejection
- `apps/api/src/services/review.service.ts:290, 314, 332` — `approve`, `reject`, `hide` methods
- `apps/api/src/lib/inngest/functions/review-moderation.ts:43` — AI-driven auto-moderation

**Today's audit trail:** `review.routes.ts` has **zero** `auditLog` calls.

**Gap impact:**
If a merchant reports "you approved a fake review" or a customer reports "my legitimate 5-star review was rejected without reason," there is no record of who approved or rejected it, when, or why. AI auto-moderation decisions at `review-moderation.ts:43` are completely invisible in the audit trail.

**Recommended fix:**
Add `auditLog({ action: 'review.approved' | 'review.rejected' | 'review.hidden', details: { reason, isAiDecision } })` in `review.routes.ts` and `review-moderation.ts`. **Effort: S (~30 min)**

---

### 8. User — role and status changes log `changedFields` string, not before/after values

**Model:** `User`
**Risk tier:** P1

**What gets mutated in place:**

- `User.role` — `customer | store_admin | super_admin`
- `User.status` — `active | inactive | suspended`

**Today's audit trail:**
`admin.routes.ts:564` writes `auditLog({ action: 'user.updated', details: { changedFields: 'role, status' } })` — the string lists which fields changed but **does NOT capture the previous values**.

`apps/api/src/routes/admin.routes.ts` lines 527–571.

**Gap impact:**
If a super-admin account is compromised and grants `store_admin` role to an attacker, the `audit_log` row proves the change happened but cannot prove the account was previously `customer`. Reconstructing the before-state requires joining against older audit rows. For SOC2 or a Kuwait Law 13/2023 erasure audit, the absence of before-values creates a compliance gap.

**Recommended fix:**
Fetch `prisma.user.findUnique({ select: { role, status } })` **before** the `prisma.user.update` call and include `previousRole` / `previousStatus` in the `auditLog` details. One-line addition. **Effort: S (~15 min)**

---

## Prioritized Close-Out Plan

Order: cheapest + highest impact first.

| Priority | Model               | Action                                                                                      | Effort     | Why first                                              |
| -------- | ------------------- | ------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| 1        | User                | Add `previousRole`/`previousStatus` to `user.updated` audit log                             | S (15 min) | One fetch + one field change; zero schema migration    |
| 2        | StoreFeature / Plan | Add `auditLog` to 5 endpoints in `feature.routes.ts`                                        | S (30 min) | Zero schema; closes the billing-change blind spot      |
| 3        | Return              | Add `auditLog` for `shipped`, `cancelled`, `inspecting` transitions                         | S (30 min) | Copy-paste from existing `return.approved` pattern     |
| 4        | Review              | Add `auditLog` for approve/reject/hide + AI decisions                                       | S (30 min) | Single route file + single Inngest function            |
| 5        | Affiliate           | Add `auditLog` for approve/reject/suspend + commission/refund events                        | M (1 hr)   | Route handlers + service-level calls; no schema change |
| 6        | Order (carrier)     | Add `auditLog` at 3 `shipping-carrier.service.ts` `order.update` sites                      | S (30 min) | Closes the carrier-driven status transition blind spot |
| 7        | Shipment            | Add `auditLog` at 3 `shipping-carrier.service.ts` `shipment.update` sites                   | S (30 min) | Pairs with #6; same file, same session                 |
| 8        | LoyaltyPoints       | Add `tier_upgrade`/`tier_downgrade` to `LoyaltyTransactionType` + write rows on tier change | M (2 hrs)  | Requires schema migration; do after schema-free fixes  |

**Total estimated effort:** ~6 hours for all 8. Items 1–7 require no schema migrations and can ship in a single PR. Item 8 requires a migration and should be a separate PR.
