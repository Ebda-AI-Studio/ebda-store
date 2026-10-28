# AP-1

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-1 — the balance sheet's retained + current earnings row is COMPUTED,
not posted.** The ledger has no period-closing entries, so cumulative revenue −
expenses up to `asOf` still sits in P&L accounts; `balanceSheet()` adds it as one
equity row (`kind: 'current_earnings'`) from the same `asOf` totals. Nothing is
written to the ledger. A future period-close entry moves those balances into
equity and the computed row shrinks by exactly that amount, so the two cannot
double count. Cost if wrong: an accountant expecting a posted retained-earnings
account sees a computed row instead, with no ledger lines behind it.
