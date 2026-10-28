# BUILDER-REV-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-REV-1 — the concurrency token travels in the JSON body (`baseRev`), not an `If-Match` header, so the admin's CORS allow-list needs no change. Race losers fail on a row re-check (`rev` in the UPDATE's WHERE) or a unique index inside a SAVEPOINT and answer 409 with the latest document. Evidence: 5 concurrent saves → exactly 1 wins (3 runs); dropping the rev guard reddens it every run. Cost if wrong: none functional; a future third-party client must send `baseRev` in the body.
