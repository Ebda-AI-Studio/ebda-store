# CL-5a

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-5a — merge with Ruling BS-5 (issue 1988, main).** Both batches
reopened Prisma errors to Sentry. The merged gate: P2002/P2003/P2025 with no
status of their own are captured at WARNING level; skipped are Zod/body-parser
errors, AppError 4xx, a Prisma error passed through `markExpected`, and — BS-5's
case — a P2002 whose unique target is a merchant-typed field (`sku`/`slug`).
Any other P2002 (a journal/ledger row, an idempotency key) is captured, which is
issue 2005's double-post case. Cost if wrong: a merchant-facing unique field not
named `sku`/`slug` produces warning-level Sentry noise until it is added to
`MERCHANT_TYPED_UNIQUE_FIELDS` or its throw site uses `markExpected`.
