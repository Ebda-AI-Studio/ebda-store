# SL-DIGEST-1

> Section: weekly unanswered-questions digest for the Smart Layer assistant (2026-11-14)

**Ruling SL-DIGEST-1 - the weekly digest of unanswered "how do I" questions goes only to the OS brain (Ahmad's own channel), each question cut to 80 characters, and never names a store.**

Why: the questions are MASKED merchant text (phones, e-mails and card numbers are removed), but masking does not remove a shopper's or customer's name, so a name can survive inside a question. The digest is built from `sl_turns`/`sl_audit` text that is kept 90 days; cutting each line to 80 characters keeps a pasted customer list or a long message out of the log, and the store id is never written to the digest.

Where enforced: `apps/api/src/smart-layer/weekly-report.ts` (the 80-character cut, the 500-store / 10-parallel fan-out cap), covered by the weekly-report test in `tests/unit/assistant-adapter.test.ts`. Erasure of the underlying rows (per user and per shopper, by id / e-mail / phone / full name) is SL-STORE-1.

Cost if wrong: a name inside a question reaches the brain log once a week; mitigated because the digest is cut, store-less, goes to one private channel only, and the source rows are erased with the person.
