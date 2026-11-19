# Arabic light stemming for storefront search (2026-11-12)

Ruling: `docs/rulings/SEARCH-STEM-1.md`. Notes: `~/.claude/handoff/e7d59025-4986-4c96-851c-39e9198e7240-stem.md`.

## Finish line

- **Must work:** on the storefront keyword arm, `كتب` finds `الكتب` / `كتابين` / `مكتبة`; `شنط` finds `شنطة` / `الشنط` / `شنطتين`; `ساعات` finds `ساعة`, in BOTH directions (query inflected or document inflected).
- **Flows exercised:** `searchProductIdSet` over the StoreDO FTS5 index (node:sqlite harness), the eval catalogue (345 existing queries + 22 new stem cases), the index migration of a pre-stemming store.
- **Must NOT change:** the folded `doc`/`name_doc`/`sku` columns and tokens; literal matches and their order; admin / bulk search (stays literal unless `stem: true`); word-start mode for all-short queries; the Postgres-parity oracle tests; the vector arm and RRF.
- **Done =** `do-search-stemming.test.ts` green and red when the stem arm is disabled; `do-search*.test.ts` green; typecheck + lint exit 0; before/after eval numbers reported; backfill path documented, not run on production.

## Design

- `stemArabicWord` (pure TS, workerd-safe) on already-folded text: strip one article prefix, one suffix, then broken-plural / مفعل patterns, never leaving fewer than 3 letters; non-Arabic words untouched. No dependency.
- Index: `product_search_fts` gains `stem_doc`, `stem_name_doc`. Query: `(literal OR stem)` per 3+ letter word; rank = literal-containing rows first, then the existing similarity order.
- Root extraction (ISRI) only if light stemming misses the eval: it does not (22/22), so it is not built.

## Backfill (live stores, per store, idempotent)

No manual step is required: the StoreDO constructor runs `ensureSearchIndex`, which detects the old table (no `stem_doc`), drops it (derived state) and marks every product dirty; `flushSearchIndex` rebuilds in transactions of 2000 rows at the next search. Re-running does nothing. Forced rebuild of one store: `reindexStore(db, storeId)` (packages/repo/src/do/search.ts), check with `verifyProductIndex`. Not run against production.

## Evidence

Numbers are printed by `npx vitest run packages/repo/test/do-search-stemming.test.ts --silent=false`.
