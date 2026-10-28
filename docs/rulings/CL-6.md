# CL-6

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-6 — the shared rate-limit budgets are measured and switchable, not
re-sized (issue 2216, issue 2230, issue 2171, issue 1963, issue 2228).**
Every limiter counts its 429s per prefix and logs a per-minute summary; a
prefix over `RATE_LIMIT_429_ALERT_PER_MIN` pages P1; a fall back to
per-process counting after a Redis-backed period is logged and alerted once;
`RATE_LIMIT_SHARED=0` restores per-process counting without a deploy of code;
and the Redis `isConnected` latch is re-armed on `ready` (an `error` only
clears it when the client is really not ready). The per-IP maxes were NOT
raised: the only replica evidence in the repo is `railway.json`, which sets no
`numReplicas` (Railway's default is one instance) and docs/SCALING.md, which
describes replicas as not yet enabled — if that holds, #1862 tightened nothing
and only made budgets survive a deploy. Amends Ruling S1-4: the live replica
count is still NOT verified against the Railway dashboard from this session;
the first post-deploy 429 summary lines settle it. The checkout limiters stay
IP-keyed: an IP+session key would let a caller mint a fresh bucket per
request by rotating `X-Session-ID`. Amends Ruling S1-8: a new address-wide
`authEmailAddressLimiter` (6/hour, no IP, no store component) sits in front of
`/forgot-password` and `/resend-verification`, so spraying public store ids no
longer multiplies the mails one inbox receives; the cost is that a flood can
now spend that ceiling for every store at once (the flooded mails still carry
working links). Cost if wrong: if production does run several replicas, CGNAT
shoppers may already be seeing 429s — now visible within a minute and
reversible with one variable.
