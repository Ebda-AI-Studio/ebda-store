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

## Monitoring & Alerts

Three orthogonal channels cover production failure modes per
`~/.claude/CLAUDE.md` Production Reality gates rule #6. Each catches
something the others can't.

### 1. UptimeRobot — "process is gone / API unreachable"

- **Dashboard**: https://uptimerobot.com
- **Monitor**: `FWB API` → `https://store-api.forcemediakw.com/health`, HTTPS, 5-min interval, 30s timeout, alert on 2 consecutive failures
- **Optional second monitor**: `https://store.forcemediakw.com/wady-aljuz` for the storefront SSR layer
- **Alert contact**: Telegram (uses the same bot + chat_id as the in-API channel below)

### 2. Sentry — "code threw"

- **Wired**: `apps/api/src/services/sentry.service.ts` + `apps/api/src/index.ts` (boot init, captures `uncaughtException` + `unhandledRejection`)
- **Env**: `SENTRY_DSN` on Railway. Falls back to log-only when missing.

### 3. Telegram alerts service — "business logic P0"

- **Bot**: `@ForceAI1_bot` (created via @BotFather, currently DMs Ahmad)
- **Env vars (Railway)**:
  - `TELEGRAM_BOT_TOKEN` — API token from @BotFather
  - `TELEGRAM_ALERT_CHAT_ID` — chat to deliver to (DM = positive int; group = negative int)
- **Code**: `apps/api/src/services/alerts.service.ts` exports `sendAlert({ level, title, body?, context? })`
- **Levels**: `p0` (wake someone now) / `p1` (degraded, morning fine) / `info`
- **Throttle**: Redis-keyed per `sha1(level + title)`, 5-min TTL — flapping events can't fan out 100 messages
- **Graceful no-op**: missing env vars = single warn at boot + every send returns `'skipped'`
- **Wired call sites**: `process.on('uncaughtException')` in `apps/api/src/index.ts`. Follow-ups deferred: payment HMAC repeated fail, Inngest dead-letter, `/api/v1/health` deep-check failure

### Verifying end-to-end

```bash
# Fire a direct Telegram test (no API code involved)
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${TELEGRAM_ALERT_CHAT_ID}\",\"text\":\"smoke test\"}"

# Confirm API health
curl https://store-api.forcemediakw.com/health

# Trigger UptimeRobot manually: dashboard → monitor → "Test" → expect OK within 30s
```

### Alert SLA

- **P0** (server unreachable, payment HMAC repeated fail, data loss): respond within 15 min, 24/7
- **P1** (degraded, AI quota exhausted, cron failed past final retry): respond within 4 hours
- **Info** (deploy notifications, scheduled job summaries): no SLA

### Log retention — still outstanding

Railway stdout logs are ephemeral (~72h). A log drain to BetterStack /
Logtail / Axiom must be configured before any merchant goes live per
`~/.claude/CLAUDE.md` rule #7. Tracked as iceberg item #11.
