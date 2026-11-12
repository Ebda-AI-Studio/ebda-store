# Ebda Store acquisition tracking (own Meta ads + PostHog funnel)

Measures Ahmad's Meta ads for Ebda Store itself. Separate from the per-merchant storefront pixels (`marketing-pixels` admin page, `apps/web` `MarketingPixels.tsx`, `pixels-capi.service.ts`), which use each merchant's own pixel.

Everything is **consent-gated** and **optional**: with the env vars unset nothing loads and nothing errors.

> Privacy gate (Ruling PIXEL-CONSENT-1): the Meta pixel neither loads nor fires on a URL whose query holds a typed term, an email, a phone or a one-time token (`SENSITIVE_QUERY_PARAMS` in `@ebda/shared`). Pixels read the page URL themselves, so on `/verify-email?token=...` the browser `CompleteRegistration` is skipped and only the server (Conversions API) event, same `event_id`, reaches Meta.

## What fires where

| Step                                                            | Meta event                              | Where                                                                                                           | Browser | Server (CAPI) | Dedup `event_id`             |
| --------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- | ------------- | ---------------------------- |
| Any page on ebda.app, `/signup`, `/verify-email`, `/onboarding` | `PageView`                              | marketing + admin funnel pages                                                                                  | yes     | no            | none                         |
| Pricing section scrolled into view                              | `ViewContent` (`content_name: pricing`) | marketing                                                                                                       | yes     | no            | none                         |
| Signup form accepted                                            | `Lead`                                  | `/signup`                                                                                                       | yes     | no            | `lead_<uuid>` (browser only) |
| Email verified (account real)                                   | `CompleteRegistration`                  | `/verify-email` + `AuthService.verifyEmail`                                                                     | yes     | yes           | `reg_<userId>`               |
| Store created                                                   | `StoreCreated` (custom)                 | `/onboarding` store step + `OnboardingService.createStore`                                                      | yes     | yes           | `store_<storeId>`            |
| First paid subscription confirmed                               | `Purchase` (value, `EGP`)               | Kashier success (checkout, upgrade, trial-end charge) and super-admin InstaPay approval (`recordManualPayment`) | no      | yes, only     | `sub_<billingEventId>`       |

`Purchase` is server-only on purpose: the payment is confirmed server-side (Kashier webhook / a super-admin click), never in the visitor's browser. It fires once per store, for its first paid payment only (later renewals are skipped by the `ebda-ads-conversion` Inngest function). Value is the gross amount in major units (`amountMinor / 100`), currency `EGP`.

PostHog (client, consent-gated, named instance `ebda`, cookie shared across `*.ebda.app`): `$pageview`, `pricing_viewed`, `signup_submitted`, `registration_completed`, `store_created`; server-side `subscription_paid` (needs the visitor's PostHog id, captured at signup).

## Consent

One first-party cookie `ebda_consent` on `.ebda.app` (180 days), written by the Arabic-first banner (EN on `/en`). Accept = PostHog + Meta + attribution; Decline = nothing. No decision yet = nothing (events are held in memory and replayed or dropped on the answer). The footer "Cookie settings" link reopens the banner. The server only sends to Meta for accounts whose signup recorded marketing consent.

## Attribution

On the first consented landing, `utm_source/medium/campaign/content/term` and `fbclid` go into the first-party cookie `ebda_attr` (90 days, `.ebda.app`) together with the landing path and referrer host; `fbclid` also becomes the Meta `_fbc` cookie (`fb.1.<ms>.<fbclid>`). First touch wins, except an ad click replaces an organic first touch and a newer `fbclid` refreshes the click id. The signup form posts it as `tracking` to `POST /auth/merchant/signup`; the API stores it in `users.acquisition` (jsonb) with the consent given and the request ip/user-agent (marketing consent only). Super-admins see source, medium, campaign, landing page and referrer on the store detail page ("How they found Ebda"). Merchants never see it; ip, user agent and Meta ids never leave the API.

**Migration (additive, flagged):** `packages/database/prisma/migrations/20261014000000_user_acquisition` adds nullable `users.acquisition jsonb`. No default, no backfill, no index. Apply it before deploying the API.

## Environment

| Variable                            | Where                                                             | Value                                                         |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `EBDA_META_PIXEL_ID`                | API (Railway)                                                     | pixel / dataset id                                            |
| `EBDA_META_CAPI_TOKEN`              | API (Railway)                                                     | secret, Conversions API token                                 |
| `EBDA_META_TEST_EVENT_CODE`         | API, optional                                                     | from Events Manager > Test events                             |
| `EBDA_POSTHOG_KEY`                  | API, optional                                                     | PostHog project key (falls back to `NEXT_PUBLIC_POSTHOG_KEY`) |
| `NEXT_PUBLIC_EBDA_META_PIXEL_ID`    | GitHub repo variable (marketing + admin builds)                   | same pixel id                                                 |
| `NEXT_PUBLIC_POSTHOG_KEY` / `_HOST` | already set for admin/web; now also passed to the marketing build | existing                                                      |

## Verify in Meta Events Manager

1. Set `EBDA_META_TEST_EVENT_CODE` (copy from Events Manager > your pixel > Test events) on the API, redeploy. Server events now appear under Test events instead of production.
2. Open `https://ebda.app/?utm_source=meta&utm_medium=paid&utm_campaign=test&fbclid=TEST123`, accept the banner. In Test events > "Browser" you see `PageView`.
3. Sign up with a fresh email at `store.ebda.app/signup` (`Lead`), open the verification mail link (`CompleteRegistration` browser + server), create a store (`StoreCreated` both).
4. Each of `CompleteRegistration` / `StoreCreated` shows twice and is marked **Deduplicated** (same `event_id`). The `Purchase` server event appears after a Kashier success or a super-admin InstaPay approval of the store's first payment.
5. Event match quality: `em`, `ph`, `fbp`, `fbc`, `client_ip_address`, `client_user_agent`, `external_id` should all show. Remove the test code when done.
6. In Admin as super-admin, open the store: "How they found Ebda" shows `meta / paid / test`.

## PostHog funnel

Insights > Funnels, steps in order, conversion window 30 days, unique users:

1. `$pageview` (filter: URL host `ebda.app`)
2. `signup_submitted`
3. `registration_completed`
4. `store_created`
5. `subscription_paid`

Break down by `utm_source` / `utm_campaign` (the `subscription_paid` event carries them; for the browser steps use the `Initial UTM source` person property PostHog stores).

## Failure behaviour

CAPI sends run in the `ebda-ads-conversion` Inngest function (never in the request): 5 attempts with backoff, then a `[ebda-ads] conversion FAILED after all retries` error log and the run ends normally (no platform P1 for an ad-attribution gap). Enqueue failures are logged and swallowed. Erased users (`deletedAt`) and accounts without marketing consent are never sent.

## Known limits

- The operator PostHog providers in `apps/admin` and `apps/orders` are consent-gated too since 2026-11-10 (Ruling ICEBERG-ADM-CONSENT-1): `posthog-js` is not imported until the shared `ebda_consent` cookie says `analytics: true`, and a later decline (the banner fires `ebda:consent-change`) opts capture out. A merchant who never answered the banner sends no analytics. The funnel events here use a separate `ebda` instance.
- No Conversions API `Lead`/`PageView` (browser-only by design). Marketing `Lead` = `contact_submitted` (contact form success, no params); `CompleteRegistration` stays on the admin signup domain.
- `Purchase` is per store (first paid payment of that store), not per owner.
