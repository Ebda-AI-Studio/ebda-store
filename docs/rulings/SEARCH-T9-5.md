# SEARCH-T9-5

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T9-5 — accepted residual of the embed doc's HTML strip (`ebda_product_embed_doc`, SEARCH-T9-1): a letter-initial `<` followed later by a `>` in merchant prose ("a <b and c> d") is read as a tag and that span becomes a space. Evidence: the strip pattern is `</?[A-Za-z][^<>]*>|<![^<>]*>` (a bare `<` / `>` as in "price < 50" is kept, pinned by `tests/integration/product-embeddings-schema.test.ts`); prose of that exact shape is rare in product descriptions, and the doc is used only for the embedding, never displayed. Cost if wrong: a few words missing from one product's embedding (lexical search still matches them).
