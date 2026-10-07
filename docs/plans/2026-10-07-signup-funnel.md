# Merchant signup funnel: plan choice, card on file, 14-day Growth trial

**Decision:** Ruling EBDA-FUNNEL-1 (Ahmad, 2026-10-07). Stacks on PR #10 (`feat/locked-pricing`).
**Rulings:** `docs/RULINGS.md` §"Signup funnel" (EBDA-FUNNEL-1..9).

## Finish line

- **Must work:** marketing plan card → `/signup?plan=<code>&interval=<month|year>` → verify email → onboarding: plan → store → card → template → product → payment → go live. The trial runs on Growth whatever plan was chosen; on day 15 the chosen plan and interval are charged.
- **Proved by:** integration tests on a local Postgres container covering the happy path, a declined card at trial end (into dunning), a webhook replay, and the trial-end job run twice. Unit tests cover the gate, the mode resolution and the deep links. Three or more money guards are mutation-checked. The touched workspaces typecheck.
- **Must not change:** the existing renewal and dunning semantics for paid subscriptions, super-admin provisioning (the operator path), page-builder and layout cache code, and migration `20261004000000`.
- **Done:** a PR is open against main, the tests are green with counts reported, and nothing is merged or deployed.

## Shape

| Piece                                                           | Where                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Card setup without a charge (`card_setup` ledger row, amount 0) | `BillingProvider.createCardSetupSession` + `capabilities.cardSetupWithoutCharge`. The stub supports it. Kashier does not: its docs say the token only exists after a paid transaction.                             |
| Trial card mode `card_on_file` \| `pay_at_trial_end`            | `resolveTrialCardMode` (env `BILLING_TRIAL_CARD_MODE`). The default follows the provider capability, and `card_on_file` is refused on a provider without the capability.                                           |
| Chosen plan during the trial                                    | `store_subscriptions.pending_plan_code` + `billing_interval`. The existing trial-end charge already bills `pendingPlanCode ?? planCode`.                                                                           |
| Card details for the UI                                         | new columns `payment_method_last4`, `payment_method_brand`, `payment_method_saved_at` (migration `20261007160000_signup_funnel`), plus `card_setup` added to the `billing_events` type check                       |
| Go-live gate                                                    | `assertStoreMayGoLive`, called from `OnboardingService.goLive` (the only merchant writer of `stores.status = active`)                                                                                              |
| `POST /stores` gap                                              | a non-operator store is created `inactive`. The first store goes on a Growth trial (no longer Basic-active); later stores go on Business, as onboarding already does.                                              |
| Trial-end job                                                   | the existing `billing-renewal-daily` Inngest cron, with an InstaPay (manual-pay) branch, reminders and a settle retry                                                                                              |
| UI                                                              | onboarding `PlanStep` and `BillingStep` (card or InstaPay); card, trial and next-charge rows on the billing page; a subscriptions table on super-admin `/billing-events`; plan CTAs on the marketing pricing cards |

## Scope additions (Ahmad, same day, same PR)

1. **Payment step = card on file OR InstaPay.** For InstaPay the merchant sees the handle (`EBDA_INSTAPAY_HANDLE`), the exact amount and a unique reference, then submits "I paid" with the transfer reference. A super-admin confirms it with **Record manual payment & activate**. The merchant's claim alone activates nothing.
2. **Daily automation** on the existing `billing-renewal-daily` cron. Reminders go out 7, 3 and 1 days before the due date and on the due day (email, bell and banner, plus a wa.me link). Card subscriptions are charged on the due day, with dunning on failure. An unpaid InstaPay subscription goes past_due, and after `INSTAPAY_GRACE_DAYS` (3) the store is suspended: shoppers see the neutral maintenance page, and the admin stays usable to pay. A recorded payment restores the store at once.
3. **Store allowance.** When an owner downgrades or lapses, live stores beyond the new plan's count are suspended, oldest kept. They are read-only in the admin, with a banner, and restored on upgrade or payment.
4. **Upsell UI.** Every plan 402 carries `upgradeTo` plus Arabic and English messages. The admin shows "Upgrade to <plan>" with a link to the plan page instead of a raw error.
5. **Amelia is a regular client.** `founding_free` stays hidden and unassigned. Her paid period is recorded with the manual-payment action.
6. **Super-admin billing page.** It lists subscriptions (all, due, overdue, suspended) with card, trial and next charge, plus the pending claim queue with confirm and reject.

Data: migration `20261007160000_signup_funnel` adds the card columns, `billing_method`, `payment_reference`, `stores.billing_suspended_reason/at`, the `manual_payment_claims` and `billing_reminders` tables (both under strict store RLS), and the `card_setup` / `manual_payment` ledger types.
