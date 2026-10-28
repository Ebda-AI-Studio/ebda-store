# SEARCH-7

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-7 — pgvector `halfvec(1024)` for bge-m3. The CI/compose image is `pgvector/pgvector:0.8.0-pg17` (production's major, Ruling SEARCH-T9-4; tag measured 2026-10-16 on Docker Hub, amd64 + arm64; same pgvector version production has available; it ships pg_trgm 1.6 and pg_stat_statements 1.11), and the dims are measured in Task 10 Step 1 (done 2026-10-16: `env.AI.run('@cf/baai/bge-m3', { text: ['أحذية جلد', '3abaya'] })` through a throwaway `wrangler dev` Worker on the Whisky account `69188202…` answered keys `meta,data,response,shape,pooling`, `shape [2, 1024]`, `data` 2 × 1024, `pooling 'cls'`; the model schema from `wrangler ai models schema` gives `text` `maxItems: 100`, `minLength: 1` — so `halfvec(1024)` stands). Cost if wrong: an image pull fails in CI, which is loud, not silent.
