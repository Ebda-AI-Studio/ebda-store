# Ebda backend on Cloudflare: design (SP3, 2026-10-03)

**Status:** decided under Ahmad's "do not stop" instruction (2026-10-03). The plan put an approval gate here, so this is recorded as Ruling R-EBDA-001 for Ahmad to review after the fact. Reversal cost is low until SP4 Stage 1 lands (see §8).

**Evidence base (all on this branch):**

- `docs/design/cloudflare-backend-inventory.md`: every FWB API dependency, Redis group, timer, hook, Inngest trigger and the spike candidates, with file:line references.
- `spikes/workers-api/`: Prisma 6.19.3 + `@prisma/adapter-pg` on workerd, through pgbouncer in **transaction mode** (pool of 2, so connections are reused across tenants). Results: 17/17 tests, 0 cross-tenant leaks in 300 interleaved requests, and the mutation check goes red when `set_config(..., true)` becomes session-level or is removed.
- `docs/design/express-on-workerd-experiment.md`: FWB's **unchanged** Express app boots on workerd via `httpServerHandler` (`cloudflare:node`). `request-transaction.ts` commit-before-respond works and AsyncLocalStorage propagates. The bundle is 3.03 MB gzip. One blocker is open: 3+ concurrent requests in one isolate hang because the pg Pool/Prisma client is shared across requests. The RLS spike already solved this, with a per-request client.

---

## 1. Decision

**Run FWB's Express API on Cloudflare Workers (`nodejs_compat` + `httpServerHandler`), with a per-request Prisma client bound through AsyncLocalStorage, Hyperdrive → Neon, and strict RLS. Swap the Node-only dependencies one group at a time. Do not rewrite to Hono.**

Why not the alternatives:

| Option                                     | Verdict           | Reason                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Express on workerd (chosen)             | **Go**            | Boots unchanged; the remaining blocker is framework-independent and already solved in the spike. It keeps Ebda's API code shape identical to FWB, so fixes stay portable through `scripts/twin-diff.sh`.                                                       |
| B. Hono rewrite                            | No                | 143k lines and 74 route files means weeks of work, and it would hit the same per-request I/O issue. It would also break twin-path portability with FWB permanently. New Ebda-only surfaces (status page, marketing APIs) may use Hono.                         |
| C. Cloudflare Containers (Express on Node) | **Fallback only** | No code change, but an always-on container costs about $40/mo per FWB's measurement (`backend-cf-migration-plan.md` §2). Scale-to-zero means cold starts on checkout, and it still needs a TCP Redis (Upstash). Use it only if Stage 1's exit test (§8) fails. |

## 2. Request path

```
client ─▶ Cloudflare edge
          ├─ ebda.app, docs., help.               → static/OpenNext Workers (SP9)
          ├─ admin.ebda.app                         → admin Worker (OpenNext)
          ├─ <slug>.ebda.app, custom hostnames    → storefront Worker (OpenNext; CF-for-SaaS fallback origin)
          ├─ status.ebda.app                      → status Worker (own storage, independent; SP9)
          └─ api.ebda.app                         → API Worker (Express via httpServerHandler)
                                                     │ per request: PrismaClient(adapter-pg, max:1) ─▶ Hyperdrive ─▶ Neon (pooled)
                                                     │ Durable Objects: RateLimiter, Lock, Realtime(store)
                                                     │ KV: public caches   R2: media   Queues: email, sms, webhooks
                                                     └ Inngest (HTTPS → /api/v1/inngest) for jobs + crons
```

## 3. Database and tenancy (Review Focus 1)

- **Hyperdrive** in front of Neon. **Query caching is disabled** (`caching.disabled = true`). A cached read is keyed on SQL text and parameters, not on the GUC, so caching could serve one store's rows to another. This is never to be re-enabled without a test.
- **Role:** the API connects as a non-bypass `ebda_app` role. There is no BYPASSRLS role in the runtime path; migrations use a separate `DIRECT_URL` owner role.
- **Runtime role guard:** fetch, queue and scheduled invocations await a database-role check before application work. Missing role rows, failed checks, superuser and BYPASSRLS roles reject the invocation. Only validated success is cached per isolate; concurrent first invocations query on their own request lease.
- **GUCs:** `app.current_store_id` and `app.current_user_id`, set with `set_config(name, value, true)` (transaction-local) as the first statement of every request transaction. Session-level `SET` is banned by an ESLint/grep rule, and the spike's negative control shows why: it leaked 13–20 times out of 20 through a transaction pooler. FWB's `SET LOCAL app.bypass_rls = 'true'` paths (`store.service.ts:491`, `reorder-scan.service.ts:212`) become `SECURITY DEFINER` functions with narrow signatures.
- **Strict policies on every tenant table** (`store_id = current_setting(...)::uuid`, with no NULL allowance). FWB allows a contextless read on all but 24 tables; Ebda flips that in SP4's first migration. Host→store lookup is a `SECURITY DEFINER` function (spike pattern). Super-admin cross-store reads go through an explicit, audited definer function, not a bypass GUC.
- **Per-request client:** `packages/database` exports `getDb()`, which returns the request's client from AsyncLocalStorage. The existing `prisma` proxy keeps its API, so the roughly 160 raw-SQL call sites and services stay unchanged. The pg pool is `max: 1` per request; `$disconnect()` goes into `ctx.waitUntil`. Prisma generator: `engineType = "client"` (wasm query compiler) plus `driverAdapters`. Cast `name` columns to `::text` in `$queryRaw`.
- **Transaction rules carried over from FWB:** one transaction per request, commit before respond, a 30 s timeout, savepoints for unique-race writes, `{ increment }` for quantities, and no external call (payment, carrier, email, LLM) inside the transaction. Deferred post-commit work drains in `ctx.waitUntil` (the 30 s grace), and anything longer goes to Queues or Inngest.
- **Capacity:** throughput ≈ pool size ÷ transaction time. Keep request transactions short (the spike measured 5–8 round trips) and watch Hyperdrive's pool against Neon's connection limit.

## 4. Host routing

- `<slug>.ebda.app`: a wildcard route on the storefront Worker. Custom domains use Cloudflare for SaaS custom hostnames with the storefront Worker as the fallback origin (same as FWB).
- **Resolver:** lowercase the host and strip the port. A reserved label (`app api docs help status whatsapp www admin orders mail cdn assets static store dashboard billing support blog`) never resolves to a store. An unknown host returns **404**, never the first store. Lookup is a `custom_hostnames` match, then a slug match; a hit is cached in KV (TTL ≥ 120 s, FWB's Redis floor) with the host in the key, and **a miss is not cached as a store**.
- **Edge/HTML cache keys always include the host.** A cross-tenant cache test (store A then store B at the same path) is mandatory in SP4.
- Reserved-slug validation lives in `@ebda/shared` (one list) and is used by both signup (SP5) and the resolver.

## 5. Dependency mapping

Consistency requirements come from the inventory's Redis grouping (§2.2).

| FWB today                                                              | Ebda on Cloudflare                                                                                                                                             | Consistency                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ioredis: token denylist (`jti`), `tv` revocation, MFA/lockout counters | **Durable Object** `AuthState`, sharded by user id                                                                                                             | Strong. KV's ~60 s staleness would let a revoked token through. |
| ioredis: rate limits (express-rate-limit store)                        | Workers **Rate Limiting binding** for coarse per-IP limits; DO `RateLimiter` for auth's 5/15 min per IP+email                                                  | Approximate is fine for coarse limits; strong for auth          |
| ioredis: locks / leader election                                       | **Dropped** for jobs that move to cron (a single fire needs no leader); DO `Lock` for the remaining mutexes                                                    | Strong                                                          |
| ioredis: caches (store, product, public payloads)                      | **KV** (TTL ≥ 120 s) plus the Cache API; purge on write                                                                                                        | Eventual, which is acceptable for caches                        |
| ioredis: reminder sentinels (abandoned cart 1h/4h/24h)                 | Rows in Postgres, or Inngest `step.sleep`                                                                                                                      | Strong                                                          |
| ioredis: campaign pacer (Lua)                                          | DO `Pacer`                                                                                                                                                     | Strong                                                          |
| email/SMS queue (LPUSH/RPOP + setInterval)                             | **Cloudflare Queues** with retries and a DLQ; the super-admin replay pages read the DLQ                                                                        | At-least-once, an upgrade on today's at-most-once               |
| 7 setInterval loops                                                    | Inngest cron (already used for 29 crons) or **Cron Triggers**                                                                                                  | Single fire                                                     |
| socket.io (admin/orders realtime)                                      | DO `StoreRealtime` with WebSocket Hibernation, one per store; clients reconnect with the same events                                                           | n/a                                                             |
| Inngest (95 functions)                                                 | Keep Inngest and serve from the Worker (`inngest/cloudflare` or the generic fetch handler; confirm in v4). Watch CPU per step on `bulk-*` and `campaign-send`. | n/a                                                             |
| sharp                                                                  | Cloudflare Images (resize on delivery) for uploads to R2                                                                                                       | n/a                                                             |
| @aws-sdk/s3                                                            | R2 binding                                                                                                                                                     | n/a                                                             |
| multer                                                                 | `Request.formData()` adapter middleware                                                                                                                        | n/a                                                             |
| @sentry/node, OpenTelemetry, pino transports                           | `@sentry/cloudflare`, Workers Logs + Logpush, a tail Worker for alerts; pino becomes a console JSON logger                                                     | n/a                                                             |
| imapflow (Gmail alert poller)                                          | **Dropped.** It was FWB ops plumbing; Ebda alerts come from Sentry and the status page.                                                                        | n/a                                                             |
| `http`/`https`, `dns`/`net` SSRF guard (`lib/safe-fetch.ts`)           | Rewrite on `fetch`, with DNS checks through DoH and an IP blocklist                                                                                            | n/a                                                             |
| compression middleware                                                 | Removed, because the edge compresses (it broke bodies on workerd)                                                                                              | n/a                                                             |
| swagger-ui-express                                                     | Moves to `docs.ebda.app` (SP9)                                                                                                                                 | n/a                                                             |
| web-push                                                               | Rewrite on WebCrypto (VAPID), or OneSignal-equivalent HTTP                                                                                                     | n/a                                                             |

## 6. Payments and webhooks

- Webhooks: raw body, then WebCrypto HMAC verify, then a `webhook_events` insert with a unique `(provider, event_id)` (replay is a no-op 200; proven in the spike), then a state change in the same transaction. Slow follow-ups go to Queues.
- Provider calls (create payment, refund) run outside the request transaction. The flow is: read, commit, call provider, then a new short transaction to record the result, with an idempotency key on every provider call. The SP6 contract suite owns this.

## 7. Observability

`/health` returns `commit` and `deploymentId` (FWB's build identity). Errors go to `@sentry/cloudflare`. Logs go to Workers Logs, with Logpush once launched. A tail Worker sends P1 alerts. `Server-Timing: request-tx` is kept, and a log line records Hyperdrive pool wait.

## 8. Rollout (SP4) and exit test

Each stage ends with tests green on workerd (the SP3 spike suite, ported) plus buy-flow parity.

1. **Stage 1, boot:** the Ebda API on workerd with a per-request client, strict RLS, and Hyperdrive with no cache. Redis groups are swapped in the order auth-state, then rate limits, then caches, then queues. Timers move to cron. Socket.io moves to the DO.
   - **Exit test:** 200 concurrent mixed requests across 2 stores give 0 errors and 0 leaks, and buy-flow parity is green.
   - If concurrency still fails after the per-request client, fall back to Option C (Containers) for the API only. The frontends stay on Workers either way.
   - **Status (2026-10-04):** the concurrency and leak half passes (0 errors, 0 leaks, 3 of 3 runs); buy-flow parity is not done. Numbers, findings (isolate memory) and the list of what is left: `stage1-exit-test.md`.
2. **Stage 2, harden:** remove the remaining stubs, run the deployed-Hyperdrive proof (real pooler, CPU and bundle on the edge), and set up observability.
3. **Parity harness:** it spawns Express from two git refs (no `--api-url`) and hard-codes loopback, and its MyFatoorah stub is a Node preload. SP4 adds an `--api-url` mode plus a provider base-URL env override, so the same 16 scenarios run against `wrangler dev`. MyFatoorah scenarios become EGP-provider scenarios in SP6.

## 9. Not proven yet (named, owned)

| Gap                                                                     | Proof                                                                              | When                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| Real Hyperdrive pooler (not pgbouncer) preserves transaction-local GUCs | Re-run the spike suite against a deployed Worker with Hyperdrive and a Neon branch | SP4, needs a CF token and a Neon project |
| CPU/startup on the edge for the full Express bundle (3 MB gzip)         | Deploy, then measure cold start and p50/p95                                        | SP4                                      |
| Inngest v4 serve on workerd                                             | Smoke test one event and one cron                                                  | SP4                                      |
| Buy-flow parity against a Worker                                        | Harness `--api-url` mode                                                           | SP4                                      |
