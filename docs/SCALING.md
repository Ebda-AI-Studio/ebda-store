# Horizontal Scaling Guide — Ebda Store API

> **RETIRED STACK (2026-11-10 note).** This document describes the Railway-hosted Express API on Neon Postgres, retired 2026-11-05 (NEON-ZERO; the API is the `ebda-api` Cloudflare Worker on D1 + Durable Objects). Kept as history only. Live runbooks: `docs/INCIDENT.md`, `docs/ROLLBACK.md`, `docs/DB-BACKUP-RESTORE.md`, `docs/observability/slo.md`.

This document covers both vertical and horizontal scaling for the Railway-hosted Express API
(`apps/api`). The code changes that make horizontal scaling safe are on branch
`feature/horizontal-scaling` (PR from that branch).

---

## Vertical Scaling

**Where:** Railway → ebda-api service → Settings → Resources

Drag the **CPU** and **RAM** sliders to increase the resources available to the single running
container.

**Current / recommended starting point:**

| Resource | Current (Railway default) | Recommended for production                            |
| -------- | ------------------------- | ----------------------------------------------------- |
| CPU      | 0.5 vCPU                  | 1 vCPU (handles ~200 concurrent requests comfortably) |
| RAM      | 512 MB                    | 1 GB (Node.js + Prisma + pino + sharp buffer pools)   |

Vertical scaling is zero-risk — it does not require any code changes. Do it first before
enabling replicas. A well-sized single container is cheaper than two undersized ones.

**Signs you need more RAM:** Railway "out of memory" deploy logs, `process.memoryUsage().rss`
climbing past 400 MB in the `/api/v1/health` response.

**Signs you need more CPU:** p95 latency above 500 ms on `GET /api/v1/stores/:id/products`
under normal load (baseline your k6 report first).

---

## Horizontal Scaling

**Where:** Railway → ebda-api service → Settings → Replicas (or `numReplicas` in
`railway.toml` / `railway.json`).

Set `numReplicas: 2` (or higher) to run multiple containers behind Railway's built-in
load balancer. Railway distributes incoming HTTP/WebSocket connections across replicas.

### Code changes that make this safe (merged in this PR)

| Concern                                   | Problem with naïve replicas                                                                  | Fix                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Socket.io events                          | A client on replica A never receives events emitted from replica B                           | Wired `@socket.io/redis-adapter` — events fan out via Redis pub/sub to all replicas                                           |
| Cron timers (loyalty, FBT, token cleanup) | Each replica runs the cron body, causing duplicate birthday-bonus emails / double DB deletes | `withLeaderLock()` in `apps/api/src/lib/leader-election.ts` — only the replica that wins the Redis `SET NX` executes the body |
| Rate limiting                             | Already uses `RedisStore` via `rate-limit-redis` — shared across replicas                    | No change needed                                                                                                              |
| CORS cache                                | BoundedMap is per-process (5-min TTL)                                                        | Safe — stale cache entry causes one extra DB lookup, then re-caches; no correctness issue                                     |
| Neon DB pool                              | pgbouncer URL already in use                                                                 | See prerequisites below                                                                                                       |

### Prerequisites checklist

Before setting `numReplicas > 1`, verify all of these:

- [ ] **`REDIS_URL` is set** on the Railway ebda-api service environment. The Railway internal
      URL is `redis://redis.railway.internal:6379`. Without it the socket adapter and leader-election
      both fall back to in-process mode and replicas are NOT safe.
- [ ] **`DATABASE_URL` uses the Neon pgbouncer pooled connection string** (port 6543, not 5432).
      The pooler distributes Prisma connections across replicas without hitting Neon's per-branch
      connection limit. `DIRECT_URL` continues to use port 5432 (for `prisma migrate deploy` only).
- [ ] **`/health` returns HTTP 200** — Railway's health check probe hits this path on each
      replica before routing traffic. Confirm in `railway.json` that `healthcheckPath: "/health"`.
- [ ] **No sticky-session requirement** — the Socket.io redis adapter makes sessions stateless,
      so Railway's default round-robin balancing works. Do NOT enable sticky sessions.
- [ ] **`REDIS_KEY_PREFIX`** — If staging and prod share the same Redis instance, staging should
      have `REDIS_KEY_PREFIX=ebda-staging:` set. Prod leaves it unset. The prefix is already wired
      in `redis.service.ts` via the `keyPrefix` ioredis option.

### Recommended rollout

1. Deploy with `numReplicas: 1` first and verify the health check passes and logs show
   `[Socket.io] Redis adapter attached`.
2. Set `numReplicas: 2` and watch Railway logs for both instances. Confirm Socket.io adapter
   line appears in both.
3. Open the admin dashboard in two browser tabs and verify order notifications appear in both
   (they arrive via Socket.io from different replicas).
4. Scale to 3+ replicas only after verifying Neon connection count is within pool limits (see
   "What to watch" below).

---

## What to Watch After Scaling

### Neon connection count vs pool limit

Neon free tier allows ~20 direct connections per branch. Each Prisma instance opens up to
`connection_limit` connections (default 10 for serverless). With pgbouncer the pool is shared,
so `numReplicas × 10` direct connections do NOT accumulate — pgbouncer sits in front.

Monitor via Neon dashboard → Monitoring → Active connections. Alert if connections approach
the branch limit (typically 20 on free, 100+ on Scale/Business plans).

If the connection count grows proportionally with replicas, the pooler URL is not being used —
double-check `DATABASE_URL` contains port 6543 and `?pgbouncer=true` or equivalent.

### Redis memory

Each Socket.io adapter pub/sub connection adds a small memory footprint. With the
`@socket.io/redis-adapter` each replica opens 2 ioredis connections (pub + sub) on top of the
existing main connection. Monitor Railway Redis service memory. With 3 replicas expect ~7 total
ioredis connections; at typical WebSocket message volume this stays well under 10 MB.

### Leader-lock contention

The `leader:*` Redis keys have TTLs equal to the cron interval. If a replica crashes mid-job,
the lock expires after the TTL and the next replica picks up the next tick. No manual
intervention required. You can inspect active locks with:

```bash
redis-cli -u $REDIS_URL keys "leader:*"
```

Expected keys when jobs are running:

- `leader:loyalty-automation-daily` (TTL ~86400s)
- `leader:fbt-recalculation` (TTL ~86400s)
- `leader:auth-refresh-token-cleanup` (TTL ~43200s)

### Abandoned-cart and shipping-carrier crons

These already used `redis.acquireLock()` before this PR. No changes needed — they are already
safe for multiple replicas.

---

## What Horizontal Scaling Does NOT Help With

- **Neon cold-start latency** — the first query after a serverless compute pause takes 200–800 ms
  regardless of replica count. Use the pgbouncer URL and keep traffic active.
- **Job concurrency** — jobs run on Cloudflare Workflows/Queues; `limit <= 3` concurrency is a `JobGate`
  lease, so Worker instance count has no effect on job fanout (`docs/cf/jobs-map.md`).
- **Railway egress costs** — more replicas = more outbound traffic billed. Verify Railway plan
  limits before scaling beyond 3 replicas.
