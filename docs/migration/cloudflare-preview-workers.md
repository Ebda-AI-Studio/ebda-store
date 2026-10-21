# Cloudflare preview workers — Ebda Store frontends (OpenNext)

> Status: **all three Ebda Store Next apps validated on Cloudflare Workers** (preview, 2026-06-19). Vercel remains production — these are parallel preview deploys, **zero DNS / prod impact**. Companion to `docs/migration/cloudflare-readiness.md`.

## Preview worker URLs

| App                        | Worker        | URL                                            | Notes                                                                                                    |
| -------------------------- | ------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web` (storefront)    | `ebda-web`    | https://ebda-web.ahmed0montaser.workers.dev    | Root = Platform landing. Real stores render by slug: `/demo-store`, `/wady-aljuz`, `/demo-boutique` (see below). |
| `apps/orders` (orders PWA) | `ebda-orders` | https://ebda-orders.ahmed0montaser.workers.dev | Clean — no blockers. SSR via OpenNext.                                                                   |
| `apps/admin` (dashboard)   | `ebda-admin`  | https://ebda-admin.ahmed0montaser.workers.dev  | `instrumentation.ts` moved aside at build time (see below).                                              |

All three: `next: 16.2.9` under `@opennextjs/cloudflare@1.19.11`, `compatibility_flags: ["nodejs_compat"]`, deploy to **Workers + Static Assets** (the `ASSETS` binding), ~20–31 ms cold start.

### See a real store on the worker (pre-DNS)

The storefront is multi-tenant: a custom domain resolves one store; a **platform host** serves the Platform landing at root and resolves stores by **slug** (`/<slug>`). `*.workers.dev` is now classed as a platform host (fix below), so without any DNS change you can view live stores on the preview worker:

- https://ebda-web.ahmed0montaser.workers.dev/ — Platform landing
- https://ebda-web.ahmed0montaser.workers.dev/demo-store — Storefront
- https://ebda-web.ahmed0montaser.workers.dev/wady-aljuz — Wady Aljuz (وادي الجوز)
- https://ebda-web.ahmed0montaser.workers.dev/demo-boutique — demo-boutique (بالورا)

After the DNS move, each store is served at its OWN domain (e.g. `demo-merchant.com`) with no `/<slug>` prefix — the same code path, just resolved by domain instead of slug.

### Required build env for `apps/web` (storefront)

`NEXT_PUBLIC_*` vars are **inlined at build time**. Without `NEXT_PUBLIC_API_URL` the worker falls back to `http://localhost:4000/api/v1` and every store fails to resolve (→ Platform landing for every slug). Build web with at least:

```bash
export NEXT_PUBLIC_API_URL="https://api.ebda.app/api/v1"  # corrected 2026-09-02: the old raw api-production-c058.up.railway.app host now 404s
export NEXT_PUBLIC_SITE_URL="https://ebda-web.ahmed0montaser.workers.dev"  # optional (canonical/OG)
bash scripts/cf-build.sh web && (cd apps/web && npx wrangler deploy)
```

(Match the Vercel `force-web` project env at cutover. The other `NEXT_PUBLIC_*` vars — ONESIGNAL / POSTHOG / VAPID — degrade gracefully; set them for full push/analytics parity.)

### Fixes that made the web worker production-equivalent (this PR)

1. **`*.workers.dev` → platform host** (`apps/web/middleware.ts` `PLATFORM_SUFFIXES` + `apps/web/src/contexts/StoreContext.tsx` `isPlatform`). It was missing the Cloudflare analog of `*.vercel.app`, so the preview URL was mis-read as a custom domain and no store ever resolved. Zero prod impact (real custom domains never end in `workers.dev`).
2. **`sharp` CF build failure** (`apps/web/next.config.js` + `apps/web/src/app/opengraph-image.tsx`). `main` had the broken pair: `serverExternalPackages: ['sharp']` (made Turbopack emit an `[externals]_sharp` stub esbuild couldn't resolve) + a **literal** `import('sharp')`. Fixed: gate `serverExternalPackages` on `IS_CLOUDFLARE` (Vercel keeps `['sharp']`, byte-identical) + non-literal `import` specifier (esbuild leaves it as a runtime require; the OG route is runtime-gated off Workers anyway). The working fix had only ever lived in the unmerged Phase-1 spike worktree.

## What's committed vs local-only

> **STALE as of the per-tenant cutover (2026-07-07) — kept for the historical
> `instrumentation.ts` / build-recipe detail below, which is still accurate.**
> This section describes the PREVIEW-phase state, where Vercel was still
> production and the CF build tooling was deliberately kept off `main`. Both
> the "Next steps" item this section refers to are done: `@opennextjs/cloudflare`
>
> - `wrangler` are now regular devDependencies in `apps/{web,admin,orders}/package.json`,
>   and each app's `wrangler.jsonc`/`open-next.config.ts` are committed (git
>   tracked, not in `.gitignore` — the `.gitignore` entries below are also
>   stale). `scripts/cf-build.sh` now also runs in CI (`ci.yml`'s
>   `cf-build-check` job, gated on package.json/lockfile/adapter-config
>   changes) — audit-followup #1632 — not just at deploy time
>   (`cf-deploy.yml`). Both paths run `scripts/cf-setup-local.sh` FIRST, so the
>   committed config is only a local-dev fallback: what CI builds and what
>   deploys is the GENERATED config, checked by `scripts/assert-cf-cache-bindings.sh`
>   in both places (issues 2089/2152/2154). CI does not reproduce the deploy's
>   NEXT*PUBLIC*\* `.env.production.local` write.

**Committed** (zero Vercel impact, mirrors web's #314 shape):

- `apps/{web,admin,orders}/next.config.js` — `IS_CLOUDFLARE` gate → `images.unoptimized` on the CF build only (Vercel stays optimized; Workers can't run native `sharp`).
- `.gitignore` — `.open-next/`, `.wrangler/`, `apps/*/open-next.config.ts`, `apps/*/wrangler.jsonc`.

**Local-only (NOT committed, deliberately)** — heavy preview-build tooling + the worker config stay off `main` to avoid bloating every install + lockfile drift (CI runs npm 10.8.2; local npm 11) **and** because `open-next.config.ts` imports `@opennextjs/cloudflare` (not a committed dep) — tracking it would break the Vercel/CI typecheck (`TS2307: Cannot find module`). Web kept them untracked for the same reason. Per app, when building:

```bash
# 1. devDeps (local only)
npm i -D @opennextjs/cloudflare@1.19.11 wrangler@4.116.0 -w @ebda/<app>
#    @ebda/admin for admin; @ebda/orders for orders. web had them in the spike.

# 2. open-next.config.ts (apps/<app>/open-next.config.ts)
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
export default defineCloudflareConfig({});

# 3. wrangler.jsonc (apps/<app>/wrangler.jsonc) — set "name" per app:
#    ebda-admin / ebda-orders / ebda-web
{
  "name": "ebda-<app>",
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
(cd apps/orders && npx wrangler deploy)         # -> ebda-orders.workers.dev

bash scripts/cf-build.sh admin
(cd apps/admin && npx wrangler deploy)          # -> ebda-admin.workers.dev

bash scripts/cf-build.sh web
(cd apps/web && npx wrangler deploy)            # -> ebda-web.workers.dev
```

`scripts/cf-build.sh` sets `OPEN_NEXT_CLOUDFLARE=1` (flips the `IS_CLOUDFLARE` image gate) and, for apps that have an `instrumentation.ts`, moves it aside for the build only and **always restores it** (EXIT trap — even on failure), so the committed Vercel path is never touched. `wrangler deploy` reads `wrangler.jsonc`; requires a prior `wrangler login`.

## Why the `instrumentation.ts` workaround is required (OpenNext upstream limitation)

OpenNext **cannot trace Next's `instrumentation.ts`** in our monorepo standalone output. Next emits `.next/server/instrumentation.js` but does **not** copy it into `.next/standalone/`, so OpenNext's `copyTracedFiles` dies with:

```
Error: File server/instrumentation.js does not exist
```

This is triggered by the **mere presence** of `instrumentation.ts`, independent of its contents — so there is **no in-file code fix** (verified 2026-06-19: gating/lazy-importing the Sentry calls inside the file does not help; the trace step fails before any of that runs). It is an upstream `@opennextjs/aws` limitation, still present in the **latest** `@opennextjs/cloudflare@1.19.11`. The only reliable workaround is to build with the file absent, which `scripts/cf-build.sh` automates safely. `apps/web` + `apps/admin` both have an `instrumentation.ts`; `apps/orders` has none (builds straight).

**Possible future eliminations (not needed for preview):** (a) an OpenNext release that fixes `copyTracedFiles` for instrumentation → then the file can stay; (b) move server-side Sentry to `@sentry/cloudflare` (Workers SDK) — **done for `apps/web` 2026-07-02** via `apps/web/sentry-worker-entry.ts` (see `cloudflare-ci-deploy.md` Follow-ups). Note this did NOT eliminate the move-aside — that's still required for the unrelated `copyTracedFiles` bug above, independent of Sentry; `instrumentation.ts` still gets moved aside on every `apps/web` CF build, and SSR Sentry now runs via the worker-entry wrapper instead. `apps/admin` still needs the same worker-entry treatment (still `instrumentation.ts`-moved-aside + no CF SSR Sentry); `apps/orders` has no Sentry at all today.

## Next steps (when promoting beyond preview)

1. Re-check newer `@opennextjs/cloudflare` for the `copyTracedFiles` instrumentation fix; if shipped, drop the move-aside. `@sentry/cloudflare` is live for web — repeat for admin.
2. ~~Commit the build tooling (devDeps + worker config) + wire a CI build job~~ — **done.** Build tooling committed at the per-tenant cutover (2026-07-07); the CI build job (`cf-build-check` in `ci.yml`) landed 2026-09-25 (audit-followup #1632).
3. Cloudflare for SaaS custom-hostname onboarding per client domain (production DNS — canary 1–2 stores first, per `cloudflare-readiness.md`).

> **The per-tenant cutover is complete (2026-07-07).** See **[`cloudflare-cutover-runbook.md`](./cloudflare-cutover-runbook.md)** for the procedure that was used (`scripts/cf-setup-local.sh` clones these git-ignored build files for you; `scripts/cf-migrate-store.sh <slug>` provisions the CF hostname + flips the store). Vercel is cancelled and removed — the `DomainProvider` resolver now always resolves to Cloudflare-for-SaaS.
