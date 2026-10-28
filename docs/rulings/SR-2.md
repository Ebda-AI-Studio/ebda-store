# SR-2

> Section: 2026-09-16

**Ruling SR-2 — the retry page ships as HTTP 500, not 503 + `Retry-After`.**
Next 16.2.11 permits only 404/403/401 as deliberate statuses from a page render
(`http-access-fallback.js`: `HTTPAccessErrorStatus = {NOT_FOUND:404,
FORBIDDEN:403, UNAUTHORIZED:401}`; `forbidden()`/`unauthorized()` additionally
require `experimental.authInterrupts`). Only Route Handlers can set an arbitrary
status, and none is on this path. Rewriting 500→503 in the OpenNext Worker entry
was rejected because `scripts/cf-setup-local.sh` GENERATES that entry at build
time, so the edit would be silently discarded on the next deploy. The defect
being fixed is "404 tells the shopper the shop is gone and tells Google to
deindex it"; 500 already fixes both, and Google retains a URL across 5xx.
Cost if wrong: uptime/DAST tooling keeps counting these as server faults rather
than backpressure — the F1 complaint, inherited rather than introduced.
