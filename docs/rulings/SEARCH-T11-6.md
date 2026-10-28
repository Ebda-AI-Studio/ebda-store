# SEARCH-T11-6

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-6 — the backstop (`17 */6 * * *` UTC) probes ACTIVE stores only, each inside its own tenant transaction (`acrossStores` with `onStoreError`, so one bad store does not stop the sweep), with an `EXISTS` query; it fans out one `search/store.reindex-requested` per store with stale rows. It is also the backfill: the first run after the `AI` binding is deployed finds every store with un-embedded products. STOP-4 (production backfill) was authorised by Ahmad on 2026-10-15 (pre-launch, 0 products); merging PR 3 and deploying it with the binding starts it, bounded by the daily cap. `requestStoreReindex` sends nothing when no provider resolves (the consumer would only skip). Cost if wrong: an inactive or suspended store that is reactivated waits up to 6 h for its vectors; until then search stays lexical for its products.
