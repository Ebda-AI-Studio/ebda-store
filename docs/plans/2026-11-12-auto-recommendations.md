# Automatic product recommendations (2026-11-12)

## Finish line

1. PDP shows merchant picks first, then bought-together (this store's orders), then similar items (Vectorize neighbours of the product's own vector), capped at 8 in total.
2. Exercised: `GET /public/:storeId/products/:productId/recommendations`, cart recs, `GET/PUT /stores/:id/recommendations/auto-setting`, admin toggle; unit tests incl. tenant isolation.
3. Must NOT change: merchant-curated relations and their order (they always win and come first), the search FTS/stemming code, PDP render path (recommendations stay a non-blocking client fetch).
4. Done = touched tests + typecheck + lint exit 0, each new test fails on old code, docs (help ar+en, docs README) updated, PR open (not merged).

## What already exists (built on, not replaced)

- `ProductRelation` (merchant cross-sell / upsell), `AiRecommendation` (Gemini sweep), `FrequentlyBoughtTogether` (per-store product-id pair counts, no PII, recomputed daily by the ai-autofill sweep and on demand), category fallback, PDP `FrequentlyBoughtTogether` + `YouMightAlsoLike` components, cart strip.
- Product vectors: Vectorize `PRODUCT_VECTORS`, ids `<productId>:d|w`, namespace = store id (the tenant boundary).

## Design

- crossSell slot: manual (<= 8) then AI rows then bought-together, deduped, total cap 8 (before: manual XOR AI XOR FBT, so one curated pick hid every automatic one).
- alsoLike slot ("similar"): Vectorize neighbours of the product's own doc vector (`getByIds` then `query`, `namespace: storeId`, 600 ms race), then the existing same-category fill; all ids re-read from the store's own DB with `storeId` + visible + active, keep only buyable. Overall cap 8 across upsell + crossSell + alsoLike.
- Vectorize missing / slow / failing: similar silently skipped; result cached 30 s (not 5 min) so a failing index is not retried on every hit.
- Cart: manual picks weigh 1000, bought-together 1 each (manual first, FBT tops up) instead of FBT only when a product has no manual pick.
- Setting `settings.autoRecommendationsEnabled` (absent = on), server-owned key like `mcpWriteEnabled` (a stale whole-settings PUT cannot flip it), written by `PUT /stores/:id/recommendations/auto-setting` (audit row), clears the store's recommendation cache. Off = curated only.
- Cache class: BOUNDED-stale, 5 min (30 s degraded); stock/visibility residual window documented at the cache site; product writes already invalidate via the existing sweep/TTL.
- Latency: adds <= 2 Vectorize calls on a cache MISS of an already non-blocking client fetch; no change to the hot-path call budgets (`workers-test/latency-budget.test.ts` does not cover this route).
