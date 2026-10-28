# SEARCH-15

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-15 — the three new IMMUTABLE `ebda_*` SQL functions (`ebda_ar_norm`, `ebda_product_search_doc`, `ebda_product_name_doc`) are NOT SECURITY DEFINER and sit on a named allowlist in `tests/integration/rls-ebda-app.test.ts` (Tasks 9 and 15 add `ebda_product_embed_doc` and `ebda_digits`); the allowlist test also asserts none sets a `search_path` in `proconfig`. EXECUTE deliberately stays PUBLIC: they are pure, invoker-rights text functions, and every role that writes `products` must be able to run index-expression functions, so revoking would break index maintenance for non-`ebda_app` writers. Evidence: definers break inlining and index use and add needless privilege; `ebda_app` has only USAGE on schema `public` (no CREATE), so it cannot shadow or overload them. Cost if wrong: a future non-definer `ebda_` function slips through only if someone adds it to the list.
