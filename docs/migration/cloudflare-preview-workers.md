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

From the repo root, after the devDeps above are installed:

```bash
# orders (clean)
cd apps/orders
OPEN_NEXT_CLOUDFLARE=1 ../../node_modules/.bin/opennextjs-cloudflare build
../../node_modules/.bin/wrangler deploy        # -> force-orders-cf-preview.workers.dev

# admin (Sentry node instrumentation can't run on Workers; OpenNext can't trace it)
cd ../admin
mv instrumentation.ts instrumentation.ts.cfbak           # move aside for the CF build only
OPEN_NEXT_CLOUDFLARE=1 ../../node_modules/.bin/opennextjs-cloudflare build
mv instrumentation.ts.cfbak instrumentation.ts           # restore — Vercel path untouched
../../node_modules/.bin/wrangler deploy        # -> force-admin-cf-preview.workers.dev
```

`OPEN_NEXT_CLOUDFLARE=1` flips the `IS_CLOUDFLARE` gates (image optimizer off). `wrangler deploy` reads `wrangler.jsonc`. Requires a prior `wrangler login`.

## Known blocker — admin `instrumentation.ts` (Sentry Node SDK)

`apps/admin/instrumentation.ts` statically re-exports `@sentry/nextjs` (`export { captureRequestError as onRequestError }`) + dynamically loads `sentry.server.config`. The Sentry **Node** SDK + OpenTelemetry can't run on Workers, and OpenNext can't trace the compiled `instrumentation.js` in the monorepo standalone output. The build-time move-aside above is the same workaround the web Phase-1 spike used. `apps/web` has the identical file and the same caveat.

**Permanent fix (deferred to prod-cutover):** swap the server side to **`@sentry/cloudflare`** (Workers SDK) gated on `IS_CLOUDFLARE`, applied to web + admin together. Not done here because (a) it risks the live Vercel Sentry wiring and (b) these are preview-only. Tracked in `cloudflare-readiness.md` §1.

## Next steps (when promoting beyond preview)

1. Permanent `instrumentation.ts` fix (`@sentry/cloudflare`) across web + admin.
2. Commit the build tooling (devDeps + scripts) + wire a CI build job, lockfile regenerated with npm 10.8.2.
3. Cloudflare for SaaS custom-hostname onboarding per client domain (production DNS — canary 1–2 stores first, per `cloudflare-readiness.md`).
