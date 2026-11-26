# Lifecycle emails (self-serve onboarding)

Source: growth strategy 2026-10-22, section 3.4. Rulings: LIFE-1..5 in `docs/RULINGS.md`.

| Kind               | When                  | Skipped when                            | CTA                            |
| ------------------ | --------------------- | --------------------------------------- | ------------------------------ |
| `add_products`     | store created + 1 day | a product exists                        | products                       |
| `payment_shipping` | + 3 days              | payment AND shipping both set           | payment settings               |
| `test_order`       | + 5 days              | any order exists                        | storefront                     |
| `share_link`       | + 7 days              | never                                   | storefront link                |
| `trial_recap`      | trial end - 4 days    | not trialing                            | billing                        |
| `first_order`      | `order/created`, once | no order, or the owner's own test order | WhatsApp share (referral link) |

- Trigger: `provisionStore` emits `store/self-serve-provisioned` when `growthTrial` is set; one Inngest run (`lifecycle-emails`) sleeps with `step.sleepUntil` to each due time and re-reads the real state (`SetupGuideService`) before sending. No cron.
- Idempotency + log: `store_lifecycle_emails` (UNIQUE store + kind, strict RLS). `sent | skipped (reason) | failed`. Viewer: admin `/stores/[id]/lifecycle-emails` (Marketing hub). Owner-only (Ahmad 2026-11-15): `GET /stores/:storeId/lifecycle-emails` is `authorize('store_admin','super_admin')` (staff get 403), the hub tab is `ownerOnly`, the search registry entry is `owner`, and the assistant tool `lifecycle_emails_overview` is `store_admin` only.
- Consent: signed one-click unsubscribe, `GET|POST /api/v1/public/lifecycle-emails/unsubscribe?token=` (GET only confirms). Stored as a `kind = optout` row. Every lifecycle email also carries RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (Ruling LIFE-6). Order, billing and security emails are unaffected.
- Sender: `EmailService.sendLifecycleEmail` (platform sender, Ebda night/gold shell, durable email queue). Refuses to send without an unsubscribe URL.
- Referral attribution: the storefront "Powered by Ebda" badge links to the marketing site with `utm_source=ebda_store_badge&utm_medium=referral&utm_campaign=powered_by&utm_content=<store host>`; the first-order email uses `utm_source=merchant_email`. Super-admin dashboard (`GET /admin/dashboard` -> `referrals`) shows signups per source (consented first touch only, so a floor).
- Not built: strategy email 6 ("day 13, no card"); the d1/d0 billing reminders already cover it (Ruling LIFE-1).
