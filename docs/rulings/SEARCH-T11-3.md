# SEARCH-T11-3

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-3 — indexer pacing: Workers AI text embeddings allow 3000 requests/minute per account (developers.cloudflare.com/workers-ai/platform/limits, read 2026-10-16). Each run sleeps `SEARCH_EMBED_THROTTLE_MS` (default 200) after every successful call, so one run makes ≤ 300 calls/min; the function's concurrency is 1 per store and 4 overall, so indexing stays under ~1200/min and leaves the rest for query-time embeds (Task 12). Cost if wrong: a 429 fails the step; Inngest backs off and retries.
