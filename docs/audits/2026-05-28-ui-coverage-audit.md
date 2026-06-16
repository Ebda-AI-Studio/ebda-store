# UI Coverage Audit — Force AI Store (FWB)

**Date:** 2026-05-28  
**Auditor:** Claude Code (automated, read-only)  
**Scope:** Every Prisma model in `packages/database/prisma/schema.prisma`  
**Rule:** Every table whose rows have business meaning to a merchant, super-admin, or customer MUST have a UI surface to view them.

---

## Executive Summary

| Metric                  | Count |
| ----------------------- | ----- |
| Total Prisma models     | 64    |
| Has UI ✅               | 49    |
| Doesn't need UI ⏭️      | 5     |
| NEEDS UI but missing ❌ | 10    |

**Top P0 callout:** `ProductFaq` rows are rendered on the storefront PDP (with JSON-LD schema.org injection) but **no admin editor exists** — merchants cannot create, edit, or delete them without direct DB access. `AiUsage` / `LoyaltyTransaction` (admin view) are the next two highest-value gaps.

---

## Infra / No-UI-needed models ⏭️

| Model                  | Justification                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `RefreshToken`         | Pure auth infra — reuse-detection rows, rotated automatically. No business meaning to any user.         |
| `VerificationToken`    | One-time tokens for email verification / password reset — consumed and expired automatically.           |
| `ProductCategory`      | Junction table (product ↔ category M:M). Not a standalone entity; managed via product/category editors. |
| `ProductVariantOption` | Junction table (variant ↔ option value). Managed inline on product variants editor.                     |
| `Sequence`             | Per-store monotonic counter for PO/adjustment/expense/journal numbering. Pure infra increment.          |

---

## Models with UI ✅ (confirmed by grep)

Orders, Products, Categories, Customers, Reviews, Returns, Coupons, ShippingZones, TaxRates, LoyaltyPoints (balance view on storefront `/account/loyalty` + admin members table), NewsletterSubscriber (admin `/newsletter`), AuditLog (admin `/audit-logs`), AbandonedCart (admin `/abandoned-carts` + `AbandonedCartConfig`), Affiliate + AffiliateConfig (admin `/affiliates`), AffiliatePayout (create modal — see gap #6), BlogPost (admin `/blog`), StorePage (admin `/content`), StoreFaq (admin `/content/[slug]` as part of page builder), StoreHowto (admin `/content/[slug]`), BulkImportJob (admin `/bulk`), BulkAiJob (admin `/ai-tools`), Supplier + PurchaseOrder + PurchaseOrderItem (admin `/stock/suppliers`, `/stock/purchase-orders`), StockAdjustment + StockAdjustmentItem (admin `/stock/adjustments`), ReorderRule (admin `/stock/reorder` — shows suggestions; gap #8), BackorderLine (admin `/stock/backorders`), Expense (admin `/finance/expenses`), Account (admin `/finance/accounts`), JournalEntry + JournalLine (admin `/finance/journal`), ProfitAnomaly (admin `/finance/anomalies`), DeadStockFlag (admin `/stock/deadstock`), ReorderSuggestion (admin `/stock/reorder`), CustomerCohortSnapshot (admin `/insights/cohorts`), FunnelSnapshot (admin `/insights/funnel`), CustomerRfmSnapshot (admin `/insights/segments`), Shipment (admin `/shipping-carriers` — ShipmentsTable), ShippingCarrierConfig (admin `/shipping-carriers`), NotificationConfig (admin `/notifications`), NotificationLog (admin `/notifications` — NotificationsLog component), PushSubscription (infra-adjacent, see gap #9), OneSignalSubscription (admin `/account/devices`), StoreFeature (admin `/features`), PaymentConfig (admin `/payment-settings`), Payment (rendered in admin order detail → PaymentCard), WhatsAppTemplate (admin `/wa-templates`), Address (storefront `/account/addresses` — user shipping addresses), WishlistItem + Wishlist (storefront `/wishlist`), Tag + ProductTag (product editor), ProductOption + ProductOptionValue + ProductVariant (admin `/products/[id]/variants`), ProductImage (product editor), ProductFaq (storefront PDP renders it — **admin side missing, see gap #1**), AffiliateReferral (API exists, no list UI — see gap #5), AffiliateEvent (API exists, no UI — see gap #7), AiUsage (no UI anywhere — gap #2), LoyaltyTransaction (customer side ✅, admin side ❌ — gap #3), CustomerAddress (admin customer detail shows last shipping address only from Order snapshot, not the `customer_addresses` table — gap #4), SystemSetting (no UI — gap #10), FrequentlyBoughtTogether (no dedicated viewer — gap #11, P2).

---

## Gaps — P0 (Money / Customer Trust / Compliance)

---

### GAP-1 — `ProductFaq` — No admin editor ❌

**Model:** `ProductFaq`  
**What rows mean:** Per-product FAQ entries (e.g. "Does this ring come in size 7?") that appear as an accordion on the storefront PDP AND are injected as `schema.org/FAQPage` JSON-LD for Google's rich results. Rich results drive click-through on search; broken/missing FAQs = SEO regression.  
**Audience:** Merchant  
**Why no UI today:** Model shipped with API CRUD routes (`GET/POST/PATCH/DELETE /products/:id/faqs`) and storefront rendering in `ProductDetailClient.tsx`, but the admin product edit page (`/stores/[id]/products/[id]/edit`) and product detail page were never updated to include the editor. The only path to manage these is the bulk AI sweep (`faq_aeo` kind) — merchants can't manually author or correct them.  
**Where UI should live:** Admin → `/stores/[id]/products/[id]/edit` — collapsible "FAQ" section below the description, with add/edit/delete rows inline (same pattern as variants). Or a dedicated tab on the product detail page at `/stores/[id]/products/[id]`.  
**Effort:** M (~2 hrs)  
**Priority:** P0 — storefront is rendering AI-drafted FAQs that merchants cannot review or correct. A bad AI answer is customer-facing and uncorrectable without DB access.

---

### GAP-2 — `AiUsage` — No viewer anywhere ❌

**Model:** `AiUsage`  
**What rows mean:** Every Gemini API call made on behalf of a store — feature name, token counts, whether it was a cache hit. Powers the daily/monthly quota cap enforcement in `ai-quota.ts`. Without a UI, merchants can't see how much of their AI budget is consumed, and super-admins can't audit per-store spend or identify runaway sweeps.  
**Audience:** Merchant (own store) + Super-admin (cross-store)  
**Why no UI today:** The model was added as internal quota tracking; no one built the read surface. The admin `/ai-tools` page only shows bulk job progress, not token consumption.  
**Where UI should live:** Merchant: admin `/stores/[id]/ai-tools` — add a "Usage" tab or stats bar showing daily/monthly token consumption vs. cap. Super-admin: `/dashboard` or `/users` — per-store usage table.  
**Effort:** M (~2 hrs for merchant; +S for super-admin summary)  
**Priority:** P0 — merchants hitting their daily quota cap (`AI_DAILY_REQUEST_CAP`) get silent failures on bulk sweeps with no explanation. This is a direct product experience gap.

---

## Gaps — P1 (Operational)

---

### GAP-3 — `LoyaltyTransaction` — Admin view missing (customer view exists) ❌

**Model:** `LoyaltyTransaction`  
**What rows mean:** Every loyalty points earn/redeem/expire/adjust event for a customer — the complete audit trail of their loyalty balance. The customer sees their own history on `/account/loyalty`. The merchant admin sees member balances in the MembersTable but **cannot view the transaction history for a specific member** from the admin panel.  
**Audience:** Merchant  
**Why no UI today:** The API endpoint `GET /stores/:storeId/loyalty/members/:customerId/transactions` exists (line 179 in `loyalty.routes.ts`) but is never called from any admin component.  
**Where UI should live:** Admin `/stores/[id]/loyalty` — clicking a member row in `MembersTable` should open a slide-over or expand to show their transaction history (date, type, points delta, order reference). This is a pure read surface.  
**Effort:** S (~30 min — API endpoint already exists, just needs a UI component)  
**Priority:** P1 — merchant support for "why did my points change?" requires DB access today.

---

### GAP-4 — `CustomerAddress` — Not visible in admin ❌

**Model:** `CustomerAddress`  
**What rows mean:** Saved delivery addresses for customers captured via the WhatsApp native catalog bot checkout flow. First address is auto-set as default. These are distinct from the `Address` model (which is the User-scoped shipping address for storefront checkout). The admin customer detail page shows "Last shipping address" sourced from order JSON snapshots — it does NOT read or display `customer_addresses` rows.  
**Audience:** Merchant  
**Why no UI today:** `CustomerAddress` was added as part of the WhatsApp bot Phase (wa-catalog native checkout). The admin customer detail page predates this model and was never updated.  
**Where UI should live:** Admin `/stores/[id]/customers/[customerKey]` — add a "Saved Addresses" section below the last-order address block, listing all `CustomerAddress` rows for the customer (label, street, block, area, isDefault badge).  
**Effort:** S (~30 min — read-only list, no create/edit needed in admin)  
**Priority:** P1 — merchants handling WhatsApp orders can't verify which address the bot collected vs. what the customer intended.

---

### GAP-5 — `AffiliateReferral` — No row-level list in admin ❌

**Model:** `AffiliateReferral`  
**What rows mean:** Every click on an affiliate referral link plus conversion events (click → order). Each row has status (`clicked` / `converted`), commission amount, order ID, cookie expiry. The admin affiliate page shows aggregate stats (totalReferrals count on the stats card) but there is no UI to list individual referral events per affiliate.  
**Audience:** Merchant  
**Why no UI today:** The API endpoint `GET /stores/:storeId/affiliates/:id/referrals` exists (line 272 in `affiliate.routes.ts`) but is never called from admin. The `PayoutsHistory` component is a payout creation modal, not a history list.  
**Where UI should live:** Admin `/stores/[id]/affiliates` — clicking an affiliate row in the table should expand or navigate to a detail view with two tabs: "Referrals" (list of AffiliateReferral rows with status/order/commission) and "Payouts" (list of AffiliatePayout rows).  
**Effort:** M (~2 hrs — need to build the referrals + payouts list component)  
**Priority:** P1 — affiliates ask "which orders counted toward my commission?" and merchants can't answer without querying the DB.

---

### GAP-6 — `AffiliatePayout` — History list missing (only create form exists) ❌

**Model:** `AffiliatePayout`  
**What rows mean:** Every payout made to an affiliate — amount, method, status (pending/paid), paidAt timestamp. The admin affiliate page has a payout creation modal (`PayoutsHistory.tsx`) but it renders a form for CREATING a new payout, not viewing historical payouts.  
**Audience:** Merchant  
**Why no UI today:** `PayoutsHistory.tsx` is a misleadingly named component — it's actually a payout creation form. The API `GET /stores/:storeId/affiliates/:id/payouts` exists but is never read back in the UI.  
**Where UI should live:** Admin `/stores/[id]/affiliates` — the per-affiliate payout modal or detail view should have a "Payout history" section listing past rows (date, amount, method, status).  
**Effort:** S (~30 min — API endpoint exists, just need read-back component)  
**Priority:** P1 — merchants have paid affiliates but can't see the payment history without DB access. Accounting gap.

---

### GAP-7 — `AffiliateEvent` — No viewer ❌

**Model:** `AffiliateEvent`  
**What rows mean:** Immutable audit trail for every affiliate lifecycle event (approve, reject, suspend, commission_recorded, payout_initiated, payout_completed). These are compliance records — if an affiliate disputes their status change, this is the source of truth.  
**Audience:** Merchant  
**Why no UI today:** The model was added as an append-only audit log. The API `GET /stores/:storeId/affiliates/:id/events` exists but is never called from admin.  
**Where UI should live:** Admin `/stores/[id]/affiliates` — per-affiliate detail view should have a "History" timeline showing AffiliateEvent rows (event type, from/to status, triggered by, timestamp).  
**Effort:** S (~30 min — API endpoint exists)  
**Priority:** P1 — dispute resolution requires DB access today.

---

### GAP-8 — `ReorderRule` — Config view missing (suggestions shown, rules not) ❌

**Model:** `ReorderRule`  
**What rows mean:** Per-product/variant rules that define when to reorder (minQty, reorderQty, leadTimeDays, preferredSupplierId). The admin `/stock/reorder` page shows `ReorderSuggestion` rows (AI-generated suggestions) but there is **no UI to view or manage the ReorderRule rows** themselves — merchants can't see what rules are configured or set them up manually.  
**Audience:** Merchant  
**Why no UI today:** The suggestions UI was built; the configuration UI for the underlying rules was not. The reorder rules are referenced in analytics (`LowStockAlertsCard` shows a badge if a rule exists) but there is no CRUD surface.  
**Where UI should live:** Admin `/stores/[id]/stock/reorder` — add a "Rules" tab alongside the "Suggestions" tab, listing all ReorderRule rows with edit/delete. Or embed it on the individual product inventory page.  
**Effort:** M (~2 hrs — needs list + create/edit form)  
**Priority:** P1 — merchants can't configure the rule parameters that feed the AI reorder suggestions. The feature is half-built operationally.

---

## Gaps — P2 (Convenience / Completeness)

---

### GAP-9 — `PushSubscription` — No viewer for merchant ❌

**Model:** `PushSubscription`  
**What rows mean:** Web Push (VAPID) subscriptions from storefront customers. Each row is one browser/device that opted in to push notifications from a store. Merchants can trigger broadcast pushes from the notifications page but cannot see how many active subscribers they have.  
**Audience:** Merchant  
**Why no UI today:** The subscriptions are infrastructure for push delivery. The admin notifications page configures channels and shows notification logs but has no subscriber count or list.  
**Where UI should live:** Admin `/stores/[id]/notifications` — add a "Push Subscribers" stats card showing total active VAPID subscriptions for this store (count only, not raw endpoints for privacy).  
**Effort:** S (~30 min — read endpoint needed, simple count card)  
**Priority:** P2 — nice to have for merchants to gauge push audience size before running a campaign.

---

### GAP-10 — `SystemSetting` — No admin UI at all ❌

**Model:** `SystemSetting`  
**What rows mean:** Platform-level key/value configuration rows (category, isPublic flag). The model exists in the schema and is part of the Store relations but grep across both `apps/admin` and `apps/api/src/routes/` finds ZERO callers. The table appears to be dead data.  
**Audience:** Super-admin  
**Why no UI today:** Model may have been scaffolded for future platform settings (global feature flags, billing config, etc.) but was never wired up.  
**Where UI should live:** Admin `/users` area or a new `/platform-settings` route, visible only to `super_admin`. If the table is truly unused, the alternative is to delete it (no data risk — orphaned model).  
**Effort:** S if just a read/edit KV editor; or just delete the model (5 min + migration)  
**Priority:** P2 — no callers means no business impact today, but it's dead schema debt. Either build the UI or delete the model.

---

### GAP-11 — `FrequentlyBoughtTogether` — No admin viewer ❌

**Model:** `FrequentlyBoughtTogether`  
**What rows mean:** Co-occurrence pairs computed from historical order data — products that are frequently bought together. Drives the "Customers also bought" storefront block. Merchants can't see which pairs were computed or how frequently they co-occur, making it impossible to validate the algorithm's output.  
**Audience:** Merchant  
**Why no UI today:** Pure read surface never prioritized. The data is consumed by the storefront recommendation service.  
**Where UI should live:** Admin `/stores/[id]/products/[id]/recommendations` — add a read-only "Frequently Bought Together" section below the manual cross-sell/upsell pickers, showing the top computed pairs with co-occurrence count and lastCalculatedAt.  
**Effort:** S (~30 min — read-only, API query needed)  
**Priority:** P2 — nice-to-have transparency for merchants who want to understand what the storefront recommends.

---

## Close-out Plan (cheapest-most-valuable first)

| #   | Gap                                        | Effort | Priority | Action                                                              |
| --- | ------------------------------------------ | ------ | -------- | ------------------------------------------------------------------- |
| 1   | GAP-3 LoyaltyTransaction admin view        | S      | P1       | Wire existing API endpoint into MembersTable expand/slide-over      |
| 2   | GAP-6 AffiliatePayout history list         | S      | P1       | Add read-back list to existing payout modal or per-affiliate detail |
| 3   | GAP-7 AffiliateEvent timeline              | S      | P1       | Wire existing API endpoint into per-affiliate detail view           |
| 4   | GAP-4 CustomerAddress in admin             | S      | P1       | Add "Saved Addresses" section to customer detail page               |
| 5   | GAP-9 PushSubscription count card          | S      | P2       | Add subscriber count stat to `/notifications` page                  |
| 6   | GAP-10 SystemSetting                       | S      | P2       | Audit if table is used anywhere; if not, delete it + migration      |
| 7   | GAP-11 FrequentlyBoughtTogether viewer     | S      | P2       | Add read-only section on product recommendations page               |
| 8   | GAP-1 ProductFaq admin editor              | M      | P0       | Add FAQ section to product edit page (uses existing API routes)     |
| 9   | GAP-2 AiUsage viewer                       | M      | P0       | Add usage tab/stats to `/ai-tools` page                             |
| 10  | GAP-5 AffiliateReferral per-affiliate list | M      | P1       | Build referral list component + wire existing API endpoint          |
| 11  | GAP-8 ReorderRule config UI                | M      | P1       | Add "Rules" tab to `/stock/reorder` with CRUD form                  |

**Batch 1 (1 sprint, ~3 hrs):** Items 1–7 above — all S-effort, wire existing API endpoints with minimal UI.  
**Batch 2 (1 sprint, ~6 hrs):** Items 8–11 — M-effort, need new form components.
