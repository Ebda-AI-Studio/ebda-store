# Cart-recovery email + email campaigns in plans (2026-10-21)

Branch `feat/cart-email-campaigns`. Two features, lean build (touched tests per step, full unit suite once at the end).

## Finish line

- **Must work:** (1) one store-branded reminder email per abandoned cart, only to an active newsletter subscriber, after a merchant-set delay, never twice, never after the cart converts; (2) `email_campaigns` is on for Growth + Business (not Basic), per-plan daily send caps, Basic sees the upsell gate.
- **Exercised:** unit tests on the sweep, the Inngest sender (consent, idempotency, converted, retry), the renderer (ar/en, unsubscribe), plan baselines, caps, config route; admin tsc/lint.
- **Must NOT change:** push/SMS recovery steps, transactional email paths, the campaign send job's consent filter.
- **Done =** typecheck, lint, full unit suite green; report in `.superpowers/cart-email-report.md`. Not pushed.

## Feature 2 - campaigns in plans

- `plan-baselines.ts`: `email_campaigns` into `PROFESSIONAL_ADDITIONS` (Growth `featureTier=professional`, Business `enterprise`; Basic `starter` stays out; `store.plan` is synced to `featureTier` by plan.service). Flip `campaign-feature-default-off.test.ts`.
- `campaignDailyCap(plan?)`: env `CAMPAIGN_DAILY_SEND_CAP` still wins when set; else professional 1000, enterprise 5000, other 500. `storeCampaignDailyCap(storeId)` used by the audience route, the send route and the send job.
- Upsell: the existing `FeatureUpgradeGate` already renders for a disabled feature; add a public-plan label override so it says "Growth" not "Professional".
- Docs: plan-feature-matrix, ENVIRONMENT, RULINGS. Marketing site keeps "not in plans yet" until both branches merge (report note).

## Feature 1 - abandoned-cart email

- Migration `20261022000300_cart_recovery_email` (+ rollback): `abandoned_cart_configs.email_enabled` (default false), `email_delay_minutes` (default 120, 60..1440); `abandoned_carts.email_status|email_detail|email_sent_at`. No new table, no RLS change.
- `services/cart-recovery-email.service.ts`: `cartEmailDueAt`, `sweepCartRecoveryEmails` (claim `email_status NULL -> queued`, then `inngest.send` with event id `cart-recovery-email/<id>`; enqueue throw marks the row `failed`), `deliverCartRecoveryEmail`, `renderCartRecoveryEmail` (ar Egyptian + en, store shell, unsubscribe).
- `functions/cart-recovery-email.ts`: re-checks at send time (config on, `abandoned_cart` feature, not recovered, items exist, consent), campaign send pacer slot, `ResendService.sendMarketingEmail` (store sender, RFC 8058 headers, idempotency key), marks `sent`; `onFailure` marks `failed`.
- Consent (Ruling EC-1): an ACTIVE `newsletter_subscribers` row of the same store for the cart's email, none of its case variants unsubscribed. Unsubscribe = `signSubscriberUnsubscribeToken` through the existing public route.
- Hook: `abandonedCartService.process()` calls the sweep after `processReminders`. Config route + admin form: toggle and delay (ar/en).

## Risks

- Detection only covers logged-in customers' carts and scans stores with an explicit `store_features` row (existing; flagged, not changed).
- Real Resend send and the Inngest dev server are not exercised (unit-level only).

## Review pass (2026-10-21, `.superpowers/cart-email-review.md`: approve with fixes)

Each item is its own commit; rulings CART-EMAIL-5..9, CART-DETECT-1, CART-CONSENT-1, CART-RESTORE-1 in `docs/RULINGS.md`.

1. Checkout email opt-in (unchecked box, cart-reminders consent scope, guest cart email, signed restore link) - migration `20261022000400_cart_email_consent`.
2. Stop-on-convert: re-read the cart after the send-slot wait. 3. Transient Resend errors retry; only permanent 4xx fail.
3. Detection by effective entitlement (plan baseline OR row), for push, SMS and email.
4. Minors: sweep prefilter, per-store cart cap in the shared budget, requeue of stuck `queued`, neutral copy, price label, re-subscribe ruling.
5. Default stays OFF + dismissible nudge.
   Integration tests (DB) are pending the coordinator's "db slot free".
