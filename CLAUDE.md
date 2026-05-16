# Force Website Builder - Project Guidelines

## Sizing rules — read `design.md` FIRST

Ahmad's standing preference (codified 2026-05-16): **default to compact ecommerce
sizing on both desktop and mobile.** Cards, logos, paddings, gaps — when in
doubt, lean smaller. Industry benchmark is pecannbee.com.kw + bank-alkahraman.com

- similar Kuwait/GCC stores.

**Before changing any size-related class (max-w, h-, p-, gap-, aspect-),
read `design.md` in the repo root.** That file is the single source of truth
for size baselines (product card 180-220px desktop / 150-180px mobile,
category card 140-180px, logo h-14 mobile / h-20 desktop, etc.). Anti-patterns
and the "still too big" diagnosis recipe are documented there too.

If `design.md` is missing from a future session's project root, recreate it
from the project memory `feedback-fwb-sizing-rules.md` (or ask Ahmad to point
to the latest version).

## Platform-level fixes — applies to every change in this repo

**Every UI/UX/feature change MUST be platform-level. NEVER tenant-scoped, NEVER theme-specific without an explicit reason.**

When Ahmad reports a bug or asks for a feature, the fix MUST land in a place where every store inherits it automatically. Concrete enforcement:

1. **Product-card UX changes** → must hit ALL 3 render paths:
   - `apps/web/src/templates/shared/PecannbeeProductCard.tsx` (PLP / search / category listings)
   - `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx` (5 theme grids)
   - `apps/web/src/templates/shared/ProductCarousel.tsx` (HOMEPAGE new-arrivals + best-sellers carousels)

   Grep the 7 files; if the new pattern doesn't appear in all 7, it isn't shipped. See `feedback-fwb-three-product-render-paths.md`.

2. **Header / footer / nav changes** → must hit ALL 5 themes (`modern/elegant/classic/minimal/bold`). Modern is wadyaljuz's theme so it ships first, but the same commit batch or an immediate follow-up MUST land the same pattern in the other 4.

3. **Storefront copy / labels** → goes in `apps/web/src/contexts/LanguageContext.tsx` (the `translations` map) so EN + AR are platform-level. Never hardcode user-facing strings in a theme.

4. **Schema / API / business-logic changes** → live in `apps/api` + `packages/database` and serve every tenant via the existing per-store scoping (`storeId` everywhere). Never branch on a specific `store.slug`.

5. **Admin tooling** → built once in `apps/admin` and works for every store the admin owns. Never wire a feature to a specific tenant ID.

**The rule's purpose:** stores inherit improvements automatically. A merchant who joins next month gets every fix shipped before they signed up. No tenant should ever ask "can you fix that for my store?" — the fix is already live for them.

**Anti-patterns to refuse:** "let's just ship this on wadyaljuz first and roll it out later", "make this a setting for store X only", "hardcode this for the demo tenant". If a request would create tenant-specific code, pause and flag it. The exception is per-tenant CONFIG (theme choice, brand colors, hero image) which is data, not code.

## Tech Stack

- **API**: Express.js + TypeScript (apps/api)
- **Admin Dashboard**: Next.js 16 + App Router (apps/admin) — `next-intl` for i18n
- **Storefront**: Next.js 16 + App Router (apps/web)
- **ORM**: Prisma (packages/database)
- **Database**: Neon PostgreSQL (serverless)
- **Storage**: Cloudflare R2 (S3-compatible, public bucket via `*.r2.dev`)
- **Cache**: Redis (Railway internal)
- **UI Components**: Shared package (@force/ui) with Tailwind CSS
- **Validation**: Zod (shared schemas in @force/shared)
- **Auth**: Custom JWT (HTTP-only cookies, cross-origin with SameSite=None)
- **Real-time**: Socket.io (WebSocket notifications)
- **Async queue**: Inngest (bulk AI sweeps, order-created fanout, abandoned-cart, etc.)
- **AI**: Google Gemini (`gemini-flash-lite-latest`) — translation, SEO, categorization with daily/monthly quota caps + 2.5s bulk throttle
- **Push notifications**: dual-stack — `web-push` (VAPID, RFC 8030) for storefront and OneSignal (admin order alerts + storefront broadcast layer)
- **Email**: Resend SDK via `resend.service.ts` (per-store branded sender with platform fallback) + `email-queue.service.ts` for retry/replay
- **Error monitoring**: Sentry (`@sentry/node` + profiling)
- **Logging**: `pino` (structured JSON logs, `pino-pretty` in dev)
- **Payment providers**: Tap, MyFatoorah, Hesabe, UPayments (Kuwait — Stripe doesn't work locally)

## Architecture

### Monorepo Structure (npm workspaces)

```
apps/
  api/          → Express.js API (Railway) - port from PORT env var
  admin/        → Next.js admin dashboard (Vercel)
  web/          → Next.js storefront (Vercel)
packages/
  database/     → Prisma ORM + schema (@force/database)
  shared/       → Shared types, utils, constants (@force/shared)
  ui/           → Shared UI components (@force/ui)
  config/       → Shared config (@force/config)
```

### Deployment

- **API**: Railway (Railpack build, NOT Dockerfile) at `api-production-c058.up.railway.app`
- **Admin**: Vercel at `force-admin-seven.vercel.app`
- **Web**: Vercel at `force-web-sigma.vercel.app`
- **Database**: Neon PostgreSQL (serverless) — local .env has stale Supabase URL, production uses Neon
- **Redis**: Railway internal (`redis.railway.internal:6379`)
- **Storage**: Cloudflare R2 (public bucket `*.r2.dev`, NOT `*.r2.cloudflarestorage.com`)

### Domain Boundaries

- `backend.forcemediakw.com` belongs to the **WhatsApp Bulk Sender** project, NOT this one
- This project's API domain: `api-production-c058.up.railway.app`

## Critical Architecture Decisions

### Authentication Flow (Cross-Origin)

The API and frontends are on **different domains**. This has major implications:

1. **HTTP-only cookies set by the API are scoped to the API domain** — Next.js middleware on Vercel CANNOT read them
2. **Server-side route protection via middleware is NOT possible** with the current setup
3. **All auth protection is client-side** via `AuthProvider` in each frontend app
4. **Do NOT add cookie-based auth checks in Next.js middleware** — they will cause redirect loops
5. Cross-origin cookies require `credentials: 'include'` on fetch AND `Access-Control-Allow-Credentials: true` from the API
6. The API must set cookies with `SameSite=None; Secure` for cross-origin to work

### Single Source of Truth Patterns

- **Auth state**: `AuthProvider` (`lib/auth.tsx`) is the ONLY auth checker. Individual pages must NOT duplicate auth checks or call `/auth/me` independently.
- **Store context (admin)**: `StoreContext` provides store list. Don't fetch `/admin/stores` elsewhere.
- **Store context (web)**: `StoreContext` provides current store. Don't fetch store info elsewhere.
- **API calls**: Use `apiGet`/`apiPost`/`apiPut`/`apiDelete` from `lib/api.ts`. Only use raw `fetch()` for file downloads or server components.

### Async Work (Inngest)

Anything `>300ms` or that calls a 3rd-party (Gemini, OneSignal, Vercel domains, SMTP) goes through `apps/api/src/lib/inngest`. Functions live in `lib/inngest/functions/` and are registered via `lib/inngest/client.ts`. Patterns:

- Mark a job as `failed` on enqueue error so retries surface in the UI (see commit `205b84b`).
- Bulk AI sweeps throttle at `AI_BULK_THROTTLE_MS` to stay under Gemini free-tier RPM (commit `6e8b5cb`).
- Cap AI calls per-day / per-month via `AI_DAILY_REQUEST_CAP` / `AI_MONTHLY_REQUEST_CAP` (`lib/ai-quota.ts`) so a single sweep can't brick the day's quota.

### Redis Cache TTL Floor

Short Redis TTLs (<120s) hammer Neon compute on cache miss. ESLint rule blocks them — `feedback-rollback-recipe.md` and commit `b6e6cd7`. If you need a sub-2-min cache, use the in-memory `bounded-map.ts` instead.

### Tenant Isolation (RLS)

`apps/api/src/middleware/tenant-context.ts` uses AsyncLocalStorage (`runInTenantContext`) to set the Postgres session GUC that RLS policies read. After any Neon snapshot restore, re-verify policy state — the runtime depends on the policy shape being intact.

### Railway Build (Railpack)

Railway uses Railpack despite `railway.json` saying Dockerfile. Key implications:

- `prisma generate` must be in the database package build script (`"build": "prisma generate && tsc"`)
- Root `railway.json` must have `startCommand` pointing to `node apps/api/dist/index.js`
- The API reads `PORT` env var (set by Railway), falling back to `API_PORT` then `4000`
- Build runs `npm run build` across ALL workspaces

## Route Authorization Pattern

Every admin route MUST use this middleware chain:

```
authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess → handler
```

- **`authenticate`**: Verifies JWT token, sets `req.user`
- **`authorize(...roles)`**: Checks `req.user.role` against allowed roles (use this, NOT `requireRole`)
- **`requireStoreAccess`**: Verifies user owns the store (or is super_admin). Reads `req.params.id` or `req.params.storeId`

**Rules:**

- Use `authorize()` for role checks, NOT `requireRole()` — standardized across all routes
- Every endpoint with a storeId param MUST have `requireStoreAccess` (prevents cross-store access)
- Public endpoints (no auth) should NOT have `requireStoreAccess`
- JWT access tokens last 7 days — stale role requires re-login

## Code Standards

### API (`apps/api`)

- TypeScript with relaxed strict mode (`strict: false`, `noImplicitAny: false` in tsconfig)
- Express.js with structured error handling via `errorHandler` middleware
- CSRF protection skips `/auth/` routes (they use JWT, not session cookies)
- Auth rate limiter: 5 attempts per 15 min per IP+email

### Admin (`apps/admin`)

- Next.js with App Router
- `middleware.ts` is a passthrough — do NOT add auth checks there
- Auth handled entirely by `AuthProvider` in `lib/auth.tsx`
- `StoreProvider` and `NotificationProvider` only mount when authenticated (see `providers.tsx`)
- SVG images must use `unoptimized` prop on Next.js `<Image>` component

### Web (`apps/web`)

- Next.js with App Router
- Multi-tenant: store resolved via domain/slug in middleware
- Store theme applied via CSS variables in `StoreContext`

### Shared Packages

- `@force/database`: Prisma client + explicit enum re-exports. Build runs `prisma generate` first.
- `@force/ui`: Shared React components (Button, Input, Toast, etc.)
- `@force/shared`: Zod schemas, types, constants

## Known Issues / Tech Debt

### Admin App

- Some pages redundantly check `isAuthenticated` in useEffect — unnecessary since AuthProvider handles redirects
- `NotificationContext` sets up WebSocket but no pages call `subscribeToStore()` — notifications are wired but inactive

### Web App

- `isPlatform` detection logic duplicated in `page.tsx` and `StoreContext.tsx` — extract to shared util
- Cart sync after login calls `addToCart()` per item — should use bulk sync or `getCart()`
- Profile fetched independently in `SettingsClient` instead of using `useAuth().user`

## Environment Variables

### API (Railway)

Required in production (app crashes without these):

- `DATABASE_URL` — Neon PostgreSQL connection string
- `DIRECT_URL` — Neon direct (non-pooled) URL for migrations / interactive transactions
- `JWT_SECRET` — min 32 chars, no placeholder values
- `ENCRYPTION_KEY` — min 32 chars
- `PORT` — set automatically by Railway
- `NODE_ENV=production`

Optional (feature degrades gracefully if missing):

- `REDIS_URL` — Railway internal (`redis.railway.internal:6379`); falls back to `localhost:6379` in dev
- `ONESIGNAL_APP_ID` / `ONESIGNAL_REST_API_KEY` — admin order alerts + storefront broadcasts. When missing, broadcast endpoint returns `503 PUSH_NOT_CONFIGURED`.
- `ONESIGNAL_ADMIN_APP_ID` / `ONESIGNAL_ADMIN_REST_API_KEY` — optional separate OneSignal app for admin alerts; falls back to the public app id/key if unset.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — standards-based Web Push (RFC 8030) for storefront subscriptions. Without these, `push.service.ts` logs a warning and skips sends.
- `SENTRY_DSN` — error monitoring; safe to omit in dev.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM_NAME` / `SMTP_FROM_EMAIL` — outbound email via Resend.
- `GOOGLE_GENERATIVE_AI_KEY` — Gemini AI features (translate, SEO, categorize). When missing, AI routes return a config error.
- `GEMINI_MODEL` (default `gemini-flash-lite-latest`), `AI_BULK_THROTTLE_MS` (default 2500), `AI_DAILY_REQUEST_CAP` (default 1000), `AI_MONTHLY_REQUEST_CAP` (default 20000) — Gemini free-tier guardrails.
- `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID` — required only for automatic custom-domain provisioning when stores attach a domain.
- `WHATSAPP_VERIFY_TOKEN` — Meta Cloud API webhook verification (WhatsApp queue is wired but per-store credentials live on the store record).
- Payment providers (per-store credentials live on the store record; env vars below are global defaults / test mode): `PAYMENT_TEST_MODE`, `DEFAULT_PAYMENT_PROVIDER`, `DEFAULT_CURRENCY`, plus provider-specific `TAP_*`, `MYFATOORAH_*`, `HESABE_*`, `UPAYMENTS_*`.

### Admin (Vercel)

- `NEXT_PUBLIC_API_URL` — Railway API URL (e.g., `https://api-production-c058.up.railway.app`)
- `NEXT_PUBLIC_ONESIGNAL_APP_ID` — OneSignal app ID for the admin PWA (`react-onesignal` in `apps/admin`).

### Web (Vercel)

- `NEXT_PUBLIC_API_URL` — Railway API URL
- `NEXT_PUBLIC_ONESIGNAL_APP_ID` — OneSignal app ID for storefront broadcasts (script-tag init via `OneSignalStorefrontInit.tsx`). Storefront silently no-ops when missing.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — VAPID public key for the standards-based Web Push subscription path.

## Commands

```bash
npm run dev:api          # Start API dev server
npm run dev:admin        # Start admin dev server (port 3001)
npm run dev:web          # Start web dev server (port 3000)
npm run build            # Build all workspaces
npm run typecheck        # tsc --noEmit across the repo
npm run lint             # Lint all workspaces
npm run lint:fix         # Lint + autofix
npm run format           # Prettier write
npm run format:check     # Prettier check (CI gate)
npm run db:generate      # prisma generate
npm run db:migrate       # prisma migrate dev
npm run db:push          # prisma db push (dev only — bypasses migration history)
npm run db:seed          # Seed dev/test data
npm run db:studio        # Open Prisma Studio
npm run test             # Run all vitest suites
npm run test:unit        # tests/unit
npm run test:integration # tests/integration (real DB + Redis)
npm run test:e2e         # tests/e2e
npm run test:coverage    # Coverage report
npm run audit:high       # npm audit --audit-level=high
npm run secrets          # secretlint scan (also runs via lint-staged on commit)
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → build → unit tests → integration tests (with Postgres 16 + Redis 7 services) → e2e → security audit + trufflehog secret scan. Gitleaks runs separately via `.github/workflows/gitleaks.yml`.

## Production rollback + backup

This project follows the standing rollback discipline (see global `~/.claude/CLAUDE.md` + `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-rollback-recipe.md`).

- **Code rollback (all 3 deploys at once):** `bash scripts/rollback.sh` — git revert + push triggers Vercel admin (`apps/admin`) + Vercel storefront (`apps/web`) + Railway API. Lock-step matters — `apps/admin` and `apps/web` share API contracts via `@force/shared`. Don't promote one Vercel app without the other.
- **Per-commit Neon snapshot:** `.github/workflows/neon-snapshot.yml` creates `prod-<short-sha>` branch on every push to main. Repo secrets: `NEON_API_KEY`, `NEON_PROJECT_ID`.
- **Local pg_dump:** `bash scripts/backup-db.sh` writes to `~/Desktop/projects/_backups/force-website-builder/`. Reads `DATABASE_URL` from `apps/api/.env`.
- **Migration rollback:** see `docs/ROLLBACK.md`. RLS policy state must be re-verified after restore (the `runInTenantContext` AsyncLocalStorage pattern depends on policy shape). Hand-written migrations live at `packages/database/prisma/migrations/<TS>_<name>/migration.sql` and apply on next API boot — by the time you notice a schema bug, it's already live.
- **Trace what migrated:** `git log --diff-filter=A --name-only -- packages/database/prisma/migrations/`

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
