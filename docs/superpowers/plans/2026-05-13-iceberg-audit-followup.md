# Iceberg Audit follow-up plan — FWB

> **Correction (2026-09-22):** "Kuwait Law 13/2023" cited below does not exist. See docs/legal/gcc-data-protection.md for the verified GCC legal basis.

**Audit ran**: 2026-05-13
**Scope**: 38 production-reality terms from the "Vibe Coding vs Production Reality" iceberg framework
**Audit doc location**: see commit history around `3ff1354` + the in-session sub-agent report
**Shipped today**: 5 quick-win fixes (`3ff1354`) + new CLAUDE.md rules 5-10 + `INCIDENT.md` + pre-push backup hook

This plan sequences the remaining gaps into focused work sessions. Each
session is a self-contained chunk — Ahmad picks the next one and we
execute. Sessions are ordered by **regulatory risk × user-facing impact**.

---

## Session 1 — DONE (2026-05-13)

- ✅ Iceberg Audit baseline (38-term scan)
- ✅ CI `npm audit` gate → `--audit-level=low`
- ✅ Pino redact extended for PII + secrets
- ✅ Request log line with userId / storeId / requestId
- ✅ `docs/INCIDENT.md` triage runbook
- ✅ `.husky/pre-push` local DB backup hook
- ✅ `~/.claude/CLAUDE.md` rules 5-10 (Production Reality gates)

Commits: `3ff1354`

---

## Session 2 — Compliance core (1–2 days) — START HERE NEXT

**Why first**: cookie consent is an **active regulatory violation** every
time a customer loads a storefront. GDPR + ePrivacy + Kuwait Law 13/2023.
Store owners are legally exposed. This is the highest user-facing risk
remaining.

### 2a. Cookie consent banner (~4 hours)

- New `CookieConsentBanner` component at `apps/web/src/components/CookieConsentBanner.tsx`
- Gate `MarketingPixelsProvider` in `apps/web/src/app/layout.tsx` on consent state
- Persist consent in `force-cookie-consent` cookie (mirror the `force-language` pattern from `feedback-locale-cookie-ssr.md`)
- Bilingual EN/AR copy
- Three options on first visit: Accept all / Reject all / Customize (toggle marketing pixels vs functional only)
- Footer "Cookie preferences" link to reopen the modal
- **Acceptance**: visit a storefront in incognito → see banner → click "Reject all" → reload → marketing pixel scripts never appear in network tab

### 2b. GDPR `/auth/me/erase` + `/auth/me/export` (~6 hours)

- `POST /auth/me/erase` — Prisma transaction NULLs PII on User + Cart + Address + Newsletter rows; preserves Orders with anonymised customer reference
- `GET /auth/me/export` — returns JSON bundle of all stored PII (Right to Portability, Art. 20)
- Admin UI hook in customer profile (`apps/admin/src/app/customers/[id]`) — super_admin can trigger erasure on behalf of a customer who emails support
- Re-issue tokens or force logout post-erasure
- **Acceptance**: customer can call `/auth/me/erase`, the User row's `email/phone/firstName/lastName` becomes NULL or hashed, related Orders keep order data but `customerName` becomes "Anonymised", JWT becomes invalid

### 2c. Data retention crons (~2 hours)

- New Inngest function `abandoned-cart-purge` (cron weekly): delete `Cart` rows where `updatedAt < now() - 30 days` AND `customerId` is not present
- New Inngest function `soft-deleted-user-anonymise` (cron monthly): for `User WHERE deletedAt < now() - 12 months`, run the erase transaction from 2b
- **Acceptance**: dry-run cron shows expected row counts; live run completes without errors

---

## Session 3 — Observability + Alerting (1 hour dashboards + 1 hour code)

**Why second**: a site outage at 3am goes undetected without alerting. This is the operational risk that compounds — every hour without monitoring is an hour where a P0 could be running silently.

### 3a. UptimeRobot + Telegram (~15 min dashboard)

- uptimerobot.com → free account
- New monitor → HTTPS → `https://store-api.forcemediakw.com/health` → 5 min interval
- Same monitor for `https://app.forcemediakw.com` and `https://store.forcemediakw.com`
- Settings → Alert Contacts → Telegram → @UptimeRobotBot → Ahmad's channel
- **Acceptance**: kill Railway API for 30s → Telegram message arrives

### 3b. BetterStack / Logtail log drain (~15 min)

- betterstack.com (or logtail.com) → free account → new "Source" → type: Railway
- Copy the drain URL
- Railway dashboard → API service → Settings → Log Drains → paste URL
- **Acceptance**: tail logs in BetterStack → see live `[INFO] request` lines from Railway

### 3c. Sentry alert rules (~20 min dashboard)

- sentry.io → ForceAI-KW project → Alerts → New Alert Rule
- Rule 1: "Any new issue in the last 5 min" → Telegram
- Rule 2: "Issue happens 10+ times in 1h" → Telegram
- Rule 3: "Performance — p95 transaction duration > 2000ms for 5 min" → Telegram

### 3d. Cost alerts (~10 min dashboards)

- Railway dashboard → Project → Settings → Budget alerts → set 80% threshold
- Vercel dashboard → Project → Settings → Spending limit on Hobby
- Neon dashboard → Project → Settings → Email alert at 80% of compute credits

### 3e. `/health/detail` endpoint (~30 min code)

- New route in `apps/api` exposing: Inngest queue depth, Redis ping status, last Neon query duration, Sentry sample rate
- Behind admin auth so internal-only
- **Acceptance**: `curl https://store-api.forcemediakw.com/api/v1/health/detail` with admin token returns JSON with the four fields

---

## Session 4 — Growth tooling (~2 days)

### 4a. Meta Conversions API server-side pixel (~1 day)

- New service `apps/api/src/services/meta-capi.service.ts`
- Fired from `handleWebhook` on `status: completed` (post-payment, same trigger as the order/created Inngest event)
- Hashes customer email/phone per Meta's requirements
- Per-store Meta Pixel ID + access token in `Store.marketingPixels` (admin-configurable)
- **Why this matters**: ad-blocker users are entirely invisible to client-side pixels; CAPI recovers ~15–30% of attribution

### 4b. PostHog A/B testing (~4 hours)

- `npm i posthog-js` in `apps/web`
- Initialize in `apps/web/src/app/layout.tsx` with consent gate (depends on Session 2a)
- `posthog.getFeatureFlag('hero-variant')` pattern for assigning variants
- Track conversion events from `trackPurchase` already firing in `SuccessClient.tsx`
- **First experiment idea**: home hero "Shop Now" CTA color variants A/B
- **Acceptance**: PostHog dashboard shows experiment running; variant assignment is persistent per visitor

---

## Session 5 — Staging environment (~3 days)

**Why this exists**: Vercel preview deployments currently hit the production
API. Every preview build can mutate production data. E2E tests run against
prod Neon. This is the biggest non-regulatory architectural debt.

### 5a. Provision staging Railway service (~half day)

- Railway → new service `api-staging`
- Same Dockerfile, different env: `DATABASE_URL` points at a new Neon branch `staging`
- Domain: `staging.store-api.forcemediakw.com` (or similar)

### 5b. Vercel preview env override (~30 min)

- Vercel `force-admin` project → Settings → Environment Variables → Preview env → `NEXT_PUBLIC_API_URL` = staging URL
- Same for `force-web`
- Verify by opening a preview deploy URL → DevTools Network → confirm requests go to staging API

### 5c. E2E test isolation (~1 day)

- Move `e2e` config to use the staging Neon branch
- Update CI workflow `ci.yml` to point E2E env at staging
- Re-test the cleanup helpers (`tests/e2e/cleanup.ts`) on staging
- **Acceptance**: E2E suite passes against staging, leaves zero test-data in production

---

## Session 6 — Platform billing (~1 week, deferrable)

**Why deferred**: currently FWB has ONE merchant (Wady Aljuz). Manual billing
is fine until merchant N > 3. Building Stripe subscription automation now
is premature.

### Scope when triggered

- `StoreSubscription` table: storeId, stripeSubscriptionId, plan, currentPeriodStart/End, cancelAt, status
- Stripe checkout for plan signup (separate from merchant-to-customer payment providers — this is Force Media → merchant)
- Webhook handler for Stripe subscription lifecycle events
- Dunning flow on failed payment
- Trial period support (free 14d on Starter+)

---

## Session 7 — Test coverage to 70% (~3 days, ongoing)

### Targets (raise vitest.config.ts threshold once met)

- `apps/api/src/services/order.service.ts` → 70%+
- `apps/api/src/routes/payment.routes.ts` → 80%+ (payment paths are highest-risk)
- `apps/api/src/routes/webhook.routes.ts` → 80%+
- `apps/api/src/services/auth.service.ts` → 70%+
- Then bump `vitest.config.ts` thresholds from `lines: 50` → `lines: 70`, `branches: 40` → `60`

---

## Running this audit on other Force projects

The same 38-term framework applies to every project, with stack-specific
weighting:

| Project                    | What to weight heavier                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Force Media CRM            | GDPR erasure (PII-heavy: client data, automations history); Audit log retention; Test coverage on CRUD service layer                                                                       |
| WhatsApp Bulk Sender (WBS) | Rate limiting on Meta Cloud API webhook receipt; Idempotency on bulk-send jobs; Secrets management for per-tenant WhatsApp credentials; Cookie consent (storefront has marketing tracking) |
| Force Media Landing Page   | Cookie consent (critical for marketing site); CSP review; Vendor lock-in to Vercel (lighter stack means easier to migrate but no need yet)                                                 |
| Future projects            | Bake all 10 CLAUDE.md non-negotiable rules from day 1 — never retrofit                                                                                                                     |

---

## Memory references

- `~/.claude/projects/-Users-ahmadsharaf/memory/reference-iceberg-audit.md` — the canonical methodology + sub-agent dispatch pattern (added 2026-05-13)
- `~/.claude/CLAUDE.md` § "Production Reality gates" — the 6 new standing rules added today (5-10)
- `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/reference-fwb-ai-sweep-data-flow.md` — AI sweep data discovery (related: today also closed the "where did my data go" UX gap)
