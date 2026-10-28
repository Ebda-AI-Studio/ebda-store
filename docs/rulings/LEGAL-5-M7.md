# LEGAL-5-M7

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M7 — `ebda_withdraw_legal_notice_send`'s 10-minute check now compares `sent_at` (naive UTC) with `now() AT TIME ZONE 'UTC'`, fixed by editing migration `20261017000200` IN PLACE rather than a third migration: the migration is unmerged and applied nowhere but disposable local databases. Evidence: `tests/integration/legal-policy-admin.test.ts` "M7" case (UTC+14 session) fails on the old function, passes on the new (final-fix-wave-report.md). Cost if wrong: a developer database that applied the old 000200 keeps the old function until it is re-created (`CREATE OR REPLACE`, re-run the file).
