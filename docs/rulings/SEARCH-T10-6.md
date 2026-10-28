# SEARCH-T10-6

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T10-6 (PR3 final review minor 1) — the preview API Worker (`ebda-api-preview`) has no Workers AI binding: `scripts/preview/preview-config.mjs` drops the base config's `ai` block. Evidence: preview has no Inngest keys (the indexer never runs there) and its `SEARCH_SEMANTIC_ENABLED` stays `"false"`, so the binding had no use; with it, a preview query embed (Task 12) would bill the production (Whisky) account. `tests/unit/preview-config-no-ai.test.ts` runs the generator and asserts no `ai` key while the base config keeps it (red before). Cost if wrong: semantic search cannot be tried on preview; doing so later needs this ruling revisited and a decision on which account pays.
