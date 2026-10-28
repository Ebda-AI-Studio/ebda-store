# AUDIT-13

> Section: 2026-10-07 — AUDIT-P2P3 (FIX-011..015, branch `fix/audit-p2-p3`)

Ruling AUDIT-13 — FIXED with a synchronous cap, no queue: bank statements are capped at `MAX_STATEMENT_ROWS = 2000` rows. Import (`importBankStatement`) rejects an oversized file with 422 `STATEMENT_TOO_LARGE` before any write, and `runAutoMatch` rejects a legacy over-cap statement inside its first transaction, so the reset of prior matches rolls back. The audit's "queue job" was not taken: auto-match is called inline from two routes and its result is returned to the caller, so a queue would change the API contract, not just add a worker. 2000 is a conservative ceiling that was NOT benchmarked (rows are upserted one by one in one transaction, matched in chunks of 50). Cost if wrong: a merchant with a genuinely larger monthly statement must split the file by period until the cap is measured and raised.
