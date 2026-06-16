# Force Website Builder

Multi-tenant SaaS e-commerce platform by Force Media. Provision and manage multiple online stores — each with its own admin, storefront, products, orders, and customers.

> **Proprietary commercial software.** © 2026 Force Media. All rights reserved.
> This is closed-source software developed for and operated by Force Media.
> Access to the repository is granted to authorized contributors only — see
> [LICENSE](./LICENSE) for terms. No part of this code may be copied,
> redistributed, hosted, or used to build derivative or competing works
> without the prior written permission of Force Media.

## What shipped in the 2026-05-22/23 session

Major capabilities added across this session (commit SHAs for reference):

| Capability                                                                           | Key commits                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Phase 6 WhatsApp customer DM ordering bridge                                         | (phase 6 base)                              |
| Phase 7 template sync + FWB-driven template management                               | `3fee59a` (WBS)                             |
| Phase 7.1 master WhatsApp tab — 4 cards → 1 consolidated page                        | `f100656e`                                  |
| Bot intelligence Phase 1–5 (intent, catalog cache, voice, image, history, analytics) | `0434afc1` `dafeb3bf` `a81e86dd` `bf4881d5` |
| Multi-provider payment links (Tap / MyFatoorah / Hesabe / UPayments)                 | `fe129e8b`                                  |
| Cart abandoned unification — website carts + WA DM carts in one sweep                | `9cdd4062`                                  |
| Date window pickers across Finance, Orders, Stock, Bot Analytics                     | `fe8b0731` `8491a91e` `07be5ebd`            |
| XLSX exports — finance reports, newsletter, bulk products                            | `5d720e44` `bb9074fb`                       |
| Newsletter broadcast + Affiliate invite button                                       | `b1e2e0dd`                                  |
| Settings discoverability chips (connected/DM-ordering state on card)                 | `917a268a`                                  |
| Origin-aware order email skip (WhatsApp-origin → WA-only, no placeholder email)      | `115e76a7`                                  |
| Version-agnostic template lookup (strip `_v2` suffix, auto-recover after reject)     | `1507ef67`                                  |
| Inngest mark-running-first (unambiguous job state)                                   | `46269715`                                  |
| Inngest auto-reaper for stuck-running jobs (queue-depth-watch 15-min cron)           | `8c229e2b`                                  |
| Service worker pre-registration (Chromium 133+ deprecation fix)                      | `91d735cf`                                  |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    FORCE MEDIA (Super Admin)                      │
│                                                                  │
│  Provision stores · Platform analytics · User management         │
│  Feature toggles · Audit logs · Billing                          │
└──────────────────────────┬───────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │  Store A    │ │  Store B    │ │  Store C    │
    │  (Owner A)  │ │  (Owner B)  │ │  (Owner C)  │
    ├─────────────┤ ├─────────────┤ ├─────────────┤
    │ Products    │ │ Products    │ │ Products    │
    │ Orders      │ │ Orders      │ │ Orders      │
    │ Customers   │ │ Customers   │ │ Customers   │
    │ Analytics   │ │ Analytics   │ │ Analytics   │
    │ Notifications│ │ Notifications│ │ Notifications│
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │ Storefront A│ │ Storefront B│ │ Storefront C│
    │ store-a.com │ │ store-b.com │ │ store-c.com │
    └─────────────┘ └─────────────┘ └─────────────┘
```

## Tech Stack

| Layer               | Technology                                                 |
| ------------------- | ---------------------------------------------------------- |
| **API**             | Express.js 4 + TypeScript                                  |
| **Admin Dashboard** | Next.js 16 (App Router)                                    |
| **Orders PWA**      | Next.js 16 (App Router) — installable focus-mode order app |
| **Storefront**      | Next.js 16 (App Router)                                    |
| **Database**        | Neon PostgreSQL (serverless) + Prisma ORM (83 models)      |
| **Cache & Queues**  | Redis                                                      |
| **Storage**         | Cloudflare R2 (S3-compatible)                              |
| **Real-time**       | Socket.io (WebSocket notifications)                        |
| **Auth**            | Custom JWT (HTTP-only cookies, cross-origin)               |
| **Validation**      | Zod                                                        |
| **UI**              | Tailwind CSS + shared component library (@force/ui)        |
| **Async Jobs**      | Inngest (30+ functions, cloud-hosted step functions)       |
| **Push**            | OneSignal + Web Push (VAPID dual-stack)                    |
| **Email**           | Resend (transactional)                                     |
| **Error Tracking**  | Sentry (three projects: api / admin / web)                 |
| **Logging**         | Pino + Axiom drain (30-day retention)                      |
| **Analytics**       | PostHog (storefront + admin)                               |
| **Testing**         | Vitest (497+ tests)                                        |

## Project Structure

```
force-website-builder/
├── apps/
│   ├── api/            # Express.js API server (Railway)
│   ├── admin/          # Admin dashboard (Vercel)
│   └── web/            # Customer storefront (Vercel)
├── packages/
│   ├── database/       # Prisma schema & client (@force/database)
│   ├── shared/         # Types, Zod schemas, constants (@force/shared)
│   ├── ui/             # Shared UI components (@force/ui)
│   └── config/         # Shared configurations (@force/config)
├── tests/              # Unit, integration & e2e tests
├── docker/             # Docker Compose for local dev
├── docs/               # Documentation
└── scripts/            # Utility scripts
```

## Features

### Platform

- **Multi-tenancy** — Row-Level Security (RLS) via AsyncLocalStorage + Prisma Proxy, automatic tenant scoping on all queries
- **Feature Toggle Engine** — 22 parent features + 14 inventory/accounting sub-features across 4 plan tiers (free / starter / professional / enterprise), with Redis-cached lookups; see `packages/shared/src/features.ts` (FEATURE_KEYS_ARRAY) and `packages/shared/src/plan-baselines.ts`
- **Plan Tier System** — four tiers (free / starter / professional / enterprise) with layered feature baselines; upgrade-marketing gate shows on-brand upsell page for plan-gated features; see `packages/shared/src/plan-baselines.ts`
- **Custom Domains** — Store owners add custom domains via admin UI; auto-registered on Vercel with SSL
- **Role-Based Access** — Super Admin (platform-wide), Store Admin (single store), Customer (storefront)

### Commerce

- **Product Management** — Categories, variants, inventory tracking, image galleries
- **Product Discount Engine** — Per-product discount dropdown (None / Percentage % / Fixed KWD) with live discounted-price preview; `compareAtPrice` is derived automatically from the active discount
- **Accounting Module** — Chart of Accounts, double-entry journal entries (auto-posted on paid orders), P&L, expense tracking, invoicing (Professional+); advanced features — tax reports, multi-currency, profit anomaly watch, bank reconciliation — on Enterprise+
- **Order Lifecycle** — Cart, checkout, payment processing, status transitions with notification triggers
- **Abandoned Cart Recovery** — Automated recovery flows via WhatsApp/SMS/Push
- **Upsell & Cross-sell** — Product recommendations engine
- **Affiliate / Influencer Program** — Tracking, commissions, referral links
- **Search Autocomplete** — Enhanced product search with suggestions

### Communication Hub

- **WhatsApp** — Meta Cloud API integration with Redis queue + circuit breaker. Includes customer DM ordering bot (see below).
- **SMS** — Unifonic API with Redis queue + circuit breaker
- **Push Notifications** — W3C Web Push (VAPID), browser subscriptions
- **Per-event, per-channel toggles** — Each store controls which events trigger which channels
- **Origin-aware delivery** — website orders send email + WhatsApp; WhatsApp-origin orders send WhatsApp only; abandoned cart recovery sweeps both origin types

### Bot Intelligence (Phase 8)

The Force AI WhatsApp Business Platform (WBS) hosts the bot engine. Force AI Store exposes a proxy layer (`apps/api/src/routes/wa-bridge.routes.ts`) that WBS calls to:

1. **Read the catalog** — categories, products, and inventory in real time
2. **Enumerate abandoned WhatsApp carts** — unified cart recovery sweeps website + WhatsApp DM carts
3. **Toggle DM ordering per-store** — enable/disable the bot from the Force AI Store admin
4. **Proxy bot analytics** — the Force AI Store admin Bot Analytics tab reads the WBS funnel data via this bridge

The Gemini AI models live entirely in WBS (`GEMINI_API_KEY` env var on the Railway WBS service). Force AI Store's `apps/api/src/services/ai.service.ts` uses `GOOGLE_GENERATIVE_AI_KEY` for catalog content tasks (translate, SEO, category suggestion). These are two separate keys and two separate call paths:

| Key                        | Service            | Used for                                                                               |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `GOOGLE_GENERATIVE_AI_KEY` | Force AI Store API | Translation, SEO generation, category suggestion, FAQ generation, review summarization |
| `GEMINI_API_KEY`           | WBS API            | Bot intent classification, voice transcription, product photo matching                 |

The bot degrades gracefully: if `GEMINI_API_KEY` is unset in WBS, the bot reverts to legacy keyword mode (still functional, no natural language understanding).

### Shipping

- **Carrier Integrations** — iCarry and Aramex with rate calculation and tracking

### Storefront

- **5 Pre-built Templates** — Modern, Classic, Minimal, Bold, Elegant — each with a distinct design identity
- **Dark Mode** — System `prefers-color-scheme` detection + manual toggle
- **RTL / Bilingual** — Arabic + English with full RTL layout support
- **PWA** — Service worker with push notification support
- **SEO** — Sitemap, robots.txt, JSON-LD structured data, meta descriptions, Open Graph

## Deployment

| Service         | Platform      | URL                                  |
| --------------- | ------------- | ------------------------------------ |
| API             | Railway       | `api-production-c058.up.railway.app` |
| Admin Dashboard | Vercel        | `app.forcemediakw.com`               |
| Storefront      | Vercel        | `wadyaljuz.com` (flagship tenant)    |
| Database        | Neon          | Serverless PostgreSQL                |
| Redis           | Railway       | Internal network                     |
| Storage         | Cloudflare R2 | Public bucket via `*.r2.dev`         |

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- npm >= 9.0.0
- Docker & Docker Compose (for local infrastructure)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Start local infrastructure (PostgreSQL, Redis)
npm run docker:up

# 3. Configure environment
cp .env.example .env

# 4. Generate Prisma client and run migrations
npm run db:generate
npm run db:migrate

# 5. Seed the database (optional)
npm run db:seed

# 6. Start all dev servers
npm run dev
```

### Neon CLI (prod ops)

For managing the production Neon DB from your machine (preview branches, snapshot restores, connection strings):

```bash
npx neonctl@latest init   # one-time per machine — opens browser, signs into the project's Neon account
```

After init, `npx neonctl@latest projects list`, `npx neonctl@latest branches create`, etc. work directly.

> **DR note (2026-06-08):** Per-commit Neon snapshot branches (`neon-snapshot.yml`) are **retired** — they were accumulating branch cost without auto-pruning. DB backups are now taken via daily local `pg_dump` (launchd `com.forceai.neon-backup` on the dev Mac, retention 30 days at `~/Desktop/projects/_backups/force-website-builder/`). See `docs/ROLLBACK.md` §C for the restore procedure.

### Environment Variables

**API (Railway)** — required:

| Variable                   | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`             | Neon PostgreSQL connection string                              |
| `JWT_SECRET`               | Min 32 characters                                              |
| `ENCRYPTION_KEY`           | Min 32 characters                                              |
| `VAPID_PUBLIC_KEY`         | Web Push public key                                            |
| `VAPID_PRIVATE_KEY`        | Web Push private key                                           |
| `VAPID_SUBJECT`            | Web Push contact (e.g. `mailto:...`)                           |
| `VERCEL_API_TOKEN`         | For custom domain registration                                 |
| `VERCEL_PROJECT_ID`        | Storefront project ID                                          |
| `GOOGLE_GENERATIVE_AI_KEY` | Gemini Flash Lite — translation, SEO, AEO, category suggestion |

**Note on AI keys:** `GOOGLE_GENERATIVE_AI_KEY` is for Force AI Store's own catalog AI features. The WhatsApp bot AI (`GEMINI_API_KEY`) lives in the WBS Railway service — not here. See Bot Intelligence section above for details.

**Admin & Storefront (Vercel):**

| Variable                       | Description                           |
| ------------------------------ | ------------------------------------- |
| `NEXT_PUBLIC_API_URL`          | Railway API URL                       |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web Push public key (storefront only) |

## Scripts

| Command                 | Description                        |
| ----------------------- | ---------------------------------- |
| `npm run dev`           | Start all apps in development mode |
| `npm run dev:api`       | Start API server only              |
| `npm run dev:admin`     | Start admin dashboard only         |
| `npm run dev:web`       | Start storefront only              |
| `npm run build`         | Build all apps for production      |
| `npm run test`          | Run all tests (Vitest)             |
| `npm run test:watch`    | Run tests in watch mode            |
| `npm run test:coverage` | Run tests with coverage            |
| `npm run lint`          | Lint all workspaces                |
| `npm run format`        | Format with Prettier               |
| `npm run typecheck`     | TypeScript type checking           |
| `npm run db:generate`   | Generate Prisma client             |
| `npm run db:migrate`    | Run database migrations            |
| `npm run db:studio`     | Open Prisma Studio                 |
| `npm run docker:up`     | Start Docker services              |
| `npm run docker:down`   | Stop Docker services               |

## Ports (Local Development)

| Service         | Port |
| --------------- | ---- |
| Storefront      | 3000 |
| Admin Dashboard | 3001 |
| API Server      | 4000 |
| PostgreSQL      | 5432 |
| Redis           | 6379 |

## Security

- **Row-Level Security (RLS)** — Database-level tenant isolation via PostgreSQL RLS policies
- **CSRF Protection** — Token-based, skips auth routes
- **Input Validation** — Zod schemas on all API endpoints
- **JWT Auth** — HTTP-only cookies, algorithm pinned to HS256
- **Rate Limiting** — 5 auth attempts per 15 min per IP+email
- **Upload Safety** — SVG uploads blocked (XSS vector)
- **UUID Validation** — All entity IDs validated before database queries

## User Roles

| Role            | Scope        | Access                                                          |
| --------------- | ------------ | --------------------------------------------------------------- |
| **Super Admin** | Platform     | Provision stores, manage all data, feature toggles, audit logs  |
| **Store Admin** | Single store | Products, orders, customers, settings, analytics, notifications |
| **Customer**    | Storefront   | Browse, purchase, manage account, wishlists                     |

## Branding & PWA

**Two distinct brand surfaces:**

- **Admin (`app.forcemediakw.com`)** — uses the unified Force operator brand: orange `#FF6E00` tile + white "FSA" (Force AI Store Admin) wordmark, shared favicon template with [Force Media CRM](https://github.com/ForceAI-KW/Force-Media-CRM) and [WhatsApp Bulk Sender](https://github.com/ForceAI-KW/whatsapp-broadcaster). Sources: `apps/admin/public/favicon.svg`, generator at `apps/admin/scripts/generate-pwa-icons.mjs`, dynamic manifest at `apps/admin/src/app/manifest.ts`.
- **Storefront (`store.forcemediakw.com`)** — **per-tenant branding**: each merchant's logo, theme color, and PWA name flow through `apps/web/src/app/manifest.ts` (dynamic, host-resolved) backed by `apps/api/src/services/pwa.service.ts::generateManifest`. Today supports 192 + 512 icons per store; the plan to extend to the full 6-size set via single-source upload + sharp auto-generation lives at `docs/superpowers/plans/2026-05-04-storefront-per-store-pwa-full-sizes.md`.

See also:

- `docs/SCALING.md` — Railway replica readiness, Redis adapter, cron leader-election
- `docs/business/` — business docs: feature catalog, pricing framework, competitive positioning, pitch deck, FAQ
- `docs/superpowers/plans/2026-05-04-cost-reduction.md` — Google AI cap (env-var daily/monthly limits) + Neon compute reduction notes

## License

Proprietary - Force Media
