# Ebda Store - Production Deployment Guide

> **2026-11-10 update:** the Railway API, Neon, the Axiom log drain and UptimeRobot named in older sections below are retired (Postgres retired 2026-11-05). Today: every app is a Cloudflare Worker, data is D1 + Durable Objects + R2, logs are Workers Logs + Logpush to R2 `ebda-logs` (section 7), availability is probed by status.ebda.app with Telegram alerts. Incident triage: `docs/INCIDENT.md`; escalation: `docs/ops/escalation.md`.

> **2026-05-22 update:** prior versions of this doc described a Cloudflare Pages + Supabase topology that was never the production state. The canonical production stack is below. The old doc misled incident responders during the 2026-05-22 audit (P1-7).
>
> **2026-07-05 update:** `apps/web`, `apps/admin`, and `apps/orders` have since fully MIGRATED off Vercel to **Cloudflare Workers** (OpenNext, deployed by GitHub Actions via `wrangler deploy` (Ebda: only the API workflow `.github/workflows/cf-api-deploy.yml` exists, manual `workflow_dispatch` on `main`; there is no `cf-deploy.yml` for web/admin/orders yet) — `ebda-web` / `ebda-admin` / `ebda-orders`, serving `store.ebda.app` / `store.ebda.app` / `orders.ebda.app`). The old Vercel projects (`force-admin`, `force-web`, `force-orders`) are decommissioned. Steps below that reference Vercel setup/rollback are kept for history where useful but no longer reflect where to actually deploy — see `docs/migration/cloudflare-ci-deploy.md` and `docs/migration/cloudflare-cutover-runbook.md` for the current procedure.

## CI gate

This project runs two complementary gates:

**Server-side (GitHub Actions):** `.github/workflows/ci.yml` runs lint + typecheck + unit tests + integration tests on every push and PR. GitHub Actions billing was suspended briefly in early 2026 but has been active since 2026-05-22.

**Local pre-push gate:** `.husky/pre-push` runs lint + 3x typecheck (api/admin/web) + unit tests (497 tests) on every `git push`, blocking the push on failure. This catches most issues locally before burning runner minutes.

- `TEST_DATABASE_URL` is set to a safe placeholder in the hook so `vitest setup-e2e.ts` prod-guard passes cleanly; unit tests mock Prisma and make no real DB calls

**Test gate scope (local):** lint + 3x typecheck + 497 unit tests (~4s)

To run the full gate manually: `npm run lint`, then `npm run typecheck` and `npm run test:unit` (scripts/safe-deploy.sh was removed in NEON-ZERO: it targeted the retired Railway deploy).

**AI-output eval harness** (branch `feat/ai-output-eval-harness`, not yet merged to `main` as of this writing — currently in CI): `apps/api/src/lib/ai/eval/` adds a QA layer across all 21 distinct AI generator output types (product FAQs/excerpts/alt-text/category+tag suggestions, translation, SEO meta, section copy, description balancing, AEO/GEO content, product recommendations, review tools). Deterministic checks (`tests/unit/ai-eval-*.test.ts` — schema validity, bilingual field presence, length bounds, script correctness, near-duplication, numeric-spec-invention guard) run on every push as part of the normal unit-test job. A separate model-as-judge layer (`.github/workflows/ai-eval-nightly.yml`, real Gemini calls scoring grounding/relevance/duplication/tone) runs nightly at 2:30am UTC (or on-demand via `workflow_dispatch`) — deliberately kept off the per-push gate since it costs Gemini quota and is non-deterministic. Internal QA tooling, not merchant-facing.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│              CLOUDFLARE WORKERS (GitHub Actions, wrangler deploy)│
│  ┌──────────────────────────┐  ┌──────────────────────────┐      │
│  │ ebda-admin   │  │ ebda-web     │      │
│  │  store.ebda.app       │  │  store.ebda.app       │      │
│  │                          │  │  + per-tenant domains    │      │
│  └──────────────────────────┘  │  (demo-merchant.com, ...)    │      │
│  ┌──────────────────────────┐  └──────────────────────────┘      │
│  │ ebda-orders  │                                    │
│  │  orders.ebda.app      │                                    │
│  └──────────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ HTTPS, credentials:include
┌──────────────────────────────────────────────────────────────────┐
│                      RAILWAY (~$10-20/mo)                        │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Express.js API (Dockerfile.api, builder=DOCKERFILE)       │    │
│  │  api.ebda.app (old: api.ebda.app)       │    │
│  │  + Redis (railway internal :6379)                        │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                     │                  │                  │
                     ▼                  ▼                  ▼
┌──────────────────────────┐  ┌─────────────────┐  ┌──────────────┐
│ NEON Launch (~$17-150/mo) │  │ CLOUDFLARE R2   │  │ CF WORKFLOWS │
│ PostgreSQL serverless     │  │ (per-tenant     │  │ + QUEUES     │
│ 83 models, RLS-backed     │  │  media storage) │  │              │
│ daily local pg_dump       │  │  *.r2.dev       │  │              │
└──────────────────────────┘  └─────────────────┘  └──────────────┘

Estimated Monthly Cost (current scale): ~$26/mo
   See docs/audits/2026-05-22-comprehensive-saas-audit.md §6 for the
   full per-service forecast at 10k MAU ($170/mo) and 100k MAU ($1,100/mo).
```

---

## Step 1: Railway Setup (API Server)

> **Note:** this is the original manual dashboard walkthrough for a from-scratch Railway project. The actual production build/start config is defined by the root `railway.json` (`builder: DOCKERFILE`, `dockerfilePath: Dockerfile.api`, `startCommand: node apps/api/dist/index.js`) — Railway reads that file automatically once linked, so most of the "1.3 Configure Service" table below is superseded by `railway.json` rather than the dashboard fields. Kept for onboarding a fresh Railway project from zero.

### 1.1 Create Railway Account

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub (recommended for auto-deploy)

### 1.2 Create New Project

1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose `Ebda-AI-Studio/ebda-store`
4. Select the `main` branch

### 1.3 Configure Service

Railway will auto-detect the monorepo. Configure:

| Setting        | Value                          |
| -------------- | ------------------------------ |
| Root Directory | `apps/api`                     |
| Build Command  | `npm install && npm run build` |
| Start Command  | `npm run start`                |
| Watch Paths    | `apps/api/**`, `packages/**`   |

### 1.4 Add Environment Variables

In Railway dashboard → Variables, add:

```
NODE_ENV=production
API_PORT=4000
API_HOST=0.0.0.0

# Database (Neon Postgres)
DATABASE_URL=postgres://neondb_owner:password@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?pgbouncer=true&connect_timeout=15
DIRECT_URL=postgres://neondb_owner:password@ep-xxx.ap-southeast-1.aws.neon.tech/neondb

# Authentication
JWT_SECRET=<generate-64-char-secret>
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=30d
ENCRYPTION_KEY=<generate-32-char-key>

# URLs
WEB_URL=https://store.yourdomain.com
ADMIN_URL=https://admin.yourdomain.com

# Payment (Tap)
TAP_API_KEY=sk_live_xxx
PAYMENT_TEST_MODE=false
DEFAULT_CURRENCY=EGP

# Storage (R2)
STORAGE_ENDPOINT=https://xxx.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY=xxx
STORAGE_SECRET_KEY=xxx
STORAGE_BUCKET=force-uploads
STORAGE_PUBLIC_URL=https://cdn.yourdomain.com

# Email
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASSWORD=re_xxx
SMTP_FROM_EMAIL=noreply@yourdomain.com
```

### 1.5 Add Custom Domain

1. Go to Settings → Domains
2. Add `api.yourdomain.com`
3. Add the CNAME record to your DNS

---

## Step 2: Cloudflare Workers Setup (Web, Admin & Orders)

> ⚠️ **NOTE (updated 2026-07-05):** Production storefront, admin, and orders PWA run on **Cloudflare Workers** (OpenNext), NOT Vercel. Worker names: `ebda-admin` (`store.ebda.app`), `ebda-web` (`store.ebda.app` + per-tenant custom domains), `ebda-orders` (`orders.ebda.app`). The Vercel projects that previously hosted these apps are decommissioned.

**Ebda status (2026-10-07):** all four Workers deploy from GitHub Actions on `ubuntu-latest`, `environment: production`, `main` only. `cf-api-deploy.yml` (`push:main` on API paths since 2026-10-25, plus manual `workflow_dispatch`) deploys `ebda-api`; `cf-admin-deploy.yml`, `cf-web-deploy.yml` and `cf-orders-deploy.yml` deploy `ebda-admin` (`store.ebda.app`), `ebda-web` (every `<slug>.ebda.app` store) and `ebda-orders` (`orders.ebda.app`) on a push to `main` touching their app (or `packages/shared`, `packages/ui`, the lockfile, the CF scripts), or by `workflow_dispatch`. Each one: `npm ci` → route tests → `scripts/cf-setup-local.sh <app>` (routes from BRAND via `scripts/cf-routes.cjs`; web with `OPENNEXT_CACHE=true` on R2 bucket `ebda-web-isr-cache` + DO tag cache) → `scripts/cf-build.sh <app>` with the `NEXT_PUBLIC_*` build env → required Worker secrets check (web: `REVALIDATE_SECRET`) → `wrangler deploy` → POLL until `/_next/static/<BUILD_ID>/_buildManifest.js` (exists only in this build) is 200 and the probe page answers (admin `/signup` 200, orders `/login` 200, web an unknown store host 404). The first deploy of all three was run locally from the same build on 2026-10-07. The Ebda Store `cf-deploy.yml` described below does not exist in this repo.

### Deploy safety (Rulings DEPLOY-SAFETY-1..5, 2026-10-08)

Two gates exist because a Worker that throws only on workerd (`Prisma.dmmf`, 2026-10-08, error 1101 on every request for ~4 minutes) passes every Node test.

1. **Refuse to deploy a Worker that cannot boot.** `scripts/ci/workerd-smoke.sh` boots the API Worker with `wrangler dev --local` and a local D1 (no Postgres since NEON-ZERO N-17) and requires `/health` 200, a directory row still flagged `pg` 410, an unknown store 404 and an unknown route 404, with no 5xx. It runs as the `api-workerd-smoke` job on every PR and in `cf-api-deploy.yml` before the deploy. Locally: `bash scripts/ci/workerd-smoke.sh` (needs the packages built: `npm run db:generate && npm run build -w packages/shared -w packages/database`). No storefront smoke yet (DEPLOY-SAFETY-4a). The same PR job then runs `npm run cf:test -w apps/api -- workers-test/embedding-provider.test.ts`: the search embedding provider inside workerd with `SEARCH_SEMANTIC_ENABLED=true` and a fake `AI` binding, because the smoke strips that binding (search Task 11 review M8).
2. **Roll back automatically when production health fails.** Each deploy workflow records the live version (`node scripts/ci/deploy-guard.mjs previous --name <worker>`), deploys, then `deploy-guard.mjs verify` polls its probes (api: `/health` on this commit + an unknown-store 404; web: this build's manifest + the unknown-store host 404; admin: manifest + `/signup` + `/login`; orders: manifest + `/login`; marketing: `/` + `/sitemap.xml`). On failure it runs `wrangler rollback <recorded version> --yes`, polls again to confirm the old version serves, and fails the job: exit 1 = rolled back and serving, exit 2 = NOT confirmed restored (act now). Tests: `tests/unit/deploy-guard.test.ts`, `tests/unit/workerd-smoke.test.ts`.
3. **A code rollback does not undo migrations.** The API migrates production first, so migrations stay expand-then-contract (CF-MIGRATE-1); the rollback path prints this warning. After an auto-rollback, fix forward on `main` and redeploy (run history cannot see the rollback).

### Storefront wildcard and the ebda.app route table

Zone routes run BEFORE Workers custom domains, so the storefront's `*.ebda.app/*` route would catch every subdomain that has no more-specific route. Current table (verify with `GET /zones/<zone>/workers/routes` + `GET /accounts/<acct>/workers/domains`):

| Host                                  | Served by                                 | How                                                                                                                                  |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ebda.app` (apex)                     | `ebda-marketing`                          | custom domain; `*.ebda.app/*` does not match the bare apex                                                                           |
| `api.ebda.app`                        | `ebda-api`                                | `api.ebda.app/*` route + custom domain                                                                                               |
| `store.ebda.app` / `orders.ebda.app`  | `ebda-admin` / `ebda-orders`              | custom domain + `<host>/*` route (the route beats the wildcard)                                                                      |
| `help.` / `docs.` / `status.ebda.app` | `ebda-help` / `ebda-docs` / `ebda-status` | custom domain + `<host>/*` route (the route beats the wildcard; a custom domain alone returns the storefront's 404, seen 2026-10-24) |
| `admin.ebda.app` (retired)            | nothing (`ebda-web` 404)                  | HOST-STORE-1: no custom domain, no route; the wildcard reaches `ebda-web`, `admin` is a reserved slug → plain 404                    |
| `media.ebda.app`                      | R2 `ebda-media`                           | R2 custom domain + a **Worker-less** `media.ebda.app/*` route (exclusion)                                                            |
| `<slug>.ebda.app`                     | `ebda-web`                                | `*.ebda.app/*` route + a proxied wildcard DNS record `*`                                                                             |

Any NEW subdomain served by something other than the storefront needs either its own Worker route or a Worker-less exclusion route (`POST /zones/<zone>/workers/routes {"pattern":"<host>/*"}` with no `script`) — otherwise the storefront answers it with store-not-found. Wildcard DNS: `A * 192.0.2.0 proxied` (originless; explicit records still win). The Cloudflare-for-SaaS `*/*` fallback route inherited from Ebda Store is deliberately NOT used — it would also capture the marketing apex; merchant custom domains need it (or a dedicated fallback-origin host) when that feature ships (Ruling EBDA-DEPLOY-1).

**A `*.ebda.app` host that is not a live store** (a mistyped or never-opened slug such as `demostore.ebda.app`, an archived/draft store, an unenrolled custom domain, an unknown path on the bare platform host) is answered by `ebda-web` with ONE Ebda-branded 404 page: HTTP 404, no redirect, Arabic by default. It is chosen in `apps/web/src/app/not-found.tsx` by `notFoundKind()` (`apps/web/src/lib/unknown-store-page.ts`): a request whose Host named a store AND resolved keeps that store's own themed 404 (`StoreNotFound`); everything else renders `UnknownHostNotFound`. A suspended store still resolves, so it keeps its own maintenance page. Reserved labels (`api`, `store`, `orders`, `www`, ...) never reach it: `middleware.ts` 404s them as plain text first. CTAs: "اعمل متجرك على إبدأ" to `https://ebda.app`; WhatsApp from `BRAND.contact.whatsapp` (omitted if empty); "جرّب المتجر التجريبي" to `https://storedemo.ebda.app` only when the `ebda-web` Worker var `SHOW_DEMO_STORE_LINK` is exactly `true` (default off; the repo variable `SHOW_DEMO_STORE_LINK` feeds it through `cf-web-deploy.yml`; ON since 2026-10-22 now the demo store is live). Ruling SUBDOMAIN-404-1. Tests: `tests/unit/unknown-store-not-found.test.tsx`.

---

## Step 3: Cloudflare R2 Setup (File Storage)

### 3.1 Create R2 Bucket

1. Go to **R2 Object Storage**
2. Click **Create bucket**
3. Name: `force-uploads`
4. Location: Choose closest to your users

### 3.2 Create API Token

1. Go to **R2** → **Manage R2 API Tokens**
2. Create token with:
   - Permission: Object Read & Write
   - Bucket: `force-uploads`
3. Save the Access Key ID and Secret Access Key

### 3.3 Enable Public Access (CDN)

1. Go to bucket → Settings
2. Enable **Public access**
3. Add custom domain: `cdn.yourdomain.com`

### 3.4 CORS Configuration

Add CORS rules:

```json
[
  {
    "AllowedOrigins": ["https://store.yourdomain.com", "https://admin.yourdomain.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## Step 4: Neon Postgres

> ⚠️ **NOTE:** Production DB is **Neon Postgres** (serverless), not Supabase. RLS is implemented via `runInTenantContext` AsyncLocalStorage + 83 ENABLE ROW LEVEL SECURITY tables.

Use the connection strings from your Neon project dashboard:

- `DATABASE_URL` — pooled URL (PgBouncer, port 5432, `?pgbouncer=true`)
- `DIRECT_URL` — direct (non-pooled) URL required for Prisma migrations

Backups: daily local `pg_dump` runs on the developer Mac at 3:30am via launchd (`com.ebda.neon-backup`). 30-day rotation at `~/Desktop/projects/_backups/ebda/` (requires `NEON_API_KEY_EBDA` in `~/.whisky-services.env`). See `docs/ROLLBACK.md` §C for the restore procedure.

---

## Step 5: DNS Configuration

Add these records to your domain:

| Type  | Name   | Value                   | Notes                                                                                                                                                                                                                                                      |
| ----- | ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | \*     | 192.0.2.0 (proxied)     | Storefront wildcard → `ebda-web` via the `*.ebda.app/*` route                                                                                                                                                                                              |
| —     | admin  | (Worker route)          | Cloudflare Worker `ebda-admin` custom domain                                                                                                                                                                                                               |
| —     | orders | (Worker route)          | Cloudflare Worker `ebda-orders` custom domain                                                                                                                                                                                                              |
| CNAME | api    | your-app.up.railway.app | Railway API — Cloudflare-PROXIED (verified live 2026-09-02: responses carry `server: cloudflare` + `cf-ray`; `cf-cache-status: DYNAMIC`, i.e. CF forwards but does not cache JSON without an explicit cache rule). The old "no proxy" note here was stale. |
| CNAME | cdn    | pub-xxx.r2.dev          | Cloudflare R2 public bucket (`*.r2.dev`)                                                                                                                                                                                                                   |

Custom domains for per-tenant storefronts are auto-registered via `apps/api/src/services/cloudflare-domain.service.ts` (Cloudflare-for-SaaS Custom Hostnames — see `docs/migration/cloudflare-cutover-runbook.md`) — merchants add their domain in the admin UI and the API provisions it automatically.

---

## Step 6: Post-Deployment Checklist

### Security

- [ ] Generate strong JWT_SECRET (64+ chars)
- [ ] Generate strong ENCRYPTION_KEY (32 chars)
- [ ] Enable 2FA on all service accounts
- [ ] Set up Cloudflare WAF rules

### Monitoring

- [ ] Set up Sentry for error tracking (SENTRY_DSN on Railway + NEXT_PUBLIC_SENTRY_DSN_ADMIN/WEB/ORDERS as GitHub Actions repo variables at build time)
- [ ] Add the `SENTRY_AUTH_TOKEN` repo secret (+ `SENTRY_ORG` / `SENTRY_PROJECT_{WEB,ADMIN,ORDERS}` repo variables) — `cf-deploy.yml` already passes them to the web/admin/orders builds; see docs/ENVIRONMENT.md "Sentry build-time config" (optional — deploys succeed without it, just with minified stack traces)
- [ ] Enable Railway metrics alerts
- [ ] Confirm Neon compute usage alerts are configured in the Neon dashboard

### Payment Providers

- [ ] Switch each payment provider (Paymob, Kashier, Fawry) to live keys
- [ ] Register each provider's webhook URL (`https://api.yourdomain.com/api/v1/webhooks/payment/<provider>`)

### Email

- [ ] Verify sender domain with email provider
- [ ] Test transactional emails

---

## Deployment Commands

### Deploy API (Railway)

```bash
# Railway auto-deploys on git push
git push origin main
```

### Deploy Web/Admin/Orders (Cloudflare Workers)

```bash
# cf-{web,admin,orders}-deploy.yml deploy each app on a push to main touching it
git push origin main
# or: gh workflow run cf-admin-deploy.yml --ref main
```

### Manual Database Migration

```bash
cd packages/database
npx prisma migrate deploy
```

**Naming a new migration (Ruling MIG-ORD-1, CI-enforced).** A new folder's 14-digit timestamp must
sort strictly after the newest migration on `main`, and must not be shared with any other folder.
CI's `Lint` job runs `node scripts/check-migration-order.mjs --fetch --base origin/main` and fails the PR
otherwise; run it locally before pushing (`--fetch` never makes a local repo shallow — `--depth` is used only inside GitHub Actions). If `main` gained a newer migration while your PR was open,
rename your folder to a later timestamp (it has not been applied anywhere yet). The gate has two
arms (issue 2355): on a PR it compares against current `origin/main`; on a push to `main` it compares
against the pre-push tip (`github.event.before`, fetched by sha), which catches two PRs that each
passed against the same old main and then both merged — main goes red on the second merge. That arm
detects after the fact (the Railway deploy on the same push has usually applied the folder already);
prevention is branch protection's "require branches to be up to date". The two collisions
already applied in production (`20260615000000_*`, `20260925160000_*`) are allow-listed in the script
and cannot be renamed.

---

## Rollback Procedures

### Railway

1. Go to Deployments
2. Find previous working deployment
3. Click "Rollback"

### Cloudflare Workers (Web, Admin & Orders)

1. `bash scripts/rollback.sh` (git revert + push) re-triggers `cf-{web,admin,orders}-deploy.yml`, redeploying the reverted build to `ebda-web` / `ebda-admin` / `ebda-orders`.
2. To roll back a single Worker without a code revert: `wrangler deployments list` (per app dir) to find the previous **version id**, then `wrangler rollback <version-id> --yes`. (Every deploy workflow now does this itself when its post-deploy probes fail, see "Deploy safety" below.)

See `docs/ROLLBACK.md` §A for the full fast-path procedure.

### Database

```bash
# List migrations
npx prisma migrate status

# Rollback (manual - create reverse migration)
npx prisma migrate dev --name rollback_xxx
```

---

## Environments & staging posture

**Current posture (2026-05-15, "option C" — safe-by-default Preview)**: there is no separate staging Railway service. Preview deployments for web/admin (whether the historical Vercel Preview flow or the Cloudflare Workers preview environment) have `NEXT_PUBLIC_API_URL=http://localhost:4000` so PR previews are **non-functional by default** — they can't talk to production. A contributor who wants their preview to reach an API must override the env var on their PR explicitly. This blocks the worst-case data-integrity gap (a PR preview from a contributor writing to prod Neon) at zero cost.

**Correction (2026-09-02):** the paragraph above used to also claim a CI gate, `preview-env-isolation.yml`, "verifies the production-vs-preview value differs and passes." That gate only ever checked **Vercel** project env vars via the Vercel API; Ebda Store's Vercel projects were decommissioned in the 2026-07 Cloudflare migration, so it had no `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID_*` to read and fell through its own "unset → warn + exit 0" branches on every run — green on every PR while checking nothing (verified: last 5 runs all `success`; no Vercel secret/vars configured on the repo). It has been deleted rather than left as false assurance. The safe-by-default `localhost:4000` value above is the actual, still-real mitigation; there is currently no automated CI check that this default hasn't been overridden to point at production — that's a real gap, not (as the deleted workflow implied) a covered one. If/when Cloudflare Workers Builds gets a real per-PR preview environment, build an isolation check against that surface instead of resurrecting the Vercel one.

**Why not a real staging Railway service yet**: at single-merchant scale (demo-merchant only) the operational cost of maintaining a parallel Railway + Neon-branch + per-provider sandbox account chain (~4-6h setup, ~$20/mo Railway Pro OR a separate Hobby project) outweighs the marginal risk reduction. The safe-by-default Preview value gives ~80% of the protection at 5 minutes of setup.

**Upgrade trigger — when to graduate to real staging (option B)**:

1. Merchant #2 actually signs and onboards
2. A second developer joins (so PRs come from people other than Ahmad)
3. A P0 incident occurs that staging would have caught
4. The team is about to run a load test that needs realistic concurrent traffic

When any of these fire, the path to real staging is:

- New Railway project `ebda-staging` on Hobby plan (~$5/mo, separate from prod)
- Neon branch `staging` from `main` + seed fixtures script at `scripts/seed-staging.mjs`
- Custom domain `api-staging.ebda.app` → CNAME → Railway service
- Preview environment `NEXT_PUBLIC_API_URL` swap from `localhost:4000` → `https://api-staging.ebda.app`
- Per-provider sandbox credentials: Paymob/Kashier/Fawry test mode, OneSignal separate "staging" app, Cloudflare R2 separate bucket `force-uploads-staging`, Sentry environment tag `staging`, Axiom dataset `ebda-api-railway-staging`
- Documentation in this section updated with the URLs + dashboards

Estimated effort: ~4h focused session.

## Cost Summary

See `docs/audits/2026-05-22-comprehensive-saas-audit.md` §6 for the authoritative per-service forecast (idle / 10k MAU / 100k MAU scenarios). Snapshot of current scale:

| Service                                   | Plan       | Monthly Cost                                                 |
| ----------------------------------------- | ---------- | ------------------------------------------------------------ |
| Cloudflare Workers (admin + web + orders) | Workers    | see linked audit doc §6 (Vercel no longer part of the stack) |
| Railway (API + Redis)                     | Hobby      | ~$6-16                                                       |
| Neon Postgres                             | Launch     | $0-17 (today)                                                |
| Cloudflare R2                             | Free tier  | $0                                                           |
| OneSignal, Sentry, R2, Gemini, etc        | Free tiers | $0                                                           |
| **Total at current scale**                |            | **see linked audit doc §6 for the current forecast**         |

---

## Support Contacts

- Railway: support@railway.app
- Neon: support@neon.tech
- Cloudflare (Workers, R2, DNS): Enterprise support or community forums

---

## Observability & Alerts

Five orthogonal channels cover production failure modes per
`~/.claude/CLAUDE.md` Production Reality gates rules #6 + #7. Each
catches something the others can't.

### 1. UptimeRobot — "process is gone / URL unreachable"

- **Dashboard**: https://uptimerobot.com
- **Public status page**: https://stats.uptimerobot.com/23nuarbz3h — merchant-facing self-service for incident state (closes iceberg item "no public status page", 2026-05-15 audit)
- **Active monitors**:
  - `Ebda Store API` → `https://api.ebda.app/health` — HTTPS, 5-min interval, 30s timeout, alert on 2 consecutive failures
  - `Ebda Store store · demo-merchant.com` → `https://demo-merchant.com` — same settings
  - `Ebda Store admin` → `https://store.ebda.app` — same settings (added 2026-05-15; domain updated 2026-07-05 after the Cloudflare Workers migration)
- **Alert routing**: UptimeRobot mobile app push (instant on iPhone/Android, free tier, replaces Telegram which is paid-tier on UptimeRobot). The bridge to Telegram is via the in-API channel below for code-level alerts.
- **Adding a new merchant**: clone the existing storefront monitor, swap the URL to the merchant's domain, name it `Ebda Store store · <slug>`. Attach the same mobile-push alert contact. Also add it to the public status page.

### 2. Sentry — "code threw"

Four Sentry projects (one per app) so issues stay isolated in the dashboard UI:

- **API** — `apps/api/src/services/sentry.service.ts` + boot init. Captures `uncaughtException`, `unhandledRejection`, Express errors. Env: `SENTRY_DSN` on Railway.
- **Storefront** (`apps/web`) — `sentry.{client,server,edge}.config.ts` + `instrumentation.ts`. Captures SSR throws, RSC errors, client hydration errors, browser uncaught errors, route-handler errors. Env: `NEXT_PUBLIC_SENTRY_DSN_WEB` as a GitHub repo variable, consumed by the Cloudflare Workers build (`cf-deploy.yml`).
- **Admin** (`apps/admin`) — same shape. Env: `NEXT_PUBLIC_SENTRY_DSN_ADMIN` as a GitHub repo variable, consumed by `cf-deploy.yml`.
- **Orders** (`apps/orders`) — **added 2026-07-02 (audit H1)**. Client-only via `instrumentation-client.ts` (no server-side Sentry — Orders has no `instrumentation.ts`). Env: `NEXT_PUBLIC_SENTRY_DSN_ORDERS` as a GitHub repo variable for the `cf-deploy.yml` Cloudflare build. Previously this app had ZERO error capture — a crash in the fulfillment UI store staff use was invisible.
- **No-op when DSN missing** (graceful in dev / preview / pre-account-creation).
- **Source maps + releases (added 2026-07-02, audit H2)**: web/admin/orders `next.config.js` are now wrapped in `withSentryConfig`. Upload only activates when `SENTRY_AUTH_TOKEN` (+ `SENTRY_ORG`/`SENTRY_PROJECT_*`) is set; `cf-deploy.yml` wires them in (2026-09-25) and warns on every deploy until the secret exists — see docs/ENVIRONMENT.md. Before this, every Sentry issue from web/admin arrived with minified/obfuscated stack traces and no release association.
- **Sample rates**: storefront `tracesSampleRate=0.1` in prod (high traffic), admin `1.0` (low volume, every trace is signal). Session replays fire only on errors, not on healthy sessions.
- **Cloudflare Workers target — storefront only (2026-07-02):** the standard `@sentry/nextjs` server SDK can't run on Workers (and `cf-build.sh` moves `instrumentation.ts` aside for the CF build regardless — see `docs/migration/cloudflare-preview-workers.md`). `apps/web/sentry-worker-entry.ts` wraps the OpenNext Worker's fetch handler with `@sentry/cloudflare`'s `Sentry.withSentry(...)` so SSR/RSC errors ARE captured on `store.ebda.app` too. The DSN reaches the Worker as a runtime var `SENTRY_DSN` (`cf-deploy.yml` → `wrangler deploy --var SENTRY_DSN:<value>`, sourced from the same `NEXT_PUBLIC_SENTRY_DSN_WEB` repo variable; omitted → clean no-op). `apps/admin` and `apps/orders` do NOT have this yet — follow-up, same pattern.

### 3. PostHog — product analytics

- **Apps wired**: `apps/web` (storefront) + `apps/admin`. SDK: `posthog-js` v1.373.4.
- **Env**: `NEXT_PUBLIC_POSTHOG_KEY` as a GitHub repo variable (both apps), consumed by the Cloudflare Workers build. Optional `NEXT_PUBLIC_POSTHOG_HOST` (defaults to `https://eu.i.posthog.com`).
- **Consent gating**:
  - Storefront: gated on the marketing cookie consent (`consent.marketing === true`). Same gate as Meta / GA / TikTok pixels. Init fires only after the visitor accepts marketing cookies.
  - Admin: always-on (operator-only tool, no public visitors, no GDPR consent surface).
- **Privacy posture**: `ip: false`, `disable_session_recording: true`, `respect_dnt: true`. Anonymous distinct_id by default; call `posthog.identify(userId)` post-login to link sessions.
- **Captures**: pageviews on route change, autocapture clicks + form submits. Plus `captureEvent('event_name', {...})` helper for funnel instrumentation (checkout_started, add_to_cart, etc).

### 4. Telegram alerts service — "business logic P0/P1"

- **Bot**: `@ebda1_bot` (created via @BotFather, currently DMs Ahmad — chat_id `1943728711`)
- **Env vars (Railway)**:
  - `TELEGRAM_BOT_TOKEN` — API token from @BotFather
  - `TELEGRAM_ALERT_CHAT_ID` — chat to deliver to (DM = positive int; group = negative int)
- **Code**: `apps/api/src/services/alerts.service.ts` exports `sendAlert({ level, scope, store?, source, title, body?, context? })`
- **Levels**: `p0` (wake someone now) / `p1` (degraded, morning fine) / `info`
- **Scope-aware headers**: `[P0 PLATFORM]` vs `[P0 STORE]` so the operator sees scope at a glance; store-scoped alerts name the merchant in the body.
- **Throttle**: Redis-keyed per `sha1(level + title + storeId?)`, 5-min TTL — flapping events can't fan out 100 messages, and per-store throttling prevents store A's flaps from suppressing store B's genuinely-new alerts. The throttle **fails open**: Redis down, or connected but rejecting writes (OOM / MISCONF / read-only — the `SET NX` throws), sends the alert unthrottled, so `sendAlert` never rejects (issue 2384 — the dead-letter `unreadable_lost` P1s fire in exactly that state).
- **Graceful no-op**: missing env vars = single warn at boot, every send returns `'skipped'`
- **Wired call sites**:
  - `process.on('uncaughtException')` in `apps/api/src/index.ts` → P0 platform
  - Payment HMAC repeated fail (3+ in 5min via Redis counter) → P0 store-scoped (`payment.factory.ts`)
  - Background job failure past final retry → P1 platform (`reportJobFailure`, `lib/jobs/failure.ts`, Ruling G5-4)
  - `/api/v1/health` deep-check degradation → P1 platform (`index.ts`)

### 5. Log drain — Axiom via `@axiomhq/pino` transport (persistent log retention)

Railway's stdout buffer is ephemeral (~72h on the Pro plan, less on Hobby). Without a drain, any post-incident investigation older than 3 days is impossible.

**Why not Railway's native log drain feature**: Railway gates the dashboard "Log Drains" config behind the **Pro plan** ($20/mo per service). On Hobby/Trial the option isn't visible. To keep persistent logging working on any Railway plan, the API streams from inside the Node process via a pino transport — no Railway-level config required.

**Migration history**: Started on BetterStack 2026-05-14, migrated to Axiom 2026-05-15 because BetterStack's free tier retains only 3 days (violates CLAUDE.md rule 11). Axiom free tier retains 30 days at 500 GB/month, satisfying the rule at zero cost.

- **Provider**: **Axiom** free tier — 500 GB ingest/month, **30-day retention** (verified 2026-05-15)
- **Dataset**: `ebda-api-railway`
- **Transport**: `@axiomhq/pino` in `apps/api/src/lib/logger.ts` — pino multi-transport sends every log line to stdout AND Axiom in parallel (Railway logs UI keeps working untouched)
- **PII**: log lines ship off-platform, so recipient emails and phone numbers are logged only masked (`maskEmail` / `maskEmailList` / `maskPhone` from `apps/api/src/lib/pii-mask.ts`, issue 2390) — grep a support case by the masked form (`a***@gmail.com`, `****5678`) plus the email/SMS id, not the full address. `tests/unit/no-raw-pii-in-logs.test.ts` walks every app and package tree (apps/web, orders and admin server code log to Cloudflare Workers, also off-platform) and fails on a new raw field, a raw value interpolated into a message, a call through a bound / child / aliased logger, or a new `{ ...spread }` in a log object — or an opaque first argument such as `logger.info(result, 'x')`, which pino merges key by key — that has not been reviewed (issues 2392, 2394, 2396; Ruling LOG-PII-1).
- **Env vars (Railway)**:
  - `AXIOM_TOKEN` — API token with **Ingest** scope, from `app.axiom.co` → Settings → API tokens
  - `AXIOM_DATASET` — dataset name, currently `ebda-api-railway`
- **Graceful no-op**: when either env var is missing the transport is omitted entirely; pino still writes to stdout
- **Redaction**: same pino redact rules apply to Axiom — auth headers, cookies, passwords, tokens, card numbers all masked before leaving the process
- **Setup** (one-time):
  1. Sign up at https://app.axiom.co/register → create dataset `ebda-api-railway`
  2. Settings → API tokens → create token with **Ingest** scope (name: `Ebda Store API ingest`)
  3. Set `AXIOM_TOKEN` + `AXIOM_DATASET` env vars on Railway and redeploy
  4. Verify in Axiom Stream view within 30s — request log lines should land
- **What to expect**: every pino log line lands in Axiom within ~2 sec. Search by `request`, `Unhandled error`, request ID, etc. Axiom's APL query language is more powerful than BetterStack's for log filtering.
- **Implementation note**: the transport target uses `require.resolve('@axiomhq/pino')` (not the bare specifier) because pino's worker_threads.Worker can't always resolve ESM/CJS exports maps when given a bare package name. The absolute path always loads.

### 6. External-service-to-Telegram alert bridge

Sentry / Axiom / PostHog each have their own native notification channels (email, Slack, webhook), but none route to Telegram natively without paid plans. To keep the operator on **one notification channel** for everything, the API exposes a small translator that accepts each service's webhook payload and forwards via the existing `sendAlert()` Telegram pipeline.

- **Endpoints** (`apps/api/src/routes/alert-webhooks.routes.ts`):
  - `POST /api/v1/alerts/webhooks/sentry` (header `x-alerts-token: <TOKEN>`) — Sentry issue alert action → P1 platform
  - `POST /api/v1/alerts/webhooks/axiom` (header `x-alerts-token: <TOKEN>`) — Axiom monitor → P1 platform
  - `POST /api/v1/alerts/webhooks/posthog` (header `x-alerts-token: <TOKEN>`) — PostHog insight alert → P1 platform
  - `POST /api/v1/alerts/webhooks/generic` (header `x-alerts-token: <TOKEN>`) — `{title, body, level, source}` for any other service
- **Auth**: shared-secret token in the **`x-alerts-token` header only** (S7, 2026-11-12: `?token=` is refused with 401 `token_in_query_refused` because query strings land in logs), read from the env on every request and checked against `ALERTS_WEBHOOK_TOKEN` (a `wrangler secret` on the `ebda-api` Worker; the value lives in macOS Keychain `ebda-alerts-webhook-token`). **Fail closed in production**: with the secret unset every call gets 503 `alerts_not_configured` (it used to accept any payload — security audit F-06, 2026-10-14).
- **Delivery**: one company bot, **@EbdaAIStudiobot** (Ebda AI Studio), serves every product. `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` are `ebda-api` Worker secrets (Keychain `ebda-telegram-bot` / `ebda-telegram-alert-chat-id`). Every alert's first line is `<emoji> Ebda Store: <problem>` (product name from `BRAND.product.nameEn`), then the `[LEVEL SCOPE]` tag.
- **Configured senders**:
  - **Sentry** (org `whisky11`, projects `ebda-api`/`ebda-web`/`ebda-admin`/`ebda-orders`): internal integration **"Ebda AI Studio Alerts"** subscribed to `issue` webhooks → `https://api.ebda.app/api/v1/alerts/webhooks/sentry`. **Operator action after S7:** Sentry webhooks cannot set a custom header, so the integration's old `?token=` URL now gets 401 — front it with a header-adding hop (or switch the sender) before this ships, otherwise Sentry alerts stop reaching Telegram. The route alerts only on `created` (new issue) and `triggered` (alert-rule action); resolved/assigned/archived are acknowledged and dropped.
  - **PostHog** (EU, project 296820): not wired yet — needs a chosen metric (e.g. zero sign-ups/day) before an insight alert means anything.
  - **Axiom**: not used by Ebda Store.
- **What this does NOT do**: it doesn't replace each service's dashboard — Sentry issues still live in Sentry, etc. It only adds Telegram as a parallel notification channel for high-signal events.

### 7. Workers Logs + Logpush to R2 (Cloudflare-only logging, G7, INFRA-CF-1)

Replaces the Axiom drain (section 5) at cutover: once the API is no longer on Railway nothing writes to that transport.

- **Workers Logs (searchable, short retention):** `observability: { enabled: true, head_sampling_rate: 1 }` (**0.1 on `ebda-api` and `ebda-web`, the public high-traffic Workers, since the launch sampling change (PERF-SAMPLING): Workers Logs keep 1 in 10 invocations; the Logpush archive below and Sentry error capture are separate pipelines. Inferred from Cloudflare's docs, not measured: confirm the archive volume after the first launch day**) and `"logpush": true` on all NINE Ebda Workers: `ebda-api`, `ebda-web`, `ebda-admin`, `ebda-marketing`, `ebda-orders`, `ebda-accounts` (identity), `ebda-help`, `ebda-docs`, `ebda-status` (`apps/*/wrangler.jsonc`; the OpenNext generator `scripts/cf-setup-local.sh` emits the same for web/admin/orders, which it regenerates at every deploy). Query them in the dashboard: Workers & Pages, the Worker, Logs. The assets-only Workers (marketing, help, docs) run no script for static hits, so those produce no log lines; the flags keep config parity. `tests/unit/ops/worker-logs-config.test.ts` fails a PR that drops either setting on any of the nine.
- **Logpush (30 days, in our bucket):** ONE account-level job **`ebda-workers-trace`** (id 1986363, dataset `workers_trace_events`, filter `ScriptName in [the nine ebda-store Workers + ebda-wa + ebda-os-brain]`, fields incl. `CPUTimeMs`/`WallTimeMs`/`Entrypoint`/`EventType`; `scripts/ops/cf-logs-setup.sh` is the source of both lists) writes gzip NDJSON to R2 bucket **`ebda-logs`**, objects `workers/<YYYYMMDD>/<start>_<end>_<id>.log.gz` (plus `workers/00010101/test.txt.gz`, Logpush's ownership check). A lifecycle rule deletes objects after 30 days (created and read back 2026-10-24). Verified 2026-10-25: the job has `last_complete` set with no `last_error`, and real log files were listed with the bucket-scoped read key. Logs carry `console.log` lines and uncaught exceptions, never request bodies; the PII masking rules of section 5 still apply to what we log.
- **Which token can do what (never print them):**

  | Token / file                                                  | Scope                                                                                      | Used for                                                                                                                     |
  | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
  | `CF_API_TOKEN` in `~/.whisky-services.env`                    | reads R2 buckets and lifecycle, creates buckets, PUTs lifecycle; no Logs, no Notifications | steps 1-2 of `cf-logs-setup.sh`                                                                                              |
  | `CF_API_TOKEN` in `~/.claude/.ebda-logpush-env`               | Account, Logs, Edit only; cannot read or write R2 (error 10000)                            | the Logpush job (step 3) and reading its `last_complete`                                                                     |
  | `LOGPUSH_R2_ACCESS_KEY_ID/SECRET_ACCESS_KEY` in the same file | R2 Object Read and Write on bucket `ebda-logs` only                                        | Logpush writes with it; also the key to read the logs back (`rclone`, endpoint `https://<account>.r2.cloudflarestorage.com`) |
  | wrangler OAuth login                                          | Workers, D1, KV, Queues; no R2, Logs or Notifications                                      | deploys only                                                                                                                 |

- **Setup / re-run (idempotent, verify-then-skip):** `bash scripts/ops/cf-logs-setup.sh`. It sources the logpush env file when `CF_API_TOKEN` is unset. Each step reads the live state and writes only when it differs; a token that cannot read R2 reports "cannot verify with this token" instead of failing. If the job's filter differs from the nine names it updates it.
- **Reading old logs:** `node os/ops/ebda-logs.mjs --since 2h [--script ebda-web] [--status 5xx|429] [--path /store/resolve] [--callers ebda-api:429] [--minutes ebda-web]` from ebda-foundation (installed to `~/.claude/scripts/`): lists + reads the objects through api.cloudflare.com only (works from Egypt, where `wrangler tail` cannot connect) and prints aggregates, paced under the API's 1200 req / 5 min. Or `rclone` with the bucket-scoped read key against `ebda-logs`, then `zcat | jq`. Asset-only Workers (marketing, help, docs) write no records while their assets answer.
- **Alerting on them:** ebda-foundation `.github/workflows/prod-watch.yml` (GitHub-hosted, every 10 min): probes + the last Logpush window -> Telegram P1s + one daily digest.
- **Sentry stays** as the error tracker (the one non-Cloudflare dependency besides payment, shipping and Meta providers). Alert route unchanged: Sentry, then the alert bridge (section 6), then Telegram.

### Verifying end-to-end

```bash
# 1. Fire a direct Telegram test (no API code involved)
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${TELEGRAM_ALERT_CHAT_ID}\",\"text\":\"smoke test\"}"

# 2. Confirm API health
curl https://api.ebda.app/health

# 3. Check the external probes: https://status.ebda.app (every component green; an incident there pages Telegram)

# 4. Trigger Sentry from the storefront (paste into browser console on demo-merchant.com):
#    throw new Error("sentry-storefront-smoke-test");
#    Issue should appear in Sentry dashboard within ~30s.

# 5. Trigger PostHog event capture from the admin (accept analytics in the cookie banner first: the admin PostHog is consent-gated; then paste into the browser console):
#    window.posthog?.capture('admin_smoke_test', {at: new Date().toISOString()});
#    Event lands in PostHog → Live Events within ~5s.
```

### Alert SLA

- **P0** (server unreachable, payment HMAC repeated fail, data loss): respond within 15 min, 24/7
- **P1** (degraded, AI quota exhausted, cron failed past final retry, deep-health degraded): respond within 4 hours
- **Info** (deploy notifications, scheduled job summaries): no SLA

### Cloud cost alerts (added 2026-05-15 per iceberg audit Quick Win #4)

Each hosting/data provider's billing dashboard fires an email to the account owner when spend or usage crosses a threshold. A runaway AI sweep, bot scrape, or cron loop can otherwise spike costs 10× silently. Verified per-provider:

| Provider   | Alert                                  | Threshold                                                                                                        |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Railway    | Budget alert                           | spend > 80% of monthly budget                                                                                    |
| Neon       | Compute credits                        | usage > 80% of monthly credits                                                                                   |
| Cloudflare | Usage-based billing notifications (G9) | Workers requests, Durable Objects, D1, R2, Email; thresholds and the exact click-path are in the next subsection |

#### Cloudflare usage notifications (G9)

The wrangler OAuth login and the stored `CF_API_TOKEN` cannot create notification policies (the API answers "Authentication error", checked 2026-10-24), so this is a dashboard task, once, on the personal/Whisky 11 account (`as.montaseer@gmail.com`, account `69188202efc4df480140dd76545aa3ab`):

1. dash.cloudflare.com, pick the account, then **Notifications** (left menu, under the account home), then **Add**.
2. Choose **Usage Based Billing** (a Pay-as-you-go account feature; Workers Paid qualifies). Name it `ebda usage <product>`.
3. Product and threshold, one notification each (80% of the Workers Paid included allowance, so the alert lands before the bill does):
   - **Workers**: requests exceed **8,000,000** per month (10 M included)
   - **Durable Objects**: requests exceed **800,000** (1 M included) and duration if offered
   - **D1**: rows read exceed **20 billion**, rows written **40 million** (25 B / 50 M included)
   - **R2**: Class A operations exceed **800,000** (1 M free), Class B **8,000,000** (10 M free), storage **8 GB** (10 GB free)
   - **Email (Email Service)**: outbound messages exceed **2,400** per month (3,000 included)
4. Notification method: **Email**, `as.montaseer@gmail.com`; add the Telegram webhook (`/api/v1/alerts/webhooks/generic` with the `x-alerts-token` header) as a second method if Webhooks is enabled on the account.
5. Save, then **Notifications > History** is where a fired one shows. Re-check quarterly with the rest of this table.

Included allowances are from developers.cloudflare.com pricing pages as read on 2026-10-24 and must be re-read before trusting the thresholds. If a product is missing from the Usage Based Billing product list, record it in the register and watch it in the billing page instead (Billing > Billable Usage).

Renewal verification: re-check these in the per-provider dashboard quarterly — providers occasionally migrate billing UIs and silently drop alert rules.

### Account ownership

| Service             | Account email        | Project / org                                                                                                  |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cloudflare          | ops@ebda.app         | Workers hosting (deployed by GitHub Actions) `force-web`/`force-admin`/`ebda-orders` (replaced Vercel 2026-07) |
| Railway             | ops@ebda.app         | project `ebda-store`                                                                                           |
| Neon                | ops@ebda.app         | project `ep-falling-meadow-a1uq2yil` (ap-southeast-1)                                                          |
| Sentry              | ops@ebda.app         | one org with four projects: `api`, `web`, `admin`, `orders`                                                    |
| PostHog             | ops@ebda.app         | EU region, single project covering web + admin                                                                 |
| UptimeRobot         | ops@ebda.app         | free tier, 2 monitors currently                                                                                |
| Axiom               | (Ahmad's account)    | free tier (500GB/30d) — dataset `ebda-api-railway`                                                             |
| Resend              | platform-wide        | one account; per-merchant domains added under it                                                               |
| @ebda1_bot Telegram | personal DM to Ahmad | chat_id `1943728711`                                                                                           |

---

## Two-factor auth & session revocation

Added in `feat/mfa-and-token-revocation` (2026-06-08). No new environment variables are required — the feature reuses two vars that must already be set:

| Env var          | Used for                                           | Already required?                                                        |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `ENCRYPTION_KEY` | AES-256-GCM encryption of the per-user TOTP secret | Yes — crashes at boot without it                                         |
| `REDIS_URL`      | jti denylist + tokenVersion cache                  | Yes — auth revocation degrades gracefully when Redis is down (fail-open) |

### Rollout safety notes

**No forced logout on deploy.** `tokenVersion` defaults to `0` and existing access tokens carry no `tv` claim. The middleware treats a missing `tv` as `tv=0`, which equals the current `tokenVersion` (also `0`) — so existing sessions continue to work. Users are not signed out when this code ships.

**Ship the super-admin enforcement gate AFTER you have enrolled yourself.** Task 9 (`requireMfaEnrolled`) returns `403 MFA_SETUP_REQUIRED` for any `super_admin` whose `mfaEnabled` is `false`. If you deploy the gate before enrolling your own account, you will 403 yourself on every protected admin route. Safe sequence:

1. Deploy Tasks 1–8 + 10–11 (enrollment routes available, gate not yet enforced).
2. Enroll your own `super_admin` account via **Account → Security → Enable 2FA**.
3. Save the 10 backup codes in a secure location.
4. Deploy Task 9 (enforcement gate).

**Redis-down behavior is fail-open.** If Redis is unavailable:

- `isJtiDenied()` returns `false` → a logged-out token is temporarily accepted.
- `getUserTokenVersion()` returns `null` → the middleware falls back to a DB read for the current `tokenVersion`, so kill-all revocation still works (but adds a DB round-trip per request until Redis recovers).

This is a deliberate tradeoff: locking every user out during a Redis outage is worse than a brief revocation bypass window. Pair with the existing Redis uptime monitor in UptimeRobot.

### Recovery

If a super-admin loses their authenticator and backup codes, use the CLI reset script as a last resort:

```bash
# Production — provide the non-pooled DIRECT_URL
DIRECT_URL="postgresql://..." npx tsx scripts/mfa-reset.ts user@example.com
# Expected: MFA reset for user@example.com: 1 row(s)
```

The script clears MFA fields and increments `tokenVersion`, forcing re-login on all devices. Full procedure: `docs/runbooks/mfa-recovery.md`.

---

## Service Worker: pre-registration pattern (commit `91d735cf`)

Chromium 133+ emits a deprecation warning when a service worker script adds
event listeners (`message`, `push`, `notificationclick`, `pushsubscriptionchange`)
**after** an async `importScripts()` call. The warning eventually becomes an
error, which would break push notifications silently.

**Fix applied to `apps/web/public/OneSignalSDKWorker.js`:**

Pre-register **no-op handlers** for all four events synchronously, before the
`importScripts` that loads the real OneSignal SDK:

```javascript
// pre-register before importScripts so Chromium 133+ doesn't warn
self.addEventListener('message', () => {});
self.addEventListener('push', () => {});
self.addEventListener('notificationclick', () => {});
self.addEventListener('pushsubscriptionchange', () => {});

importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
```

The real handlers from `importScripts` override the no-ops. The pre-registration
is invisible to the SDK — it only prevents the browser from seeing the first
async event handler registration as a post-import listener.

**When adding a new service worker or updating `OneSignalSDKWorker.js`:**
preserve this pre-registration block. Removing it restores the deprecation
warning on Chromium 133+.

## Merchant custom domains (Cloudflare for SaaS, M-072): the route change

**Goal.** A merchant's own domain (`shop.example.com`, CNAME to the fallback origin `cf.ebda.app`) is added as a Cloudflare for SaaS
custom hostname on the `ebda.app` zone. Its traffic enters THIS zone and is matched against this zone's Workers routes
([Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/):
"Any Worker routes configured on your zone will match this incoming traffic", and the recommended route is `*/*`). The storefront
Worker (`ebda-web`) today only owns `*.ebda.app/*`, which cannot match `shop.example.com`.

**Change (code only, NOT deployed).**

| Where                           | Change                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/cf-routes.cjs` (web)   | add `{ pattern: "*/*", zone_name: "ebda.app" }` after `*.ebda.app/*`                                                                            |
| `apps/marketing/wrangler.jsonc` | add the explicit apex route `ebda.app/*` (besides the custom domain)                                                                            |
| `apps/accounts/wrangler.jsonc`  | add the explicit route `accounts.ebda.app/*` (besides the custom domain)                                                                        |
| already explicit                | `api.`, `store.`, `orders.` (generated), `docs.`, `help.`, `status.` have a `<host>/*` zone route; `media.` has its Worker-less exclusion route |

**Why it is safe: precedence.** Cloudflare's rule ([Routes, matching behavior](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior)):
"When more than one route pattern could match a request URL, the most specific route pattern wins" (`www.example.com/*` beats
`*.example.com/*`), and "a route can be specified without being associated with a Worker. This will act to negate any less
specific patterns" (the `media.` exclusion). The same page for Cloudflare for SaaS: "More specific routes take precedence over
wildcard routes." `*/*` is the least specific pattern there is, so every named-host route out-ranks it.

**The one thing the docs do not settle, and how the plan avoids it.** `scripts/cf-routes.cjs` records that a wildcard zone route is
evaluated BEFORE Custom Domains. If that is also true of `*/*`, a host protected only by a Custom Domain would be taken by the
storefront. Today `ebda.app` (marketing) and `accounts.ebda.app` have ONLY a custom domain, so they get explicit zone routes in
this change. The test deliberately ignores custom-domain entries and proves every named host has a zone route.
`tests/unit/cf-route-precedence.test.ts` checks each host resolves to its own Worker (and fails if the apex or accounts route is
removed), using a model of the documented rules (`scripts/ci/cf-route-resolve.mjs`).

**Before the dashboard step (Ahmad's browser):** enable SSL for SaaS on `ebda.app`, set the fallback origin to `cf.ebda.app` (already
resolves through the wildcard; the docs want it proxied and originless, which the wildcard-to-Worker setup satisfies), then deploy
this branch. **Deploy order matters:** deploy `ebda-marketing` and `ebda-accounts` FIRST (their explicit routes), then `ebda-web`
(the `*/*`). Verify after each deploy (rule F): `curl -sI https://ebda.app/` and `https://accounts.ebda.app/health` still answer from
marketing / accounts, `https://api.ebda.app/health` from the API, and a store subdomain from the storefront.

**Dashboard state (set by the controller, 2026-10-27).** SSL for SaaS is active on `ebda.app`; the fallback origin is `cf.ebda.app`, a
proxied `A` record to `192.0.2.0` (an originless record, as the Cloudflare docs require for a Worker fallback origin), and it stays
"pending deployment" until `ebda-web` serves the `*/*` route from this change.

**What the Worker must also do (not in this change).** `ebda-web` will now receive arbitrary `Host` headers. The storefront resolver
must map a custom hostname to a store through a verified-domain lookup and 404 any unknown host (tenant resolvers throw/404, never
default). That is the M-072 application work; until it ships, a custom hostname must not be attached.

**Rollback.** Instant, no redeploy of the other Workers: delete the `*/*` route. Dashboard: Workers & Pages, `ebda.app` zone,
Workers Routes, delete `*/*` (ebda-web). API: `curl -X GET -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes`
to find the route id, then `curl -X DELETE ... /zones/$ZONE/workers/routes/$ID`. Then revert the PR and redeploy ebda-web so the
next deploy does not re-add it. Store subdomains (`*.ebda.app/*`) are unaffected throughout; the explicit apex/accounts routes are
harmless to leave in place.

## CI deploy token: minimum scope, and where it can be reached from (Ruling DEPLOY-PARITY-1)

`Ebda-AI-Studio/ebda-store` is a Free-plan private repo: GitHub offers no required reviewers, no environment protection and no
enforced CODEOWNERS here, so the controls are in code. They are enforced by tests and a required check:

- **A pull request can never reach a deploy secret.** `tests/unit/deploy-secrets-never-on-pr.test.ts` fails the build if any
  workflow triggered by `pull_request`, `pull_request_target` or `workflow_run` references `secrets.CLOUDFLARE_*`,
  `EBDA_MIGRATE_DATABASE_URL`, `SENTRY_AUTH_TOKEN`, `secrets: inherit` or `toJSON(secrets)`; every `cf-*-deploy.yml` must trigger
  only on push to `main` or manual dispatch; `db-backup.yml` no longer exists (Ruling NZ-17-BACKUP-1).
- **A change to how production deploys needs a human label.** The required check "Deploy workflow changes need the
  deploy-change label" (`.github/workflows/deploy-change-label.yml`, `scripts/ci/deploy-change-label.mjs`) fails a PR that edits
  `cf-*-deploy.yml`, `db-backup.yml`, `scripts/ci/deploy-guard.mjs`, `scripts/ci/deploy-plan.mjs`, `scripts/ci/api-required-secrets.json`, `scripts/cf-build.sh` or
  `scripts/ebda-cf-api-config.mjs` unless it carries the `deploy-change` label, which only a person applies after reading the diff.
- **The CI Cloudflare token is `ebda-github-deploy` (`CLOUDFLARE_API_TOKEN`, production environment secret).** Checked in the
  Cloudflare dashboard on 2026-10-27 by the controller: it is scoped to **1 account (Ebda's) and 1 zone (`ebda.app`)**, never
  "all accounts" or "all zones", and carries **10 permissions**, each justified. Read vs Edit levels were not visible in that
  review; the intent is Edit only where deploys write.

  | Permission                   | Scope           | Why a deploy needs it                                                                                                              |
  | ---------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | Account · Workers Scripts    | account         | `wrangler deploy` for the 9 Workers; `wrangler secret list` in the secret gate                                                     |
  | Account · Workers KV Storage | account         | the cache namespace binding (`EBDA_KV_CACHE_ID`)                                                                                   |
  | Account · D1                 | account         | `Apply D1 migrations (ebda-identity)` and the D1 bindings                                                                          |
  | Account · Workers R2 Storage | account         | the nightly `cf-backup.yml` upload to `ebda-db-backups`, and R2 bindings (cache, uploads)                                          |
  | Account · Queues             | account         | the queue producer/consumer bindings on the API Worker                                                                             |
  | Account · Hyperdrive         | account         | retired (NEON-ZERO N-17): the API Worker has no Hyperdrive binding; delete the config with the Neon project                        |
  | Account · Account Settings   | account         | wrangler resolves the account and its subdomain on deploy (the broadest line here: review it first if the token is ever tightened) |
  | Zone · Workers Routes        | zone `ebda.app` | the `<host>/*` zone routes in the `wrangler.jsonc` files, including the storefront `*/*` for merchant custom domains               |
  | Zone · DNS                   | zone `ebda.app` | Workers **Custom Domains** create their DNS records on deploy                                                                      |
  | Zone · DNS Settings          | zone `ebda.app` | read alongside DNS when a Custom Domain is attached                                                                                |

  Everything else (Members, API Tokens, Firewall, Billing, Logs, other zones, other accounts) is OFF. If a deploy ever needs a
  permission not listed, add exactly that one and update this table in the same PR (the `deploy-change` label check forces a
  human to look at the diff). The repo cannot read its own token's permissions, so this table is a record of the dashboard, not
  something CI proves.
