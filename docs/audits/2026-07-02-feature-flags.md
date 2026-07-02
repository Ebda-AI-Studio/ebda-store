# Feature-Flag 4-Layer Enforcement Audit — 2026-07-02

**Scope:** Billing-leak detection across `packages/shared/src/plan-baselines.ts` (153 lines) +
`features.ts` (506 lines) as the flag catalog, traced through `apps/api/src/routes` (60 files),
`apps/api/src/services`, `apps/api/src/lib/inngest/functions`, `apps/admin`, `apps/web`.

**Method:** for every `FeatureKey`, grep `requireFeature('<key>')` (route layer) +
`featureService.isFeatureEnabled(..., '<key>')` (service/job/data layer) across the whole API,
then read the actual route/service files for the keys with zero or partial hits. Cross-checked
admin (`useFeatures().isEnabled`) and storefront (`store.enabledFeatures`) for Layer-1/UI parity.

**Reference doctrine:** `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-feature-flag-multi-layer-enforcement.md`
— UI hide alone is a billing leak; every paid `PLAN_BASELINE` key needs UI + route + async-job +
service/DB-write gates, all with a `super_admin` bypass.

The gate primitive is `apps/api/src/middleware/feature-gate.ts` `requireFeature(key)` — fail-closed
403 `FEATURE_DISABLED`, with a `super_admin` bypass (`feature-gate.ts:25-27`). This part is sound;
the problem in every finding below is **call sites that never invoke it**, not the primitive itself.

---

## Findings

### F1 — CRITICAL — CONFIRMED — Admin push broadcast has zero feature gate (any tier can blast real push notifications)

**File:** `apps/api/src/routes/onesignal.routes.ts:155-198` (`POST /stores/:storeId/push/broadcast`),
backed by `apps/api/src/services/onesignal.service.ts` (`OneSignalService.broadcastToStore` — grep
for `isFeatureEnabled`/`featureService` in this file returns nothing).

`push_notifications` is a Professional-tier addition (`plan-baselines.ts:71`, `PROFESSIONAL_ADDITIONS`).
The route's middleware chain is only `authenticate, authorize('store_admin','super_admin'), requireStoreAccess`
(`adminStoreMiddleware`, line 144-148) — no `requireFeature('push_notifications')`. Compare to the
sibling _customer_ subscribe route `POST /:storeId/push/subscribe` (`notification.routes.ts:380-382`)
which correctly has `requireFeature('push_notifications')`.

The transactional dispatcher (`notification-dispatcher.service.ts:187-189`) does check the flag
before sending order-event pushes — so _that_ path is fine. The admin marketing-blast path is a
completely separate function (`OneSignalService.broadcastToStore`) with its own zero-gate route.

**Layer status:** UI ✗ partial (admin hides `BroadcastComposerCard` when `!pushEnabled`,
`apps/admin/src/app/stores/[id]/notifications/page.tsx:285`) · Route ✗ · Service ✗ · Async job N/A (synchronous send).

**Billing-leak scenario:** a Starter-tier merchant (no `push_notifications` in baseline, no override)
opens devtools or scripts a request to `POST /stores/<their-storeId>/push/broadcast` with a real
title/body payload. `authorize` + `requireStoreAccess` pass (they own the store). The route calls
`OneSignalService.broadcastToStore` directly — a real push notification is sent to every customer
who ever subscribed on that storefront, with zero regard for plan. This is the most severe class:
actual customer-facing send capability, not just config, delivered for a paid feature the merchant
never bought.

**Fix:** add `requireFeature('push_notifications')` to `adminStoreMiddleware` in `onesignal.routes.ts`
(both the broadcast POST and the broadcasts-list GET at line 206 for consistency), matching the
existing pattern on the subscribe route.

---

### F2 — HIGH — CONFIRMED — Kuwait invoice generation (accounting.invoicing, Professional addon) has zero gate anywhere

**Files:**

- `apps/api/src/routes/order.routes.ts:529-547` (`GET /stores/:storeId/orders/:orderId/invoice`, admin)
- `apps/api/src/routes/order.routes.ts:554-590` (`POST /:orderId/invoice/email`)
- `apps/api/src/routes/public.routes.ts:782-810` (`GET /orders/:id/invoice`, customer-facing)
- `apps/api/src/services/invoice.service.ts` — zero matches for `isFeatureEnabled`/`featureService`
- `apps/admin/src/app/stores/[id]/orders/[orderId]/invoice/page.tsx` and the order-detail page —
  zero matches for `isEnabled`/`useFeatures` around invoice actions.

`accounting.invoicing` is described in `features.ts:425-435` as "Kuwait-compliant invoice generation
with tax line, bilingual layout, and PDF export" and is a `PROFESSIONAL_ADDITIONS` addon
(`plan-baselines.ts:67`) — i.e. Starter and Free should NOT have it. `grep -rn "'accounting.invoicing'"`
across the entire API returns **zero** hits in any `requireFeature`/`isFeatureEnabled` call.

**Layer status:** UI ✗ (admin doesn't hide the invoice button/page) · Route ✗ · Service ✗ · Data N/A.
This is not "UI-only enforcement" — it's **zero-layer enforcement**. Every store on every plan,
including `free`, gets full bilingual tax-invoice generation + email delivery today.

**Billing-leak scenario:** a Free-tier (lapsed-payment grace state) or Starter merchant hits
`GET /stores/:storeId/orders/:orderId/invoice?locale=ar` directly (or clicks the button, since the
admin UI never hid it) and gets the exact deliverable that `accounting.invoicing` is sold as.

**Fix:** add `requireFeature('accounting.invoicing')` to both order.routes.ts endpoints; decide
whether the _customer-facing_ `public.routes.ts:782` route should show a simpler unbranded receipt
instead when the flag is off (rather than 403 a paying customer) — that's a product decision, but
today there is no decision point at all, it's just always-on.

---

### F3 — HIGH — CONFIRMED — `staff_accounts` is a fully dead flag: declared, visible, implemented, never enforced, and excluded from every plan baseline

**Files:** `packages/shared/src/features.ts:268-276` (registry entry, NOT `hidden: true` despite the
line-88 comment listing it among features that should be hidden "until the backing code lands"),
`packages/shared/src/plan-baselines.ts` (grep confirms `staff_accounts` appears in **no** plan array —
not `free`, `starter`, `professional`, or `enterprise`), `apps/api/src/routes/staff.routes.ts` (fully
implemented CRUD: list/invite/update-role/delete — `authenticate, authorize('store_admin','super_admin'),
requireStoreAccess` only, zero `requireFeature` calls), `apps/admin/src/app/stores/[id]/staff/page.tsx`
(zero `isEnabled`/`useFeatures` references).

`isFeatureEnabled(storeId, 'staff_accounts')` resolves to `false` for every store (no baseline
includes it, so only a manual `StoreFeature` override could ever turn it on) — **but nothing ever
calls that check**, so the resolved value is irrelevant. The feature is unconditionally available on
every plan today, contradicting its own registry classification (`tier: 'core'`, visible in the
admin Features toggle list) and the code comment that says it should be `hidden`.

**Layer status:** UI ✗ · Route ✗ · Service ✗ · Data N/A. Zero of four.

**Billing-leak scenario:** if staff/team-seat limits are ever part of a sales pitch tied to plan tier
(a reasonable SaaS pattern), every merchant on every plan can already add unlimited staff accounts
today with no code change required on their end.

**Fix:** either (a) decide staff accounts should be a `core` feature on every plan and formally add
it to `STARTER_CORE` in `plan-baselines.ts` so the declared state matches reality, or (b) if it's
meant to be tier-gated, add `requireFeature('staff_accounts')` to `staff.routes.ts` and gate the
admin nav entry. Currently the registry, the baseline, and the enforcement all disagree with each
other — pick one truth and make the other two match it.

---

### F4 — HIGH — CONFIRMED — Public affiliate signup accepts applications on stores that never bought `affiliate` (Enterprise-only)

**Files:** `apps/api/src/routes/affiliate.routes.ts:444-455` (`POST /public/:storeId/affiliates/apply`
— no middleware at all, fully public), `apps/api/src/services/affiliate.service.ts:95-105`
(`getConfig`) + `:155-170` (`apply`).

All ADMIN affiliate routes correctly bundle `requireFeature('affiliate')` into `adminMiddleware`
(`affiliate.routes.ts:68-73`) — that part is well done. But the public apply endpoint calls
`affiliateService.apply(storeId, data)` directly, which only checks `config.publicSignupEnabled`
(`affiliate.service.ts:159`) — and `getConfig` **defaults** `publicSignupEnabled: true` when no
`AffiliateConfig` row exists yet (`CONFIG_DEFAULTS`, line 18-24). Since `affiliate` is Enterprise-only
(`ENTERPRISE_ADDITIONS`, `plan-baselines.ts:86`) and a Starter/Professional store has never touched
the affiliate admin page, it has no config row — so the default (`true`) applies, and the public
apply route accepts the submission with **zero** `isFeatureEnabled(storeId, 'affiliate')` check
anywhere in the call chain.

**Layer status:** UI ✓ (storefront `apps/web/src/app/affiliate/page.tsx:81` checks
`isEnabled('affiliate')` and hides the page) · Route ✗ (public, unauthenticated, unfeatured) ·
Service ✗ (`apply()` never checks the plan feature, only the sub-config) · Data ✗ (creates a real
`Affiliate` row).

**Billing-leak/spam scenario:** a Professional-tier store's storefront hides the `/affiliate` page
in the nav, but a scripted `POST` to `/public/<storeId>/affiliates/apply` with a name/email still
returns `201` and writes an `Affiliate` row with `status: 'pending'` (since `autoApprove` also
defaults false). The merchant can't see or approve it today (admin routes are correctly gated) — but
the moment that store is ever upgraded to Enterprise or gets a `StoreFeature` override, every
accumulated pending row instantly becomes live/manageable, and in the meantime it's an unauthenticated
public write surface on every non-Enterprise store with no rate limiting tied to the feature state.

**Fix:** add `requireFeature('affiliate')` ahead of the apply/track public routes, or have
`affiliateService.apply()` check `featureService.isFeatureEnabled(storeId, 'affiliate')` first (mirrors
the pattern already used correctly in `loyalty.service.ts`, see the Positive Pattern note below).

---

### F5 — MEDIUM — CONFIRMED — SMS/Push channel config + test-connection routes ungated (config leak, not send leak)

**File:** `apps/api/src/routes/notification.routes.ts:81-207` — the generic
`GET/PUT/DELETE /:storeId/notifications/configs/:channel` and `POST /:storeId/notifications/test/:channel`
routes accept any `channel` param (`sms`, `push`, `whatsapp`) with only `adminMiddleware`
(`authenticate, authorize, requireStoreAccess`, line 75) — no per-channel `requireFeature`.

`sms` is Enterprise-only, `push_notifications` is Professional+ (`plan-baselines.ts`). The actual
transactional _send_ is correctly gated in `notification-dispatcher.service.ts:187-189`
(`featureService.isFeatureEnabled(storeId,'sms'|'push_notifications')`), and the admin UI hides the
`SmsChannelCard`/`PushChannelCard` (`apps/admin/.../notifications/page.tsx:265,277`) — so this is not
a "send for free" leak. But a Starter-tier merchant can still `PUT` real Unifonic `appSid`/`senderId`
credentials via direct API call and `POST /test/sms`, which round-trips a live call to Unifonic's
`Account/info` endpoint (`sms.service.ts:verifyCredentials`) — i.e. they can configure and validate a
paid channel's third-party credentials before ever paying for it, and the encrypted credentials sit
in `NotificationConfig` ready to activate the instant the flag flips.

**Layer status:** UI ✓ · Route ✗ · Service ✓ (send-time only) · Data ✗ (write persists regardless).

**Fix:** add a lightweight `requireFeature` dispatch keyed off `req.params.channel` (map
`sms→'sms'`, `push→'push_notifications'`) to the four generic routes, matching the affiliate
`adminMiddleware` array pattern.

---

### F6 — MEDIUM — CONFIRMED — Floating widget write route ungated (config-ahead-of-payment, same shape as F5)

**File:** `apps/api/src/routes/store.routes.ts:907-931` (`PUT /:id/floating-widget`).

`floating_widget` is Enterprise-only (`ENTERPRISE_ADDITIONS`). The route only has
`authenticate, requireMfaEnrolled, authorize('store_admin','super_admin'), requireStoreAccess` — no
`requireFeature('floating_widget')`.

**Layer status:** UI ✓ (`apps/admin/src/app/stores/[id]/floating-widget/page.tsx:90-112` correctly
uses `useFeatures().isEnabled('floating_widget')` and blocks the form with a "Feature not enabled"
message) · Route ✗ · Service ✗ (`StoreService.updateFloatingWidget` has no flag check) · Storefront-read ✓
(`apps/web/src/components/ShopChrome.tsx:469` — `store.enabledFeatures?.includes('floating_widget')`
correctly gates rendering).

**Billing-leak scenario:** contained on the customer-facing side (storefront won't render it), but a
non-Enterprise merchant can call the write route directly and persist a fully-configured widget to
`Store.settings.floatingWidget`. The moment the plan is upgraded or a super-admin flips a
`StoreFeature` override for any reason, the pre-built widget goes live immediately with no further
merchant action — the paid setup work was done for free while gated off. This is the textbook
"UI hides it, API doesn't" pattern the standing rule warns about, just with the actual display
output correctly gated as a mitigating factor.

**Fix:** add `requireFeature('floating_widget')` to the PUT route for defense-in-depth /
consistency with every other theme-adjacent gated route (e.g. `marketing_pixels` at
`store.routes.ts:998`).

---

### F7 — MEDIUM — CONFIRMED — Profit-anomaly read/acknowledge routes ungated; write-gate (Inngest) and read-gate (route) disagree

**File:** `apps/api/src/routes/smart-layer.routes.ts:235-300` (`GET /:storeId/finance/anomalies`,
`POST /:storeId/finance/anomalies/:id/acknowledge`) vs. `apps/api/src/lib/inngest/functions/accounting-profit-anomaly.ts:45-51`
(the daily sweep correctly does `featureService.isFeatureEnabled(store.id, 'accounting.profit_anomaly')`
before writing new `ProfitAnomaly` rows).

`accounting.profit_anomaly` is Enterprise-only (`ENTERPRISE_ADDITIONS`). The list/acknowledge routes
only chain `authenticate, requireMfaEnrolled, authorize('store_admin','super_admin'), requireStoreAccess`
— no `requireFeature`.

**Layer status:** Async job ✓ (write-time gate present and correct) · Route ✗ (read-time gate absent) ·
UI unknown/unverified this pass · Data — historical rows persist regardless of current flag state.

**Billing-leak scenario:** an Enterprise store that downgrades to Professional (feature flips off,
override not required per the "plan changes don't touch StoreFeature rows" doc in
`plan-baselines.ts:9-12`) retains full, unrestricted read + acknowledge access to every
previously-generated profit-anomaly record forever — the write path stopped, but the read path was
never gated in the first place, so downgrade has zero effect on data access. This is a genuine
enforcement inconsistency between two layers of the _same_ feature, not just a missing layer.

**Fix:** add `requireFeature('accounting.profit_anomaly')` to both routes in `smart-layer.routes.ts`.

---

## Positive pattern found (for contrast — NOT a finding)

`apps/api/src/services/loyalty.service.ts` is a good reference implementation: nearly every method
(`getCustomerPoints`, `initializeCustomerPoints`, and 6+ others) independently re-checks
`featureService.isFeatureEnabled(storeId, 'loyalty')` at the **service layer**, even though the public
`/join`, `/my-points`, `/my-transactions` routes (`routes/loyalty.routes.ts:309-398`) have no
route-level `requireFeature`. Because the service throws `AppError(400, 'LOYALTY_DISABLED', ...)`
when the flag is off, the missing route-level gate is redundant rather than a leak — this is what
defense-in-depth is supposed to look like, and F1/F2/F3/F4/F6/F7 should be brought up to this
standard rather than just patched at one layer.

`inventory.backorder` (product.routes.ts, backorders.routes.ts, cart.service.ts ×3, order.service.ts)
and `payment_abandonment` are similarly well-covered across route + service + async-job layers per
the 2026-05-28 PR #33 hardening referenced in project memory — spot-checked this pass, still intact.

## Not a leak — correctly platform-level / not plan-gated

`reorder-suggestions` and `deadstock-flags` (also in `smart-layer.routes.ts`) are **not** `FeatureKey`
values at all (confirmed via grep of `features.ts`/`plan-baselines.ts`) — they're core capabilities
for every plan by design, so the absence of `requireFeature` there is correct, not a gap.

---

## Severity table

| #   | Finding                                                                     | Severity     | Status    | File:line                                                                                 |
| --- | --------------------------------------------------------------------------- | ------------ | --------- | ----------------------------------------------------------------------------------------- |
| F1  | Admin push broadcast — zero gate, real sends                                | **Critical** | Confirmed | `apps/api/src/routes/onesignal.routes.ts:155-198`                                         |
| F2  | Invoice generation (accounting.invoicing) — zero gate anywhere              | **High**     | Confirmed | `apps/api/src/routes/order.routes.ts:529-590`, `public.routes.ts:782`                     |
| F3  | `staff_accounts` — dead flag, 0/4 layers, excluded from every plan baseline | **High**     | Confirmed | `packages/shared/src/features.ts:268`, `apps/api/src/routes/staff.routes.ts`              |
| F4  | Public affiliate apply — no gate, defaults open                             | **High**     | Confirmed | `apps/api/src/routes/affiliate.routes.ts:444-455`, `services/affiliate.service.ts:95-170` |
| F5  | SMS/Push config + test-connection routes ungated                            | **Medium**   | Confirmed | `apps/api/src/routes/notification.routes.ts:81-207`                                       |
| F6  | Floating widget write route ungated                                         | **Medium**   | Confirmed | `apps/api/src/routes/store.routes.ts:907-931`                                             |
| F7  | Profit-anomaly read/acknowledge routes ungated vs. gated write              | **Medium**   | Confirmed | `apps/api/src/routes/smart-layer.routes.ts:235-300`                                       |

All seven findings are **Confirmed** (read the actual route/service code and traced the full call
chain) rather than Plausible — no finding in this report rests on inference alone.
