# Force Website Builder - Production Deployment Guide

> **2026-05-22 update:** prior versions of this doc described a Cloudflare Pages + Supabase topology that was never the production state. The canonical production stack is below. The old doc misled incident responders during the 2026-05-22 audit (P1-7).

## Local CI gate (active while GitHub Actions billing is suspended)

GitHub Actions is currently blocked by a billing issue. Until billing resumes, this project uses a **local pre-push gate** instead:

- `.husky/pre-push` runs lint + 3x typecheck (api/admin/web) + unit tests (497 tests) on every `git push`
- Failures BLOCK the push — the gate exits non-zero and git aborts
- Successful pushes still trigger Railway auto-deploy (Railway's GitHub integration runs independently of GitHub Actions)
- `TEST_DATABASE_URL` is set to a safe placeholder in the hook so `vitest setup-e2e.ts` prod-guard passes cleanly; unit tests mock Prisma and make no real DB calls

**Test gate scope:** lint + 3x typecheck + 497 unit tests (~4s)

To run the full gate manually: `bash scripts/safe-deploy.sh`

When GitHub Actions billing is restored, the existing `.github/workflows/ci.yml` will run server-side gates again. The pre-push hook stays as a fast local-first gate.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                       VERCEL Pro ($20/mo)                        │
│  ┌──────────────────────────┐  ┌──────────────────────────┐      │
│  │  force-admin (Next 16)   │  │  force-web (Next 16)     │      │
│  │  app.forcemediakw.com    │  │  store.forcemediakw.com  │      │
│  │                          │  │  + per-tenant domains    │      │
│  └──────────────────────────┘  │  (wadyaljuz.com, ...)    │      │
│                                └──────────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ HTTPS, credentials:include
┌──────────────────────────────────────────────────────────────────┐
│                      RAILWAY (~$10-20/mo)                        │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Express.js API (Dockerfile, Railpack runner)             │    │
│  │  store-api.forcemediakw.com                              │    │
│  │  + Redis (railway internal :6379)                        │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                     │                  │                  │
                     ▼                  ▼                  ▼
┌──────────────────────────┐  ┌─────────────────┐  ┌──────────────┐
│ NEON Launch (~$17-150/mo) │  │ CLOUDFLARE R2   │  │ INNGEST CLOUD│
│ PostgreSQL serverless     │  │ (per-tenant     │  │ 30 functions │
│ 79 models, RLS-backed     │  │  media storage) │  │              │
│ per-commit snapshot brs   │  │  *.r2.dev       │  │              │
└──────────────────────────┘  └─────────────────┘  └──────────────┘

Estimated Monthly Cost (current scale): ~$26/mo
   See docs/audits/2026-05-22-comprehensive-saas-audit.md §6 for the
   full per-service forecast at 10k MAU ($170/mo) and 100k MAU ($1,100/mo).
```

---

## Step 1: Railway Setup (API Server)

### 1.1 Create Railway Account

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub (recommended for auto-deploy)

### 1.2 Create New Project

1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose `ForceAI-KW/force-website-builder`
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

# Database (from Supabase)
DATABASE_URL=postgres://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgres://postgres.xxx:password@aws-0-region.pooler.supabase.com:5432/postgres

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
DEFAULT_CURRENCY=KWD

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

## Step 2: Cloudflare Pages Setup (Web & Admin)

> ⚠️ **STALE — see top of doc.** Production storefront + admin run on **Vercel Pro**, not Cloudflare Pages. Project names: `force-admin` (app.forcemediakw.com) and `force-web` (store.forcemediakw.com + per-tenant custom domains). Vercel domain provisioning is automated via `apps/api/src/services/vercel-domain.service.ts`. The instructions below predate the 2026-05-17 Vercel migration and should not be followed.

### 2.1 Create Cloudflare Account

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Sign up or login

### 2.2 Create Pages Project - Web App

1. Go to **Workers & Pages** → **Create**
2. Select **Pages** → **Connect to Git**
3. Select your GitHub repo: `ForceAI-KW/force-website-builder`

Configure build settings:

| Setting                | Value           |
| ---------------------- | --------------- |
| Project name           | `force-web`     |
| Production branch      | `main`          |
| Framework preset       | `Next.js`       |
| Root directory         | `apps/web`      |
| Build command          | `npm run build` |
| Build output directory | `.next`         |

### 2.3 Add Environment Variables - Web

In Settings → Environment Variables:

```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api/v1
NEXT_PUBLIC_APP_NAME=Your Store Name
NEXT_PUBLIC_APP_URL=https://store.yourdomain.com
```

### 2.4 Create Pages Project - Admin App

Repeat steps 2.2-2.3 with:

| Setting        | Value         |
| -------------- | ------------- |
| Project name   | `force-admin` |
| Root directory | `apps/admin`  |

Environment Variables:

```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api/v1
NEXT_PUBLIC_APP_NAME=Force Admin
NEXT_PUBLIC_APP_URL=https://admin.yourdomain.com
```

### 2.5 Add Custom Domains

1. Go to project → Custom domains
2. Add `store.yourdomain.com` for web
3. Add `admin.yourdomain.com` for admin
4. Cloudflare will auto-configure SSL

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

## Step 4: Supabase Configuration

> ⚠️ **STALE — see top of doc.** Production DB is **Neon Postgres** (serverless, per-commit snapshot branches via `.github/workflows/neon-snapshot.yml`), not Supabase. RLS is implemented via `runInTenantContext` AsyncLocalStorage + 52 ENABLE ROW LEVEL SECURITY tables. Migration was completed pre-2026-05-01. Do not follow the Supabase setup steps below.

### 4.1 Upgrade to Pro Plan

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project
3. Go to Settings → Billing
4. Upgrade to Pro ($25/mo)

### 4.2 Add Compute Add-on

For 10 stores with 1M customers:

1. Go to Settings → Add-ons
2. Select **Medium** compute ($50/mo)
   - 2 CPU cores
   - 4 GB RAM

### 4.3 Enable Connection Pooling

1. Go to Settings → Database
2. Copy the **Pooler** connection string (port 6543)
3. Use this for `DATABASE_URL`
4. Use direct connection (port 5432) for `DIRECT_URL`

### 4.4 Configure Backups

Pro plan includes daily backups. Verify in:
Settings → Database → Backups

---

## Step 5: DNS Configuration

Add these records to your domain:

| Type  | Name  | Value                                | Proxy |
| ----- | ----- | ------------------------------------ | ----- |
| CNAME | store | force-web.pages.dev                  | Yes   |
| CNAME | admin | force-admin.pages.dev                | Yes   |
| CNAME | api   | your-app.up.railway.app              | No    |
| CNAME | cdn   | your-bucket.r2.cloudflarestorage.com | Yes   |

---

## Step 6: Post-Deployment Checklist

### Security

- [ ] Generate strong JWT_SECRET (64+ chars)
- [ ] Generate strong ENCRYPTION_KEY (32 chars)
- [ ] Enable 2FA on all service accounts
- [ ] Set up Cloudflare WAF rules

### Monitoring

- [ ] Set up Sentry for error tracking
- [ ] Enable Railway metrics alerts
- [ ] Configure Supabase alerts

### Payment Providers

- [ ] Switch Tap to live keys
- [ ] Configure webhook URLs:
  - Tap: `https://api.yourdomain.com/api/v1/webhooks/payment/tap`
  - MyFatoorah: `https://api.yourdomain.com/api/v1/webhooks/payment/myfatoorah`

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

### Deploy Web/Admin (Cloudflare)

```bash
# Cloudflare auto-deploys on git push
git push origin main
```

### Manual Database Migration

```bash
cd packages/database
npx prisma migrate deploy
```

---

## Rollback Procedures

### Railway

1. Go to Deployments
2. Find previous working deployment
3. Click "Rollback"

### Cloudflare Pages

1. Go to Deployments
2. Find previous deployment
3. Click "..." → "Rollback to this deploy"

### Database

```bash
# List migrations
npx prisma migrate status

# Rollback (manual - create reverse migration)
npx prisma migrate dev --name rollback_xxx
```

---

## Environments & staging posture

**Current posture (2026-05-15, "option C" — safe-by-default Preview)**: there is no separate staging Railway service. Instead, Vercel Preview deployments for force-web + force-admin have `NEXT_PUBLIC_API_URL=http://localhost:4000` so PR previews are **non-functional by default** — they can't talk to production. A contributor who wants their preview to reach an API must override the env var on their PR explicitly. This blocks the worst-case data-integrity gap (a PR preview from a contributor writing to prod Neon) at zero cost. The CI `preview-env-isolation.yml` rule-13 gate verifies the production-vs-preview value differs and passes.

**Why not a real staging Railway service yet**: at single-merchant scale (wadyaljuz only) the operational cost of maintaining a parallel Railway + Neon-branch + per-provider sandbox account chain (~4-6h setup, ~$20/mo Railway Pro OR a separate Hobby project) outweighs the marginal risk reduction. The safe-by-default Preview value gives ~80% of the protection at 5 minutes of setup.

**Upgrade trigger — when to graduate to real staging (option B)**:

1. Merchant #2 actually signs and onboards
2. A second developer joins (so PRs come from people other than Ahmad)
3. A P0 incident occurs that staging would have caught
4. The team is about to run a load test that needs realistic concurrent traffic

When any of these fire, the path to real staging is:

- New Railway project `fwb-staging` on Hobby plan (~$5/mo, separate from prod)
- Neon branch `staging` from `main` + seed fixtures script at `scripts/seed-staging.mjs`
- Custom domain `store-api-staging.forcemediakw.com` → CNAME → Railway service
- Vercel Preview `NEXT_PUBLIC_API_URL` swap from `localhost:4000` → `https://store-api-staging.forcemediakw.com`
- Per-provider sandbox credentials: Tap/MyFatoorah/Hesabe/UPayments test mode, OneSignal separate "staging" app, Cloudflare R2 separate bucket `force-uploads-staging`, Sentry environment tag `staging`, Inngest separate `INNGEST_DEPLOY_ID`, Axiom dataset `force-api-railway-staging`
- Documentation in this section updated with the URLs + dashboards

Estimated effort: ~4h focused session.

## Cost Summary

See `docs/audits/2026-05-22-comprehensive-saas-audit.md` §6 for the authoritative per-service forecast (idle / 10k MAU / 100k MAU scenarios). Snapshot of current scale:

| Service                                     | Plan         | Monthly Cost   |
| ------------------------------------------- | ------------ | -------------- |
| Vercel (admin + web)                        | Pro (1 seat) | $20            |
| Railway (API + Redis)                       | Hobby        | ~$6-16         |
| Neon Postgres                               | Launch       | $0-17 (today)  |
| Cloudflare R2                               | Free tier    | $0             |
| Inngest, OneSignal, Sentry, R2, Gemini, etc | Free tiers   | $0             |
| **Total at current scale**                  |              | **~$26-36/mo** |

---

## Support Contacts

- Vercel: support@vercel.com
- Railway: support@railway.app
- Neon: support@neon.tech
- Cloudflare: Enterprise support or community forums

---

## Observability & Alerts

Five orthogonal channels cover production failure modes per
`~/.claude/CLAUDE.md` Production Reality gates rules #6 + #7. Each
catches something the others can't.

### 1. UptimeRobot — "process is gone / URL unreachable"

- **Dashboard**: https://uptimerobot.com
- **Public status page**: https://stats.uptimerobot.com/23nuarbz3h — merchant-facing self-service for incident state (closes iceberg item "no public status page", 2026-05-15 audit)
- **Active monitors**:
  - `FWB API` → `https://store-api.forcemediakw.com/health` — HTTPS, 5-min interval, 30s timeout, alert on 2 consecutive failures
  - `FWB store · wadyaljuz.com` → `https://wadyaljuz.com` — same settings
  - `FWB admin` → `https://app.forcemediakw.com` — same settings (added 2026-05-15)
- **Alert routing**: UptimeRobot mobile app push (instant on iPhone/Android, free tier, replaces Telegram which is paid-tier on UptimeRobot). The bridge to Telegram is via the in-API channel below for code-level alerts.
- **Adding a new merchant**: clone the existing storefront monitor, swap the URL to the merchant's domain, name it `FWB store · <slug>`. Attach the same mobile-push alert contact. Also add it to the public status page.

### 2. Sentry — "code threw"

Three Sentry projects (one per app) so issues stay isolated in the dashboard UI:

- **API** — `apps/api/src/services/sentry.service.ts` + boot init. Captures `uncaughtException`, `unhandledRejection`, Express errors. Env: `SENTRY_DSN` on Railway.
- **Storefront** (`apps/web`) — `sentry.{client,server,edge}.config.ts` + `instrumentation.ts`. Captures SSR throws, RSC errors, client hydration errors, browser uncaught errors, route-handler errors. Env: `NEXT_PUBLIC_SENTRY_DSN_WEB` on Vercel.
- **Admin** (`apps/admin`) — same shape. Env: `NEXT_PUBLIC_SENTRY_DSN_ADMIN` on Vercel.
- **No-op when DSN missing** (graceful in dev / preview / pre-account-creation).
- **Sample rates**: storefront `tracesSampleRate=0.1` in prod (high traffic), admin `1.0` (low volume, every trace is signal). Session replays fire only on errors, not on healthy sessions.

### 3. PostHog — product analytics

- **Apps wired**: `apps/web` (storefront) + `apps/admin`. SDK: `posthog-js` v1.373.4.
- **Env**: `NEXT_PUBLIC_POSTHOG_KEY` on Vercel (both projects). Optional `NEXT_PUBLIC_POSTHOG_HOST` (defaults to `https://eu.i.posthog.com`).
- **Consent gating**:
  - Storefront: gated on the marketing cookie consent (`consent.marketing === true`). Same gate as Meta / GA / TikTok pixels. Init fires only after the visitor accepts marketing cookies.
  - Admin: always-on (operator-only tool, no public visitors, no GDPR consent surface).
- **Privacy posture**: `ip: false`, `disable_session_recording: true`, `respect_dnt: true`. Anonymous distinct_id by default; call `posthog.identify(userId)` post-login to link sessions.
- **Captures**: pageviews on route change, autocapture clicks + form submits. Plus `captureEvent('event_name', {...})` helper for funnel instrumentation (checkout_started, add_to_cart, etc).

### 4. Telegram alerts service — "business logic P0/P1"

- **Bot**: `@ForceAI1_bot` (created via @BotFather, currently DMs Ahmad — chat_id `1943728711`)
- **Env vars (Railway)**:
  - `TELEGRAM_BOT_TOKEN` — API token from @BotFather
  - `TELEGRAM_ALERT_CHAT_ID` — chat to deliver to (DM = positive int; group = negative int)
- **Code**: `apps/api/src/services/alerts.service.ts` exports `sendAlert({ level, scope, store?, source, title, body?, context? })`
- **Levels**: `p0` (wake someone now) / `p1` (degraded, morning fine) / `info`
- **Scope-aware headers**: `[P0 PLATFORM]` vs `[P0 STORE]` so the operator sees scope at a glance; store-scoped alerts name the merchant in the body.
- **Throttle**: Redis-keyed per `sha1(level + title + storeId?)`, 5-min TTL — flapping events can't fan out 100 messages, and per-store throttling prevents store A's flaps from suppressing store B's genuinely-new alerts.
- **Graceful no-op**: missing env vars = single warn at boot, every send returns `'skipped'`
- **Wired call sites**:
  - `process.on('uncaughtException')` in `apps/api/src/index.ts` → P0 platform
  - Payment HMAC repeated fail (3+ in 5min via Redis counter) → P0 store-scoped (`payment.factory.ts`)
  - Inngest function failure past final retry → P1 platform (`alerts-failure-watch.ts` listening on `inngest/function.failed`)
  - `/api/v1/health` deep-check degradation → P1 platform (`index.ts`)

### 5. Log drain — Axiom via `@axiomhq/pino` transport (persistent log retention)

Railway's stdout buffer is ephemeral (~72h on the Pro plan, less on Hobby). Without a drain, any post-incident investigation older than 3 days is impossible.

**Why not Railway's native log drain feature**: Railway gates the dashboard "Log Drains" config behind the **Pro plan** ($20/mo per service). On Hobby/Trial the option isn't visible. To keep persistent logging working on any Railway plan, the API streams from inside the Node process via a pino transport — no Railway-level config required.

**Migration history**: Started on BetterStack 2026-05-14, migrated to Axiom 2026-05-15 because BetterStack's free tier retains only 3 days (violates CLAUDE.md rule 11). Axiom free tier retains 30 days at 500 GB/month, satisfying the rule at zero cost.

- **Provider**: **Axiom** free tier — 500 GB ingest/month, **30-day retention** (verified 2026-05-15)
- **Dataset**: `force-api-railway`
- **Transport**: `@axiomhq/pino` in `apps/api/src/lib/logger.ts` — pino multi-transport sends every log line to stdout AND Axiom in parallel (Railway logs UI keeps working untouched)
- **Env vars (Railway)**:
  - `AXIOM_TOKEN` — API token with **Ingest** scope, from `app.axiom.co` → Settings → API tokens
  - `AXIOM_DATASET` — dataset name, currently `force-api-railway`
- **Graceful no-op**: when either env var is missing the transport is omitted entirely; pino still writes to stdout
- **Redaction**: same pino redact rules apply to Axiom — auth headers, cookies, passwords, tokens, card numbers all masked before leaving the process
- **Setup** (one-time):
  1. Sign up at https://app.axiom.co/register → create dataset `force-api-railway`
  2. Settings → API tokens → create token with **Ingest** scope (name: `FWB API ingest`)
  3. Set `AXIOM_TOKEN` + `AXIOM_DATASET` env vars on Railway and redeploy
  4. Verify in Axiom Stream view within 30s — request log lines should land
- **What to expect**: every pino log line lands in Axiom within ~2 sec. Search by `request`, `Unhandled error`, request ID, etc. Axiom's APL query language is more powerful than BetterStack's for log filtering.
- **Implementation note**: the transport target uses `require.resolve('@axiomhq/pino')` (not the bare specifier) because pino's worker_threads.Worker can't always resolve ESM/CJS exports maps when given a bare package name. The absolute path always loads.

### 6. External-service-to-Telegram alert bridge

Sentry / Axiom / PostHog each have their own native notification channels (email, Slack, webhook), but none route to Telegram natively without paid plans. To keep the operator on **one notification channel** for everything, the API exposes a small translator that accepts each service's webhook payload and forwards via the existing `sendAlert()` Telegram pipeline.

- **Endpoints** (`apps/api/src/routes/alert-webhooks.routes.ts`):
  - `POST /api/v1/alerts/webhooks/sentry?token=<TOKEN>` — Sentry issue alert action → P1 platform
  - `POST /api/v1/alerts/webhooks/axiom?token=<TOKEN>` — Axiom monitor → P1 platform
  - `POST /api/v1/alerts/webhooks/posthog?token=<TOKEN>` — PostHog insight alert → P1 platform
  - `POST /api/v1/alerts/webhooks/generic?token=<TOKEN>` — `{title, body, level, source}` for any other service
- **Auth**: shared-secret token via querystring `?token=...` or header `x-alerts-token: ...`; gated on `ALERTS_WEBHOOK_TOKEN` env var on Railway. Token rotation = single Railway var change, no code touch.
- **Result**: regardless of which external service raised the alarm, it lands in the same `@ForceAI1_bot` Telegram chat with the same `[P1 PLATFORM]` header format as the internal call sites.
- **Configure per external service**:
  - **Sentry** → Project Settings → Alerts → Create Alert Rule → Action: "Send a notification via an integration" → Webhook → URL = `https://store-api.forcemediakw.com/api/v1/alerts/webhooks/sentry?token=<ALERTS_WEBHOOK_TOKEN>`
  - **Axiom** → dataset → Monitors → New monitor → Notifier: Webhook → URL = `https://store-api.forcemediakw.com/api/v1/alerts/webhooks/axiom?token=<ALERTS_WEBHOOK_TOKEN>`
  - **PostHog** → Insights → Subscriptions → Webhook URL = `https://store-api.forcemediakw.com/api/v1/alerts/webhooks/posthog?token=<ALERTS_WEBHOOK_TOKEN>`
- **What this does NOT do**: it doesn't replace each service's dashboard — Sentry issues still live in Sentry, etc. It only adds Telegram as a parallel notification channel for high-signal events.

### Verifying end-to-end

```bash
# 1. Fire a direct Telegram test (no API code involved)
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${TELEGRAM_ALERT_CHAT_ID}\",\"text\":\"smoke test\"}"

# 2. Confirm API health
curl https://store-api.forcemediakw.com/health

# 3. Trigger UptimeRobot manually: dashboard → monitor → "Test" → expect OK within 30s

# 4. Trigger Sentry from the storefront (paste into browser console on wadyaljuz.com):
#    throw new Error("sentry-storefront-smoke-test");
#    Issue should appear in Sentry dashboard within ~30s.

# 5. Trigger PostHog event capture from the admin (paste into browser console):
#    window.posthog?.capture('admin_smoke_test', {at: new Date().toISOString()});
#    Event lands in PostHog → Live Events within ~5s.
```

### Alert SLA

- **P0** (server unreachable, payment HMAC repeated fail, data loss): respond within 15 min, 24/7
- **P1** (degraded, AI quota exhausted, cron failed past final retry, deep-health degraded): respond within 4 hours
- **Info** (deploy notifications, scheduled job summaries): no SLA

### Cloud cost alerts (added 2026-05-15 per iceberg audit Quick Win #4)

Each hosting/data provider's billing dashboard fires an email to the account owner when spend or usage crosses a threshold. A runaway AI sweep, bot scrape, or cron loop can otherwise spike costs 10× silently. Verified per-provider:

| Provider | Alert           | Threshold                        |
| -------- | --------------- | -------------------------------- |
| Railway  | Budget alert    | spend > 80% of monthly budget    |
| Neon     | Compute credits | usage > 80% of monthly credits   |
| Vercel   | Spending limit  | hard cap configured in dashboard |

Renewal verification: re-check these in the per-provider dashboard quarterly — providers occasionally migrate billing UIs and silently drop alert rules.

### Account ownership

| Service                | Account email            | Project / org                                         |
| ---------------------- | ------------------------ | ----------------------------------------------------- |
| Vercel                 | ahmed0montaser@gmail.com | Hobby plan, sole owner                                |
| Railway                | ahmed0montaser@gmail.com | personal project `force-website-builder`              |
| Neon                   | ahmed0montaser@gmail.com | project `ep-falling-meadow-a1uq2yil` (ap-southeast-1) |
| Sentry                 | (Ahmad's account)        | one org with three projects: `api`, `web`, `admin`    |
| PostHog                | (Ahmad's account)        | EU region, single project covering web + admin        |
| UptimeRobot            | (Ahmad's account)        | free tier, 2 monitors currently                       |
| Axiom                  | (Ahmad's account)        | free tier (500GB/30d) — dataset `force-api-railway`   |
| Resend                 | platform-wide            | one account; per-merchant domains added under it      |
| @ForceAI1_bot Telegram | personal DM to Ahmad     | chat_id `1943728711`                                  |

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
