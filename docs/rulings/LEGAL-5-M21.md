# LEGAL-5-M21

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M21 — no integration test for "the unverified-resend path writes nothing" (the unit test `tests/unit/merchant-signup-legal.test.ts` pins the branch), and the checkbox takes focus only when no other field is invalid (focus goes to the first invalid field, standard form behaviour). Cost if wrong: a regression that writes acceptance rows on the resend path is caught by unit tests only.
