# Force Website Builder - Production Deployment Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE (Free)                        │
│  ┌─────────────────────┐  ┌─────────────────────┐          │
│  │   Pages: Web App    │  │  Pages: Admin App   │          │
│  │   store.domain.com  │  │  admin.domain.com   │          │
│  └─────────────────────┘  └─────────────────────┘          │
│  ┌─────────────────────┐                                   │
│  │   R2: File Storage  │  cdn.domain.com                   │
│  └─────────────────────┘                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    RAILWAY (~$50/mo)                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Express.js API                          │   │
│  │              api.domain.com                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    SUPABASE (~$75/mo)                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              PostgreSQL Database                     │   │
│  │              Pro Plan + Medium Compute               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

Estimated Monthly Cost: $125-150
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

## Cost Summary

| Service          | Plan          | Monthly Cost     |
| ---------------- | ------------- | ---------------- |
| Railway          | Pro           | $20 + ~$30 usage |
| Supabase         | Pro + Medium  | $75              |
| Cloudflare Pages | Free          | $0               |
| Cloudflare R2    | Pay-as-you-go | ~$5-10           |
| **Total**        |               | **~$130-140**    |

---

## Support Contacts

- Railway: support@railway.app
- Cloudflare: Enterprise support or community forums
- Supabase: support@supabase.io

---

## Observability & Alerts

Five orthogonal channels cover production failure modes per
`~/.claude/CLAUDE.md` Production Reality gates rules #6 + #7. Each
catches something the others can't.

### 1. UptimeRobot — "process is gone / URL unreachable"

- **Dashboard**: https://uptimerobot.com
- **Active monitors**:
  - `FWB API` → `https://store-api.forcemediakw.com/health` — HTTPS, 5-min interval, 30s timeout, alert on 2 consecutive failures
  - `FWB store · wadyaljuz.com` → `https://wadyaljuz.com` — same settings
- **Alert routing**: UptimeRobot mobile app push (instant on iPhone/Android, free tier, replaces Telegram which is paid-tier on UptimeRobot). The bridge to Telegram is via the in-API channel below for code-level alerts.
- **Adding a new merchant**: clone the existing storefront monitor, swap the URL to the merchant's domain, name it `FWB store · <slug>`. Attach the same mobile-push alert contact.

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

### 5. Log drain — BetterStack (persistent log retention)

Railway's stdout buffer is ephemeral (~72h on the Pro plan, less on Hobby). Without a drain, any post-incident investigation older than 3 days is impossible.

- **Provider**: BetterStack (free tier covers 3 GB ingest/month, 3-day retention; paid plan extends both)
- **Setup** (one-time, ~10 min — Ahmad's account work):
  1. Sign up at https://betterstack.com → create a "Logs" source
  2. Copy the **HTTP ingestion URL** (looks like `https://s1234567.eu-nbg-2.betterstackdata.com`) and the **source token**
  3. Railway dashboard → `api` service → Settings → **Log Drains** → Add → paste the HTTP URL with the token as a header
  4. Verify ~5 min after: BetterStack Logs view shows live entries
- **What to expect**: every stdout/stderr line from the Railway API service (request logs from pino, prisma errors, etc) lands in BetterStack within ~2 sec. Search + filter + 3-day retention free.
- **Future**: add a second log drain for Vercel storefront + admin once the platform grows. Vercel offers its own log drains feature on Pro plan.

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

### Account ownership

| Service                | Account email            | Project / org                                         |
| ---------------------- | ------------------------ | ----------------------------------------------------- |
| Vercel                 | ahmed0montaser@gmail.com | Hobby plan, sole owner                                |
| Railway                | ahmed0montaser@gmail.com | personal project `force-website-builder`              |
| Neon                   | ahmed0montaser@gmail.com | project `ep-falling-meadow-a1uq2yil` (ap-southeast-1) |
| Sentry                 | (Ahmad's account)        | one org with three projects: `api`, `web`, `admin`    |
| PostHog                | (Ahmad's account)        | EU region, single project covering web + admin        |
| UptimeRobot            | (Ahmad's account)        | free tier, 2 monitors currently                       |
| BetterStack            | (Ahmad's account)        | free tier — log source for `api` service              |
| Resend                 | platform-wide            | one account; per-merchant domains added under it      |
| @ForceAI1_bot Telegram | personal DM to Ahmad     | chat_id `1943728711`                                  |
