# RFM-K1

> Section: 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

**Ruling RFM-K1 — guest RFM snapshots are re-keyed from `GUEST:sha256("<email>:<phone>")` to
`rfmKeyFor(customerKeyOf(order))` (`lib/customer-key.ts`), the Customers-page grouping with the
contact hashed; no data migration is written.** The nightly `runRfmRollup` recomputes every
snapshot, and a new stale-row sweep at the end of each run deletes rows whose key no paid order
produces — which removes every old-format guest row on the first run after deploy. Until that run,
guest drill-downs match nothing (the old keys cannot be joined — that is the bug) and segment counts
on the Segments page are unchanged. `previousSegment` history for guests resets once. The cohort
rollup uses the same key, so a guest who reused an email with a new phone is one cohort member, not
two. Cost if wrong: for up to a day after deploy a guest-only store's drill-down lists are empty,
and one night's "segment movers" narration is blind to guest moves.
