# Ebda Store — Hardening Plan (historical)

This file was the synthesis of five parallel audits run on 2026-04-30 (267 findings,
38 critical). It is 4 months stale as of 2026-09-02: most of its "open P0"
findings are long since fixed (e.g. T0-2's admin routes now carry
`requireStoreAccess` + storeId-scoped lookups), while it understates the one
finding that is still true — T0-1, RLS bypass in production.

**Current state lives in `docs/audits/` (dated, per-topic).**
**T0-1 (RLS bypass) remains open and is a deliberate, parked decision** — see
`docs/plans/done/2026-07-02-rls-cutover.md` for the cutover plan and why flipping
it today (before the unmerged Phase-1 plumbing lands) would cause a write
outage, not fix anything.

The original 186-line body is preserved in git history at this file's prior
commits if it's ever needed for archaeology.
