# Force Website Builder - Project Guidelines

## Strategic positioning — read this BEFORE any feature decision (codified 2026-05-19)

**Force AI's competitive value in the Kuwait market = customizable storefronts + AI/smart software on top.**

Every feature decision should be evaluated against that positioning. Generic SaaS storefront builders (Shopify, Wix, Wix Kuwait, Salla) compete on tooling depth + ecosystem. We compete on:

1. **Customization granularity** — merchants can tune visual + behavioral details (per-section bg, per-section typography, per-section card frame size/color, smart-palette distribution, per-theme image-spec hints) that Shopify locks behind paid themes or developer access. Ahmad's standing "I want to control X" feedback is direct evidence of this market gap.
2. **AI-as-default** — translation (en/ar), SEO copy, category suggestion, content auto-fill, bulk catalogue sweeps via Gemini Flash Lite. Free tier matters because Kuwait merchants are price-sensitive and mostly self-shoot/self-write. Every manual field that an AI could fill is a competitive opportunity.
3. **Arabic-first locality** — bilingual fields everywhere, RTL-correct admin, Kuwait-stack integrations (Tap/MyFatoorah/Hesabe/UPayments/OneSignal/Resend/Neon). Localized to the Gulf instead of bolt-on i18n.
4. **Compact-ecommerce sizing** — design.md compact baselines match how Kuwait/GCC merchants actually shoot products + write copy. Shopify's 2048×2048 luxury assumptions are wrong for our merchant profile.

### When evaluating a new feature, ask:

- **Does this strengthen one of the four pillars above?** If yes, it's on-strategy. If no, it's table-stakes — implement at the minimum quality bar but don't over-invest.
- **Is there a manual step here an AI could auto-fill?** If yes, surface an "AI auto-fill" button. Gemini Flash Lite is the default provider (free tier covers most catalogues).
- **Is this a setting a merchant should be able to tune per-section/per-store?** If yes, expose it. Don't pre-decide for them. The platform's job is to give them the dials + smart defaults; their job is the brand.
- **Does it work in Arabic?** Test in both locales. RTL is not an afterthought.

### Anti-patterns to refuse

- **Generic features for "any market"** when a Kuwait-specific shape exists (e.g. shipping zones generic across countries when KW Districts have known names + courier coverage).
- **Manual workflows that should be AI-assisted** (e.g. asking merchant to write Arabic translations when Gemini Flash Lite can suggest them).
- **Hardcoded design choices that should be customization knobs** (e.g. "the section heading is always 32px" — see `feedback-fwb-data-zone-hardcoded-size-trap`).
- **English-first UI** even if Arabic is "supported later" (e.g. ColorField labels in English-only with no Arabic translation key).

The 2026-05-19 AI competitive audit at `docs/superpowers/audits/2026-05-19-ai-competitive-audit.md` baselines where we stand against this positioning + ranks improvement opportunities.

## Sizing rules — read `design.md` FIRST

Ahmad's standing preference (codified 2026-05-16): **default to compact ecommerce
sizing on both desktop and mobile.** Cards, logos, paddings, gaps — when in
doubt, lean smaller. Industry benchmark is pecannbee.com.kw + bank-alkahraman.com

- similar Kuwait/GCC stores.

**Before changing any size-related class (max-w, h-, p-, gap-, aspect-),
read `design.md` in the repo root.** That file is the single source of truth
for size baselines (product card 180-220px desktop / 150-180px mobile,
category card 140-180px, etc.). Anti-patterns and the "still too big"
diagnosis recipe are documented there too.

**Logo sizing exception (2026-05-17 night, Ahmad explicit override):** logo
defaults to **h-24 mobile / md:h-36 desktop** (was h-14/h-20 in design.md
— Ahmad bumped this after "still not bigger" + "md sizes are very small
in reality" feedback). Row container is **h-32 / md:h-44** with
**`overflow-hidden`** in modern + bold headers so the absolute-positioned
mobile-centered logo can never visually clip into the hero below.
Applied platform-wide across all 5 theme headers.

If `design.md` is missing from a future session's project root, recreate it
from the project memory `feedback-fwb-sizing-rules.md` (or ask Ahmad to point
to the latest version).

## Every data has a UI — applies to every PR

**Rule (codified 2026-05-28):** every database table whose rows have business meaning to a human user (merchant, super-admin, customer) MUST have a UI surface to view them. Backend-only data with no viewer is a defect, not a feature.

- At plan time: identify who needs to view the data. "Nobody" means dead data — delete it.
- At PR time: the test plan MUST include "open the UI at /xxx → verify rows render."
- For subagent dispatches: the prompt MUST include the UI surface in scope.
- Anti-patterns to refuse: "audit data, just query the DB", "Sentry catches it", "we'll build UI later", "super_admin can use Prisma Studio."

Exempt: pure infra tables (`_prisma_migrations`, rate-limit counters, AsyncLocalStorage breadcrumbs).

Full audience routing table + checklist at `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-every-data-needs-ui.md`.

## Platform-level fixes — applies to every change in this repo

**Every UI/UX/feature change MUST be platform-level. NEVER tenant-scoped, NEVER theme-specific without an explicit reason.**

When Ahmad reports a bug or asks for a feature, the fix MUST land in a place where every store inherits it automatically. Concrete enforcement:

1. **Product-card UX changes** → must hit ALL 3 render paths:
   - `apps/web/src/templates/shared/PecannbeeProductCard.tsx` (PLP / search / category listings)
   - `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx` (5 theme grids)
   - `apps/web/src/templates/shared/ProductCarousel.tsx` (HOMEPAGE new-arrivals + best-sellers carousels)

   Grep the 7 files; if the new pattern doesn't appear in all 7, it isn't shipped. See `feedback-fwb-three-product-render-paths.md`.

2. **Header / footer / nav changes** → must hit ALL 5 themes (`modern/elegant/classic/minimal/bold`). Wadyaljuz uses `elegant` and Palora uses `minimal` (verified against prod 2026-05-17); ship the change in whichever theme the merchant under active review uses FIRST, but the same commit batch or an immediate follow-up MUST land the same pattern in the other 4.

3. **Storefront copy / labels** → goes in `apps/web/src/contexts/LanguageContext.tsx` (the `translations` map) so EN + AR are platform-level. Never hardcode user-facing strings in a theme.

4. **Schema / API / business-logic changes** → live in `apps/api` + `packages/database` and serve every tenant via the existing per-store scoping (`storeId` everywhere). Never branch on a specific `store.slug`.

5. **Admin tooling** → built once in `apps/admin` and works for every store the admin owns. Never wire a feature to a specific tenant ID.

**The rule's purpose:** stores inherit improvements automatically. A merchant who joins next month gets every fix shipped before they signed up. No tenant should ever ask "can you fix that for my store?" — the fix is already live for them.

**Anti-patterns to refuse:** "let's just ship this on wadyaljuz first and roll it out later", "make this a setting for store X only", "hardcode this for the demo tenant". If a request would create tenant-specific code, pause and flag it. The exception is per-tenant CONFIG (theme choice, brand colors, hero image) which is data, not code.

## Tech Stack

> **GSC + AI crawler runbook:** `docs/runbooks/google-search-console-indexing.md` — covers what to submit to Google Search Console for wadyaljuz.com, llms.txt status (Google ignores it), AI-crawler robots.txt strategy, and bilingual hreflang guidance.

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
- **Admin**: Vercel project `force-admin` → custom domain `app.forcemediakw.com`
- **Web**: Vercel project `force-web` → custom domain `wadyaljuz.com` (per-tenant; future tenants attach their own custom domains)
- _Stale Vercel projects to ignore:_ `force-web-sigma` (no prod deploy), `force-web-sigma-seven.vercel.app` (DEPLOYMENT_NOT_FOUND ghost). Both pre-date the 2026-05-17 rename to the canonical `force-web` / `force-admin` projects. Safe to delete via Vercel dashboard.
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

### Per-store visual configuration (updated 2026-06-09)

The storefront's visual language is configured per-store. **Page Builder + Smart Palette are the CANONICAL design system** for all color, font, hero, and per-section layout controls as of 2026-06-09 (PRs #86–#90). The Branding tab's manual color pickers (`ColorPalettePicker`), global font-family picker (`TypographyPicker`), and `backgroundPreset` selector are **retired inputs** — they are now "edit in Page Builder" pointers or read-only swatches. Any code or doc referencing those as the primary color/font editors is stale.

**Canonical owners after 2026-06-09:**

| Concern                                            | Canonical editor                           | Notes                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Brand color tokens (`primaryColor`, `accentColor`) | **Page Builder → Smart Palette**           | Branding ThemeTab color pickers are retired; Branding now shows read-only swatches with "Edit in Smart Palette →" link |
| Font family (headings + body)                      | **Page Builder → Typography / Fonts**      | Branding `TypographyPicker` is retired; per-zone `!important` rules win regardless                                     |
| Hero content (title/subtitle/CTA/image)            | **Page Builder → Hero section (slides)**   | Legacy `/hero` page now redirects to Page Builder; any hero content set there was migrated to slides                   |
| Per-section background color                       | **Page Builder → per-section bgColor**     | `backgroundPreset` on Branding is treated as a global fallback only; section-level page-builder value wins             |
| Announcement visibility + bg color                 | **Page Builder → announcement card**       | `/announcement` page keeps text content only                                                                           |
| WhatsApp display number                            | **`/contact`** (`store.whatsapp` column)   | Social-tab `socialLinks.whatsapp` feeds footer icons separately; `store.whatsapp` wins for the contact button          |
| Email sender local-part                            | **`/seo`** (`emailSenderLocalPart` column) | `/domain` now reads this field instead of hardcoding `noreply`                                                         |

**Theme PUT is now a server-side shallow-merge PATCH** — `PUT /:id/theme` merges the incoming body into the existing theme JSON rather than replacing it wholesale. This means a partial save from one surface (e.g. Smart Palette sending only `primaryColor`) no longer clobbers keys written by another surface. Dev note: always send only the keys your surface owns; the server preserves untouched keys.

**Security changes shipped 2026-06-09:**

- `heroCtaLink` is now URL-scheme-validated server-side — `javascript:` and `data:` values are rejected (C6 fix). All storefront `<a href>` values for user-supplied CTA links must pass the scheme check.
- Marketing-pixel and SMS integration secrets are **masked on GET** (last-4 only) and the mask sentinel is treated as "no change" on save — never submitted as the real value.
- Newsletter HTML broadcast is sanitized (DOMPurify allowlist) before sending.
- Coupon `/validate` is rate-limited and returns a uniform `INVALID_COUPON` error (no enumeration).
- WhatsApp (`whatsapp`) and AI-Tools (`ai_tools`) admin pages are feature-gated — only stores with the appropriate feature override or plan see them.
- Journal new-entry form is hidden for non-`super_admin` roles (UI matches the API gate).

All flags below live on the `StoreTheme` JSON column except `blogEnabled` which is
its own `Store` column (because it gates API routes).

| Flag                                | Default                                                                                         | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backgroundPreset`                  | `none`                                                                                          | **Global fallback only** — per-section bgColor in Page Builder wins when set. Values: `none` / `warmSand` / `coolGrey` / `pureWhite` / `brandColor`. Sections alternate two HSL pairs from `--bg-page` ↔ `--bg-section-alt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dividers` (DividerSettings object) | `{enabled: true, style: solid, thickness: 1, width: short, color: foreground, spacing: normal}` | `/stores/:id/dividers` admin page. `SectionDivider` component renders real `<hr>` between sections                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `showBrandBadge`                    | `false`                                                                                         | Branding → Theme. `BrandPill` overlay (store name) on product card images. Hidden when OOS / NEW already occupies the corner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `showQuickAdd`                      | `false`                                                                                         | Branding → Theme. `(+)` circle on `ProductCarousel` cards for one-tap add-to-cart. When ON, the bottom "Add to cart" button on the same card auto-suppresses (no redundancy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `showBrandStory`                    | `true`                                                                                          | Branding → Theme. `BrandStoryBlock` on homepage using `store.heroImage` + `store.description`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `showTrustStrip`                    | `true`                                                                                          | Branding → Theme. 3-up `TrustStrip` above footer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `trustStripLayout`                  | `'horizontal'`                                                                                  | Branding → Theme. `'horizontal'` (3-up tight on mobile) or `'vertical'` (stacked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `blogEnabled` (Store column)        | `false`                                                                                         | Branding → Theme. Gates `/blog` routes + `HomeBlogCarousel`. Blog admin at `/stores/:id/blog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `aiAutopilot`                       | `true`                                                                                          | AI-first autofill master switch. When ON, the platform auto-fills a product's empty AI-writable fields on create/update + a 3-day sweep, and generates recs for new products. **Bidirectional** (Arabic-first): the en/ar pairs (name/nameAr, description/descriptionAr) source each other so it fills whichever language is empty (EN→AR and AR→EN); SEO meta refreshes from a change in either language. Manual edits always win via the per-field `Product.aiFieldSources` provenance map (`ai`/`human`); the `canWrite` guard also never overwrites existing content that has no provenance entry (legacy products with `aiFieldSources={}` are safe). Status chip on Settings → Branding; manual "Generate" buttons unaffected when OFF. Default ON because AI-as-default is a core positioning pillar. |

**SectionDivider ↔ backgroundPreset mutex:** when `backgroundPreset !== 'none'`,
`SectionDivider` returns null. Color alternation IS the divider — running both
together was unpleasant double-separation. Storefront enforces; merchants don't
think about it.

**Hairline accents on every section heading** are independent of the above —
`SectionHeading` flanks `kicker` text AND `subtitle` text with `bg-foreground/30`
hairlines automatically when those fields are set per-section in Admin → Layout.
Merchants don't need to type `---- text ----`; the platform draws the lines.

**Card-size:font-size locked table** (Sprint 1, see `design.md` →
`getProductCardTextSizes(cardSize)` in `@force/shared`). Pack-styles' size
tokens were stripped from `productCardName` / `productCardPrice` — flavor only
(weight/tracking/color/family). Sizes come from the cardSize-aware helper.

**Per-template branded baseline (Brand Engine Phase 2, 2026-06-05):** a store
with empty `layoutSettings` inherits its template's polished, fully-tokenized
baseline via `resolveLayoutSettings(saved, store.template)`. Baselines live in
`packages/shared/src/types/template-baselines.ts`: `BASE_BRANDED_LAYOUT` (the
calibrated `elegant` base, extracted from wadyaljuz with content stripped) +
`TEMPLATE_IDENTITIES` (per-template size/frame/column/aspect deltas on the
shared mechanical scale) → `TEMPLATE_LAYOUT_BASELINES`. Colors are `token:*`
only (the Phase-1 engine paints them contrast-safe). Saved values always win the
merge, so wadyaljuz (full saved layout) is unchanged; palora (empty layout)
adopts the minimal baseline by design. Demos (`demo-<template>`, via
`clone-demo-stores.ts`) carry wadyaljuz's brand colors + empty layout → one
palette, distinct identity per template. wadyaljuz immutability gate:
`packages/database/scripts/verify-baseline-nodrift.mjs` (read-only). The API
layout routes thread `store.template` into the resolver; omitting `templateId`
reproduces the legacy global-default behavior.

**Mobile chrome**: `BottomTabBar` (Home / Wishlist / Cart / Search) mounts
in `ShopChrome`, hidden on PDP/checkout/auth. Header cart icon + mobile search
bar hidden via `hidden md:inline-flex` in all 5 theme headers to avoid
duplication with the tab bar.

**Bottom-reserve invariant for fixed BottomTabBar**: `<body>` carries
`pb-32 md:pb-0` in root `layout.tsx`. ShopChrome carries NO additional pb
(would create double-reserve white-space above the cookieFallback row).
Body-pb is the single source of truth. Cookie consent banner lifts on
mobile via `bottom-[calc(56px+env(safe-area-inset-bottom))]` so its
action buttons sit above the bar.

**data-zone wiring rule**: any storefront text element exposed in the
Admin → Typography page MUST carry the matching `data-zone="<zoneKey>"`
on its wrapper AND avoid hardcoded `text-[Xpx]` arbitrary values —
otherwise merchant overrides silently no-op. PoweredByForce was the
trigger for this rule (commit `489bdaf`). Audit grep recipe in
`feedback-fwb-data-zone-hardcoded-size-trap` scoped memory.

**Cart icon canonical SVG path** (commit `e6ae439`):
`M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z`
— the shopping-cart-on-wheels glyph. Used across 11 surfaces (BottomTabBar,
PecannbeeProductCard, ProductCarousel, 5 theme headers, CartClient,
ProductListItem, admin MobileBottomNav, admin AnalyticsStatsGrid). Do NOT
use the old shopping-bag path `M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z`.

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
- JWT access tokens last 30 days — stale role requires re-login

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
- `AI_AUTOFILL_STALE_TTL_DAYS` (default 30) — AI-first autofill: the 3-day sweep only re-generates an `ai`-owned text field when its product has been untouched longer than this. Keeps steady-state cost near zero (text rarely re-generates; recommendations refresh via the FBT recompute each sweep). Lower for fresher AI copy at higher Gemini cost.
- `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID` — required only for automatic custom-domain provisioning when stores attach a domain.
- `WHATSAPP_VERIFY_TOKEN` — Meta Cloud API webhook verification (WhatsApp queue is wired but per-store credentials live on the store record).
- `FORCE_AI_META_BM_ID` + `FORCE_AI_META_ADMIN_TOKEN` — one-time Force AI master credentials used by the "Provision automatically" button in `MetaCatalogCard`. The token needs `business_management` + `catalog_management` + `whatsapp_business_management` scopes. Without these, the button returns 503 `PROVISIONER_NOT_CONFIGURED`. Optional `META_GRAPH_API_VERSION` (default `v21.0`) + optional `FORCE_AI_META_PROVISIONER_USER_ID` to auto-assign new catalogs to a dedicated system user.
- `VERCEL_WEBHOOK_SECRET` — required when the Vercel Spend Management webhook is configured to POST to `/api/v1/webhooks/vercel-budget`. HMAC-SHA1 over raw body via `x-vercel-signature`. Refuses 503 when unset (never silently accepts unsigned alerts). Triggers Telegram alert via `alerts.service`. P0 for `budget.exceeded` + `budget.notification`, info for `billing_cycle.end`.
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
- **Per-commit Neon snapshots: RETIRED (2026-06-08, cost).** `neon-snapshot.yml` is disabled and the stale `prod-<sha>` branches pruned (the auto-prune had let them pile up + drive extra-branch/compute charges). DR is now an **automated daily local pg_dump**: launchd `com.forceai.neon-backup` (3:30am, runs on next wake) → `~/.claude/scripts/backup-all-neon.sh` → `~/Desktop/projects/_backups/<project>/` (keeps 30). It pulls the real direct URL from Neon via `neonctl --role-name neondb_owner` and **requires `pg_dump` ≥ PG17** (`brew install postgresql@17`; pg_dump 14 fails silently on a PG17 server). Weekly `com.forceai.mac-maintenance` handles storage hygiene + a Telegram low-disk alert.
- **Local pg_dump:** `bash scripts/backup-db.sh` writes to `~/Desktop/projects/_backups/force-website-builder/`. Reads `DATABASE_URL` from `apps/api/.env`.
- **Migration rollback:** see `docs/ROLLBACK.md`. RLS policy state must be re-verified after restore (the `runInTenantContext` AsyncLocalStorage pattern depends on policy shape). Hand-written migrations live at `packages/database/prisma/migrations/<TS>_<name>/migration.sql` and apply on next API boot — by the time you notice a schema bug, it's already live.
- **Trace what migrated:** `git log --diff-filter=A --name-only -- packages/database/prisma/migrations/`

## UI/UX standing rules (codified 2026-05-17 from the design refresh sprints)

These are LESSONS, not feature docs. Apply on every UI/UX change in this repo. Each rule has a memory file with the failure-mode context — read it once if in doubt.

**1. Sister systems = runtime mutex, not merchant decision.** When two features can both solve the same UX problem (bg color shift vs hairline `<hr>` both separate sections), make them mutually exclusive on the storefront, don't ask the merchant to reconcile. The storefront component short-circuits at runtime (e.g. `if (theme.backgroundPreset !== 'none') return null;` in SectionDivider). Admin stays orthogonal; merchant flips either flag freely; storefront picks one. Reference: `feedback-fwb-section-rhythm-architecture` (scoped). Original incident: shipped both = "unpleasant double-separation".

**2. New visual features default OFF.** Any toggle that changes how existing stores look ships with default `false` so no merchant gets visual surprise. Standing pattern from 2026-05-17: `showBrandBadge`, `showQuickAdd`, `blogEnabled`, `BrandPill` all default OFF. Utility features that fill empty space (`showBrandStory`, `showTrustStrip`) may default `true` because the empty state is worse than the filled state. Decide which category the flag belongs to at design time, not after a merchant complains.

**3. Theme flags ride `StoreTheme` JSON; Store columns only when API-gated.** `apps/api/src/routes/store.routes.ts` themeSchema is `z.record(z.string(), z.unknown())` — new opt-in flags pass through with zero migration and zero new endpoint. Use a `Store` column ONLY when (a) routes need to 404 when off (e.g. `blogEnabled` gates `/blog`), (b) the field is used in a Prisma WHERE/ORDER, or (c) services outside the storefront need it (email templates, external APIs). Reference: `feedback-fwb-theme-flag-pattern` (scoped).

**4. ThemeTab clutter ceiling = 7 toggles. Next toggle gets a dedicated admin page.** Once `ThemeTab.tsx` exceeds ~7 toggles + pickers + sub-forms, the next merchant-facing toggle is built as `/stores/[id]/<feature>` with its own sidebar entry under the right grouping (Typography / Layout / Branding). Established pattern: `/stores/:id/dividers`, `/stores/:id/blog`, `/stores/:id/typography`. Don't keep stacking onto ThemeTab — Ahmad's standing complaint: "complicated for the users".

**5. Admin pages mirror storefront top-to-bottom flow.** Controls on `/typography`, `/layout`, future page-builder admins MUST be ordered in the sequence a visitor encounters them on the storefront (announcement bar → header → section headings → categories → products → footer → after-footer), NOT alphabetical, NOT grouped-by-control-type, NOT sub-controls-clustered-at-end. Use a `groupHeading` field per control + hairline group separators for labeled clusters. Sub-controls nest visually under their broad parent via `ms-4 sm:ms-6 border-s-2 border-s-primary/30`. Reference: `feedback-admin-mirrors-storefront-flow` (global). Verified on Typography page commit `c4afbe9`.

**6. Fixed-bottom UI two-trap recipe.** Whenever you add ANY `position: fixed; bottom: 0;` element on mobile (tab bar, sticky CTA, cookie banner, chat widget):

- **Reserve space on `<body>`, NOT on the chrome wrapper.** Body siblings (`<CookieFallback />`, debug bars, "Powered by ..." rows) live outside chrome and get clipped if pb-X is only on chrome's outer div. Root `layout.tsx` body owns `pb-32 md:pb-0`; chrome carries NO additional pb.
- **Lift any OTHER fixed-bottom UI above the primary one** via `bottom-[calc(<bar-height>px+env(safe-area-inset-bottom))] md:bottom-0`. `env(safe-area-inset-bottom)` is critical (≥34px on notched iOS).
  Reference: `feedback-fixed-bottom-ui-stacking` (global, 3 traps).

**7. data-zone + size-class wiring is required for Typography overrides to work.** Already documented above under "Per-store visual configuration". Restated as a rule: every storefront text element exposed in `/typography` MUST (a) carry `data-zone="<zoneKey>"` on the wrapper, (b) use a Tailwind size class (`text-sm`, `text-base`, etc.), NEVER `text-[Xpx]` arbitrary values — they win specificity battles against the per-store CSS emitter and silently no-op merchant overrides. Reference: `feedback-fwb-data-zone-hardcoded-size-trap` (scoped). Audit grep recipe in the memory file.

**8. Editorial-hairline divider language is platform-wide and reusable.** The visual idiom — two `bg-foreground/30` lines at `flex-1 max-w-[140px] sm:max-w-[200px]` flanking centered text — is the canonical "announcement" separator. Used in 3 places today: `SectionKicker` (above title), `SectionHeading` subtitle (below title), `SectionDivider` (between sections when bg preset is `none`). Any future decorative separator MUST reuse this language rather than invent a new visual. Single visual idea, infinite placements.

**9. OSOSS reference set is the canonical Kuwait-grocery UX benchmark.** When in doubt about storefront UX direction, the three OSOSS-platform stores are the comparison set: Pecannbee, Bank Alkahraman, SMEJ. Their extracted patterns are at `reference-ui-target-pecannbee-bankalkahraman` + `reference-ui-untitled-smej` (scoped memory). Before inventing a new pattern, scan these first. The Sprint 1 "color shift IS the divider" pattern came directly from this reference set.

**10. Live-review iteration is part of the design loop, not a sign of failure.** First-pass shipment is the start. Plan for 2-4 refinement rounds per non-trivial UX change. Examples from 2026-05-17 single session: logo sizing took 3 passes (h-14 → h-20 → h-24/md:h-36 + row + overflow-hidden); divider color took 2 (brand color → still brand color but visible-by-default); typography ordering took 1 major reorg after the flat-list-with-end-cluster proved unscannable; cookie banner stacking took 3 (main pb → chrome pb → body pb). Budget time for the refinement; don't claim "done" after first push without an Ahmad sign-off.

**11. Sprint plan → Stitch preview → code is the standard cross-cutting UI workflow.** For any UI change that spans multiple themes, components, or admin surfaces: write `docs/plans/<date>-<slug>.md` first, drive a Stitch visual preview against the plan DESIGN.md, validate visually with Ahmad before code. Reference: `~/.claude/projects/-Users-ahmadsharaf/memory/reference-stitch-mcp` (Stitch CLI install gotcha: `--header` is varargs, name+URL FIRST). The Sprint 1 preview flow is the template — repeat for Sprint N+1.

**12. commitlint enforces lowercase subjects.** `subject must be lower-case` errors come from any uppercase word in the commit subject (CLAUDE, URLs, project names). HEREDOC commits MUST start with a lowercase type (`feat:`, `fix:`, `docs:`) AND keep the subject all-lowercase. Co-Authored-By trailer needs a blank line before it (footer-leading-blank rule).

**13. data-zone wiring sweep when adding to TYPOGRAPHY_ZONES.** Adding a new entry to `TYPOGRAPHY_ZONES` in `packages/shared/src/types/typography.ts` is HALF the work — the matching `data-zone="<name>"` MUST land in every theme that should honor it (5 themes for broad zones, 1+ surfaces for sub-zones). Without DOM targets the admin control silently no-ops. Audit: `for zone in $(grep -oE "'[a-zA-Z]+'" packages/shared/src/types/typography.ts); do echo "$zone: $(grep -rl data-zone=$zone apps/web/src/templates | wc -l)"; done` — every entry must report ≥1 wiring. Reference: `feedback-fwb-footer-data-zone-missing` (scoped). Footer was the missing one 5+ months; fixed 2026-05-20 commit `de2f0b5`.

**15. token:X color resolution MUST fall back to `hsl(var(--<key>))`.** When emitting any merchant-saved `token:<name>` color value into CSS — whether via `resolveColor()` from `@force/shared` OR a server-side per-store CSS emitter — the resolver MUST handle the case where `StoreTheme[<key>Color]` is undefined by falling back to `hsl(var(--<key>))`. Globals.css defines `--card / --muted / --border / --foreground / --primary / --secondary / --accent` for every store, so the fallback always paints. Without this, legacy theme rows that pre-date the card/muted/border/foreground tokens silently drop the merchant pick (resolveColor returns undefined → React strips prop, OR emitter writes literal "token:card" string → browser drops the rule). Audit recipe in scoped memory. Verified FWB 2026-05-20 commits `941295e` + `2c9543d`. Reference: `feedback-fwb-token-resolution-gap` (scoped).

**14. ColorField everywhere — never inline color inputs in admin.** `apps/admin/src/components/page-builder/ColorField.tsx` is the single canonical color picker — brand-token dropdown + hex picker + contrast preview + i18n-ready. Inline `<input type="color">` + `<input type="text">` pairs are an anti-pattern: tiny touch targets, no brand-token pathway, no contrast warning, inconsistent with rest of admin. Threading: `theme={storeInfo?.theme ?? FALLBACK_THEME}`. Saved values like `"token:primary"` MUST resolve via `resolveColor(value, theme)` on the storefront side. Audit grep: `grep -rn 'type="color"' apps/admin/src | grep -v ColorField` must be empty. Reference: `feedback-fwb-colorfield-reuse-pattern` (scoped). Verified 2026-05-20 commit `dab6af5` — divider custom-color picker migrated.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Standing rules from global config (cross-project)

These are enforced globally in `~/.claude/CLAUDE.md`. Summarized here for
contributors who don't have access to the global config. Read the source file
for the full context.

1. **Memory pipeline after every commit** — `nohup ~/.claude/scripts/update-memory-pipeline.sh all` fires after each commit. Not optional.
   Reference: `~/.claude/projects/-Users-ahmadsharaf/memory/MEMORY.md`

2. **Scoped memory = source of truth, MEMORY.md = index** — detailed lessons live in `feedback-*.md` / `project-*.md` files; MEMORY.md is the pointer table.
   Reference: `~/.claude/projects/-Users-ahmadsharaf/memory/MEMORY.md`

3. **Fix everything, no "non-blocking ignored" category** — warnings and lint errors are treated as failures.
   Reference: `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-ai-security-checklist.md`

4. **Never defer a task unless Ahmad explicitly asks** — don't leave partial work or TODOs without a signal.

5. **Session auto-config** — Remote Control auto-starts, session names to `basename($PWD)`.

6. **Documentation parity** — every feature ships with docs in the same session (local commit + remote push).
   Reference: `~/.claude/CLAUDE.md` §"Plan-before-code for big changes"

7. **Multi-step Redis sentinel for reminders** — stepped reminder queues (e.g. cart abandoned 1h/4h/24h cadence) use Redis sentinel keys to track which step fired, not simple TTL locks.
   Reference: `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/`

8. **Discoverability status-chip pattern for buried features** — any feature with a toggle buried 3+ taps deep MUST surface its state on the Settings overview card (e.g. "DM ordering: ON/OFF" chip on the WhatsApp connection card).
   Reference: commit `917a268a` (FWB)

9. **Version-agnostic lookup for externally-versioned names** — Meta template names can be renamed via Reset-to-Draft. Dropdowns must resolve by base-name match (strip `_v2`, `_v3` suffixes) not exact-name lookup.
   Reference: commit `1507ef67` (FWB)

10. **CI/CD + 5-layer testing standard** — every workflow file converges to the canonical shape: `ci.yml` with concurrency group + per-job `timeout-minutes` (anti-hang), `notify-failure` Telegram alert (sleep-proof), audit split (prod zero-tolerance, dev gated at high), Prisma `db:generate` before typecheck, integration tests TRUNCATE in `beforeAll`, module-level `setInterval`/`setTimeout` cleared in teardown, gitleaks paired with `.gitleaks.toml` + `.gitleaksignore`. Branch hygiene: only `main` (+ `preview` if staging). Codified 2026-05-25 after a session burned 30+ CI iterations on ad-hoc per-repo drift.
    Reference: `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-force-ai-ci-cd-standard.md`
