# OMD-0

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-0 — #2078: a disabled variant that still holds units is excluded
from stock value, and disabling it posts no journal entry (owner decision).**
Every reader already applied the exclusion on main (M5-6, AP-10, AN-8); this
change makes the finance dashboard and the analytics snapshot ONE query
(`storeStockValueFils`) instead of two copies (merged with #2294's CL-14: the
dashboard also shows the disabled-variant value on its own line and the flip
writes a zero-quantity `inventory_history` row — still no journal entry), pins all four readers and the
no-ledger rule in one test, and states the consequence in inventory-model.md
and the merchant docs: the dashboard's stock value and balance-sheet Inventory
(1200) differ by the cost of the units on disabled variants. Not changed, and
NOT covered by the decision: the readers still disagree on WHICH products they
value — the finance dashboard and analytics snapshot value every non-deleted
product, including `track_inventory = false` and archived ones; the inventory
page values only `track_inventory = true`; the opening-balance entry excludes
archived and untracked products; dead stock values only active, tracked ones.
A store with an untracked product whose `inventory` column is non-zero sees two
different stock values. Which products carry value is a separate decision.
Cost if wrong: that store's finance dashboard and inventory page keep showing
different totals until it is decided.
