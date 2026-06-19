# Cloudflare preview workers — FWB frontends (OpenNext)

> Status: **all three FWB Next apps validated on Cloudflare Workers** (preview, 2026-06-19). Vercel remains production — these are parallel preview deploys, **zero DNS / prod impact**. Companion to `docs/migration/cloudflare-readiness.md`.

## Preview worker URLs

| App                        | Worker                    | URL                                                        | Notes                                                                          |
| -------------------------- | ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/web` (storefront)    | `force-web-cf-preview`    | https://force-web-cf-preview.ahmed0montaser.workers.dev    | Phase 1 (#314). Root renders Platform landing (workers.dev not domain-mapped). |
| `apps/orders` (orders PWA) | `force-orders-cf-preview` | https://force-orders-cf-preview.ahmed0montaser.workers.dev | Clean — no blockers. SSR via OpenNext.                                         |
| `apps/admin` (dashboard)   | `force-admin-cf-preview`  | https://force-admin-cf-preview.ahmed0montaser.workers.dev  | `instrumentation.ts` moved aside at build time (see below).                    |

All three: `next: 16.2.9` under `@opennextjs/cloudflare@1.19.11`, `compatibility_flags: ["nodejs_compat"]`, deploy to **Workers + Static Assets** (the `ASSETS` binding), ~24–31 ms cold start.

## What's committed vs local-only

**Committed** (zero Vercel impact, mirrors web's #314 shape):

- `apps/{web,admin,orders}/next.config.js` — `IS_CLOUDFLARE` gate → `images.unoptimized` on the CF build only (Vercel stays optimized; Workers can't run native `sharp`).
- `.gitignore` — `.open-next/`, `.wrangler/`, `apps/*/open-next.config.ts`, `apps/*/wrangler.jsonc`.

**Local-only (NOT committed, deliberately)** — heavy preview-build tooling + the worker config stay off `main` to avoid bloating every install + lockfile drift (CI runs npm 10.8.2; local npm 11) **and** because `open-next.config.ts` imports `@opennextjs/cloudflare` (not a committed dep) — tracking it would break the Vercel/CI typecheck (`TS2307: Cannot find module`). Web kept them untracked for the same reason. Per app, when building:

```bash
# 1. devDeps (local only)
npm i -D @opennextjs/cloudflare@1.19.11 wrangler@^4.86.0 -w @force/<app>
#    @force/admin for admin; @force/orders for orders. web had them in the spike.

# 2. open-next.config.ts (apps/<app>/open-next.config.ts)
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
export default defineCloudflareConfig({});

# 3. wrangler.jsonc (apps/<app>/wrangler.jsonc) — set "name" per app:
#    force-admin-cf-preview / force-orders-cf-preview / force-web-cf-preview
{
  "name": "force-<app>-cf-preview",
  "main": ".open-next/worker.js",
  "compatibility_date": "2025-03-25",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" }
}
```

## Build + deploy recipe (per app)

From the repo root, after the devDeps + `wrangler.jsonc` + `open-next.config.ts` above exist, build with the committed helper (it handles the `instrumentation.ts` workaround automatically — see below) then deploy:

```bash
bash scripts/cf-build.sh orders                # -> apps/orders/.open-next/worker.js
(cd apps/orders && npx wrangler deploy)         # -> force-orders-cf-preview.workers.dev

bash scripts/cf-build.sh admin
(cd apps/admin && npx wrangler deploy)          # -> force-admin-cf-preview.workers.dev

bash scripts/cf-build.sh web
(cd apps/web && npx wrangler deploy)            # -> force-web-cf-preview.workers.dev
```

`scripts/cf-build.sh` sets `OPEN_NEXT_CLOUDFLARE=1` (flips the `IS_CLOUDFLARE` image gate) and, for apps that have an `instrumentation.ts`, moves it aside for the build only and **always restores it** (EXIT trap — even on failure), so the committed Vercel path is never touched. `wrangler deploy` reads `wrangler.jsonc`; requires a prior `wrangler login`.

## Why the `instrumentation.ts` workaround is required (OpenNext upstream limitation)

OpenNext **cannot trace Next's `instrumentation.ts`** in our monorepo standalone output. Next emits `.next/server/instrumentation.js` but does **not** copy it into `.next/standalone/`, so OpenNext's `copyTracedFiles` dies with:

```
Error: File server/instrumentation.js does not exist
```

This is triggered by the **mere presence** of `instrumentation.ts`, independent of its contents — so there is **no in-file code fix** (verified 2026-06-19: gating/lazy-importing the Sentry calls inside the file does not help; the trace step fails before any of that runs). It is an upstream `@opennextjs/aws` limitation, still present in the **latest** `@opennextjs/cloudflare@1.19.11`. The only reliable workaround is to build with the file absent, which `scripts/cf-build.sh` automates safely. `apps/web` + `apps/admin` both have an `instrumentation.ts`; `apps/orders` has none (builds straight).

**Possible future eliminations (not needed for preview):** (a) an OpenNext release that fixes `copyTracedFiles` for instrumentation → then the file can stay; (b) move server-side Sentry to `@sentry/cloudflare` (Workers SDK) AND drop `instrumentation.ts` on the CF build — heavier, risks the live Vercel Sentry wiring, deferred to prod cutover. Tracked in `cloudflare-readiness.md` §1.

## Next steps (when promoting beyond preview)

1. Re-check newer `@opennextjs/cloudflare` for the `copyTracedFiles` instrumentation fix; if shipped, drop the move-aside. Otherwise `@sentry/cloudflare` across web + admin.
2. Commit the build tooling (devDeps + worker config) + wire a CI build job, lockfile regenerated with npm 10.8.2.
3. Cloudflare for SaaS custom-hostname onboarding per client domain (production DNS — canary 1–2 stores first, per `cloudflare-readiness.md`).
