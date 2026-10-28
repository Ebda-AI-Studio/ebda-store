# LEDGER-2026-10-01-owner-money-decisions-branch-fix-owne

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

Ruling LEDGER-2026-10-01-owner-money-decisions-branch-fix-owne — unlabelled notes from the legacy ledger section "2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)":

Owner (Ahmad) decided four open money questions on 2026-10-01: #2078, #1207 +
#1351, #1209 + #1455, #1956. M1-7, M1-8 and R2-3 are marked RESOLVED above; W-3
is amended. Every decision is pinned by
`tests/integration/accounting/owner-money-decisions.test.ts` (9 tests, amounts
that do not divide evenly) plus the producer unit tests; each change was
mutation-proved (the code broken, a named test turned red, the file restored
byte-identical).
