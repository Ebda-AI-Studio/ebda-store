# LEDGER-Main-integration-lane-red-2026-10-22-branch-fix

> Section: Main integration lane red (2026-10-22, branch `fix/main-integration-red`)

Ruling LEDGER-Main-integration-lane-red-2026-10-22-branch-fix — unlabelled notes from the legacy ledger section "Main integration lane red (2026-10-22, branch `fix/main-integration-red`)":

Thirteen integration files failed on the manual `CI` run of main. Production search was NOT broken (live `X-Search-Query` searches on storedemo.ebda.app return 200 with results in English and Arabic; `/public` is mounted behind `publicStoreContext`). Every failure was a stale test or fixture except one missing FK index and one hardening gap.
