# RLS-S3

> Section: 2026-09-25 — RLS strict policies (cutover attempt #1 rollback)

**Ruling RLS-S3 — long jobs use `runInStoreScope` (one short tenant tx per query), not
`runInTenantContext`.** #461 removed the bulk-AI wrapper because a 30s interactive transaction
cannot span Gemini calls; its premise ("products + bulk_ai_jobs are not RLS-protected") was false.
Cost if wrong: one extra BEGIN/SET/COMMIT round-trip per query in bulk jobs — negligible next to a
2.5s AI throttle.
