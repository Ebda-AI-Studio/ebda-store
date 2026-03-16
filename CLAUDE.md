# Force Website Builder - Project Guidelines

## Tech Stack

- **API**: Express.js + TypeScript (apps/api)
- **Admin Dashboard**: Next.js + App Router (apps/admin)
- **Storefront**: Next.js + App Router (apps/web)
- **ORM**: Prisma (packages/database)
- **Database**: Neon PostgreSQL (serverless)
- **Storage**: Cloudflare R2 (S3-compatible, public bucket via `*.r2.dev`)
- **Cache**: Redis
- **UI Components**: Shared package (@force/ui) with Tailwind CSS
- **Validation**: Zod (shared schemas in @force/shared)
- **Auth**: Custom JWT (HTTP-only cookies, cross-origin with SameSite=None)
- **Real-time**: Socket.io (WebSocket notifications)

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
- `JWT_SECRET` — min 32 chars, no placeholder values
- `ENCRYPTION_KEY` — min 32 chars
- `PORT` — set automatically by Railway
- `NODE_ENV=production`

### Admin (Vercel)

- `NEXT_PUBLIC_API_URL` — Railway API URL (e.g., `https://api-production-c058.up.railway.app`)

### Web (Vercel)

- `NEXT_PUBLIC_API_URL` — Railway API URL

## Commands

```bash
npm run dev:api          # Start API dev server
npm run dev:admin        # Start admin dev server
npm run dev:web          # Start web dev server
npm run build            # Build all workspaces
npm run db:generate      # Run prisma generate
npm run db:migrate       # Run prisma migrate dev
npm run db:studio        # Open Prisma Studio
npm run test             # Run all tests
npm run lint             # Lint all workspaces
```
