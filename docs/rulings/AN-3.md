# AN-3

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-3 — duplicate open scan rows are cleaned by marking older duplicates `expired`
(script, not run), never by deleting.** Reversible, and uses the status the scans' own 30-day
expiry already writes. Cost if wrong: expired history carries ~4.9k extra rows until any retention
job removes them.
