# 2026-11-10 — store resolution: bulletproof + redundant (layers 2-5)

Incident (2026-11-10, measured): every storefront render resolves host -> store via `GET /public/store/resolve`;
`storeResolveLimiter` (30/min per IP) saw all storefront traffic as one client, so unknown or busy hosts flipped
between 404 and 500 inside a minute. Layer 1 (per-shopper signed IP, PR #514) is separate; this plan is layers 2-5.

## Finding that shapes the design

`apps/web/open-next.config.ts` sets only `incrementalCache: r2IncrementalCache`. OpenNext's default `tagCache` is
`"dummy"` (`@opennextjs/cloudflare/dist/api/config.js` `resolveTagCache(value = "dummy")`), so `revalidateTag
('store-domain:<host>')` never reached the Next data cache: the resolve copy there was only TTL-bounded (15 s + one
stale serve). Store status and domain ownership are NEVER-stale, so the resolve call now bypasses the Next data cache
(`cache: 'no-store'`) and the storefront owns its caching, invalidated by the per-store purge EPOCHS the Worker already
writes to R2 on every `/api/revalidate` (Ruling STORE-EDGE-1).

## Layers (all in `apps/web/src/lib/store-resolve-cache.ts`, used by `store-resolver.ts`)

| #   | layer                                                                 | where                                                                            | TTL                                               | invalidation                                                                    |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| L1  | per-isolate memory, hits AND definitive misses                        | Map                                                                              | hit 60 s / miss 30 s (no R2: 8 s / 15 s)          | epoch check (`all`, `host/<host>`, `id/<storeId>`, 2 s memo) before every serve |
| L2  | durable last-known-good in R2 `resolve-lkg/<host>`                    | `NEXT_INC_CACHE_R2_BUCKET`                                                       | fresh 60 s (miss 30 s), stale-if-error up to 24 h | same epoch check; stamp = fetch START, so a purge mid-fetch invalidates         |
| L3  | in-isolate coalescing                                                 | inflight Map                                                                     | per request                                       | n/a                                                                             |
| L4  | stale-if-error                                                        | L1/L2 copy that is still epoch-current                                           | 24 h                                              | a purge newer than the copy forbids it (fail closed)                            |
| L5  | one jittered retry (150-400 ms) only when no stale copy; never on 404 |                                                                                  | bounded < 0.5 s extra                             |                                                                                 |
| L6  | nothing usable -> 503 + `Retry-After: 30`, `Cache-Control: no-store`  | `resolve-unavailable-edge.ts`, wired in `serveDemoEdge` (outermost edge wrapper) |                                                   | edge caches store only 200 (`isStorableHtml`)                                   |

Edge verdicts (`storeVerdict`, `isDemoStoreHost`): a transient failure keeps the last known verdict instead of
replacing it with "no" (stale-if-error); a definitive answer is cached as before.

## Staleness classes

- NEVER-stale: store status, domain/slug ownership, plan entitlement (`enabledFeatures`, `disabledCmsSlugs`). Every
  layer above checks the R2 epoch before serving. Residual: 2 s epoch memo (EPOCH_MEMO_MS, existing NZ-D3 window).
- BOUNDED-stale: theme/content fields in the same payload; same purge, outer bound 60 s fresh.
- Outage mode: a copy older than 60 s is served only while the API fails AND no purge happened since; cap 24 h.

## Write paths -> invalidation (API, `bustStoreCaches` -> `revalidateStorefront` -> Worker bumps epochs)

| write                           | file                                                                                                              | epochs bumped                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| domain add/change/remove/verify | `services/domain-claim.service.ts` `afterDomainChanged`                                                           | host/new, id/<store>; OLD host now too (fixed here)   |
| store update (slug/domain)      | `services/store.service.ts` `StoreService.update`                                                                 | host/new, host/old slug + OLD domain (fixed here), id |
| admin edit (slug/status/plan)   | `routes/admin.routes.ts:965`                                                                                      | host, old slug (fixed here via `previous`), id        |
| suspend/unsuspend/status        | `provisioning.service.ts:665`, `billing/account.service.ts:153`                                                   | host, id                                              |
| delete                          | `store.service.ts` `StoreService.delete`                                                                          | host, id                                              |
| plan/entitlement                | `plan.service.ts:180`, `billing/billing-notify.ts:112`, `billing/comp-migration.ts:199`, `feature.service.ts:260` | host, id                                              |

Fix: `bustStoreCaches` purged only the CURRENT slug/domain on the storefront and left the old domain's API resolve
key to its 120 s TTL; it now busts `previous.slug`/`previous.domain` (Redis resolve key, CORS, storefront tags).

## Alert

`noteResolveFailure()` counts upstream 429/5xx/network per isolate per 60 s; at 10 it emits one
`[resolve-degraded]` console.error (Workers logs/logpush) + `Sentry.captureMessage` (error level) per window.

## Rollback

Revert the PR. No data migration; R2 `resolve-lkg/` objects are inert without the code (safe to leave).
