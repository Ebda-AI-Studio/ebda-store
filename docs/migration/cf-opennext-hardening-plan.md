# Cloudflare / OpenNext storefront hardening plan (2026-06-27)

Closes the architectural gaps that surfaced in the post-Vercel→Cloudflare regression audit. These changes are **high blast radius** (a wrong `open-next.config.ts` / `wrangler.jsonc` breaks the storefront worker for **every** store) and **must be verified on a CF preview deploy before merge** — the storefront auto-deploys from `main` via `.github/workflows/cf-deploy.yml`. The CF build config (`apps/web/open-next.config.ts`, `apps/web/wrangler.jsonc`) is **generated at deploy time** by `scripts/cf-setup-local.sh` and git-ignored, so all config changes below land in that generator.

OpenNext Cloudflare version in use: `@opennextjs/cloudflare@1.19.11` (pinned in `cf-setup-local.sh`). Verify the override import paths against that exact version before applying — they have moved between minors.

---

## Gap 1 — `revalidateTag` is per-isolate (theme saves take ~15s instead of ~1s)

**Cause:** `open-next.config.ts` is generated as `defineCloudflareConfig({})` — no incremental cache and no tag cache. On Workers each isolate has its own in-memory cache, so `POST /api/revalidate` → `revalidateTag(...)` only clears the isolate that handled the call. Merchant edits (theme/brand color) don't appear until the per-fetch `revalidate` TTL (up to 60s) expires on each isolate.

**Fix:** wire OpenNext's R2 incremental cache + sharded-Durable-Object tag cache + DO queue.

### 1a. Create CF resources (one-time, needs `CLOUDFLARE_API_TOKEN` + account)

```bash
# R2 bucket for cached pages (idempotent — ignore "already exists")
npx wrangler r2 bucket create force-web-opennext-cache
# (Durable Objects for the tag cache + queue are created by the deploy via
#  the migrations block below — no manual step.)
```

Add the bucket-create as an idempotent step in `cf-deploy.yml` (it already has `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) so fresh environments self-provision:

```yaml
- name: Ensure R2 cache bucket
  run: npx wrangler r2 bucket create force-web-opennext-cache || true
```

### 1b. `open-next.config.ts` (emitted by `cf-setup-local.sh` for `web`)

```ts
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import { shardedTagCache } from '@opennextjs/cloudflare/overrides/tag-cache/tag-cache';
import { queueCache } from '@opennextjs/cloudflare/overrides/queue/queue-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: shardedTagCache({ baseShardSize: 12, regionalCache: true }),
  queue: queueCache(doQueue),
  enableCacheInterception: true,
});
```

> ⚠️ Confirm each `@opennextjs/cloudflare/overrides/...` path resolves under 1.19.11 (`ls node_modules/@opennextjs/cloudflare/dist/overrides`). If a path differs, use the one the installed package exports — do NOT guess.

### 1c. `wrangler.jsonc` additions (emitted by `cf-setup-local.sh` for `web`)

```jsonc
// add to the generated web wrangler.jsonc:
"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
"services": [
  { "binding": "WORKER_SELF_REFERENCE", "service": "force-web-cf-preview" }
],
"r2_buckets": [
  { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "force-web-opennext-cache" }
],
"durable_objects": {
  "bindings": [
    { "name": "NEXT_TAG_CACHE_DO_SHARDED", "class_name": "DOShardedTagCache" },
    { "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DurableObjectQueueHandler" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["DOShardedTagCache", "DurableObjectQueueHandler"] }
]
```

The DO classes are exported by OpenNext's generated worker — no app code needed. The `WORKER_SELF_REFERENCE` service name MUST equal the worker `name` (`force-web-cf-preview`).

### 1d. Verify (preview deploy, BEFORE merge)

1. `bash scripts/cf-build.sh web && (cd apps/web && npx wrangler deploy)` to a preview.
2. Change a brand color in admin → time-to-visible on the preview storefront should drop to ~1s (was ~15s).
3. Confirm no `NEXT_INC_CACHE_R2_BUCKET`/DO binding errors in `wrangler tail`.

---

## Gap 2 — `next/image` unoptimized on CF

**Cause:** `images.unoptimized = IS_CLOUDFLARE` in `apps/web/next.config.js` (sharp is Node-only). Accepted to date because R2 images are backend-resized on upload — but directly-uploaded images bypass that, and there's no format negotiation/blur.

**Fix (optional, same deploy):** OpenNext supports CF image optimization via an `IMAGES` binding. Add to the generated `wrangler.jsonc`:

```jsonc
"images": { "binding": "IMAGES" }
```

and set `images.unoptimized` back to `false` on CF in `next.config.js`. **Verify** product images on a preview load via the optimizer (not raw `*.r2.dev`) and aren't upscaled on mobile. If it regresses quality/cost, revert to `unoptimized` — this is the lowest-priority item.

---

## Gap 3 — server-side Sentry off on CF

**Cause:** `scripts/cf-build.sh` moves `instrumentation.ts` aside (the `@sentry/nextjs` Node SDK + OpenTelemetry can't run on Workers), so SSR / route-handler / Server-Component errors on CF are uncaptured.

**Fix:** add `@sentry/cloudflare` and wrap the OpenNext worker. OpenNext exposes the worker entry; wrap it with `withSentry`:

```ts
// the generated worker entry (or an open-next custom worker wrapper)
import * as Sentry from '@sentry/cloudflare';
export default Sentry.withSentry(
  env => ({
    dsn: env.NEXT_PUBLIC_SENTRY_DSN_WEB,
    environment: 'production-cf',
    tracesSampleRate: 0.1,
  }),
  baseWorker
);
```

Needs `@sentry/cloudflare` as a CF-only devDep in `cf-setup-local.sh` (NOT committed to package.json — keeps Vercel/CI lean, same pattern as the OpenNext deps). **Verify** an intentional SSR error on a preview appears in Sentry tagged `production-cf`.

---

## Gap 4 — OG card SVG logo → text fallback on CF

**Cause:** `apps/web/src/app/og/route.tsx` guards `rasterizeSvgToPng` off when `isCloudflareRuntime()` (sharp unavailable), so stores with an **SVG** logo get a text card on WhatsApp/social previews. Raster logos are fine.

**Fix (low priority — few stores have SVG logos):** either (a) pre-rasterize SVG logos to PNG at upload time and store the PNG variant, or (b) use a Workers-compatible rasterizer (e.g. `@resvg/resvg-wasm`) in the OG route. Option (a) is cheaper and reuses the existing upload-resize pipeline.

---

## Merge discipline

- Gaps 1–3 change the **generated CF build config / worker** → they CANNOT be verified by CI (CI builds for Vercel) and MUST be verified on a **CF preview deploy** before the change reaches `main`. Treat the implementing PR as **do-not-auto-merge**.
- Gap 4 is app code, verifiable in a normal build, but low value.
- After merge, watch the first `cf-deploy.yml` run + `wrangler tail` for binding errors, and keep `scripts/rollback.sh` ready (the worker reverts with the code).
