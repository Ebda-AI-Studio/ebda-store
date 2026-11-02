# MKT-HTML-BUDGET-2

Ruling MKT-HTML-BUDGET-2 - raise the marketing HTML gzip budget for `/` (51.5 -> 52.5 KB), `/terms` and `/merchant-agreement` (20.5 -> 21.5 KB) to the CI-measured 52.1 / 21.3 / 20.9 KB. Pre-existing on main (copy and header changes landed with the budget unchanged; the gate only runs when a PR touches shared files such as the lockfile). Cost if wrong: ~1 KB more HTML on three pages until the next ratchet.
