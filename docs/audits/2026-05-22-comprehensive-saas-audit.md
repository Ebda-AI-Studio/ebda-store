# Ebda Store (Ebda Store) — Comprehensive SaaS Due-Diligence Audit

**Date:** 2026-05-22
**Subject:** Ebda Store / Ebda Store (proprietary multi-tenant e-commerce SaaS)
**Audit framing:** acquirer-grade due diligence — every square inch
**Scope:** security, database, infrastructure, code quality, business features, cost forecast, risk register, SWOT

---

## Executive Summary (for the would-be acquirer)

Ebda Store (operated as "Ebda Store" by Ebda AI Studio Egypt) is a **proprietary multi-tenant SaaS e-commerce platform** purpose-built for Egypt/GCC SMB merchants. The codebase is **1,158 tracked files, 79 Prisma models, 30 async Inngest functions, 51 API route files, 5 production storefront themes**, currently serving 2 live merchants (Wady Aljuz @ 235 products / 8 categories; demo-boutique). Source code is proprietary (`license: UNLICENSED`).

**The headline assessment:** this is a remarkably well-architected SaaS for its production stage. The 4 pillar moats — AI-as-default via Gemini Flash Lite, Arabic-first locality, Egypt-native payment stack (Tap/MyFatoorah/Hesabe/UPayments), per-section customization granularity — are genuinely differentiated. Feature depth (full Chart-of-Accounts accounting, AEO/GEO 7-layer architecture, WBS WhatsApp bridge, dual-stack push) exceeds the SMB tier and would typically be found in $200–500/mo enterprise platforms. The platform's primary commercial weakness is operational: **no self-serve signup or public pricing exists**, capping growth to what the Ebda AI Studio agency can close manually.

The infrastructure topology (Vercel × 2 + Railway + Neon + Cloudflare R2 + Inngest) has been thoughtfully hardened: per-commit Neon snapshots, 5-channel observability (Sentry + UptimeRobot + PostHog + Telegram + Axiom log drain), correct rollback automation, RLS-backed tenant isolation, and zero-vulns CI gates. Cost discipline is excellent — current run-rate is **~$26/mo**, scaling linearly to **~$170/mo at 10k MAU** and **~$1,100/mo at 100k MAU**.

The audit surfaces **three P0 issues**, **eight P1 issues**, and a longer list of P2/P3 items. The P0s are remediable in days, not months. The single most material issue: **Vercel Hobby plan violates Vercel's commercial-use terms** — the platform processes payments and operates as a SaaS but runs on a $0 plan that explicitly forbids this. A $20/mo upgrade resolves it. This is the highest priority pre-acquisition cleanup item.

**Acquisition recommendation framework:** for a buyer looking to enter the Egypt/GCC e-commerce platform space, Ebda Store offers a 12–24 month head start on Salla and Zid (which lack Egypt-native KNET integration and bulk-AI features). The AI moat decays to 12–18 months as Gemini integration becomes table-stakes; the Egypt payment stack + Arabic-first data model moats are 60+ months durable. Pre-revenue or low-revenue today, but cost structure supports a $30–100/mo per-merchant SaaS price with 70%+ gross margins at scale.

---

## Table of Contents

1. [P0/P1 Risk Register (Action Required)](#p0p1-risk-register-action-required)
2. [SWOT Analysis](#swot-analysis)
3. [Security & Compliance](#1-security--compliance-audit) — [`_slices/01-security-compliance.md`](_slices/01-security-compliance.md)
4. [Database & Performance](#2-database--performance-audit) — [`_slices/02-database-performance.md`](_slices/02-database-performance.md)
5. [Infrastructure & DevOps](#3-infrastructure--devops-audit) — [`_slices/03-infrastructure-devops.md`](_slices/03-infrastructure-devops.md)
6. [Code Quality & Architecture](#4-code-quality--architecture-audit) — [`_slices/04-code-quality.md`](_slices/04-code-quality.md)
7. [Business Features & Competitive Positioning](#5-business-features--competitive-positioning) — [`_slices/05-business-features.md`](_slices/05-business-features.md)
8. [Cost Forecast & Scaling](#6-cost-forecast--scaling) — [`_slices/06-cost-forecast.md`](_slices/06-cost-forecast.md)
9. [Forecast Summary at 10k / 100k Visitor Bursts](#forecast-summary)
10. [Acquisition Due-Diligence Checklist](#acquisition-due-diligence-checklist)

---

## P0/P1 Risk Register (Action Required)

Risks are ordered by severity then by remediation difficulty (easy wins first).

### Remediation status — last updated 2026-05-22 (same-day, P2 batch added end-of-day)

| Item                                                  | Status           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1** Vercel Hobby → Pro                           | ✅ done          | Upgraded same-day. Also paid Neon Launch.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **P0-2** divergent `apps/api/railway.json`            | ✅ done          | File removed; root `railway.json` is the single source.                                                                                                                                                                                                                                                                                                                                                                                      |
| **P0-3** Sentry header / PII leak                     | ✅ done          | `sentry.service.ts` strips `authorization` / `cookie` / `x-csrf-token` from `errorHandler`; user email dropped from `setUser()` + `userContextMiddleware`. Historical events left in Sentry — Ahmad's call (sole access, retention policy expires them over time).                                                                                                                                                                           |
| **P1-1** RLS on 8 missing tables                      | ✅ done          | Migration `20260522000000_rls_for_8_missing_tables` shipped. 7 tables direct (blog_posts / store_faqs / store_howtos / ai_recommendation / bulk_ai_jobs / ai_usage / product_faqs via EXISTS through products). `onesignal_subscriptions` correctly excluded — user-scoped, not store-scoped.                                                                                                                                                |
| **P1-2** uuid + exceljs CVEs                          | ✅ done          | Migrated to `crypto.randomUUID()` (Node 16+ built-in); `package.json` overrides force `uuid: ">=11.1.1"` including the nested `exceljs.uuid` form. `npm audit` clean at every severity.                                                                                                                                                                                                                                                      |
| **P1-3** Frontend test coverage (Playwright smoke)    | ✅ done          | Commit `3bf2a34d`. 5 specs (3 storefront + 2 admin), read-only against prod, 6.6s. Vitest exclude added for `tests/smoke/**`. README at `tests/smoke/README.md`. Generalized pattern in global memory: `feedback-playwright-smoke-against-prod.md`.                                                                                                                                                                                          |
| **P1-4** CI `continue-on-error: true` removal         | ⏸ deferred       | Blocked on GitHub Actions billing failure at the Whisky-11 org. Every CI run since the billing event has been auto-rejected in 3 seconds. Removal is cosmetic until billing is resolved at `github.com/organizations/Whisky-11/settings/billing`. Pattern documented in global memory: `feedback-github-actions-billing-rejects-jobs.md`.                                                                                                  |
| **P1-5** bulk-import `retries: 0`                     | ❌ audit misfire | Code is intentionally non-retrying because CSV import isn't idempotent — re-running a half-completed import would create duplicate products. The catch block at `bulk-import.ts:74` already marks the job `failed` with `errorMessage`, surfacing the failure to the admin UI. The audit's proposed `retries: 2` fix would regress safety. No action.                                                                                        |
| **P1-6** `DIRECT_URL` fail-fast                       | ✅ done          | Added to `getRequiredSecret` list in `apps/api/src/config/index.ts`. App now refuses to boot without it instead of silently failing on first migration.                                                                                                                                                                                                                                                                                      |
| **P1-7** stale infra docs                             | ✅ done          | `docs/DEPLOYMENT.md` + `docs/ROLLBACK.md` audited, no Cloudflare-Pages / Supabase / force-admin-seven / force-web-sigma references remain. Canonical infra: Vercel (admin + web) + Railway (API) + Neon + Cloudflare R2.                                                                                                                                                                                                                     |
| **P1-8** Railway build failure → Telegram             | ✅ done          | `/external/alert-webhooks/railway` endpoint added in `apps/api/src/routes/alert-webhooks.routes.ts`. Severity mapping: DEPLOY_FAILED + CRASHED → p0; DEPLOY_REMOVED → p1. Token auth via `requireToken()`. Tested live in Railway dashboard (test webhook returns 401 as expected when token mismatches; real webhook authenticates + posts to Telegram).                                                                                    |
| **P2.1** Cart sync N+1 post-login                     | ✅ done          | Commit `1cf1ebfd`. New `POST /stores/:id/cart/sync` accepting up to 100 items in one transaction. Web client `CartContext` post-login migration switched from `Promise.allSettled(addToCart loop)` (5 round-trips) to single `api.syncCart` call (1 round-trip).                                                                                                                                                                             |
| **P2.2** loyalty-automation unbounded `findMany`      | ✅ done          | Commit `5863b9b0`. Both unbounded scans (birthday + expiration) replaced with cursor batching in pages of 500 (new `SCAN_BATCH_SIZE` constant). Birthday filter still runs in JS per page — Postgres `EXTRACT` not reachable through Prisma's typed API without raw SQL. Connection-pool budget now bounded regardless of member count.                                                                                                      |
| **P2-4** `as any` coercions masking ApiResponse drift | ✅ done          | Commit `1cf1ebfd`. Added `unwrapList<T>(value): T[]` + `unwrapObject<T>(value): T \| null` helpers to `apps/admin/src/lib/api.ts`. Replaced all 13 `as any` coercions in admin (seo + customers pages) and web (`api.ts` login csrfToken site fixed by widening the request generic instead). Zero `as any` remaining in `apps/admin/src` and `apps/web/src`. `apps/api` still has 26 — separate cleanup pass tracked.                       |
| **P2-5** ESLint `no-explicit-any` warn → error        | ✅ partial       | Commit `1cf1ebfd`. `@typescript-eslint/no-explicit-any` bumped to `"error"` in `apps/admin` + `apps/web` eslint configs (both at 0 `as any` after P2-4). `apps/api` stays at `"warn"` until the 26 API-side instances are cleaned. lint-staged ESLint hook intentionally NOT added — prior session documented per-workspace eslint configs conflict with root-level lint-staged invocation; CI `npm run lint --workspaces` enforces instead. |

**Audit follow-up extension (Ahmad-requested C → A → E → B → D → F sequence):**

| Track                                 | Outcome                                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C — Business documentation            | ✅ shipped. 6 docs reframed from SaaS tiers → agency-managed proposal model. Lessons in `feedback-agency-model-not-saas-reframe.md`.                                                                                                    |
| A — Self-serve signup flow            | ✅ descoped. Conflicts with the agency model (no public tier list, owner-led onboarding). Existing codebase was already consistent — only StorePlan badges in super-admin UI needed removal (commit `3afc477f`).                        |
| E — `apps/api` TypeScript strict mode | ✅ shipped. Commit `bd536c9a`. Audit estimated 3-5 days; actual was 30 minutes (3 errors, single-edit fixes). Lessons in `feedback-audit-overestimate-strict-mode.md`.                                                                  |
| B — Playwright frontend smoke         | ✅ shipped (= P1-3 above).                                                                                                                                                                                                              |
| D — CI hardening + smoke wiring       | ⏸ deferred (= P1-4 above).                                                                                                                                                                                                              |
| F — Multi-instance Railway scaling    | ⏸ deferred. Owner decision pending. Today's 1GB single-replica setup caps ~80 req/s + has 30-90s deploy outages. Worth doing when (a) onboarding 5+ merchants OR (b) deploy-window outage becomes a real complaint. ~$30-60/mo upgrade. |

**Carry-over items (next session / next audit cycle):**

1. Resolve GitHub Actions billing at `github.com/organizations/Whisky-11/settings/billing` → unblocks P1-4 (Track D)
2. Decide on Track F when merchant onboarding pipeline matures
3. Clean the 26 remaining `as any` instances in `apps/api/src`, then bump `@typescript-eslint/no-explicit-any` to `"error"` in `apps/api/eslint.config.mjs` for full P2-5 coverage
4. Run the next quarterly Iceberg Audit per the standing schedule in `~/.claude/CLAUDE.md`

**Net session outcome:** 11 of 13 explicit P0/P1/P2 items closed (8 P0+P1, 3 P2, 1 partial on P2-5). 1 P1 reclassified as audit misfire. 2 items deferred with owner-side blockers (CI billing, Railway scaling). Audit follow-up sequence (C/A/E/B/D/F) fully tracked.

### 🚨 P0 — Immediate

| #        | Risk                                                                                                                                                                                                                                                                                       | Slice        | Remediation effort                  | Cost impact |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------- | ----------- |
| **P0-1** | **Vercel Hobby commercial-use violation.** Platform processes payments on a $0 plan that explicitly forbids commercial use. Vercel can suspend `force-admin` and `force-web` without notice.                                                                                               | Cost / Infra | 5 min — upgrade to Pro              | $20/mo      |
| **P0-2** | **Divergent `apps/api/railway.json` exec-form trap.** Service-level file still uses broken `&&` shell-chain `startCommand`. If Railway ever resolves to it (config change / service re-link), all future deploys fail silently — three documented prior incidents from this exact pattern. | Infra        | 5 min — delete file or sync to root | $0          |
| **P0-3** | **Sentry sends raw `Authorization` + `Cookie` headers on every 5xx.** `sentry.service.ts:59` pipes `req.headers` as Sentry `extra`. Every 500 error leaks live JWTs to a third-party SaaS (Sentry). Tokens valid for 30 days (current default TTL).                                        | Security     | 10 min — 3-line destructure fix     | $0          |

### ⚠️ P1 — Within next sprint

| #        | Risk                                                                                                                                                                                                                                                                                       | Slice        | Remediation effort                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| **P1-1** | **8 tables missing RLS policies.** `blog_posts`, `store_faqs`, `store_howtos`, `product_faqs`, `ai_recommendation`, `bulk_ai_jobs`, `ai_usage`, `onesignal_subscriptions` are tenant-scoped in app code but have no DB-level backstop. A future query bug = silent cross-tenant data leak. | Database     | One migration adding ALTER TABLE + CREATE POLICY for all 8                                                 |
| **P1-2** | **2 active moderate CVEs in `uuid` + `exceljs` violate zero-tolerance CI gate.** Buffer-bounds CVE in uuid v3/v5/v6.                                                                                                                                                                       | Code Quality | Migrate `uuid` call sites to `crypto.randomUUID()` (Node 16+ built-in); override exceljs's transitive uuid |
| **P1-3** | **Zero frontend test coverage.** Admin (86 pages, 331 files) + storefront (37 pages, 238 files) have no tests. Checkout / auth / cart / admin CRUD regressions reach production undetected.                                                                                                | Code Quality | Playwright smoke tests for top 5 user journeys                                                             |
| **P1-4** | **CI integration + E2E marked `continue-on-error: true`.** Failing tests don't block pipeline or deployment. Broken auth / payment / multi-tenant isolation can pass CI green and deploy.                                                                                                  | Infra        | Remove `continue-on-error` lines; add retry-on-flake instead                                               |
| **P1-5** | **`bulk-import` Inngest function has `retries: 0`.** Transient Neon error or Railway restart leaves `BulkImportJob` row permanently `running`. Admin sees "import is running" indefinitely with no failure mark.                                                                           | Database     | `retries: 2` + catch block marks job `failed` on exhaustion                                                |
| **P1-6** | **`DIRECT_URL` not in fail-fast guard.** Required for Prisma migrate on Neon serverless. Missing in env = `preDeployCommand` migration fails silently.                                                                                                                                     | Infra        | Add to `getRequiredSecret` list in `config/index.ts`                                                       |
| **P1-7** | **`DEPLOYMENT.md` documents wrong infrastructure** (Cloudflare Pages + Supabase). Actual topology is Vercel + Neon. `docs/ROLLBACK.md` references stale `force-admin-seven` and `force-web-sigma` projects. Incident response will mislead.                                                | Infra        | Update both docs to canonical project names                                                                |
| **P1-8** | **No Railway build failure notification.** Railway builds fail silently, old container keeps serving, only new routes 404. CI mitigates for PR workflows but direct-to-main pushes race CI.                                                                                                | Infra        | Configure Railway → Project Settings → Notifications → Failed Deployment → Telegram webhook                |

### Combined remediation budget

| Tier                           | Total effort   | Calendar elapsed |
| ------------------------------ | -------------- | ---------------- |
| P0 (3 items)                   | ~20 min        | Same day         |
| P1 (8 items)                   | ~3–5 dev-days  | Within 1 sprint  |
| P2 (~25 items, see slice docs) | ~2–3 dev-weeks | Within 1 quarter |
| P3 (~15 items, see slice docs) | Ongoing        | As convenient    |

---

## SWOT Analysis

### Strengths

1. **AI-as-default with zero merchant cost.** 11+ live AI features (translation, SEO, AEO, FAQ generation, HowTo generation, review spam detection, review translation, owner-response drafting, category suggestion, smart-skip bulk sweeps) all powered by Gemini Flash Lite free tier. Shopify charges $20+/mo for AR translation alone — Ebda Store ships it built-in.

2. **Egypt-native payment stack as first-party integration.** Tap / MyFatoorah / Hesabe / UPayments with KNET support — per-store credential storage, AES-GCM encrypted. Salla is Saudi-first (Mada/STC Pay) with no KNET; Shopify Egypt requires third-party gateway plugins.

3. **Arabic-first data model, not Arabic-as-afterthought.** Bilingual fields on every entity (name/nameAr, description/descriptionAr, metaTitle/metaTitleAr, etc.). RTL admin. Arabic-locale search hits both `name` and `nameAr` columns. Structural — hard to retrofit on competitors' platforms.

4. **Full Chart-of-Accounts accounting inside the platform.** Finance hub with journal entries, expense management, P&L reports, two-step expense approval. SMBs typically pay separately for QuickBooks. 15 accounting tables in schema.

5. **AEO/GEO architecture (7-layer).** Schema.org JSON-LD on every page type (Store + Product + AggregateRating + Review + FAQPage + HowTo + BreadcrumbList + ItemList), dynamic `/llms.txt` per llmstxt.org spec, AI bulk-fill for AEO content. No Egypt competitor has this.

6. **Multi-tenant operator economics.** One codebase serves N merchants. Platform improvements (new AI feature, new theme flag, security fix) reach all merchants simultaneously — no per-merchant upgrade work. Unusual at this market tier.

7. **Excellent operational hygiene.** Per-commit Neon snapshot branches, 5-channel observability stack, Axiom log drain (30-day retention verified), `docs/ROLLBACK.md` with 3 documented paths, gitleaks+TruffleHog+secretlint triple secret scanning, zero TODO comments in source code.

8. **Service layer architecture.** Clean service-per-domain pattern, no business logic in routes. `AppError` class with discriminated log levels (4xx → debug, 5xx → error). Pino structured logging. 30 Inngest functions for everything `>300ms` or third-party.

### Weaknesses

1. **No self-serve signup or public pricing.** Schema has `StorePlan` enum (free/starter/professional/enterprise) and `StoreFeature` model wired for billing, but no checkout flow exists. Growth capped at what Ebda AI Studio agency can close manually.

2. **Limited theme variety.** 5 themes vs Shopify's 100+ (most paid $150–350). Merchants outside modern/elegant/classic/minimal/bold aesthetics have no native option.

3. **No app marketplace.** Shopify's ~8,000-app ecosystem is a major retention driver. Ebda Store has no third-party integration marketplace — every integration must be first-party.

4. **Single Railway instance bottleneck (~190 req/s sustained).** Documented load-test ceiling. One viral merchant can degrade performance for all tenants. Vertical scale = Railway Pro; horizontal = architectural changes.

5. **`apps/api` running `strict: false`.** Most security-critical layer (206 files of payment/auth/order logic) opts out of TypeScript strict mode. 27 `as any` escapes in admin pages indicate ApiResponse type drift.

6. **Zero frontend test coverage.** 53 test files all in root `tests/`. Admin (86 pages) + storefront (37 pages) have no tests. Any frontend regression reaches production undetected.

7. **3 experimental features with no backing code** (`customer_wallet`, `email_campaigns`, `staff_accounts`). `hidden: true` in feature registry. Absence of multi-staff accounts limits appeal to merchants with teams.

8. **Vercel Hobby commercial-use violation.** Live legal/operational risk — Vercel can suspend without notice (see P0-1).

### Opportunities

1. **Self-serve signup flow.** Schema is ready (StorePlan, StoreFeature). Wiring a checkout — say MyFatoorah or Tap for subscription billing — turns the platform from agency-managed to product-led growth. Unlock 10× → 100× merchant count without proportional sales effort.

2. **Per-merchant tier monetization.** 6 `addon` features (loyalty, WhatsApp, floating_widget, affiliate, upsell_crosssell, sms, push_notifications) are natural paid-tier candidates. None currently connected to billing.

3. **GCC regional expansion.** Egypt-native payment stack already deployed. Adding Mada (Saudi), Benefit (Bahrain), Knet-equivalents in UAE/Oman would unlock 10×+ TAM. Bilingual data model already supports it.

4. **AI feature monetization.** AI features currently free-tier-capped (`AI_DAILY_REQUEST_CAP=1000`). A paid tier with higher quota at $5–15/store/month would have ~95% gross margin (Gemini Flash Lite paid is $0.10/1M input / $0.40/1M output).

5. **WBS WhatsApp bridge cross-product synergy.** Ebda AI Studio also owns WhatsApp Business Sender (WBS). Bundling Ebda Store + WBS as a unified offer creates a network effect — every Ebda Store merchant becomes a WBS prospect and vice versa.

6. **App marketplace.** Even a small (10–20 apps) marketplace would shift positioning from "another e-commerce platform" to "Egypt's e-commerce platform of choice." Apps would primarily be Egypt-specific integrations (delivery providers, KNET wallet apps, local logistics).

7. **Theme marketplace.** 5 themes is a constraint. A community/paid theme marketplace would broaden appeal and unlock another revenue stream.

8. **Acquisition target for regional players.** Salla, Zid, or careem could plausibly acquire Ebda Store to enter Egypt with a turnkey platform + existing Egypt merchant relationships. The Ebda AI Studio brand + WBS bridge are particular acquisition synergies.

### Threats

1. **Gemini pricing changes.** AI moat depends on free-tier economics. Google has reduced Gemini free-tier limits before (December 2025 reduction noted). A further reduction or price hike compresses margins.

2. **Salla / Zid entering Egypt with native KNET.** The Egypt payment stack moat depends on competitors NOT integrating KNET. If a regional player closes the gap (relatively easy contractually), the moat shrinks rapidly.

3. **Vercel TOS enforcement.** Hobby plan suspension is a live risk until upgrade (P0-1). Even after upgrade, Vercel's per-tenant custom-domain pricing could shift unfavorably at scale.

4. **Single-instance Railway availability ceiling.** A single viral merchant or DDoS event can take down the platform for all tenants. Without horizontal scale, the platform's reliability story is brittle as merchant count grows.

5. **Gemini regulatory restrictions in Egypt.** AI regulation in MENA is evolving (Saudi PDPL, UAE AI office). If Egypt introduces AI-feature labeling requirements or data residency rules, the bulk-AI approach may need adjustment.

6. **Shopify or Wix doubling down on AR translation.** Both have the resources to ship AR + AEO features that match Ebda Store's AI offering. The 12–18 month moat on AI features could compress if a major incumbent prioritizes.

7. **Egypt e-commerce TAM is small** (~$3–5B GMV total). Realistic merchant count ceiling for Egypt alone is ~10–20k SMBs. GCC expansion is necessary for venture-scale outcomes.

8. **Key-person dependency.** Codebase reflects a single primary developer (Ahmad Sharaf). Memory files reference "Ahmad's standing rule" 50+ times. Documentation is comprehensive but operational knowledge concentrated. Bus-factor risk for an acquirer.

---

## Forecast Summary

### Per-Service Cost at Each Scale

| Service           | Idle today          | 10k MAU     | 100k MAU            | Breaks first at burst                            |
| ----------------- | ------------------- | ----------- | ------------------- | ------------------------------------------------ |
| Vercel            | $20 (Pro mandatory) | $20         | $30–60              | Image transforms at 100k                         |
| Railway           | $6                  | $16         | $64                 | **190 req/s ceiling — single store viral**       |
| Neon              | $0                  | $17         | $72–142             | Branch cap (10)                                  |
| Cloudflare R2     | $0                  | $0          | $10                 | Class B ops if CDN cache cold                    |
| Sentry            | $0                  | $0          | $26                 | Error volume at 100k                             |
| Resend            | $0                  | $29         | $515                | **100 emails/day free cap (binding constraint)** |
| OneSignal         | $0                  | $0          | $79                 | 10K subscriber send cap                          |
| Inngest           | $0                  | $75         | $175                | Bulk AI sweeps exhaust 50K free steps            |
| Gemini Flash Lite | $0                  | $2          | $63                 | 15 RPM + 1K RPD free cap                         |
| GitHub Actions    | $0                  | $12         | $25                 | —                                                |
| Domains           | $2.50               | $2.50       | $2.50               | —                                                |
| **Total**         | **$26/mo**          | **$171/mo** | **$1,074–1,144/mo** | —                                                |

### Visitor Burst Scenarios

**Scenario A: 10,000 unique visitors in 1 hour on a single store.**

- Average ~14 req/s, burst ~70 req/s.
- Cache-warm path: handles comfortably within current 190 req/s Railway ceiling.
- **Single point of failure: cold Redis cache.** A Railway deploy or restart in the hour before the burst = all reads fall through to Neon, Prisma connection pool exhausts.
- **Mitigation: pre-warm strategy** + `connection_limit=25` in DATABASE_URL.
- **Cost spike: ~$0.31 one-off** (negligible).
- **Verdict:** survivable today with pre-warm; brittle without.

**Scenario B: 100,000 unique visitors in 1 hour across the platform.**

- Average ~139 req/s, burst ~694 req/s.
- **Railway single instance overwhelmed within 3–5 minutes.** Container restarts. Cascade:
  1. Railway API down (190 req/s ceiling × 3–4 overrun)
  2. Redis disconnect storm during Railway restart
  3. Neon connection pool exhausts (100 concurrent default)
  4. Vercel SSR functions timeout (10s default) — pages 502/504
  5. Inngest queue depth → 2,000-step backlog at free-tier 5 concurrent
  6. Resend 100/day cap hit in 30 min → silent email failures
  7. Gemini 15 RPM cap → any concurrent AI sweep 429s
- **Required pre-scaling:** Railway Pro + 4 replicas, Neon Scale + connection_limit tuning, Inngest Pro, Resend Pro, Redis fallback strategy.
- **Cost spike: ~$5–20 one-off if pre-scaled** (modest).
- **Verdict: WITHOUT pre-scaling, platform-wide outage. WITH pre-scaling, $200–400/mo extra ongoing cost.**

### 12-Month Cost Trajectory

Linear growth from 1k MAU (today) to 10k MAU over 12 months:

- Months 1–3: $36–54/mo (free tiers absorb everything)
- Months 4–6: **$137–150/mo** (Inngest cliff at M4 — bulk AI features hit 50K free-step cap)
- Months 7–12: $159–177/mo (steady-state)
- **12-month cumulative: $1,577**

### Per-Merchant Economics

| Scale                      | Infra cost | Per merchant | Min SaaS price for 70% margin | Realistic SaaS price |
| -------------------------- | ---------- | ------------ | ----------------------------- | -------------------- |
| 10k MAU / 100 merchants    | $171/mo    | $1.71/mo     | $2.44/mo                      | $15–30/mo            |
| 100k MAU / 1,000 merchants | $1,100/mo  | $1.10/mo     | $3.67/mo                      | $49–99/mo            |

**Egypt market calibration:** Shopify is $29–79/mo. Salla is 25–99 EGP/mo ($80–320). Ebda Store cost structure comfortably supports a **29–49 EGP/mo ($95–160)** price point with 70%+ gross margins at 100k MAU.

---

## Acquisition Due-Diligence Checklist

For a buyer evaluating Ebda Store:

### Pre-deal (must verify before signing)

- [ ] **Vercel Hobby commercial-use violation** — confirm upgrade to Pro happened (P0-1)
- [ ] **Source code IP ownership** — confirm `license: UNLICENSED` and that Ahmad Sharaf holds all copyright (no third-party contributors with claims)
- [ ] **Egypt payment provider contracts** — confirm Tap, MyFatoorah, Hesabe, UPayments accounts are in Ebda AI Studio's name (not Ahmad personally), or that they transfer with the asset
- [ ] **Vercel + Railway + Neon + R2 + Inngest accounts** — confirm asset transfer mechanism (sub-org transfer vs new accounts)
- [ ] **Trademark status** — "Ebda Store" / "Ebda AI Studio" / "Ebda AI Studio" Egypt trademark registration
- [ ] **Live merchant contracts** — Wady Aljuz and demo-boutique — confirm contract terms transfer with platform sale
- [ ] **Gemini API key + Google Cloud account** — transferable? Tied to Ahmad's personal Google account?
- [ ] **GitHub repo ownership** — `Whisky-11` org membership + admin rights
- [ ] **Domain ownership** — ebda.app registrar account

### Technical due diligence (during negotiation)

- [ ] **Read all 6 audit slice docs** in `docs/audits/_slices/` for file:line evidence on every finding
- [ ] **Verify P0/P1 remediation plan** — request 4-week patch plan with timeline
- [ ] **RLS coverage gap (P1-1)** — request the migration adding RLS to 8 missing tables
- [ ] **CVE remediation (P1-2)** — request `npm audit` showing 0 vulnerabilities at every severity
- [ ] **Frontend test backlog (P1-3)** — agree on minimum viable smoke test coverage as condition of closing
- [ ] **Single-instance Railway** — discuss horizontal-scale architecture plan
- [ ] **Bus factor** — request 2-week handoff plan with code walkthrough sessions

### Post-deal (first 90 days)

- [ ] **Sentry account audit** — purge historical Sentry events containing leaked Authorization headers (P0-3 historic leak)
- [ ] **JWT rotation** — rotate `JWT_SECRET` after first auth-token expiry window (force re-login)
- [ ] **Self-serve signup flow** — top priority for revenue unlock
- [ ] **Per-tier monetization wiring** — connect addon features to billing
- [ ] **Strict mode on `apps/api`** — quarterly migration
- [ ] **Test coverage ramp** — 30% → 60% → 80% over 4 quarters
- [ ] **Multi-instance Railway / scaling architecture** — design for 10k+ MAU before reaching it

---

## Final Verdict

**This is a production-grade SaaS with a 12–24 month head start in the Egypt/GCC market** and a small but real list of fixable issues. The architecture choices reflect deep operational experience — RLS, Inngest async queue, custom Redis TTL ESLint rules, per-commit Neon snapshots, 5-channel observability — that signal a builder who has been burned by production incidents before and built guardrails accordingly.

The codebase is **ready for an acquirer who plans to professionalize the operations layer** (self-serve signup, multi-instance scaling, frontend tests, strict mode) while preserving the architectural foundation. It is **not ready** for an acquirer who wants to operate the platform as-is at 100k MAU without architectural investment.

**Best-fit acquirer profiles:**

1. **Regional e-commerce platform** (Salla, Zid, careem) wanting Egypt market entry with existing merchant relationships + a Egypt-native payment stack
2. **GCC fintech / payment processor** (Tap, MyFatoorah, PayTabs parent) wanting forward-integration into merchant tooling
3. **Saudi/UAE PE fund** looking for a "Salla for Egypt" play with eventual GCC expansion

**Estimated valuation framework:** Pre-revenue / low-revenue, valued primarily on:

- Codebase replacement cost (~$200–400K dev-equivalent if rebuilt from scratch)
- Strategic optionality (Egypt market head start premium)
- AI feature moat (12–18 month durability)
- Multi-tenant operator architecture (enables scale)

Realistic strategic-acquirer range: **$300K–$800K USD** depending on deal structure and earn-out. Higher if combined with WBS as a bundle.

---

## Audit slice documents

The full per-slice findings (with file:line citations on every claim) live in:

- [`_slices/01-security-compliance.md`](_slices/01-security-compliance.md) — Security & Compliance (10 sub-domains, 60+ findings)
- [`_slices/02-database-performance.md`](_slices/02-database-performance.md) — Database & Performance (10 sub-domains, 50+ findings)
- [`_slices/03-infrastructure-devops.md`](_slices/03-infrastructure-devops.md) — Infrastructure & DevOps (12 sub-domains, 50+ findings)
- [`_slices/04-code-quality.md`](_slices/04-code-quality.md) — Code Quality & Architecture (10 sub-domains, 40+ findings)
- [`_slices/05-business-features.md`](_slices/05-business-features.md) — Business Features & Competitive Positioning (8 sub-domains, 22-feature inventory, competitive matrix)
- [`_slices/06-cost-forecast.md`](_slices/06-cost-forecast.md) — Cost Forecast & Scaling (12 services, 4 scenarios, bottleneck cascade, 12-month trajectory)

**Audit metadata:**

- Conducted: 2026-05-22
- Approach: 6 parallel Sonnet subagents on independent audit slices, then main-session synthesis
- Lines of source code reviewed: ~250K LOC across 1,158 tracked files
- Findings cited with file:line where possible — every claim is verifiable
- Methodology basis: CLAUDE.md project rules + the 38-term Iceberg Audit framework (`reference-iceberg-audit.md`) + standard SaaS due-diligence checklists
