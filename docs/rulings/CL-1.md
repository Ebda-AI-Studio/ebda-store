# CL-1

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-1 — a CORS lookup failure serves the last resolved answer for up to
15 minutes (issue 2109, issue 2169).** The first failed custom-domain lookup no
longer poisons the hostname: the next request re-queries, and only the second
consecutive failure short-circuits to 503 for 5s. A domain resolved within
`CORS_STALE_SERVE_MAX_MS` keeps its last answer through the outage (stale-allow
or stale-reject). Cost if wrong: a domain the merchant DEACTIVATED (store status
change, not a domain edit) during an outage on another replica keeps passing
CORS on this replica for up to 15 minutes — bounded, and harmless on its own
because CSRF tokens and `restrictPlatformOnlyOrigins` are the real boundary; a
domain removal on this replica busts the entry and is never served stale.
