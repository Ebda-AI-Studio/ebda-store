# Super-admin playbook

> Merchants run onboarding, plan changes, suspension appeals and support requests themselves. This playbook describes each merchant path first, then what a super admin does as the override or the decision.

## Roles

- **`super_admin`** — Ahmad and any future Ebda AI Studio staff. Can see and toggle ALL features for any store, change plans, and suspend/reactivate. Sees the "Manage Features" link in the store sidebar.
- **`store_admin`** — Merchant team. Can see + use only the features that resolve to enabled for their store. Does NOT see "Manage Features" (the per-feature override screen). A merchant DOES change their own plan: Billing page (`POST /stores/:storeId/billing/checkout`, `PUT .../billing/trial-plan` while trialing, cancel and resume). The super admin's plan dropdown is the override, not the normal path.
- Merchants reach Ebda staff with **Contact Ebda Store** (sidebar), which stores a request and emails the support inbox (`BRAND.supportEmail`); see "Requests merchants send you" below.

## Plans

Ebda Store: **Starter / Professional / Enterprise** (plus `free` as a stripped fallback for the demo state / lapsed payment).

| Domain                                                                               | Starter            | Professional       | Enterprise         |
| ------------------------------------------------------------------------------------ | ------------------ | ------------------ | ------------------ |
| Storefront essentials (cart, checkout, search, reviews, wishlist, returns, PWA, SEO) | ✓                  | ✓                  | ✓                  |
| AI features (translation, SEO copy, category suggest, bulk sweep, AEO/GEO)           | ✓                  | ✓                  | ✓                  |
| Inventory — basic stock tracking                                                     | ✓                  | ✓                  | ✓                  |
| Inventory — stock alerts + backorder                                                 | —                  | ✓                  | ✓                  |
| Inventory — multi-warehouse + barcode + PO + bulk adjustments                        | —                  | —                  | ✓                  |
| Accounting — journal + expenses + invoicing                                          | —                  | ✓                  | ✓                  |
| Accounting — tax reports + multi-currency + profit anomaly + bank reconcile          | —                  | —                  | ✓                  |
| Loyalty + push notifications + upsell-crosssell                                      | —                  | ✓                  | ✓                  |
| Affiliate program + SMS + floating widget                                            | —                  | —                  | ✓                  |
| Ebda AI Studio WhatsApp bot integration                                              | **Separate quote** | **Separate quote** | **Separate quote** |

The canonical source is `packages/shared/src/plan-baselines.ts` — when the table here disagrees with the code, the code is right.

## Resolution rule

```
isFeatureEnabled(storeId, key) =
  StoreFeature row exists?  → row.enabled       (override wins)
  else                       → PLAN_BASELINE[store.plan].includes(key)
```

**Plan changes never touch StoreFeature rows.** Every override is preserved across upgrade AND downgrade. Super-admin manually clears overrides if a clean slate is wanted after a plan change.

## How to onboard a new merchant

**Merchant path (default).** The merchant signs up, verifies their email, and creates the store in the onboarding stepper (`POST /onboarding/store`); it starts on the Growth trial and they pick the plan billed at trial end. Nobody on staff is needed. Two blockers have their own merchant path, with staff as the decision:

- **Protected brand address**: the merchant files a claim with proof (`POST /onboarding/slug-claims`). You review it; to release it, create the store as a super admin (the `allowProtected` override) or have them retry once you lift it.
- **Daily store limit**: the merchant files a request with proof (`POST /onboarding/store-cap-requests`). You decide.

Both arrive by email to the support inbox and are stored in `trust_requests` (`kind = slug_claim | store_cap`, `status = open`). Review them in the admin app under **Support and trust requests** (`/trust-requests`, below). Granting the address (creating or renaming a store onto it as a super admin) or changing the owner's plan (`PUT /admin/stores/:id/subscription`) closes the matching open request by itself, so the merchant can ask again; otherwise press Resolve or Reject on the request.

## Support and trust requests screen

Super admin only, MFA required (`/trust-requests`, API `GET /admin/trust-requests`). It lists every support request, suspension appeal, protected address claim and store limit request, filtered by type, status, store id and created date; open one to read the full message and evidence, then **Resolve** (you acted on it) or **Reject** (you declined it). Each decision is written to the audit log (`trust_request.resolve` / `trust_request.reject`) and an already decided request cannot be decided again. Rejecting an appeal starts the merchant's 24 hour cooldown. The suspension reason notes are not requests and are not listed.

**Staff path (override, for a contract-led merchant).**

1. Sign the contract + collect payment.
2. From the super-admin sidebar, create the store (existing `POST /admin/stores` flow).
3. The store is created on `plan = free` by default. From the "Manage Features" page, **change the plan dropdown to the tier the merchant signed for** (Starter / Professional / Enterprise).
4. If the merchant paid for any **out-of-plan** add-ons (e.g. Starter but with Loyalty added, or Pro but with profit_anomaly), grant them per-row from the same Manage Features page. The feature shows ⚪ "Not in Starter" → click → it becomes 🔵 "Granted by override".
5. Onboarding continues per the existing checklist (branding, catalog import, payment provider, training).

## How to change a merchant's plan

**Merchant path (default).** The merchant opens **Billing**, picks a plan and pays (checkout), or changes the trial plan while trialing, or cancels and resumes. No staff step.

**Staff path (override).** Use it for a negotiated plan or a fix:

1. Go to the store's **Manage Features** page (super-admin sidebar).
2. Change the plan dropdown. Confirm in the modal — overrides will be preserved.
3. The UI re-renders: features that newly fall into the baseline now show 🟢 "Included in [NewPlan]". Features the merchant had as overrides keep their override badge.
4. If you want a clean slate after a downgrade (e.g. merchant dropped from Enterprise to Pro and shouldn't keep grandfathered features), use **"Reset to plan defaults"** at the bottom of the Manage Features page. Confirm in modal — this DELETEs ALL StoreFeature override rows for the store.

## How to grant or revoke a single feature

From the Manage Features page, click the toggle in the row. Action depends on the current tri-state:

| State           | What the toggle does                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| 🟢 Baseline ON  | Creates an override row `enabled=false` (revoke from plan) — row becomes 🔴  |
| 🔴 Override OFF | DELETEs the override row — falls back to baseline 🟢                         |
| ⚪ Baseline OFF | Creates an override row `enabled=true` (grant outside plan) — row becomes 🔵 |
| 🔵 Override ON  | DELETEs the override row — falls back to baseline ⚪                         |

Audit log records every toggle: action, user, store, ip, timestamp. Visible in the AuditLog table at `prisma.auditLog`.

## How to suspend a store

Suspension is for missed renewals + AUP violations. **The decision is super-admin only.** The merchant can read the reason and appeal once; they cannot lift it.

1. Go to the store's **Settings** page → Danger Zone (visible only to super-admin).
2. Click **"Suspend Store"**, type the **reason** (it is shown to the merchant, so write it as you would say it to them; up to 500 characters) and confirm. The API takes it as `reason` on `PATCH /stores/:id/status`.
3. Internal effects:
   - `Store.status = 'suspended'`
   - Feature cache invalidated
   - AuditLog entry written (`action: store.suspend`)
   - The reason is saved (`trust_requests`, `kind = suspension`) BEFORE the status flips, and a failed save fails the suspension (retry it). One note per suspension: a repeat suspend with no reason writes nothing and keeps the earlier reason; a first suspend with no reason shows the merchant "no reason recorded". It is shown in a banner on every page of that store's dashboard
   - Reactivating closes the open appeal first (same rule: a failure fails the reactivation, retry it)
4. External effects:
   - Storefront serves the `StoreMaintenance` page (HTTP 200 with branded "we'll be back soon" + "Powered by Ebda AI Studio" link)
   - Store admin can still log into admin (so they can pay invoice + click reactivate)
   - Background jobs (Inngest functions, abandoned cart reminders, etc.) skip suspended stores

## Appeals

A merchant of a suspended store sees the reason in a banner and can send ONE appeal (`POST /stores/:storeId/suspension/appeal`, 1000 characters). It reaches the support inbox by email and is stored (`kind = suspension_appeal`, `status = open`). A billing suspension (`billingSuspendedReason` set) cannot be appealed: the banner tells them to settle the invoice. You decide: reply to the merchant by email, then reactivate (below) to accept. To reject: reply to the merchant by email, then `POST /stores/:id/suspension/appeal/reject` (super admin, MFA). It sets the appeal to `rejected`, stamps `rejected_at`, writes an audit row (`store.suspension_appeal_reject`) and leaves the store suspended; 404 `NO_OPEN_APPEAL` when none is open. The merchant can send a new appeal 24 hours after `rejected_at` (until then: 429 `APPEAL_COOLDOWN`). Never edit `trust_requests` by hand.

Staff notices (support request, appeal, address claim, store-limit request): the full text and the merchant's e-mail reach you ONLY in the support inbox e-mail. The alert channel gets an `info` notice with ids only (store id, request id, kind, topic), never the message. A merchant can have at most 3 address claims open at once, and 5 support requests per store per UTC day (each request claims one of 5 slots through a unique key, so a burst cannot exceed it).

## How to reactivate

Same UI, the button reads "Reactivate Store" in green when status is suspended. Click → confirm → `status` flips to `active`. Storefront returns immediately on the next request. Reactivating also marks the store's open appeal `resolved`.

## Requests merchants send you

Every request below lands in the support inbox by email (reply-to is the merchant) and in `trust_requests`:

| `kind`              | Where the merchant files it                                                                                                 | Limit                       | Your action                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------- |
| `support`           | **Contact Ebda Store** (sidebar, and inside screens that need staff, such as a 3D models card that says it is switched off) | 5 per store per day         | reply by email                    |
| `suspension_appeal` | banner on a suspended store                                                                                                 | 1 open per store            | reply, then reactivate or reject  |
| `slug_claim`        | onboarding, protected address                                                                                               | 1 open per user and address | verify proof, release the address |
| `store_cap`         | onboarding, daily store limit                                                                                               | 1 open per user             | verify proof, raise the limit     |

**3D models** are on by default for every plan (`product_3d`, tier core). They are off for a store only when a super admin override disables it on Manage Features; the merchant's card then says so and offers Contact Ebda Store. Clear the override to turn them back on.

There is no review screen for these yet: the email is the queue, `trust_requests` is the record.

## How to delete a store

Permanent. Use it for test or abandoned stores only.

1. Open `/stores` (the platform store list, super admin only). On the store row or card, tap the "..." menu and choose **Delete store** (last item, red). Or open the store (`/stores/<id>`) and use **Delete store** in the danger zone at the bottom.
2. Type the store slug exactly (for example `qa-merchant-test`). The button stays disabled until it matches character for character.
3. Confirm the final prompt. The row disappears and a "store deleted" toast shows; the audit log records `STORE_DELETED`.

Refusals you may see (nothing is deleted):

- **Billing parent** (409 `STORE_IS_BILLING_PARENT`): other stores bill through this one. Move their billing first.
- **Money in flight** (409 `STORE_HAS_MONEY_IN_FLIGHT`): a payment or payout is still settling. Wait, then retry.
- **403 `MFA_SETUP_REQUIRED`**: turn on two-step verification at `/account/security` first; the dialog links there.
- **401**: the session ended, sign in again.

Backed by `DELETE /api/v1/stores/:id` (`authenticate`, `requireMfaEnrolled`, `authorize('super_admin')`, `requireStoreAccess`).

## Ebda AI Studio WhatsApp side

Ebda AI Studio WhatsApp is a **separate product** with its own 3-tier plan system on the WBS side (`Client.plan` + `ClientFeature` table). Same super-admin UI pattern in WBS admin frontend.

**Cross-product rule (HARD):** `wbs.bot.*` features REQUIRE a linked active Ebda Store. WBS plan can be at any tier, but if no Ebda Store is linked OR the linked store is suspended/inactive, all bot features resolve to disabled. Bulk campaigns + unified inbox + templates work without Ebda Store. Super-admin override on a `wbs.bot.*` feature CANNOT bypass this precondition — it's a runtime check, not a config flag.

## Money alerts that need a human

- **`order.auto_cancel.captured_on_terminal_order` (P1)** — the nightly
  auto-cancel sweep asked the provider about a stale unpaid order and the
  provider said PAID, but the order had already been cancelled or refunded by
  staff, so the capture is recorded nowhere on the order (issue 2136). The alert
  names each order, payment and transaction id, and the order page's payment
  timeline carries a `Reconciliation` event with reason
  `provider_paid_on_terminal_order`. Check the transaction in the provider
  dashboard; if the order stays cancelled, refund the customer from the
  provider dashboard (there is no in-app action on a cancelled + unpaid order).
- **`payment.refund.claim_stuck` (P1)** — a refund was claimed and the provider
  never confirmed it. Alerted at 15m, 24h and 72h, not every tick. Check the
  provider; if the money went out, complete the return with "Already refunded —
  record only", which writes `refund_reconciled` and stops the alerts
  (issue 2002).

## How to publish a legal policy change

Follow `docs/runbooks/legal-policy-change.md`: edit the text + bump `LEGAL_POLICIES` in one PR,
deploy marketing AND the API, then for a material version press **Send notice** on
**Policy updates** (`/policy-updates`). It emails every store owner once (bilingual, Arabic first)
and shows a banner until they press "Got it". It cannot be sent twice, and a fee change cannot be
sent with less than 30 days to its effective date (send it the day it deploys). Watch the counts
and the failed list. A run that stalls or did not start: **Resume**; failed emails: fix the cause,
then **Retry failed** (runbook § Recover a stalled or failed run; nobody is mailed twice). A row
stuck in `sending` for 15+ minutes is never re-sent: check Resend and contact the merchant. Who
accepted what: Users -> the merchant -> **Policy acceptances**. Rulings LEGAL-4/5/6.

## Where the code lives

| What                                 | Path                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Plan baseline constants              | `packages/shared/src/plan-baselines.ts`                                      |
| Feature registry (with sub-features) | `packages/shared/src/features.ts`                                            |
| Resolver                             | `apps/api/src/services/feature.service.ts`                                   |
| Super-admin endpoints                | `apps/api/src/routes/feature.routes.ts`                                      |
| Suspend endpoint                     | `apps/api/src/routes/store.routes.ts` (`PATCH /stores/:id/status`)           |
| Manage Features page                 | `apps/admin/src/app/stores/[id]/features/FeatureMatrix.tsx`                  |
| Super-admin wrapper                  | `apps/admin/src/components/RequireSuperAdmin.tsx`                            |
| Storefront suspension page           | `apps/web/src/components/StoreMaintenance.tsx`                               |
| WBS-side mirror                      | `whatsapp-bulk-sender/backend/src/lib/plan-baselines.js` + `feature-gate.js` |

## Related runbooks

- [`ROLLBACK.md`](../ROLLBACK.md) — code + DB rollback
- [`STAGING-DEPLOYMENT.md`](STAGING-DEPLOYMENT.md) — promotion flow

## Platform queue pages (email-queue, sms-queue, webhook-events) — 2026-11-04

These three super-admin pages used to call `/admin/...` without the `/api/v1` prefix, so they 404ed in production (UX:PL-1 / BE:F-1). They now call `/api/v1/admin/email-queue/*`, `/api/v1/admin/sms-queue/*` and `/api/v1/admin/webhook-events/*`; `tests/unit/admin-api-prefix.test.ts` fails the build for any admin `api*()` call (quoted or template literal) whose path does not start with `/api/v1`. Retry-all, discard-corrupt, refund, replay-an-already-processed-webhook, VAT enable, tax-verification revoke and cancel-subscription now ask through the shared confirm dialog (named object, one-sentence consequence, outcome-named button) instead of the browser's native `confirm()`.
