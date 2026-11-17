# Ruling RESOLVE-SWR-1 - the resolved store is served stale-while-revalidate, NEVER-stale fields are cleared by event (2026-11-17)

Evidence: `GET /public/store/resolve` took 3-8 s on a cache miss (p90 5.07 s, max 8.2 s; Workers Logpush `ebda-logs`, 2026-11-15 15:40-16:30Z) and every shopper after an idle gap, plus the 5-minute status probe, paid it. RESOLVE-PARALLEL-1 makes the fill the slowest single read; this makes the miss rare.

Decision:

- `getCachedSwr` (lib/public-cache.ts): age <= 120 s served as is; 120-600 s served STALE at once with ONE background refresh (single-flight per key, waitUntil on Workers); past 600 s the entry is gone (KV TTL = hard max) and the fill is synchronous. Hard max = 600 s, the same as the edge `stale-while-revalidate` already on this response.
- The refresh uses the same generation guard as a fill: it captures the key's generations before it reads, skips its write if they moved, and takes its own entry back out if they move between check and write.

STALENESS CLASS (declared at the cache site, `public.routes.ts` and `getCachedSwr`):

- BOUNDED-stale (up to 600 s): anything that changed WITHOUT an event.
- NEVER-stale: store status / suspension, plan (-> `enabledFeatures`), slug, domain, deletion. Cleared by EVENT, not by the window: every writer calls `bustStoreCaches`, which deletes the key and bumps its generation. A deleted entry cannot be served stale; a refresh in flight during the write cannot republish the old payload.
- Residual, unchanged from NZ-D1: a KV delete reaches other data centres within ~60 s, so a just-suspended store can resolve for <= 60 s on storefront READS. Writes (cart, checkout, order, payment) never use this cache; they read D1 / the StoreDO and refuse a suspended store.

Write paths that change status / suspension / plan / slug / domain / deletion, and what each clears. Layers: (a) KV entry + generation (`invalidateStoreDirectory` + `invalidateCached`), (b) per-isolate memory (`invalidateCached` clears the in-memory layer and the refresh marker; `bustCorsCache` the CORS trust of THIS isolate, other isolates age out on the CORS TTL, which only affects credentialed CORS, never the payload), (c) edge / CDN (`revalidateStorefront`: Next data cache tags `layout:<id>`, `store-slug:`, `store-domain:` and the per-host edge HTML epoch).

| Write path                                                         | Where                                                                                              | (a)                                                                                 | (b) | (c) |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --- | --- |
| Settings save (incl. slug / domain change, previous values purged) | `StoreService.update` store.service.ts                                                             | bustStoreCaches                                                                     | yes | yes |
| Suspend / unsuspend / status                                       | `StoreService.setStatus`, `ProvisioningService.updateStoreStatus`                                  | bustStoreCaches                                                                     | yes | yes |
| Billing suspension / reinstatement                                 | `billing/account.service.ts` (`suspendForBilling`, unsuspend)                                      | bustStoreCaches                                                                     | yes | yes |
| assignPlan                                                         | `plan.service.ts`                                                                                  | bustStoreCaches                                                                     | yes | yes |
| Billing downgrade / plan change by a payment effect                | `subscription-billing.service.ts` `downgradeToFree` / `applyPlan` -> effect -> `billing-notify.ts` | bustStoreCaches                                                                     | yes | yes |
| Comp migration                                                     | `billing/comp-migration.ts`                                                                        | bustStoreCaches                                                                     | yes | yes |
| Plan-tier reconciliation repair                                    | `reconcilePlanTiers` (subscription-billing.service.ts)                                             | **was missing, now bustStoreCaches**                                                | yes | yes |
| Store-directory (B1) reconciler repair                             | `store-directory-reconcile.ts`                                                                     | **was missing, now `bustAfterRepair` -> bustStoreCaches for every corrected store** | yes | yes |
| Domain claim / verify / clear                                      | `domain-claim.service.ts`, `store-domain.service.ts` (via `afterDomainChanged`)                    | bustStoreCaches                                                                     | yes | yes |
| Onboarding activation                                              | `onboarding.service.ts`                                                                            | bustStoreCaches                                                                     | yes | yes |
| Store creation (no earlier payload)                                | `store-create-do.ts`                                                                               | invalidateStoreDirectory                                                            | n/a | n/a |
| Store delete                                                       | `StoreService.delete` (post-commit)                                                                | bustStoreCaches                                                                     | yes | yes |

Two gaps found by this audit and fixed here: the plan-tier repair wrote `stores.plan` and the directory reconciler wrote `stores.status` / `deleted_at` straight into D1 with no bust; with a stale window they would have kept the old payload for up to 600 s instead of 120 s.

Guard: `tests/unit/store-directory-bust-coverage.test.ts` scans every source file for a Store write funnel (`storeUpdate`, `storeUpdateMany`, `updateStoreThrough`, `storeUpdateOnDo`, `.store.update*`, raw `UPDATE/DELETE/INSERT stores`) that writes one of those columns and fails unless the file calls `bustStoreCaches` / `invalidateStoreDirectory` or is listed as delegating to a file that does (checked). It also fails when the bust stops reaching a layer or a helper has no call site.

Not verified: production p90 / p99 after deploy and 24 h of status data. Cost if wrong: a store whose NEVER-stale column is written by a path that skips the bust serves the old payload for up to 600 s (was 120 s); the guard test exists so that cannot be added silently.
