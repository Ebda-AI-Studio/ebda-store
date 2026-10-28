# CL-4

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-4 — the R2 orphan check keeps scanning every registered JSON/HTML
column; its cost is bounded rather than removed (issue 2249, issue 2250).**
Measured on Postgres 16 with 200k synthetic `abandoned_carts` rows (3 image
URLs each): the combined statement took ~475 ms for a key that is NOT
referenced (the common case — it is what triggers the delete); the exact-URL
half alone took ~20 ms. Changes: the exact half runs first and short-circuits
a still-referenced (cloned) image; the substring half runs under
`SET LOCAL statement_timeout = 5000` and a timeout KEEPS the object; the
deferred task declares `connections: 2` so the global deferred cap counts the
nested `withRlsBypass` connection (at most 2 concurrent checks per process at
the default pool of 15). NOT done: dropping `abandoned_carts` from the scan
(its snapshot images appear in recovery emails already sitting in inboxes, so
deleting them breaks sent mail — a product call, and the table is bounded by
the 30-day `abandoned-cart-purge`), and a `pg_trgm` expression index (write
amplification on every cart-step update, unjustified at today's volume). Cost
if wrong: an image delete costs ~0.5 s of one pooled connection per 200k
abandoned carts; past ~2M rows the 5 s timeout starts keeping orphaned files
(a storage leak the weekly sweep already reports), which is the signal to add
the trigram index.
