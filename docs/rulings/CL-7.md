# CL-7

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-7 — the Inngest global-limiter bypass is conditioned on the SDK
actually verifying, and the path gets its own failure-counted bucket (issue
2063, issue 2064).** Amends Ruling RL-1: its "costs nothing" held only in
cloud mode with a key; the bypass now also requires `NODE_ENV=production` and a
non-empty `INNGEST_SIGNING_KEY`, boot pages P1 when the key is missing, and the
SDK behaviour is pinned by driving the real `inngest/express` handler (a
dev-mode positive control answers 200 and runs the function, so the test has
teeth). `inngestLimiter` (300/15min/IP, `skipSuccessfulRequests`) sits before
the body parser. NOT changed: the 10 MB JSON limit on this path — Inngest's
step-state payload ceiling was not measured, and a too-small parser limit
would break real jobs; the failure-counted bucket bounds a forged-body flood
to 300 parses per IP per 15 minutes instead. Cost if wrong: a caller rotating
IPs can still force 300 × 10 MB parses per IP per window — the same exposure
every JSON route has under the global cap.
