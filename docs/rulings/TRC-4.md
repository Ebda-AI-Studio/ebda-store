# TRC-4

> Section: Tenant routing canary (2026-10-01, branch `feat/tenant-routing-canary`, PR 1979)

**Ruling TRC-4 — the canary preview Worker `force-web-canary-preview` and R2 bucket
`force-web-canary-cache` are no longer needed by this PR, and were not deleted here.** They held the
Phase-2 evidence, which is recorded in the plan; the next canary runs on production behind the
secrets. They are left for the owner to delete because deletion is a production action on the
Ebda AI Studio account. It is still live: a plain GET on 2026-10-01 returned the harness's 400 ("x-canary-host
must be one of …"), so anyone who sends that header gets the 3 live stores rendered by a stale
2026-09-25 build with the flag on. Cost if wrong: that stale public copy keeps serving until deleted.
