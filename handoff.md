# Handoff — merchant MCP read tools + RFM segment drill-down

_Updated 2026-09-30. Branch `feat/mcp-read-tools-rfm-drilldown`, worktree
`_worktrees/force-website-builder__feat-mcp-read-tools-rfm-drilldown`, off `origin/main`
(rebased after PR 2218 merged)._

## Goal

Close accounting/MCP audit §7 (merchant MCP read coverage) and analytics audit §4 (RFM segments have
counts but no drill-down; guest RFM keys cannot join the Customers list).

## Current state

Code, tests and docs committed; PR open against `main`. Not deployed.

## Done

- MCP tools `admin_list_coupons`, `admin_list_customers`, `admin_get_customer`, `admin_get_funnel`,
  `admin_list_reviews`; delivery detail + status history on the order tools; contact masking on every
  customer-bearing tool (`lib/pii-mask.ts`).
- One customer key (`lib/customer-key.ts`) for the Customers list, export, RFM and cohort rollups;
  aggregation extracted to `services/customer-aggregate.service.ts`; stale RFM snapshot sweep.
- Segments page cards link to `/customers?segment=`; Customers page reads/syncs `?segment=` and badges
  guests; Arabic recommended action.
- Issue 2051 (phantom zero-order rows) fixed; `::uuid`-on-TEXT raw SQL fixed in 3 places + static gate.
- Rulings MCP-R1…R5, RFM-K1…K4, SQL-1, MUT-1 in `docs/RULINGS.md`.

## In progress

Nothing.

## Left to do

- After deploy: the first nightly `analytics-daily-rollup` re-keys guest snapshots (Ruling RFM-K1);
  until then guest drill-downs are empty. Verify on prod with a read-only count of
  `customer_rfm_snapshots` rows whose `customer_id` is a `GUEST:` key that no Customers-page row
  hashes to (should be 0 after the run).
- Live-check the MCP tools against a store with `merchant_mcp` on (pecannbee) once deployed.
