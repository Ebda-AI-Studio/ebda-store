# Read-only, count-only metrics across stores' Durable Objects (design, no code yet)

Status: proposal for the main controller's decision. Author: track 3. Date: 2026-11-17.

## The gap

Per-store data lives in one StoreDO per store (SQLite) plus D1 `ebda-platform` for the directory. Nothing lets an operator MEASURE DO data read-only in production. Two tracks were blocked today: track 1 (journal repair counts: how many stores have unbalanced or unrepaired journal rows) and track 4 (push exposure counts: how many subscriptions / stores a push change would reach). Today the only ways are: write throwaway code and deploy it, read a nightly backup offline, or guess. All three are slow, and the first is a production change made to answer a question.

## What already exists (verified in the code)

- The fan-out machinery: `hubFanoutStoreIds()` (cap `HUB_FANOUT_CAP = 500`, reports `truncated`) and `hubFanout()` (concurrency `HUB_FANOUT_CONCURRENCY = 8`; a failing store is skipped and reported, never fatal) in `apps/api/src/lib/platform-hub.ts`.
- Named DO procedures: the writer client has `$proc(name, args)` (`lib/repo-factory.ts`), the DO side lives in `apps/api/src/cf/store-do/`.
- Super-admin routes (`requireRole('super_admin')`, MFA gate) and an audit sink (`auditLog({ action, userId, resourceType, details, ip, userAgent })`).
- Rate limiters (`middleware/security.ts`).
  So the new piece is small: a fixed allow-list of named count procedures, one route, one CLI.

## Requirements (from the controller)

Fixed allow-listed named queries that return only aggregate counts (never rows, never PII, no free SQL); authz super_admin plus an audit row per call; rate-limited with a bounded per-store fan-out; a CLI wrapper for the controller.

## Options

### A. Live allow-listed metrics through the DOs (recommended)

- In the StoreDO: `metric(name)` runs ONE constant statement from a `METRICS` table compiled into the code, e.g. `journal_unbalanced: SELECT COUNT(*) FROM journal_entries WHERE ...`. The caller sends only the metric name (and, per metric, a zod-validated enum/number argument, never text that reaches SQL). The return type is `{ metric, value: number }` or a small fixed-key bucket object (`{ ok, repaired, unrepaired }`); there is no code path that returns a row.
- API: `POST /api/v1/admin/ops/do-metrics { metric, storeIds? }`, super_admin + MFA, fan-out over `hubFanoutStoreIds()` with the existing cap (500) and concurrency (8), a per-store timeout (2 s), response = totals + per-store counts + `{ truncated, failedStores }`. Per-store counts are allowed (a super admin can already see stores); per-user or per-row output is structurally impossible.
- Audit: one row per call: caller, metric name, number of stores asked / answered / failed, `truncated`, duration, and the TOTAL (never per-store payloads); IP and user agent as the other admin audit rows.
- Rate limit: 10 calls per minute per user, 1 in flight, a 60 s result cache keyed by metric (KV) so repeating the question costs nothing; kill switch `DO_METRICS_ENABLED=false` (env), checked first.
- CLI: `scripts/ops/do-metrics.mjs <metric> [--store <id> ...] [--json]`, prints totals and the worst N stores; reads a dedicated credential (see "Open decisions").
- Guards in tests: (1) every `METRICS` statement is a single `SELECT COUNT(*)` / `SELECT <aggregate>` with no `;`, no write keyword, no `ATTACH`/`PRAGMA` (static test over the table); (2) every statement runs `EXPLAIN QUERY PLAN` in the test DO and must use an index (no full scan of a big table); (3) the route test proves a non-super_admin gets 403, the audit row is written, the 11th call in a minute is 429, `truncated` is reported at the cap; (4) a "no row" test: the DO method's return value is checked to be numbers only.
- Cost to build: about 2-3 days with the tests above. Cost to run: one indexed COUNT per store per call, 500 stores at concurrency 8, cached 60 s.

### B. Precomputed daily snapshots in D1 (no live fan-out)

A cron job runs the same allow-listed counts per store and writes `do_metrics_daily(day, store_id, metric, value)` in D1; the super-admin route and CLI read D1 only. Safest for DO load and authz (it is a D1 read), cheapest to query, history for free. Downsides: answers are up to 24 h old (track 1's "did my repair work" loop needs minutes, not a day); every new metric needs a deploy before it has data; the cron itself is a fan-out with the same cap and timeout problems, just unattended. Cost to build 1-2 days.

### C. Offline analysis of the nightly backups

`cf-backup.yml` already dumps every StoreDO (encrypted); the restore drill rebuilds one locally. Run arbitrary SQL there. Fully off production and the most flexible, but: up to 24 h stale, a heavy local restore per question, and it puts PII on a laptop (the very thing the count-only rule avoids). Good as a fallback for one-off forensic questions, not as the answer.

### D. Free SQL for super admins (rejected)

One endpoint that executes caller-supplied read-only SQL in every DO. Maximum flexibility, and exactly the exfiltration path the requirements forbid: SQL injection surface, row and PII output, no static review. Not considered further.

## Recommendation

A, with B as a later add-on only if someone needs history (the allow-list and its tests are shared, so B is a thin extra). Ship with the two metric families that unblock today: track 1 (journal repair counts: `journal_unbalanced`, `journal_repaired`, `journal_unrepaired`) and track 4 (push exposure: `push_subscriptions_active`, `stores_with_push_enabled`), each added by a PR that carries its own SQL, its EXPLAIN assertion and a ruling line (the allow-list is code: adding a metric is a reviewed change, never data). Start with a spike to settle the one unknown below, then build.

## Open decisions for the controller

1. Credential for the CLI. A full super_admin session (MFA) cannot be used from a script. Options: (a) a dedicated service credential with a single scope `ops:metrics`, stored in `OS_SERVICES_ENV`, accepted only by this route (recommended: least privilege, revocable, its own audit identity); (b) a short-lived super_admin token minted per run by the identity service; (c) the controller's browser session (no CLI). Recommend (a).
2. Per-store counts or totals only? Recommend per-store (needed to find WHICH stores to repair), with no per-user output at all.
3. Cache TTL (60 s proposed) and the rate limit (10/min/user proposed).

## Unknowns (to settle in a one-day spike, before the build)

- Whether the DO SQLite API lets a method enforce read-only at runtime (an authorizer or `PRAGMA query_only`). If not, the guarantee is the constant allow-list plus the static test, which is enough for correctness but weaker as defence in depth.
- The real per-store latency of the proposed counts on a large store (measure, then set the per-store timeout).
- Whether a StoreDO that is hibernated adds cold-start cost to the fan-out (it should be bounded by the 2 s timeout and the concurrency of 8, but not measured).

## Risks and the cost if wrong

- A badly written metric (full scan) slows a hot store's DO for everyone on it. Bounded by: EXPLAIN-index test, 2 s timeout, concurrency 8, cache, kill switch. Cost if wrong: a few seconds of slower requests on the stores asked, until the switch is flipped.
- Allow-list creep turns the path into a data-export path. Mitigation: no free text reaches SQL, the return type is numbers only (tested), each metric needs a ruling and a review. Cost if wrong: counts of things per store leak to a super admin who can already see those stores; no row or person is exposed.
- Option B/C stale answers drive a wrong repair decision. Cost if wrong: a repair run on out-of-date numbers; recoverable, but it is why A is recommended over B for the repair loop.
- The credential (decision 1) is the real risk of this feature: a leaked `ops:metrics` credential reads counts only, and is revocable on its own.

## Not in scope

Writes of any kind, row-level reads, per-user output, customer-facing metrics, and the metrics UI (a super-admin page can come later from the same route).
