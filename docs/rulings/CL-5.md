# CL-5

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-5 — Prisma P2002/P2025/P2003 are captured by Sentry again; the
response mapping is unchanged (issue 2005).** `clientErrorStatus` still decides
the 4xx the client gets; the Sentry gate now uses the narrower
`isExpectedClientError` (ZodError, body-parser SyntaxError, AppError 4xx, or a
Prisma error the throw site passed through `markExpected`). This restores the
safety net Ruling SN-2 relies on: a EBDA-API-28 recurrence (P2003) reaches
Sentry instead of answering a silent 400, and a P2002 on a ledger row is no
longer an invisible 409. Cost if wrong: EBDA-API-2A-style events (a merchant
saving a duplicate SKU) come back as Sentry events — noise, not an outage; the
fix for any such site that turns out to be loud is `markExpected` at that
throw site, never widening the global gate again.
