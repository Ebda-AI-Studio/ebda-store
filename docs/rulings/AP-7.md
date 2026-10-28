# AP-7

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-7 — partial profit is shown WITH a note, unknown profit as null.**
`totalProfit` is `null` only when sold lines exist and none has a cost; when some
do, the figure covers the costed lines and `profitItemsMissingCost` /
`profitRevenueMissingCost` travel with it (the UI says what is excluded);
`profitChange` is `null` unless both periods are complete. Cost if wrong: a
merchant who ignores the note reads a partial profit as the whole.
