# SEARCH-T11-14

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-14 (review N-M1) — quarantining a product deletes its existing vector in the same step (`quarantineEmbedFailures`): a product edited from text A (embedded) to a text B the model rejects must not keep matching on A's words while it is out of the index. It re-enters through the normal stale path once its text or the model changes, or the quarantine expires (SEARCH-T11-15). Evidence: `tests/integration/product-index.test.ts` "review N-M1" (red before: A's vector survived). Cost if wrong: the product is absent from semantic search while quarantined, which is the intended state.
