# MCP-2

> Section: 2026-09-25 — P2 batch S1 (auth/session core)

**Ruling MCP-2 — denied-write audits coalesce to one row per (store, ip, tool,
credential) per minute, and the count is kept, not dropped (#1644 / #1649, owner
decision 2026-09-25; key wording corrected in issue 2149).**

Every refused MCP write (`add_to_cart` / `place_order` with no or a wrong
`x-agent-key`) opened its OWN interactive `runInTenantContext` transaction —
reachable by a fully unauthenticated caller, bounded only by `publicLimiter`'s
300/min/IP. A distributed prober could hold up to 5 interactive transactions
per second per IP on the small Neon pool the human checkout path shares, and
grow `audit_logs` (90 days hot, 7-year R2 archive) at the same rate: the
security control's own telemetry becoming the DoS surface (#1644, #1649).

A FIRST attempt at this fix, the same day, coalesced denials to one row per
(store, ip, tool) per 10s window via a Redis sentinel — and was reverted
within the hour (commit `af8df622`) because it dropped the repeat count
entirely: a sustained flood would have logged roughly one row per 10 seconds
with no record of how many attempts each row stood for, which could push
`classifyAgentDenials`'s volume thresholds (`anonymousFlood`, etc.) below the
real attack rate and silently mute the alert the thresholds exist to fire.
Ahmad ruled the same day that the fix ships only WITH the count preserved.

This version: the FIRST denial in a (store, ip, tool, credential) 60s window
(`DENIAL_COALESCE_WINDOW_SECONDS`; key built by `denialCoalesceKey`,
`apps/api/src/mcp/agent-auth.ts`) still writes a durable row through
`runInTenantContext`, exactly as before, and remembers the row's id in Redis.
Every REPEAT in that window costs one plain, non-transactional
`prisma.auditLog.update()` bumping that row's `details.count` — never a new
row, never a new transaction. `rls_audit_logs_tenant`'s policy admits the
unscoped update the same way it already admits an unscoped insert
(`current_store_id() IS NULL` outside any tenant transaction). If the cached
row id cannot be found (a Redis restart mid-window, a TTL race, or the update
itself failing), the code falls through and writes a fresh row rather than
dropping the attempt — self-healing at the cost of starting a new window.
Redis unavailable (`incrementRateLimit` returning 0, its documented fail-open
value) degrades to exactly today's per-attempt behaviour: one row per denial,
same as before this change. `agent.write.failed` (an AUTHORISED write that
then threw) was originally never coalesced on the claim that it requires
credential possession — corrected in the addendum below (issue 2151): only a
VALID-key caller's `failed` is per-attempt.

`credential` is part of the key on purpose: `classifyAgentDenials` PARTITIONS on
`details.credential` (`none` / `invalid` / …), so the coalescing key must be at
least as fine-grained as that partition — a coarser (store, ip, tool) key sums
attempts from different classifier buckets under whichever credential arrived
last (49 `invalid` + 1 `none` would become `credential: 'none', count: 50`, an
`info` anonymous flood instead of the p1 `integration_broken`), which
`tests/unit/agent-denial-coalesce.test.ts` pins. The bound is therefore at most
one row per (store, ip, tool, credential) per 60s — up to five per (store, ip,
tool), since `AgentCredentialOutcome` has five values; size the per-IP
transaction and `audit_logs` growth ceilings from that. Cost if wrong: a change
written against the old three-part wording would drop `credential` from the key
and bring back exactly the misclassification the test pins.

`classifyAgentDenials` (`agent-denial-alerts.ts`) and the watcher
(`agent-write-denied-watch.ts`) were updated to weigh a row by its
`details.count` (defaulting to 1 for an uncoalesced row) rather than by row
count — otherwise the classifier itself would reproduce the reverted attempt's
bug one layer up, by counting coalesced rows as single attempts.

Mutation-proven: `agent-denial-write-coalesced-with-count`
(`docs/security/defence-mutations.json`, domain `agent identity`) removes the
coalescing gate and asserts `tests/unit/agent-denial-coalesce.test.ts` goes
red; all 80 registered defences are KILLED after this change
(`docs/security/defence-mutation-record.md`).

Cost if wrong: if the Redis row-id cache and the counter ever drift (an
extremely narrow race between the `incrementRateLimit` call and the
`rememberDenialRow` write, both best-effort), a repeat in that window falls
back to writing its OWN fresh row instead of updating the existing one — one
extra row and a fresh coalescing window, never a lost attempt and never a
reintroduced interactive transaction per repeat, since the update path itself
never opens one.

Addendum (issues 2150, 2151, 2141, 2054 — backlog batch d-routes-mcp,
2026-10-01). (a) The `failed` exemption is now gated on the GRANT, not the
outcome: only `grant === 'credential'` gets a per-attempt `agent.write.failed`
row; an `open_writes` (escape hatch on, `credential: 'none'`) `failed` is
coalesced under its own `agent:failed:` key, because "requires credential
possession" is false on exactly the rollback lever most likely to be on during
an incident. (b) Concurrent repeats: the first writer `SET <key>:row pending NX
EX 45` before inserting; a repeat that reads `pending` writes nothing (its INCR
already happened, and the writer re-reads the counter after publishing the row
id, so it is carried); a failed insert releases the reservation. (c) The key's
ip is `ipKeyGenerator(ip)` (express-rate-limit's /56 IPv6 prefix, identical to
`publicLimiter`'s default bucketing). (d) A rejected `incrementRateLimit` reads
as 0 (per-attempt fallback) instead of dropping the row. Accepted residuals:
concurrent flushes to one row are last-writer-wins, so a count can briefly
read lower than the counter until the next flush; and a process that dies
holding a `pending` reservation suppresses that window's rows for up to 45s
(its attempts stay in the counter and the next row's `base` skips them). A
reserving insert that FAILS (pool timeout / P2028) no longer loses the burst:
it releases the slot and writes one plain, non-transactional row carrying the
counter's attempts (PR 2301 audit). Cost
if wrong: an under-count of at most one window's in-flight attempts on a
single row — never a per-attempt transaction for an anonymous caller.
