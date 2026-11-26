# NZ-N27B: consent evidence outlives the person (plan, written first)

Date 2026-11-24. Ruling NZ-N27B (Ahmad 2026-11-24, recommended default approved; proposal in the approvals file). Register row: Neon-zero (N-27b).
Counsel has NOT verified the 12-month ip/user-agent window or the legal basis; the ruling says so.

## Finish line

- Must work: erasing a user pseudonymises `user_id` on `legal_acceptances` and `legal_notice_deliveries` (opaque `erased:<uuid>`), NULLs `ip` + `user_agent` (and the delivery `error`), and keeps the row; a daily job NULLs ip/user-agent older than 12 months and deletes rows older than RETENTION_YEARS (7).
- Exercised: the real platform D1 schema over node:sqlite (`tests/unit/platform-subject-coverage.test.ts`, `tests/unit/legal-evidence-retention.test.ts`), the classification contract (`packages/cf-schema/test`), the job registry (`jobs-map`).
- Must NOT change: other tables' erasure, the acceptance/delivery write paths, the bystander's rows, the byte shape of exports for other tables.
- Done: tests above green, a mutation (dropping the scrub columns) fails 3 tests, tsc api clean.

## Facts found (not in the request)

- `legal_notice_deliveries` has NO ip or user_agent column; only `user_id`, `status`, a free-text `error` (can quote an address). The ruling's "ip/UA" applies to `legal_acceptances`; for deliveries the personal columns are `user_id` and `error`.
- The D1 platform schema never had a foreign key to users (users live in the identity D1). The cascade was Postgres only (`onDelete: Cascade` on both models, used by the super-admin hard delete). It also had to go: a pseudonym is not a user.
- Before: classification said `action: delete` with `subjectColumns: [user_id]`, so a D1 erasure DELETED the consent proof.
- Postgres is removed from prod (Neon-zero); the PG path stays for Node tests / local dev. `ebda_app` still cannot UPDATE legal_acceptances there (append-only grant, LEGAL-4), so the PG path does not pseudonymise; it only stops deleting (FK dropped). The D1 engine is the erasure path.

## Changes

1. `packages/cf-schema/erasure-classification.json`: both entries `action: scrub`, new `pseudonymiseColumns`, `scrubOnErasure`, `retention` blocks.
2. `apps/api/src/cf/erasure/platform-subject.ts`: plan gains `pseudonymise`; export, count and erase handle it (one UPDATE per table in the existing atomic batch; one random pseudonym per erasure).
3. `apps/api/src/services/legal-evidence-retention.ts` + job `legal-evidence-retention` (daily 03:41 UTC), registered in the jobs map / job data.
4. Prisma: relation to `User` removed from `LegalAcceptance` and `LegalNoticeDelivery`; migration `20261124100000_legal_evidence_no_user_fk` (+ rollback.sql); generated tenant-guard schema and cf-schema meta regenerated.
5. Tests: classification accounting group, coverage test (export, pseudonymise, bystander, idempotent), retention test, jobs-map count, the PG integration test now asserts the row is KEPT after a hard delete.

## Cost if wrong / rollback

No rollback for data already NULLed or pseudonymised (that is the purpose). Code and migration roll back (`rollback.sql` re-adds the FK and fails while any `erased:` row exists: export then delete those first). A window that is too short loses the ip/UA needed in a dispute about who accepted (version + time + pseudonym remain); too long keeps personal data past its purpose.
