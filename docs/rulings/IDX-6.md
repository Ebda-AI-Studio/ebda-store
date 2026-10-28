# IDX-6

> Section: 2026-10-01 — Missing indexes / order search (`perf/missing-indexes`, issue #2405)

**Ruling IDX-6 — the guest-id cap is still measured store-wide, not against the listed filters
(declined part of issue 2444).** The issue also asked to pass `status` / `from` / `to` /
`confirmedOnly` into `guestOrderIdsSql` so the cap counts only the rows being listed. Declined: the
`id IN (...)` arm is ANDed with those same filters by `listWhere`, so correctness is unchanged either
way, and threading them would change the SQL the guest-index plan test pins (the partial-index
predicate and the `store_id` filter are what keep it eligible for the four trigram indexes) for a
latency cliff that is now confined to the guest half. Revisit if production shows the guest half over
the cap on filtered lists. Cost if wrong: a filtered list whose store-wide guest matches exceed 1,000
uses the unindexed JSON filter for the guest half even when the filter would leave fewer rows.
