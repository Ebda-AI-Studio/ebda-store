# Force Website Builder

Multi-tenant SaaS e-commerce platform by Force Media. Provision and manage multiple online stores — each with its own admin, storefront, products, orders, and customers.

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

| Layer               | Technology                                            |
| ------------------- | ----------------------------------------------------- |
| **API**             | Express.js 4 + TypeScript                             |
| **Admin Dashboard** | Next.js 16 (App Router)                               |
| **Storefront**      | Next.js 16 (App Router)                               |
| **Database**        | Neon PostgreSQL (serverless) + Prisma ORM (51 models) |
| **Cache & Queues**  | Redis                                                 |
| **Storage**         | Cloudflare R2 (S3-compatible)                         |
| **Real-time**       | Socket.io (WebSocket notifications)                   |
| **Auth**            | Custom JWT (HTTP-only cookies, cross-origin)          |
| **Validation**      | Zod                                                   |
| **UI**              | Tailwind CSS + shared component library (@force/ui)   |
| **Testing**         | Vitest (332+ tests)                                   |

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
- **Feature Toggle Engine** — 21 per-store toggleable features with Redis-cached lookups
- **Custom Domains** — Store owners add custom domains via admin UI; auto-registered on Vercel with SSL
- **Role-Based Access** — Super Admin (platform-wide), Store Admin (single store), Customer (storefront)

### Commerce

- **Product Management** — Categories, variants, inventory tracking, image galleries
- **Order Lifecycle** — Cart, checkout, payment processing, status transitions with notification triggers
- **Abandoned Cart Recovery** — Automated recovery flows via WhatsApp/SMS/Push
- **Upsell & Cross-sell** — Product recommendations engine
- **Affiliate / Influencer Program** — Tracking, commissions, referral links
- **Search Autocomplete** — Enhanced product search with suggestions

### Communication Hub

- **WhatsApp** — Meta Cloud API integration with Redis queue + circuit breaker
- **SMS** — Unifonic API with Redis queue + circuit breaker
- **Push Notifications** — W3C Web Push (VAPID), browser subscriptions
- **Per-event, per-channel toggles** — Each store controls which events trigger which channels

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
| Admin Dashboard | Vercel        | `force-admin-seven.vercel.app`       |
| Storefront      | Vercel        | `force-web-sigma.vercel.app`         |
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

### Environment Variables

**API (Railway)** — required:

| Variable            | Description                          |
| ------------------- | ------------------------------------ |
| `DATABASE_URL`      | Neon PostgreSQL connection string    |
| `JWT_SECRET`        | Min 32 characters                    |
| `ENCRYPTION_KEY`    | Min 32 characters                    |
| `VAPID_PUBLIC_KEY`  | Web Push public key                  |
| `VAPID_PRIVATE_KEY` | Web Push private key                 |
| `VAPID_SUBJECT`     | Web Push contact (e.g. `mailto:...`) |
| `VERCEL_API_TOKEN`  | For custom domain registration       |
| `VERCEL_PROJECT_ID` | Storefront project ID                |

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

## License

Proprietary - Force Media
