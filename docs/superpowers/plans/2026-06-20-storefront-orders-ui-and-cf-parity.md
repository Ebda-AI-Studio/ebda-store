# Storefront + Orders UI fixes & Cloudflare parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix five prod storefront/orders UI issues in the codebase (deploys to Vercel), then rebuild the Cloudflare preview workers with correct build-env and verify they match Vercel.

**Architecture:** Two phases, in this order per Ahmad's directive — **Phase A** lands all _code_ fixes on `main` (prod = Vercel). **Phase B** rebuilds the three CF workers with the right `NEXT_PUBLIC_*` build env and runs a Vercel-vs-Cloudflare parity sweep. Phase B is mostly config/redeploy, not code — the only "CF bugs" (admin Load-failed, pecannbee locations) are the missing build-env that web already proved (#318).

**Tech Stack:** Next.js 16 (web/admin/orders), Express+Prisma API, Postgres (Neon), Tailwind, OpenNext+wrangler for CF.

**Design decisions (confirmed with Ahmad 2026-06-20):**

- Best-seller (#2) → a **general per-category "show on homepage strip" toggle** (any category, not just best-seller).
- Logo (#4) → **auto-fit by aspect ratio (default) + optional per-store size override** in admin.

---

## File structure (what changes & why)

| File                                                                                 | Responsibility                                                                                                                                        | Phase/Task |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- | -------------------------------------------------- | --- |
| `apps/web/src/templates/shared/SectionDivider.tsx`                                   | Suppress the divider band when the store uses a non-default **page** background (not just per-section bgColor) → kills the white band on brown stores | A1         |
| `apps/web/src/app/HomePageContent.tsx`                                               | Thread the page-bg signal into the `hideForExplicitBg` calls around best-sellers/brand-story/trust-strip                                              | A1         |
| `apps/orders/src/contexts/ToastContext.tsx`                                          | Move the toast stack from top (overlapping `AppHeader`) to bottom, above safe-area inset                                                              | A2         |
| `apps/orders/src/lib/push.ts` + `apps/orders/src/components/EnableNotifications.tsx` | Diagnose + harden the notification-enable failure (surface the real reason)                                                                           | A3         |
| `apps/web/src/templates/shared/StoreLogo.tsx` (**new**)                              | Single shared logo component: auto-fit by measured aspect ratio within min/max thresholds + per-store size override                                   | A4         |
| `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/Header.tsx`            | Replace the hardcoded logo `<Image className="h-14 max-w-[150px]…">` with `<StoreLogo>`                                                               | A4         |
| `apps/web/src/lib/store-resolver.ts` + `@force/shared` theme type                    | Carry `logoSize` (theme JSON: `'auto'                                                                                                                 | 'sm'       | 'md' | 'lg'`, default `'auto'`) through to the storefront | A4  |
| `apps/admin/src/components/.../BrandingTab` (logo area)                              | Add a "Logo size" control (Auto / S / M / L) writing `theme.logoSize`                                                                                 | A4         |
| `packages/database/prisma/schema.prisma` (`Category`)                                | Add `showOnHomeStrip Boolean @default(true)` column                                                                                                   | A5         |
| `apps/api/src/routes/category.routes.ts` + service                                   | Honor `showOnHomeStrip` on the public homepage-categories read; accept it on admin update                                                             | A5         |
| `apps/admin` category edit UI                                                        | Per-category toggle "Show on homepage strip"                                                                                                          | A5         |
| `apps/web` CategoryStrip data source                                                 | Filter to `showOnHomeStrip` for the homepage strip only (category pages/nav unaffected)                                                               | A5         |
| `docs/migration/cloudflare-preview-workers.md` + `scripts/cf-build.sh`               | Document/wire the required `NEXT_PUBLIC_*` build env for admin + orders                                                                               | B          |

---

## PHASE A — Prod code fixes (land on `main` → Vercel)

### Task A1: Kill the white divider band on page-bg stores

**Files:** Modify `apps/web/src/templates/shared/SectionDivider.tsx`, `apps/web/src/app/HomePageContent.tsx`

The homepage renders a `<SectionDivider hideForExplicitBg={!!sectionBgColor}>` before brand-story / trust-strip / etc. On a store whose brown comes from the **page background** (`theme.backgroundColor` / `backgroundPreset`), not a per-section `bgColor`, `hideForExplicitBg` is false → a light band renders over the brown = the reported "white part after best-seller".

- [ ] **Step 1** — Read `SectionDivider.tsx` end-to-end + confirm how `hideForExplicitBg` and the existing `backgroundPreset` mutex interact (CLAUDE.md: "SectionDivider ↔ backgroundPreset mutex"). Identify whether a non-`none` `theme.backgroundPreset` or a custom `theme.backgroundColor` already suppresses it; the bug is the _custom page bg color_ case.
- [ ] **Step 2** — Add a `pageHasCustomBg` boolean to the divider's suppression: divider returns `null` when the store's resolved page background is non-default (brown), regardless of per-section bgColor. Source the signal from `store.theme` (already in scope in HomePageContent).
- [ ] **Step 3** — Sweep ALL `<SectionDivider>` call-sites in `HomePageContent.tsx` (lines ~386, 495, 579, 660, 678, 693, 709, 804) so the suppression is consistent (fix-the-whole-defect-class — the earlier white-divider fix this session missed the page-bg case).
- [ ] **Step 4 — Verify**: build web with a pecannbee-like brown page bg locally OR redeploy preview and load `/pecannbee` → no white band between best-sellers and trust strip; a `none`/white store still shows its dividers.
- [ ] **Step 5 — Commit**: `fix(web): suppress section dividers on custom page-bg stores (white band)`

### Task A2: Move orders toast off the header

**Files:** Modify `apps/orders/src/contexts/ToastContext.tsx`

Toast stack is `fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-50`; `AppHeader` is `sticky top-0` → toast lands on the logo/Sign-out row.

- [ ] **Step 1** — Change the toast container to bottom: `fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-50 flex flex-col-reverse items-center` (newest toast nearest the thumb; `flex-col-reverse` keeps stack order natural at the bottom).
- [ ] **Step 2 — Verify**: trigger a toast (e.g. the notification flow) → it appears at the bottom, never overlapping the header.
- [ ] **Step 3 — Commit**: `fix(orders): show toasts at the bottom, clear of the header`

### Task A3: Diagnose + harden the orders notification-enable failure

**Files:** Read `apps/orders/src/lib/push.ts`, `EnableNotifications.tsx`; possibly modify both.

`subscribeToOrderPush` returned `error` → either SW (`/sw.js`) never `ready` or the server `…/orders-app/push/subscribe` POST failed. The toast shows the generic `t.notifications.failed`.

- [ ] **Step 1 — Determine WHERE it fails**: confirm whether the failing app is **prod** (`orders.forcemediakw.com`, real bug) or the **CF worker** built without `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (then the banner wouldn't even show — so prod is the likely surface). Check prod `/sw.js` serves 200 + the `orders-app/push/subscribe` endpoint responds for an authed staff token.
- [ ] **Step 2 — Make the failure legible**: split the `'error'` outcome into specific reasons (`'sw-not-ready'` vs `'server-rejected'`) and show a more actionable toast (e.g. "Reopen the app and try again" vs "Couldn't register — contact support"). Keep the rollback (`subscription.unsubscribe()`) on server failure.
- [ ] **Step 3 — Fix the root cause found in Step 1** (SW registration timing OR the API subscribe handler). If it's a CF-build-env miss, that moves to Phase B and this task only adds the legibility improvement.
- [ ] **Step 4 — Verify**: enable notifications on a device → success toast; force a failure → specific message.
- [ ] **Step 5 — Commit**: `fix(orders): surface real reason when enabling notifications fails`

### Task A4: Logo auto-fit by aspect + per-store override

**Files:** Create `apps/web/src/templates/shared/StoreLogo.tsx`; modify the 5 theme `Header.tsx`; add `logoSize` to the theme type in `@force/shared` + `store-resolver.ts`; add a control in admin Branding.

Today every store shares one fixed box (`h-14 max-w-[150px] / md:h-20 max-w-[210px]`) → shrinking pecannbee shrank wady-aljuz. New model: **measure the logo's natural aspect ratio on load and pick a fit within safe min/max**, times a per-store multiplier.

- [ ] **Step 1** — Define `logoSize: 'auto' | 'sm' | 'md' | 'lg'` (default `'auto'`) on the resolved store theme (`@force/shared` theme type + `store-resolver.ts` passthrough). It rides the `StoreTheme` JSON (theme-flag pattern → zero migration).
- [ ] **Step 2** — Build `StoreLogo.tsx` (client component): renders `next/image`, `onLoadingComplete` reads `naturalWidth/naturalHeight` → aspect. Map aspect → a height/width cap pair, all clamped to thresholds so the header row (`h-32 / md:h-44` container) never breaks:
  - wide wordmark (aspect ≥ ~2.5): cap by width (`max-w`), shorter height.
  - balanced (0.8–2.5): cap by height, moderate width.
  - tall/square (< 0.8): cap by height (taller), narrow width.
    Apply the per-store `logoSize` as a multiplier on the chosen caps (`sm`=0.8, `md`=1.0, `lg`=1.25, `auto`=1.0 but aspect-derived). SSR default = current `md`-ish box (no layout flash before measure).
- [ ] **Step 3** — Replace the inline `<Image …logo classes>` in all 5 `Header.tsx` with `<StoreLogo logo={displayLogo} size={theme.logoSize} alt={…} />`. Keep each theme's container/positioning (absolute-centered mobile etc.) unchanged.
- [ ] **Step 4** — Admin: add a "Logo size" segmented control (Auto / S / M / L) in the Branding logo area writing `theme.logoSize` via the existing theme PATCH.
- [ ] **Step 5 — Verify**: pecannbee (wide-ish) and wady-aljuz (different shape) each render a well-fit logo independently; switching one store's size doesn't affect the other; nothing overflows the header at mobile + desktop in all 5 themes.
- [ ] **Step 6 — Commit**: `feat(web): adaptive per-logo sizing (auto-fit by aspect + per-store override)`

### Task A5: Per-category "show on homepage strip" toggle

**Files:** `packages/database/prisma/schema.prisma`, a new migration, `apps/api` category route+service, admin category edit UI, `apps/web` homepage CategoryStrip source.

- [ ] **Step 1** — Schema: add `showOnHomeStrip Boolean @default(true)` to `Category`. Hand-write the migration at `packages/database/prisma/migrations/<TS>_category_show_on_home_strip/migration.sql` (`ALTER TABLE "Category" ADD COLUMN "showOnHomeStrip" BOOLEAN NOT NULL DEFAULT true;`). Default true = no visual change for existing stores (rule #2 — but inverse: hiding is opt-in).
- [ ] **Step 2** — API: the **homepage** categories read filters `where: { showOnHomeStrip: true }` (the strip only). Category nav/menu + category landing pages keep showing all categories. Admin category update accepts `showOnHomeStrip`.
- [ ] **Step 3** — Admin: per-category toggle "Show as a card on the homepage strip" (default on). Platform-level (works for every store's categories).
- [ ] **Step 4** — Web: ensure the homepage `CategoryStrip` consumes the filtered list; other category surfaces unaffected.
- [ ] **Step 5 — Verify**: toggle a category off → it disappears from the homepage strip card row but its collection/nav still works; products page best-seller scroll unaffected.
- [ ] **Step 6 — Commit**: `feat: per-category toggle to hide it from the homepage strip`

### Task A7: Admin icon text "DASHBOARD" → "ADMIN" (bigger glyph)

**Files:** `apps/admin/public/favicon.svg` + regenerate the PNG icon set.

The admin app icon/favicon renders `<text…>DASHBOARD</text>` (font-size 71) — too long, so the glyph + brand mark render small. "ADMIN" is shorter → render it bigger.

- [ ] **Step 1** — In `favicon.svg`, change the `<text>` content `DASHBOARD` → `ADMIN` and bump `font-size` (≈71 → ≈95–105) + re-check `y`/letter-spacing so it's centered and fills the badge without touching the mark.
- [ ] **Step 2** — Regenerate every raster icon from the updated SVG (they all carry the word): `favicon-16.png`, `favicon-32.png`, `icon.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-192x192.png`, `icon-384x384.png`, `icon-512x512.png`. Rasterize with sharp/Playwright/Chrome-headless at each target size from `favicon.svg`.
- [ ] **Step 3 — Verify**: open each PNG → reads "ADMIN", larger than before, mark intact; `manifest.ts` name/short_name unchanged ("Force Admin").
- [ ] **Step 4 — Commit**: `fix(admin): app icon says ADMIN (bigger) instead of DASHBOARD`

### Task A6: Ship Phase A to prod

- [ ] PR the Phase-A commits, CI green (incl. all 3 Vercel deploys), merge to `main`. This is "fixed on prod".

---

## PHASE B — Cloudflare parity (rebuild workers + verify == Vercel)

The only CF "bugs" are the missing build-env that web already proved. No app-code changes expected here beyond what Phase A merged.

### Task B1: Rebuild admin worker with build env → fixes "Load failed"

- [ ] Add CF tooling locally to admin (`npm i -D @opennextjs/cloudflare@1.19.11 wrangler@^4.86.0 -w @force/admin` + recreate `wrangler.jsonc`/`open-next.config.ts`).
- [ ] Build with the admin env inlined: `export NEXT_PUBLIC_API_URL=https://api-production-c058.up.railway.app/api/v1` (+ `NEXT_PUBLIC_ONESIGNAL_APP_ID` if push parity wanted) `&& bash scripts/cf-build.sh admin && (cd apps/admin && npx wrangler deploy)`.
- [ ] **Verify**: `force-admin-cf-preview.workers.dev/login` → no "Load failed"; the login form reaches the API (CSRF/login network calls 200).

### Task B2: Rebuild orders worker with build env

- [ ] Same tooling for orders; build with `NEXT_PUBLIC_API_URL` + `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (+ ONESIGNAL if used) inlined → deploy.
- [ ] **Verify**: orders worker loads orders list (API reachable), and the notification-enable path no longer fails for a build-env reason (the A3 legibility change tells us if a real failure remains).

### Task B3: Rebuild web worker from post-Phase-A `main`

- [ ] Rebuild + redeploy `force-web-cf-preview` from the merged `main` (picks up A1 divider + A4 logo + A5 strip) with `NEXT_PUBLIC_API_URL` + `NEXT_PUBLIC_SITE_URL`.
- [ ] **Verify**: `/pecannbee` (no white band, adaptive logo), `/pecannbee/locations` (Avenues branch — already confirmed), `/wady-aljuz`, `/palora`.

### Task B4: Cloudflare-vs-Vercel parity sweep

- [ ] For each surface, compare the CF worker against the live Vercel prod: storefront home/PDP/cart/search/locations, admin login→dashboard, orders list→detail. Note any Workers-only divergence (SSR errors, missing env, native-dep paths) and fix at the boundary.
- [ ] Document the required per-app build env + the parity results in `docs/migration/cloudflare-preview-workers.md`. Consider committing a small `apps/<app>/.env.cloudflare.example` (public values only) + having `scripts/cf-build.sh` auto-source `apps/<app>/.env.cloudflare.local` so a build never silently misses `NEXT_PUBLIC_API_URL` again (the root cause of admin Load-failed + the earlier web fallback).

---

## Self-review

- **Spec coverage:** #1 white divider → A1; #2 best-seller/category → A5 (per-category toggle, per Ahmad); #3 orders notification + toast → A2 (toast) + A3 (notification); #4 logo → A4 (auto+override, per Ahmad); admin broken on CF → B1; locations on CF → already fixed, re-verified in B3; "check all CF == Vercel" → B4. All covered.
- **Ordering:** matches Ahmad's directive — all prod code (Phase A) ships + merges before any CF rebuild (Phase B).
- **Risk notes:** A4 (logo) is a much-iterated area (CLAUDE.md history) — expect 1–2 live-review rounds; A5 adds a DB column (migration applies on next API boot — verify on a preview/branch first per rollback discipline). A1 must not over-suppress dividers on white/`none` stores.
- **Open data point:** A3 root cause (prod vs build-env) is determined in A3/Step 1 before deciding if the fix lands in Phase A or B.
