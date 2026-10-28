# SEARCH-T11-2

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-2 — `SEARCH_EMBED_STORE_DAILY_CAP` (default 3000) counts DISTINCT products embedded in the store since the start of the Cairo day (`product_embeddings.embedded_at`), not provider calls; no new counter table. A product is re-embedded only when its doc's md5 changed, and runs are debounced 20 s per store (2 min max wait), so repeated re-embeds of one product are bounded by edits. `capped` is reported ONLY when this daily cap is spent, never for a caller's `maxDocs` (preflight B-T11b), so the Inngest loop and the eval harness keep going on a large backlog. Cost if wrong: a merchant who edits the same product continuously re-embeds it up to once per debounce window without moving the cap — at bge-m3's $0.0118/M input tokens, ≈ 4320 runs × ~1k tokens ≈ $0.05/product/day worst case.
