# IDX-5

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-5 — guest orders are searched through the `shipping_address` JSON, with partial
expression trigram indexes, and only when `customer_id IS NULL`.** A guest has no `users` row; the
only contact record is the checkout snapshot, the same one `customerKeyOf` and `/customers/search`
read. The index predicate is `customer_id IS NULL` and the query repeats it, so a registered
customer's order is never matched through its shipping JSON and the registered results do not change.
The four indexes are separate rather than one concatenated expression, so each field matches exactly
as the registered arm does (no cross-field match). A concatenated index would be one index instead of
four but could match a term spanning two fields. Terms under 3 characters and terms matching more
than 1,000 guest orders take an unindexed JSON path filter with the same rows; since issue 2444 that
fallback degrades ONLY the over-cap half (a registered customer match keeps its indexed
`customer_id IN (...)` arm). Pinned by
`tests/integration/order-search-guest-contact.test.ts`, mutation-checked (guest arm removed, a
different JSON expression, `customer_id IS NULL` dropped, LIKE escaping removed, fallback guard
removed: each turns a test red). Cost if wrong: a store with a very common guest name or phone
fragment (more than 1,000 guest orders) gets the unindexed JSON filter for the guest half of that
one search. The cap is reached far more often than "a very common name": every Egypt guest phone
starts `+965`, so the characters `965`, `+965`, `9655`... of a phone typed left to right match every
guest order and, past 1,000 guest orders, take that path for those keystrokes (300 ms debounce, no
minimum length); four more GIN indexes on `orders` add about 3 ms per 5,000 inserts.
