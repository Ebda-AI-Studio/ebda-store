# Super-admin playbook

> How to onboard a new merchant, change plans, grant/revoke individual features, and suspend / reactivate a store.

## Roles

- **`super_admin`** — Ahmad and any future Ebda AI Studio staff. Can see and toggle ALL features for any store, change plans, and suspend/reactivate. Sees the "Manage Features" link in the store sidebar.
- **`store_admin`** — Merchant team. Can see + use only the features that resolve to enabled for their store. Does NOT see "Manage Features" or any plan-change UI. Plan is shown read-only.

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

1. Sign the contract + collect payment.
2. From the super-admin sidebar, create the store (existing `POST /admin/stores` flow).
3. The store is created on `plan = free` by default. From the "Manage Features" page, **change the plan dropdown to the tier the merchant signed for** (Starter / Professional / Enterprise).
4. If the merchant paid for any **out-of-plan** add-ons (e.g. Starter but with Loyalty added, or Pro but with profit_anomaly), grant them per-row from the same Manage Features page. The feature shows ⚪ "Not in Starter" → click → it becomes 🔵 "Granted by override".
5. Onboarding continues per the existing checklist (branding, catalog import, payment provider, training).

## How to change a merchant's plan

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

Suspension is for missed renewals + AUP violations. **Super-admin only.**

1. Go to the store's **Settings** page → Danger Zone (visible only to super-admin).
2. Click **"Suspend Store"**. Confirm modal.
3. Internal effects:
   - `Store.status = 'suspended'`
   - Feature cache invalidated
   - AuditLog entry written (`action: store.suspend`)
4. External effects:
   - Storefront serves the `StoreMaintenance` page (HTTP 200 with branded "we'll be back soon" + "Powered by Ebda AI Studio" link)
   - Store admin can still log into admin (so they can pay invoice + click reactivate)
   - Background jobs (Inngest functions, abandoned cart reminders, etc.) skip suspended stores

### What a suspension stops (Ruling SUSPEND-OUT-1)

One predicate, `apps/api/src/lib/store-operational.ts` (`isStoreOperational`: only `status = 'active'`), is checked at every send and payout entry point. It reads the store live (never the 60 s directory cache), so the next send after the flip is already refused.

| Stopped while suspended / inactive                                                                        | Where                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Abandoned-cart recovery: the sweep skips the store; email, SMS, push                                      | `abandoned-cart.service.ts`, `cart-recovery-email.service.ts`                        |
| Customer SMS + storefront push on order events and back-in-stock                                          | `notification-dispatcher.service.ts`                                                 |
| Marketing email: campaigns, newsletter broadcast (admin gets 423 `STORE_NOT_OPERATIONAL`)                 | `store-mailer.service.ts`, `campaign.routes.ts`, `newsletter.routes.ts`              |
| Push broadcast to storefront subscribers (423)                                                            | `onesignal.service.ts`                                                               |
| Ebda Chat events that message a customer: order created, status changed, shipment, cart                   | `wa-store-events.ts`                                                                 |
| Customer emails: order confirmation, shipped, and the invoice of an UNPAID order (423 on the admin click) | `order-created.ts`, `order-status-changed.ts`, `invoice-email.ts`, `order.routes.ts` |
| Affiliate payouts, the money-OUT path (423)                                                               | `affiliate.service.ts`                                                               |

Campaigns are not failed when a store is suspended mid-send: the send PAUSES (campaign back to `draft`, recipients stay `queued`, one status read per batch) and a new Send after reactivation resumes the unsent recipients.

Still allowed on purpose (Ruling SUSPEND-OUT-1b): receipts for paid orders (the payment-success email and the invoice of a paid order, including the admin invoice click), refunds to customers and the refund notice, the merchant's own mail (owner invoice copy, campaign test send to their own address, new-order alerts), data export, and the appeal / support routes. The admin UI shows the refusal from the error code `STORE_NOT_OPERATIONAL` (`details.messageEn` / `details.messageAr`; admin string `common.storeNotOperational`). Reactivating the store lifts all of it at once; nothing queued while suspended is replayed.

## How to reactivate

Same UI, the button reads "Reactivate Store" in green when status is suspended. Click → confirm → `status` flips to `active`. Storefront returns immediately on the next request.

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
