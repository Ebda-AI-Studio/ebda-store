# SEARCH-CONTRACT-1

> Section: 2026-10-21 — Phase B2 Souq (B2-\*)

Ruling SEARCH-CONTRACT-1 (issue 30; closes SEARCH-T13-8 and the SEARCH-P2-5 function half) — migration `20261029000300_contract_unused_search_definers` drops the 5-argument `ebda_product_embed_doc` (search PR4 #100 is live; callers: none, `tests/unit/embed-doc-callers.test.ts`) and the `'guest'` / `'customers'` kinds of `ebda_order_search_ids` (callers: none, only `'order_number'` is passed). Rollback recreates both. The six per-key trigram indexes of SEARCH-P2-5 are NOT dropped here. Cost if wrong: a Worker older than PR4 that still calls the 5-argument form fails its indexer until redeployed.
