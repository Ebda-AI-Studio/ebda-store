# Force Website Builder — Project Guidelines

Rules + invariants only (slimmed 2026-07-11). Reference catalogs moved out: **env vars → `docs/ENVIRONMENT.md`**, **theme flags / canonical editors / card-CTA system → `docs/architecture/store-theme-flags.md`**, **sizing baselines → `design.md`**. Cross-project rules live in the global `~/.claude/CLAUDE.md` — they are NOT repeated here.

## Strategic positioning — read BEFORE any feature decision

**Force AI's competitive value in the Kuwait market = customizable storefronts + AI/smart software on top.** Four pillars:

1. **Customization granularity** — merchants tune visual + behavioral details Shopify locks behind paid themes/dev access. Ahmad's "I want to control X" feedback is direct evidence of the market gap.
2. **AI-as-default** — translation (en/ar), SEO copy, categorization, bulk sweeps via Gemini Flash Lite. Every manual field an AI could fill is a competitive opportunity.
3. **Arabic-first locality** — bilingual fields everywhere, RTL-correct admin, Kuwait stack (Tap/MyFatoorah/Hesabe/UPayments/OneSignal/Resend/Neon).
4. **Compact-ecommerce sizing** — design.md baselines match how Kuwait/GCC merchants shoot + write (benchmark: pecannbee.com.kw, bank-alkahraman).

Every new feature: does it strengthen a pillar (if not → minimum-bar table stakes)? Is there a manual step AI could auto-fill (→ add an AI button)? Should it be a per-section/per-store dial (→ expose it)? Does it work in Arabic/RTL?

**Anti-patterns to refuse:** generic any-market features when a Kuwait-specific shape exists; manual workflows that should be AI-assisted; hardcoded design choices that should be knobs; English-first UI. Baseline audit: `docs/superpowers/audits/2026-05-19-ai-competitive-audit.md`.

## Sizing — read `design.md` FIRST

Default compact ecommerce sizing on desktop AND mobile; when in doubt, lean smaller. Before changing any size class (`max-w`, `h-`, `p-`, `gap-`, `aspect-`), read `design.md` (single source of truth for baselines + anti-patterns). If it's missing, recreate from scoped memory `feedback-fwb-sizing-rules.md`.

## Every data has a UI (every PR)

Every DB table whose rows have business meaning MUST have a UI surface. Plan time: name the viewer ("nobody" = dead data — delete). PR time: test plan includes "open /xxx → rows render". Subagent prompts include the UI surface. Refuse: "just query the DB", "UI later", "Prisma Studio". Exempt: pure infra tables. Detail: global memory `feedback-every-data-needs-ui.md`.

## Platform-level fixes (every change)

**Every UI/UX/feature change lands platform-level — NEVER tenant-scoped, NEVER theme-specific without explicit reason.** Per-tenant CONFIG (theme choice, colors, hero) is data and fine; per-tenant CODE is not.

1. **Product-card UX** → ALL render paths: `shared/PecannbeeProductCard.tsx`, the 5 `templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx`, `shared/ProductCarousel.tsx` (+ `ProductListItem` for the CTA/OOS system = 8 paths). Grep all; if the pattern isn't in all of them, it isn't shipped. → `feedback-fwb-three-product-render-paths.md`
2. **Header/footer/nav** → all 5 themes (wadyaljuz=elegant, palora=minimal). Ship the active merchant's theme first; the same batch or an immediate follow-up lands the other 4.
3. **Storefront copy** → `apps/web/src/contexts/LanguageContext.tsx` translations map (EN + AR). Never hardcode user-facing strings in a theme.
4. **Schema/API/business logic** → `apps/api` + `packages/database`, per-store scoping via `storeId`. Never branch on a `store.slug`.
5. **Admin tooling** → built once in `apps/admin` for every store. Never wire to a tenant ID.

Refuse: "ship on wadyaljuz first, roll out later", "setting for store X only", "hardcode for the demo tenant".

## Tech stack + deployment (current)

- Express+TS API (`apps/api`, Railway (Dockerfile.api — see the builder note below, not Railpack); served via the Cloudflare custom domain `api.force-ai.co` — verified 200 through Cloudflare 2026-09-02. The formerly-documented raw `api-production-c058.up.railway.app` hostname now 404s with `server: railway-hikari` / `x-railway-fallback: true` — no service is bound to it; the current internal/generated Railway hostname behind the custom domain is NOT verified, so it is not named here); Next.js 16 App Router admin/web/orders on **Cloudflare Workers** (`force-{admin,web,orders}-cf-preview` → `admin/store/orders.force-ai.co`, web also serves per-tenant custom domains via the CF-for-SaaS fallback — the SOLE domain provider since 2026-07-07; the Vercel domain path is deleted); Prisma + Neon; Redis (Railway internal); R2 public bucket (`*.r2.dev`, NOT `*.r2.cloudflarestorage.com`); Inngest for anything >300ms; Gemini `gemini-flash-lite-latest` with quota caps; dual push (web-push VAPID + OneSignal); Resend email; Sentry + pino; payments Tap/MyFatoorah/Hesabe/UPayments (Stripe doesn't work in Kuwait). Old Vercel projects decommissioned.
- Monorepo: `apps/{api,admin,web,orders}` + `packages/{database,shared,ui}` (npm workspaces). Zod schemas in `@force/shared`.
- `backend.forcemediakw.com` belongs to WhatsApp Bulk Sender, NOT this project.
- **Env vars: `docs/ENVIRONMENT.md`** (canonical catalog — update it in the same session as any env change).
- Railway builds the API via **`Dockerfile.api`** (`railway.json` sets `builder: DOCKERFILE`; the old "actually Railpack" claim was stale — confirm the live service's builder in the dashboard if deploy behavior is ever in question). `prisma generate` stays in the database package build script; root `startCommand` = `node apps/api/dist/index.js`; API reads `PORT` (→ `API_PORT` → 4000); build runs `npm run build` across ALL workspaces. Deploy is moving Railway GitHub-App auto-deploy → GitHub Actions (`railway-deploy.yml`, safe no-op until `RAILWAY_TOKEN` is set — cutover: `docs/migration/railway-actions-deploy.md`).
- GSC + AI crawler runbook: `docs/runbooks/google-search-console-indexing.md`.

## Critical architecture rules

**Cross-origin auth** (API and frontends on different domains):

1. API cookies are scoped to the API domain — Next middleware CANNOT read them; **all auth protection is client-side** via `AuthProvider`. Do NOT add cookie checks to Next middleware (redirect loops).
2. `credentials: 'include'` + `Access-Control-Allow-Credentials: true`; cookies `SameSite=None; Secure`.
3. Rotating refresh tokens (2026-06-09): `token` (30min access JWT, `jti` denylist + `tv` bulk revocation) + `refresh_token` (365d, DB-backed `refresh_tokens`, rotation with reuse-detection → family revoke). `/auth/refresh` accepts JSON body OR cookie, rotates both; both frontends silently refresh on 401 and retry once (single-flight). MFA composes: `login()` returns a challenge token; only `issueSessionFor` mints the real pair. `revokeAllSessions` bumps `tv` AND revokes all refresh tokens.

**Single source of truth:** `AuthProvider` (`lib/auth.tsx`) is the ONLY auth checker; `StoreContext` owns store data (don't fetch `/admin/stores` or store info elsewhere); API calls via `apiGet/apiPost/apiPut/apiDelete` from `lib/api.ts` (raw fetch only for downloads/server components).

**Async (Inngest):** anything >300ms or calling a 3rd party goes through `apps/api/src/lib/inngest` (functions in `lib/inngest/functions/`, registered via `client.ts`). Mark jobs `failed` on enqueue error; bulk AI throttled via `AI_BULK_THROTTLE_MS`; daily/monthly caps via `lib/ai-quota.ts`. **Post-purchase side effects fan out on Inngest, not inline** (Lens E): `order/status-changed` → `order-status-changed-fanout`, each side effect a retriable `step.run` dead-lettering via `alerts-failure-watch`; only the awaited money reversal + socket ping stay inline in `updateStatus`. Order-lifecycle emails route through the durable Redis retry queue (`email-queue.service`, `{ queue: true }`). The payment-webhook inbox has a super-admin UI + replay at `/webhook-events` (idempotency-safe).

**Redis TTL floor:** no TTLs <120s (hammers Neon on cache miss; ESLint-blocked) — use in-memory `bounded-map.ts` for sub-2-min caches.

**RLS:** `middleware/tenant-context.ts` (AsyncLocalStorage `runInTenantContext`) sets the Postgres session GUC that RLS policies read. Every tenant-data write path must run inside it. Re-verify policy state after any snapshot restore.

**Route authorization:** every admin route = `authenticate → authorize('store_admin','super_admin') → requireStoreAccess → handler`. Use `authorize()` (not `requireRole`); every endpoint with a storeId param gets `requireStoreAccess`; public endpoints don't get it.

**Code standards:** API: relaxed strict mode, `errorHandler` middleware, CSRF skips `/auth/`, auth rate limit 5/15min/IP+email. Admin: `middleware.ts` stays a passthrough; `StoreProvider`/`NotificationProvider` only mount when authenticated; SVG `<Image>` needs `unoptimized`. Web: store resolved via domain/slug in middleware; theme applied via CSS vars in `StoreContext`. `@force/database` build runs `prisma generate` first.

## Inventory model

**`products.inventory` is stock ONLY for a product with NO variants; for a variant product it is unused and stays 0, and the stock is `SUM(product_variants.inventory)`.** Read stock via `effectiveInventory`/`isOrderable`/`EFFECTIVE_STOCK_SELECT` (`apps/api/src/lib/effective-inventory.ts`) or `ON_HAND_SQL` (`…-sql.ts`) — never by dereferencing `.inventory`, and never with a filter that disagrees with its computation. One line writes the variant row XOR the product row, never both. Every variant write busts the product caches. Full rules + the 2026-08-30 defect that produced them: **`docs/architecture/inventory-model.md`**.

## Per-store visual configuration

Canonical editors, all StoreTheme flags, the product-card CTA/OOS system, PLP facets, AI balancer, and layout invariants: **`docs/architecture/store-theme-flags.md`**. Binding headlines: Page Builder + Smart Palette are the canonical design system (the Branding tab's color/font/preset pickers are retired inputs); theme PUT is a server-side shallow-merge PATCH — send only the keys your surface owns; new visual toggles default OFF (rule 2 below); Store columns instead of StoreTheme JSON only when API-gated.

## UI/UX standing rules (lessons — apply on every UI change)

1. **Sister systems = runtime mutex**, not merchant decision (`SectionDivider` returns null when `backgroundPreset !== 'none'`). → `feedback-fwb-section-rhythm-architecture`
2. **New visual features default OFF**; utility features that fill empty space may default ON — decide the category at design time.
3. **Theme flags ride StoreTheme JSON; Store columns only when API-gated** (routes 404 / Prisma WHERE / external services). → `feedback-fwb-theme-flag-pattern`
4. **ThemeTab ceiling = 7 toggles** — the next merchant-facing toggle gets a dedicated `/stores/[id]/<feature>` page under the right sidebar group.
5. **Admin pages mirror storefront top-to-bottom flow** (never alphabetical or grouped-by-control-type; `groupHeading` clusters + nested sub-controls). → `feedback-admin-mirrors-storefront-flow`
6. **Fixed-bottom UI two-trap recipe**: reserve space on `<body>` (NOT the chrome wrapper); lift any other fixed-bottom UI via `bottom-[calc(<bar>px+env(safe-area-inset-bottom))]`. → `feedback-fixed-bottom-ui-stacking`
7. **data-zone + Tailwind size classes required** for Typography overrides — never `text-[Xpx]`. → `feedback-fwb-data-zone-hardcoded-size-trap`
8. **Editorial-hairline divider language is THE separator idiom** (two `bg-foreground/30` lines flanking centered text; `SectionKicker`/`SectionHeading`/`SectionDivider`) — reuse, don't invent new separators.
9. **OSOSS reference set is the UX benchmark**: Pecannbee, Bank Alkahraman, SMEJ — scan `reference-ui-target-pecannbee-bankalkahraman` + `reference-ui-untitled-smej` (scoped memory) before inventing a pattern.
10. **Live-review iteration is part of the loop** — budget 2-4 refinement rounds; no "done" claim on non-trivial UX without Ahmad sign-off.
11. **Sprint plan → Stitch preview → code** for UI spanning multiple themes/components/surfaces (plan in `docs/plans/<date>-<slug>.md`, validate visually first). → `reference-stitch-mcp`
12. **commitlint: all-lowercase subjects** (HEREDOC commits start with lowercase type); blank line before Co-Authored-By.
13. **TYPOGRAPHY_ZONES additions need the data-zone wiring sweep** — every zone must report ≥1 DOM wiring or the admin control silently no-ops. → `feedback-fwb-footer-data-zone-missing`
14. **ColorField everywhere** — never inline `<input type="color">` in admin (`grep -rn 'type="color"' apps/admin/src | grep -v ColorField` must be empty); thread `theme={storeInfo?.theme ?? FALLBACK_THEME}`; storefront resolves `token:*` via `resolveColor(value, theme)`. → `feedback-fwb-colorfield-reuse-pattern`
15. **`token:X` resolution MUST fall back to `hsl(var(--<key>))`** when the theme key is undefined (legacy rows) — otherwise merchant picks silently drop. → `feedback-fwb-token-resolution-gap`

## Project-specific standing lessons

- **Multi-step Redis sentinel for reminders** — stepped reminder cadences (cart-abandoned 1h/4h/24h) use Redis sentinel keys tracking which step fired, not simple TTL locks.
- **Discoverability status-chip** — any feature whose toggle is buried 3+ taps deep MUST surface its state on the Settings overview card (e.g. "DM ordering: ON/OFF" chip). Ref commit `917a268a`.
- **Version-agnostic lookup for externally-versioned names** — Meta template names get renamed via Reset-to-Draft; dropdowns resolve by base-name match (strip `_v2`/`_v3`), never exact-name. Ref commit `1507ef67`.

## Known issues / tech debt

- Admin: some pages redundantly check `isAuthenticated` (AuthProvider handles redirects); `NotificationContext` WebSocket wired but no pages call `subscribeToStore()`.
- Web: `isPlatform` detection duplicated in `page.tsx` + `StoreContext.tsx`; cart sync after login calls `addToCart()` per item (should bulk); `SettingsClient` fetches profile independently of `useAuth().user`.

## Commands

```bash
npm run dev:api|dev:admin|dev:web     # dev servers (admin 3001, web 3000)
npm run build|typecheck|lint|lint:fix|format|format:check
npm run db:generate|db:migrate|db:push|db:seed|db:studio
npm run test|test:unit|test:integration|test:e2e|test:coverage
npm run test:defence-mutations           # deletes each security guard, asserts its test goes red
npm run audit:high | npm run secrets
```

CI (`ci.yml`): lint → typecheck → build → unit → integration (Postgres 16 + Redis 7 services) → e2e → audit + trufflehog; gitleaks separate workflow. The pre-push hook mirrors CI locally + runs blast-radius + a deduped Opus AI diff review (`SKIP_AI_GATE=1` skips the AI part).

**Reviewer model:** author, auto-fix and PR review all run on `claude-opus-5` (changed 2026-09-03 — the review previously ran on `claude-fable-5`). The rotation is therefore GONE: the reviewer is now the same model as the author, so it is a second pass, not an independent second opinion, and correlated blind spots are no longer mitigated at all. What still separates them is the prompt contract and the reviewer's restricted input, not the weights. That makes the durable answer more important, not less: turn each caught defect into a deterministic gate (lint/type/test) rather than trusting a reviewer. Security controls in the five mutation-record-mandatory domains carry that gate explicitly: `npm run test:defence-mutations` deletes each guard and asserts its test goes red — see `docs/security/defence-mutation-record.md`. In practice the **Blast-radius scoped audit** is the check that catches real defects here — it found every P0/P1 in the 2026-09-02 remediation — while the PR review has found nothing the audit missed. The reviewer sees ONLY the prompt contract + the unified diff — **never** the PR body or the author's rationale, or it inherits the framing that produced the defect. → `standard/skill-hygiene.md` (lens 26).

## Rollback + backup

`bash scripts/rollback.sh` reverts + pushes → redeploys the CF Workers + Railway in lock-step (never promote one app alone — shared API contracts via `@force/shared`). **Primary DR = Neon PITR (7-day window)** — branch-at-timestamp for bad migrations/deletes; full runbook + drill log: `docs/DB-BACKUP-RESTORE.md` (both paths drilled 2026-07-06). Belt-and-suspenders: daily local pg_dump via launchd (`backup-all-neon.sh`, keeps 30, needs pg_dump ≥ PG17) + daily encrypted copy to R2; per-commit Neon snapshots RETIRED — don't re-enable. Migration rollback: `docs/ROLLBACK.md` (re-verify RLS policy state after restore). Trace what migrated: `git log --diff-filter=A --name-only -- packages/database/prisma/migrations/`.

## graphify

Knowledge graph at `graphify-out/`. ALWAYS read `graphify-out/GRAPH_REPORT.md` before source files/grep; prefer `graphify query/path/explain` for cross-module questions; run `graphify update .` after code changes (AST-only, free).

## Cross-project standing rules

The global `~/.claude/CLAUDE.md` + its memory pointers govern here too (blast-radius D-GATE, fix-the-class, the 15 code-quality gates, memory pipeline after every commit, worktree-per-task, documentation parity). They are intentionally not restated in this file.
