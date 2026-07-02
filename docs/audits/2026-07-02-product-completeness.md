# Product Completeness Audit — Force AI Store (FWB)

**Date:** 2026-07-02
**Auditor:** Claude Code (automated, read-only). HEAD `2332c4d5`.
**Lens:** Product completeness — feature-flag enforcement, admin↔API endpoint wiring, "every data needs a UI" coverage, redundancy/consolidation, docs parity, i18n/RTL.
**Baselines re-verified:** `docs/audits/2026-05-28-ui-coverage-audit.md`, `docs/audits/2026-06-01-admin-settings-redundancy-audit.md`.

---

## Coverage note (methodology honesty)

This run dispatched six parallel sub-audits. Three completed and are fully incorporated below: **admin↔API endpoint wiring** (also re-verified the full GAP-1..11 UI-coverage baseline), **admin redundancy/consolidation**, and **docs parity**. Two lenses — **feature-flag 4-layer enforcement** and **i18n/RTL parity** — did not return before consolidation was called; they are marked `NOT-COMPLETED-THIS-RUN` in the table and should be re-run. The UI-coverage lens is effectively covered because the endpoint audit re-verified every one of the eleven 2026-05-28 gaps against current code.

---

## Executive summary

The June consolidation work largely landed: **most 2026-06-01 redundancy items and several 2026-05-28 UI gaps are now FIXED** (announcement/hero/nav/footer split-brains collapsed to a single Page-Builder owner; ProductFaq, AiUsage-merchant, LoyaltyTransaction, AffiliateEvent viewers all shipped). The remaining product-completeness debt clusters in three places:

1. **A dead Page-Builder product-hydration call (404)** — real merchants hit it.
2. **Affiliate referral/payout itemized viewers + ReorderRule config + CustomerAddress admin view** — still open from 2026-05-28, plus a **misleading affiliate nav link** that points at the wrong page.
3. **Docs drift on WhatsApp plan-gating** — three business/sales docs still describe WhatsApp as an "always add-on, not baseline-included," contradicting the code's default-open model since PR #94 (2026-06-09). This is proposal-facing and the highest business-risk item.
4. **A new operational UI gap: `WebhookEvent`** (payment webhook inbox) has no admin viewer or read route, yet the documented P0 stuck-webhook runbook depends on manual replay from it.

---

## Findings

### F1 — Page Builder product-name hydration hits a nonexistent route (404)

- **Severity:** Critical · **Verdict:** CONFIRMED · **NEW**
- **Where (admin call):** `apps/admin/src/app/stores/[id]/page-builder/page.tsx:4221` — `GET /api/v1/admin/stores/${storeId}/products?ids=...&limit=50`
- **Where (real route):** `apps/api/src/routes/product.routes.ts:168` — `GET /stores/:storeId/products?ids=...` (mounted at `/stores/:storeId/products`, no `/admin` segment). The `/admin/products` route at `apps/api/src/routes/admin.routes.ts:823` takes `storeId` as a query param, has no `ids` filter, and is `super_admin`-only.
- **Gap:** When a merchant opens Page Builder and selects products by ID that aren't already cached, the batched name-hydration fetch 404s silently — the picker shows raw IDs / a stuck loading state instead of product names.
- **Fix:** Point the call at `GET /stores/${storeId}/products?ids=...` (drop `/admin`). One-line URL fix.

### F2 — Affiliate "Referrals & Payouts" link points at the wrong page; itemized viewers still missing

- **Severity:** High · **Verdict:** CONFIRMED · **STILL-OPEN (2026-05-28 GAP-5/GAP-6)** + NEW mislabel
- **Where (mislabel):** `apps/admin/src/app/stores/[id]/affiliates/[affiliateId]/audit-trail/page.tsx:229` — link labeled "Referrals & Payouts →" routes to `/affiliates/:id/events` (the lifecycle audit log), not to any referral or payout list.
- **Where (orphaned routes):** `apps/api/src/routes/affiliate.routes.ts:362-364` (`GET /:storeId/affiliates/:id/referrals`) and `:384-386` (`GET .../payouts`) exist but are never called from any admin component. `PayoutsHistory.tsx` is a payout-_creation_ form with zero read calls (`apps/admin/src/app/stores/[id]/affiliates/_components/PayoutsHistory.tsx`).
- **Gap:** Affiliates ask "which orders counted toward my commission?" and "show my payment history" — merchants can only answer via DB access. The Events timeline surfaces `referral.clicked/converted` + `payout.*` as log lines (partial mitigation) but not itemized commission/order-ref/method/amount data.
- **Fix:** Build referral + payout list components (or tabs on the affiliate detail view) wired to the two existing endpoints; relabel/redirect the audit-trail link accordingly.

### F3 — WhatsApp plan-gating: three business/sales docs contradict code (default-open since PR #94)

- **Severity:** Critical (business/proposal risk) · **Verdict:** CONFIRMED · **NEW (regression vs code)**
- **Where (docs):** `docs/business/04-pricing-tiers.md:135-141` ("whatsapp is a separate add-on at any plan tier ... not baseline-included in any plan; it always requires a per-store activation step"); `docs/business/02-feature-catalog.md:490-492` (§11); `docs/business/05-pitch-deck-outline.md:192` (Slide 10).
- **Where (code = truth):** `packages/shared/src/plan-baselines.ts:53` — `'whatsapp'` in `STARTER_CORE` ("available to ALL stores by default"), also in free baseline (line ~111). `docs/business/plan-feature-matrix.md:62` already documents the corrected default-open behavior.
- **Gap:** Ahmad uses `04-pricing-tiers.md` to write client proposals. He could quote/charge an add-on fee for admin-panel access that is already default-enabled, or mis-scope a contract. Nuance the docs conflate: the _feature flag_ is default-on, but a functioning WABA connection is still a real paid setup — none of the three docs draw that distinction.
- **Fix:** Rewrite all three to match `plan-feature-matrix.md:62` in one pass — admin access is baseline/default-open; the WABA connection + Force AI WhatsApp Business Platform account is the paid line item.

### F4 — `WebhookEvent` payment inbox has no admin UI or read route

- **Severity:** High · **Verdict:** CONFIRMED · **NEW**
- **Where:** `packages/database/prisma/schema.prisma` — `model WebhookEvent`. No GET/POST route referencing `webhook_events`/`WebhookEvent` anywhere in `apps/api/src/routes/*.routes.ts`; zero references in `apps/admin/src`.
- **Gap:** Project CLAUDE.md documents a `STUCK_WEBHOOK_MINUTES` sweep firing a P0 alert expecting "manual replay from the durable row." Responding to that P0 today requires production DB access (Prisma Studio / SQL) — explicitly a named anti-pattern under the "Every data needs a UI" rule.
- **Fix:** Minimal super-admin viewer listing stuck/failed rows + a "replay" button invoking the existing `PaymentService.handleWebhook` path.

### F5 — `ReorderRule` config UI still missing (suggestions shown, rules not)

- **Severity:** High · **Verdict:** CONFIRMED · **STILL-OPEN (2026-05-28 GAP-8)**
- **Where:** No `ReorderRule` route exists in `apps/api/src/routes/*.ts`. `apps/admin/src/app/stores/[id]/stock/reorder/page.tsx` only calls `/stock/reorder-suggestions` (`smart-layer.routes.ts`).
- **Gap:** Merchants can view AI reorder _suggestions_ but cannot view or configure the underlying `ReorderRule` rows (minQty/reorderQty/leadTimeDays/preferredSupplierId) that feed them. Feature is half-built operationally.
- **Fix:** Add a "Rules" tab with CRUD (needs both a new API route and UI).

### F6 — `CustomerAddress` not visible in admin; only reachable via wa-bridge internal auth

- **Severity:** High · **Verdict:** CONFIRMED · **STILL-OPEN (2026-05-28 GAP-4), harder than noted**
- **Where:** Customer detail page `apps/admin/src/app/stores/[id]/customers/[customerKey]/page.tsx` only calls `/stores/:storeId/customers/:key`. The only API touching `CustomerAddress` is `GET/POST /customer-addresses` at `apps/api/src/routes/wa-bridge.routes.ts:1137/1156`, gated by `waBridgeAuth` (internal WhatsApp-bridge secret) — not reachable via the admin JWT session.
- **Gap:** Merchants handling WhatsApp orders can't see which delivery addresses the bot captured. Fixing this needs a NEW admin-authed endpoint, not just UI wire-up.
- **Fix:** Add an admin-authed `GET /stores/:storeId/customers/:key/addresses` + "Saved Addresses" section on the customer detail page.

### F7 — `plan-feature-matrix.md` missing the `payment_abandonment` feature row

- **Severity:** High · **Verdict:** CONFIRMED · **NEW**
- **Where:** `packages/shared/src/plan-baselines.ts:89-90` adds `'payment_abandonment'` to `ENTERPRISE_ADDITIONS` (2026-06-22); `packages/shared/src/features.ts:41-44,478-491` fully defines it (Enterprise, addon, marketing). `docs/business/plan-feature-matrix.md` (Last synced 2026-06-19) has no row for it in the 29-row table (lines 25-57) or the "not plan-gated" section.
- **Gap:** A real Enterprise-tier FeatureKey with zero documentation trace — exactly what the doc-parity rule exists to catch. `ROADMAP.md` also omits it from Shipped (Finding F12).
- **Fix:** Add the Enterprise-only row; bump "Last synced" date.

### F8 — `DEPLOYMENT.md` architecture omits the live Cloudflare Workers dual-deploy path

- **Severity:** Medium · **Verdict:** CONFIRMED · **NEW**
- **Where:** `DEPLOYMENT.md:21-55` (architecture ASCII) shows only Vercel → Railway → Neon/R2/Inngest. Zero "Cloudflare Workers" hits outside the R2 section, despite CLAUDE.md documenting admin/web/orders all auto-deploying to CF Workers (`admin.force-ai.co`, `orders.force-ai.co`, `store.force-ai.co` + per-merchant Custom Hostnames) via `.github/workflows/cf-deploy.yml`, with wadyaljuz.com already live on Cloudflare.
- **Gap:** The doc an incident responder reads for prod topology is missing an entire production serving path.
- **Fix:** Add the CF Workers dual-deploy topology to the diagram.

### F9 — `DEPLOYMENT.md` "Vercel Hobby" claims predate the confirmed Pro-plan correction

- **Severity:** Medium · **Verdict:** PLAUSIBLE · **NEW**
- **Where:** `DEPLOYMENT.md:25`, `:323`, `:480` all assert Hobby tier; `:293-297` bases staging posture on "Vercel Hobby ... zero cost." User memory records a 2026-06-13 correction to paid Pro.
- **Gap:** Staging-posture rationale may no longer hold under Pro. Cannot re-verify billing from inside the repo (hence PLAUSIBLE).
- **Fix:** Verify current Vercel tier; correct the three spots + the staging rationale.

### F10 — SEO page loads 6 dead social state vars (R1 tail)

- **Severity:** Low · **Verdict:** CONFIRMED · **STILL-OPEN (2026-06-01 R1 tail)**
- **Where:** `apps/admin/src/app/stores/[id]/seo/page.tsx:19-32,245-254` fetch/store `instagram/facebook/tiktok/youtube/linkedin/twitter` into `socialLinks` state but only render `wikidata`/`wikipedia` inputs; only those two are submitted (line ~401). Dead fetch/state, no data-loss risk (social links owned by Branding→Social).
- **Fix:** Remove the 6 unused fields from state/fetch.

### F11 — `/categories` and `/staff` missing from Settings hub `urlPrefixes`

- **Severity:** Low · **Verdict:** CONFIRMED · **NEW**
- **Where:** `apps/admin/src/components/admin-layout/hubs.ts:190-208` — Settings hub `urlPrefixes` omits `/categories` and `/staff`, though `settings/page.tsx` links to both (categories card line ~294, staff card line ~458).
- **Gap:** Sidebar Settings hub won't highlight active state on those pages. UX consistency, not an orphan (still reachable via card).
- **Fix:** Add `/categories` and `/staff` to the `urlPrefixes` array (2-line change).

### F12 — `ROADMAP.md` internal contradictions + missing payment-abandonment

- **Severity:** Medium · **Verdict:** CONFIRMED · **NEW**
- **Where:** `ROADMAP.md:89` marks the WhatsApp DM bot + Meta catalog provisioning as `[x]` Shipped, while `:135` lists "WBS bot go-live" as `[ ]` Next (blocked on Meta BM access) — same capability marked both shipped and not-live with no built-vs-activated distinction. `payment_abandonment` (shipped 2026-06-22) absent from both Shipped and Next (only pre-existing cart-abandonment lines 23/93 mention "abandon").
- **Fix:** Add the payment-abandonment feature to Shipped; footnote the bot's code-complete-vs-activated status.

### F13 — Settings landing is a flat 13-card grid; `/bulk` reachable only from Products toolbar

- **Severity:** Low · **Verdict:** CONFIRMED · **STILL-OPEN (2026-06-01 P3-D / P4-B)**
- **Where:** `apps/admin/src/app/stores/[id]/settings/page.tsx` (13 cards, no sub-grouping); `/bulk` entry only at `apps/admin/src/app/stores/[id]/products/_components/ProductsToolbar.tsx:24`.
- **Fix:** Sub-tab grouping on Settings when card count grows; add a `/bulk` dashboard quick-action or Catalog tab.

### F14 — Logo/favicon/icons scattered across 3 surfaces (R9); PWA description/icon prefill one-directional (R8)

- **Severity:** Low · **Verdict:** CONFIRMED · **STILL-OPEN (2026-06-01 R9/R8)**
- **Where:** `logo`/`logoAr`/`favicon` in `branding/_components/BrandingIdentityTab.tsx` + `LogoUploader.tsx`; `footerLogo` in `ThemeTab.tsx`; PWA icons + description prefill in `pwa/_hooks/usePwaSettings.ts:36-39,84-110` (explicit "populate from store," not auto-synced after later edits).
- **Fix:** Optional "Logo & Icons" grouped section; document the non-sync caveat.

### F15 — Super-admin cross-store AiUsage summary never built (half of GAP-2)

- **Severity:** Low · **Verdict:** CONFIRMED · **STILL-OPEN (2026-05-28 GAP-2 partial)**
- **Where:** Merchant `/ai-usage` page shipped (GAP-2 merchant half FIXED), but no cross-store super-admin usage view exists (no callers outside `stores/[id]/ai-usage`).
- **Fix:** Add a per-store usage table on the super-admin dashboard.

### F16 — `PushSubscription` count (GAP-9) and `FrequentlyBoughtTogether` viewer (GAP-11) still missing

- **Severity:** Low · **Verdict:** CONFIRMED · **STILL-OPEN (2026-05-28 GAP-9/GAP-11)**
- **Where:** No count/list endpoint in `notification.routes.ts` (only `/push/subscribe|unsubscribe`); zero `FrequentlyBoughtTogether` references in `apps/admin/src` or as a standalone route.
- **Fix:** Subscriber-count stat card on `/notifications`; read-only FBT section on product recommendations page.

---

## Confirmed FIXED since prior audits (no action)

| Item                                              | Prior gap             | Evidence                                                                             |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| ProductFaq admin editor                           | 2026-05-28 GAP-1 (P0) | `products/[productId]/edit/_components/ProductFaqSection.tsx` — full CRUD + AI draft |
| AiUsage merchant viewer                           | 2026-05-28 GAP-2 (P0) | `/ai-usage` page (super-admin half still open → F15)                                 |
| LoyaltyTransaction admin view                     | 2026-05-28 GAP-3      | `/loyalty/transactions` page wired to real endpoint                                  |
| AffiliateEvent viewer                             | 2026-05-28 GAP-7      | `/affiliates/[id]/events` page                                                       |
| Announcement bar split-brain                      | 2026-06-01 R6         | `announcement/page.tsx` content-only; Page Builder owns visibility/bg                |
| Hero content split-brain                          | 2026-06-01 R7         | `hero/page.tsx` is a pure redirect to `/page-builder`                                |
| navMenu / footerLinks                             | 2026-06-01 R4/R5      | `navigation/page.tsx` + `pages/page.tsx` now pure redirects                          |
| emailSenderLocalPart                              | 2026-06-01 R11        | single writer (`seo/page.tsx` → `PUT /stores/:id`); domain page read-only            |
| Theme colors                                      | 2026-06-01 R2         | per-token ColorFields; SmartPalette stages + commits on Save; server merge           |
| Reviews/Coupons/Loyalty/Returns orphans           | 2026-06-01            | Sales-hub nav tabs in `hubs.ts`                                                      |
| plan-feature-matrix.md exists                     | 2026-06-01            | generated mirror of plan-baselines.ts (minus F7 row)                                 |
| merchant quickstart discount-dropdown             | 2026-06-01            | `docs/merchant/quickstart.md:57` correct                                             |
| README stack (Next 16 / Gemini / Kuwait gateways) | 2026-06-01            | CURRENT — no Stripe/Anthropic/Next-14 drift                                          |
| 06-faq no-self-serve / no-free-trial              | 2026-06-01            | CURRENT — no "free trial"/"sign up online" language                                  |

---

## Ranked findings table

| #   | Severity | Verdict   | Status                   | Gap                                                          | File:line                                                          |
| --- | -------- | --------- | ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| F1  | Critical | CONFIRMED | NEW                      | Page Builder product hydration → 404 route                   | `apps/admin/src/app/stores/[id]/page-builder/page.tsx:4221`        |
| F3  | Critical | CONFIRMED | NEW                      | 3 docs call WhatsApp "always add-on" vs default-open code    | `docs/business/04-pricing-tiers.md:135-141`                        |
| F2  | High     | CONFIRMED | STILL-OPEN (GAP-5/6)+NEW | Affiliate link mislabel; referral/payout viewers orphaned    | `apps/admin/.../affiliates/[affiliateId]/audit-trail/page.tsx:229` |
| F4  | High     | CONFIRMED | NEW                      | WebhookEvent inbox: no admin UI / read route                 | `packages/database/prisma/schema.prisma` (model WebhookEvent)      |
| F5  | High     | CONFIRMED | STILL-OPEN (GAP-8)       | ReorderRule config UI + route missing                        | `apps/admin/src/app/stores/[id]/stock/reorder/page.tsx`            |
| F6  | High     | CONFIRMED | STILL-OPEN (GAP-4)       | CustomerAddress not admin-reachable (wa-bridge auth only)    | `apps/api/src/routes/wa-bridge.routes.ts:1137`                     |
| F7  | High     | CONFIRMED | NEW                      | plan-feature-matrix missing payment_abandonment              | `packages/shared/src/plan-baselines.ts:89`                         |
| F8  | Medium   | CONFIRMED | NEW                      | DEPLOYMENT.md omits CF Workers dual-deploy                   | `DEPLOYMENT.md:21-55`                                              |
| F9  | Medium   | PLAUSIBLE | NEW                      | DEPLOYMENT.md stale "Vercel Hobby"                           | `DEPLOYMENT.md:25,323,480`                                         |
| F12 | Medium   | CONFIRMED | NEW                      | ROADMAP bot shipped/not-live contradiction + missing feature | `ROADMAP.md:89,135`                                                |
| F10 | Low      | CONFIRMED | STILL-OPEN (R1 tail)     | SEO page 6 dead social state vars                            | `apps/admin/src/app/stores/[id]/seo/page.tsx:245-254`              |
| F11 | Low      | CONFIRMED | NEW                      | /categories + /staff missing from Settings urlPrefixes       | `apps/admin/src/components/admin-layout/hubs.ts:190-208`           |
| F13 | Low      | CONFIRMED | STILL-OPEN (P3-D/P4-B)   | Flat Settings grid; /bulk single entry                       | `apps/admin/src/app/stores/[id]/settings/page.tsx`                 |
| F14 | Low      | CONFIRMED | STILL-OPEN (R9/R8)       | Logo/icons scattered; PWA prefill one-directional            | `apps/admin/.../pwa/_hooks/usePwaSettings.ts:36-110`               |
| F15 | Low      | CONFIRMED | STILL-OPEN (GAP-2)       | Super-admin cross-store AiUsage summary missing              | `apps/admin/src/app/stores/[id]/ai-usage/`                         |
| F16 | Low      | CONFIRMED | STILL-OPEN (GAP-9/11)    | PushSubscription count + FBT viewer missing                  | `apps/api/src/routes/notification.routes.ts`                       |

**Severity counts:** Critical 2 · High 5 · Medium 3 · Low 6 · Total 16.

---

## Not completed this run (re-run recommended)

| Lens                                                                                                                                     | Status                 | Fallback                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feature-flag 4-layer enforcement (UI/API/job/DB per PLAN_BASELINE key)                                                                   | NOT-COMPLETED-THIS-RUN | See `docs/audits/2026-05-28-feature-enforcement-coverage.md` + `2026-05-28-feature-flag-enforcement.md`. Re-dispatch: for each key in `packages/shared/src/plan-baselines.ts`, verify `requireFeature('<key>')` on routes + service `isFeatureEnabled` dual-gate + Inngest handler short-circuit. Historical bug class: `inventory.backorder` UI-gated only. |
| i18n/RTL parity (en.json↔ar.json key parity, `tracking-[` on Arabic, `dir="ltr"` on snap-x carousels, hardcoded English in new surfaces) | NOT-COMPLETED-THIS-RUN | See memory `feedback-fwb-i18n-duplicate-key-block-trap.md`, `feedback-tailwind-tracking-breaks-arabic.md`. Focus new surfaces: product-card CTA/OOS labels, PLP facet filters, AI balancer buttons, payment webhook/abandonment, domain/CF migration UI.                                                                                                     |
