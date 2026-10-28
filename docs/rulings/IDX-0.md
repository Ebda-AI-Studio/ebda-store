# IDX-0

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-0 — the order search is fixed by a query rewrite plus trigram indexes, not by indexes
alone.** Prisma compiles the four `customer: { is }` filters into LEFT JOINs with an OR spanning
`orders` and `users`. With all five trigram indexes built and the query unchanged, the plan did not
change (153–167 ms at 50k). `orderSearchWhere` resolves the matching customers first, restricted to
customers with an order in this store (not `users.store_id`: 13 of 14 customer-linked production
orders point at a user registered elsewhere), and then filters `orders` on `order_number` OR
`customer_id IN`. That runs in < 1 ms. It returns the same rows as the relation-join shape, pinned
by `tests/integration/order-search-indexes.test.ts`. Terms under 3 characters and terms matching
more than 1,000 customers fall back to the relation filter. Cost if wrong: a merchant searching a
very common name (> 1,000 matching customers) gets the old, unindexed plan for that search.
