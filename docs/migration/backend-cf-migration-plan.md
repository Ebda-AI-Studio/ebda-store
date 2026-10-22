# Backend → Cloudflare migration plan (Ebda Store API + WBS)

> **Status: PLANNING / decision doc — no code.** Driver = **cost + vendor consolidation**
> (empty the Railway bill). Written 2026-06-26 after the Ebda Store **frontend** cutover to
> Cloudflare completed (storefront/admin/orders live on `*.ebda.app`, a real card
> payment verified end-to-end). Builds on the parked strategy in memory
> (`project-ebda-cloudflare-migration-strategy`) and the in-repo CF docs
> (`cloudflare-cutover-runbook.md`, `cloudflare-preview-workers.md`, `cloudflare-ci-deploy.md`).

## 1. What this is and isn't

The **frontends are done.** Three Next apps build with OpenNext and serve on Cloudflare
Workers behind `store/admin/orders.ebda.app` + every merchant Custom Hostname. The old
`*.ebda.app` hosts 301 → the new domains. Vercel stays as a fallback during a
1–2 week soak, then gets dropped.

What remains, and what this doc decides: **moving the two stateful backends off Railway** —
the **Ebda Store API** (`api.ebda.app`) and **WBS** (WhatsApp Bulk Sender,
`backend.ebda.app`). This is a _different class of problem_ from the frontends and
must not be treated as "one more redeploy."

## 2. The cost reality-check (do this BEFORE any code)

The whole point is cost, so the first gate is: **does leaving Railway actually save money?**

**Consolidation only pays off if Railway is emptied entirely.** One **Hobby** plan covers both
projects; the bill only dies when **both** Ebda Store-API **and** WBS leave. That is why both are in
scope together — but see the measured numbers below: the bill is already ~$2/mo, so there is
almost nothing to empty.

**Savings (what leaves):** the entire Railway bill — Hobby base (~$5/mo, includes $5 usage) +
combined Ebda Store+WBS compute. **Measured total: ~$6 usage, ~$0–2 actual bill.**

**New costs (what appears) depend on the path:**

| Path                 | New monthly cost added                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF Containers        | CF Workers Paid $5 (already paying for the frontend workers) + **container compute** (always-on instance, not free) + **Upstash Redis ×2** (Ebda Store + WBS; no TCP Redis on CF) |
| CF Workers rewrite   | $5 Workers Paid + per-request/CPU-ms (cheap) + **Upstash Redis ×2** + Durable Objects (sockets)                                                                                   |
| Mac Studio self-host | ~**$0 marginal** (hardware already being bought) — power only. Keeps Redis local.                                                                                                 |

**MEASURED 2026-06-26 — from the Railway DASHBOARD (the source of truth).** The whole Railway
account (Ebda Store + WBS combined) on the **Hobby** plan:

| Cycle                         | Total usage (both projects)                                     | Total bill     |
| ----------------------------- | --------------------------------------------------------------- | -------------- |
| May 25 – Jun 25 (full)        | **$5.95** (memory $5.07 / CPU $0.32 / egress $0.56 / volume $0) | **$0.00**      |
| Jun 25 – Jul 25 (in progress) | $0.22 so far                                                    | est. **$1.82** |

**Headline finding: the entire Railway bill is ~$2/mo (≤$6 usage, mostly covered by the Hobby
$5 included).** There is **no meaningful cost to recover by leaving Railway.**

> **Correction (important):** an earlier draft of this doc claimed ~$100–115/mo (with a fake
> "~$93 WBS / $88 memory"). That was WRONG — it came from multiplying Railway's `estimatedUsage`
> GraphQL `estimatedValue` fields (which have no documented unit) by a _guessed_ GB-hour rate,
> overstating reality ~20×. The dashboard is authoritative: ~$6 usage, ~$0–2 bill, **Hobby**
> plan (not Pro). Lesson: read the billing dashboard; never derive a dollar figure from an
> un-unit'd usage API.

> **Action flag:** both dashboard screenshots show a **"subscription past due — pay the
> outstanding balance to avoid service disruption"** banner. Usage is tiny, so it's almost
> certainly a failed payment method, not a real bill — but clear it; it threatens the live API
>
> - WBS.

**Rates pulled 2026-06-26:**

- **CF Containers:** vCPU $0.000020/s ($0.072/hr), RAM $0.0000025/GiB-s ($0.0066/GiB-hr),
  disk $0.184/GB-mo; egress $0.025/GB NA-EU; included on Workers Paid 375 vCPU-min + 25 GiB-hr
  - 200 GB-hr; **scale-to-zero = $0 when asleep**. Always-on 0.5 vCPU/2 GiB ≈ **$40/mo** (worse
    than Railway as a PRIMARY); idle as a STANDBY ≈ **$0**.
- **Upstash Redis:** free = 500K cmd + 256 MB; pay-go $0.20/100K cmd + $0.25/GB; **Fixed 250 MB
  = $10/mo with UNLIMITED commands** (the right choice for BullMQ, which is command-heavy).

**Target architecture (Mac primary + scale-to-zero CF standby) — running the existing Express
app in a CONTAINER on both sides sidesteps BOTH Workers blockers (Socket.io works on a real
process; no Hyperdrive → the RLS hard-stop disappears):**

| Component                                                            | ≈ $/mo       |
| -------------------------------------------------------------------- | ------------ |
| Mac Studio (power only)                                              | ~$0          |
| Neon (Ebda Store already on it; **WBS Postgres moves here**)         | ~$0–19       |
| Upstash Redis — WBS BullMQ ($10 fixed) + Ebda Store cache (free/$10) | ~$10–20      |
| CF Workers Paid (already paying)                                     | $5           |
| CF Container standby (scale-to-zero, idle)                           | ~$0–3        |
| CF Load Balancer + health checks (Mac↔standby failover)              | ~$5–10       |
| **Total**                                                            | **≈ $20–40** |

**Net vs reality: this target is ~$20–40/mo — MORE than the ~$2/mo Railway costs today.** So it
**does not save money**; it _adds_ ~$20–35/mo in exchange for (a) the warm-standby failover and
(b) running the workloads on owned Mac hardware. That is a **redundancy / hardware-utilization**
decision, **not a cost decision.** For pure cost, the cheapest redundant always-on host you
already have is **Railway itself (~$2/mo)** — stay put.

> **Pre-conclusion:** from the parked cost model, a pure-cost backend move nets only
> **~$20–40/mo** _if_ it works, against **weeks** of rewrite + real risk. On cost grounds
> alone that ROI is poor. The structurally cheaper consolidation is **self-hosting both APIs
> on the Mac Studio** (already a decided purchase), which removes the Railway vendor _without_
> adding CF Container + Upstash spend. Cloudflare for the backend makes sense for _latency /
> single-pane-of-glass_, less so for _pure cost_.

## 3. Why the API is not the frontend (the technical reality)

The Ebda Store API is Express 4.22, **62 route files / 247 TS files**, with four properties that
don't map onto Cloudflare Workers:

| Dependency                               | Today (Railway)    | On CF Workers                     | Resolution                                               |
| ---------------------------------------- | ------------------ | --------------------------------- | -------------------------------------------------------- |
| **Redis** (ioredis, TCP)                 | Railway internal   | ✗ no raw TCP sockets              | **Upstash Redis** (HTTP/REST) or keep local (self-host)  |
| **Socket.io** (persistent WS server)     | long-lived process | ✗ no persistent server            | **Durable Objects** rewrite, or keep on a real server    |
| **Prisma + Neon** (83 models, RLS)       | direct pooled      | needs driver-adapter / Hyperdrive | `@prisma/adapter-neon` or Hyperdrive                     |
| **Express** (request-scoped, middleware) | native             | ✗ not a Workers runtime           | run in **CF Containers** (as-is) or rewrite Express→Hono |
| Inngest, crons, webhooks                 | external/offloaded | works from anywhere               | no change                                                |

**HARD-STOP gate (Workers path only):** Ebda Store tenant isolation uses
`SET LOCAL app.current_client_id` per transaction (RLS via `runInTenantContext`
AsyncLocalStorage → Postgres session GUC). **If Hyperdrive's connection pooling does not
preserve the per-transaction GUC, tenant isolation silently fails** — a cross-tenant data
leak. This must be proven on a throwaway branch _before_ any Workers/Hyperdrive commitment.
CF Containers + direct Neon connection sidesteps this (no Hyperdrive).

## 4. The options

### A. CF Containers (least rewrite)

Run the existing Express app in a container on Cloudflare Containers, ~as-is. Swap
ioredis→Upstash (or a CF-reachable Redis). Prisma talks to Neon directly (no Hyperdrive →
RLS safe). Socket.io _may_ work but CF Containers + WebSockets has caveats to validate.

- **Effort:** low–medium (containerize + Redis swap + env wiring).
- **Cost:** adds container compute + Upstash; net saving vs Railway is **unclear** — must measure.
- **Risk:** CF Containers is a newer product (limits/pricing maturing); WS support to verify.

### B. CF Workers rewrite (fully native)

Express→Hono, ioredis→Upstash, Prisma driver-adapter or Hyperdrive, Socket.io→Durable Objects.

- **Effort:** **high — weeks.** 62 routes + the RLS hard-stop + a socket rewrite.
- **Cost:** lowest steady-state CF spend, but the rewrite cost dwarfs the monthly saving.
- **Risk:** highest (RLS-under-Hyperdrive hard-stop; long-lived fork drift against an active API).

### C. Mac Studio self-host (cheapest consolidation)

Run both APIs (Ebda Store + WBS) as services on the Mac Studio already being purchased for
CI/staging/backups/local-AI. Redis stays local. Neon stays. Railway is cancelled.

- **Effort:** low–medium (process management, tunnel/ingress via Cloudflare Tunnel for TLS +
  DDoS, uptime + auto-restart, backup of local Redis).
- **Cost:** ~**$0 marginal** (power only) — removes the _entire_ Railway bill with no CF
  Container/Upstash spend. Best pure-cost outcome.
- **Risk:** home-infra availability (power/network/uptime) — mitigated by Cloudflare Tunnel +
  the existing alerting + the Mac being always-on; acceptable for these workloads, NOT for
  the storefront origin (which is already on CF Workers, not the Mac).

### D. Status quo (hybrid) — the baseline

Keep both APIs on Railway; frontends on CF. Zero further work, zero risk. The ~$20–40/mo is
the price of not spending weeks. This is the **do-nothing benchmark** every option above must beat.

## 5. WBS (WhatsApp Bulk Sender) — parallel analysis

Separate repo/project (`backend.ebda.app`). Stack to confirm, but known: BullMQ
(Redis-backed queues) + WhatsApp Cloud API webhooks + per-tenant credentials. Same Redis/TCP
constraint as Ebda Store (BullMQ needs a real Redis, not a request-scoped HTTP client → Upstash works
for BullMQ but verify the BullMQ-on-Upstash latency/limits). No Socket.io → simpler than Ebda Store.
**WBS must move in the same wave as Ebda Store** for the Railway bill to actually die.
→ _Action: a short WBS stack audit (deps, Redis usage, long-running workers, cron) before
sizing._

## 6. Recommendation (revised after measuring — cost case is closed)

**The cost driver is gone.** Railway is ~$2/mo; nothing to save. So the decision is now purely
about **redundancy + horizontal headroom + using the Mac Studio you're buying anyway.** Don't
cancel Railway — **make it the warm standby.** It's already running, managed, and ~free.

**Recommended topology — Mac + Railway dual-origin behind a Cloudflare Load Balancer:**

```
                       Cloudflare (Load Balancer + health checks)
                          /                              \
            POOL A: Mac Studio  (primary)        POOL B: Railway (warm standby)
            via Cloudflare Tunnel                 already live, ~$2/mo
                          \                              /
                 SHARED state both reach: Neon (DB) + ONE shared Redis
```

- **Mac = primary pool**, exposed through **Cloudflare Tunnel** (TLS + DDoS; no ports opened on
  home network). **Railway = standby pool**, untouched, takes over automatically when CF health
  checks fail the Mac. Failover is seconds, no DNS change.
- **Shared state is the linchpin:** both pools MUST hit the same **Neon** (already shared) and
  the **same Redis**. Railway's Redis is internal-only (`redis.railway.internal`) so the Mac
  can't reach it — pick ONE shared Redis: Upstash (~$10/mo, simplest), OR Mac-hosted Redis
  exposed to Railway via Tunnel, OR Railway Redis with a public proxy. **For WBS/BullMQ this is
  mandatory** (queue state must be one place) — otherwise the standby can't drain the queue.
- **Cost of this HA setup ≈ $2 (Railway) + ~$10 (shared Redis) + ~$5 (CF LB) ≈ $17/mo** — it
  _adds_ ~$15/mo over today for real high-availability + a scale path. Not a saving; a resilience
  buy. (You can DIY the LB with a small Worker health-checker to drop the ~$5.)

## 7. Scaling — vertical, horizontal, traffic

**Reality check first: you are nowhere near any limit.** Measured Ebda Store+WBS = **~0.05 vCPU avg and
~0.5 GB RAM combined** ($0.32 CPU + $5 memory for the whole month). Scaling is a _future_ concern,
not a present one. The storefront/admin/orders are already on **CF Workers = infinite edge scale**;
the API is the only thing that ever needs scaling thought.

- **Vertical:** trivially solved for years. A Mac Studio has enormous headroom (tens of cores,
  64–192 GB RAM) vs the ~0.5 GB used today; Railway Hobby already allows 8 GB/8 vCPU and you use a
  fraction. Just raise the instance size when a real bottleneck appears. **First true ceiling will
  be Neon (DB), not the app** — keep the pooled connection string + watch Neon compute.
- **Horizontal:** the dual-origin topology above IS horizontal scale — run Mac **and** Railway
  active for ~2× capacity, and add a **scale-to-zero CF Container burst pool** for spikes (costs
  ~$0 when idle, only bills during a surge). BullMQ (WBS) scales horizontally for free (add workers
  pulling the same queue). **The one real code prerequisite: the Ebda Store API's Socket.io needs the
  `@socket.io/redis-adapter`** so WebSocket events fan out across instances (without it, a client
  on instance A misses events emitted by instance B). In-memory `bounded-map` caches also become
  per-instance — fine for cache, but don't put correctness on them. Both are small, well-trodden
  changes — do them BEFORE going multi-instance.
- **Traffic:** today's load is negligible; a single Mac handles thousands of req/s for an
  Express+Prisma API. As traffic climbs the order of bottlenecks is: **Neon connections → Redis
  throughput → app CPU.** Front everything with Cloudflare (cache + LB) so the edge absorbs the
  storefront read load (already true) and the API only sees writes/auth.

## 8. Decision gates (must pass in order)

1. **Redis gate** — one shared Redis reachable by Mac + Railway carries Ebda Store cache + WBS BullMQ at real volume (Upstash Fixed $10 = unlimited cmds is the safe default for BullMQ).
2. **Socket.io gate** — add `@socket.io/redis-adapter` so notifications fan out across instances BEFORE running >1 origin.
3. **Health-check gate** — CF Load Balancer (or a Worker) correctly detects a dead Mac and fails to Railway within seconds; failback when Mac returns.
4. **Webhook gate** — the payment `webhook_events` inbox + Inngest offload behaves identically whichever origin serves; Meta/WhatsApp webhooks (WBS) reach whichever origin is live.
5. **Data gate** — both origins on the SAME Neon + SAME Redis; no split-brain on queues or sessions.

## 9. Open questions for Ahmad

- Confirm the goal is now **HA + use-the-Mac**, not cost (cost is ~$2 — settled).
- Shared-Redis choice: **Upstash ($10, simplest)** vs Mac-hosted-Redis-over-Tunnel vs Railway-Redis-public-proxy?
- Mac as **sole primary (Railway standby)**, or **both active** (true 2× horizontal)?
- Mac Studio arrival date — gates the build.

## 10. Decisions locked (2026-06-26)

- **Shared Redis = Upstash, $10/mo Fixed (unlimited commands)** — both Mac + Railway + any CF
  Container burst instance point at it via `rediss://`. Chosen over the Railway-public-proxy idea
  so Railway can be a _true_ cold standby (no always-on dependency on it). **Upstash supports Redis
  pub/sub over its TCP endpoint**, so the existing Socket.io adapter works unchanged.
- **Socket.io multi-instance fan-out = ALREADY DONE in code** (`apps/api/src/services/socket.service.ts`
  attaches `@socket.io/redis-adapter` with duplicated pub/sub clients + graceful fallback). Switching
  to Upstash is **env-only**: set `REDIS_URL` to the Upstash `rediss://` URL. No code change. BullMQ
  (WBS) already scales out on the shared Redis.
- **Burst trigger = REACTIVE** (load/latency-driven), not scheduled — bring the burst pool in when a
  threshold is crossed, drain + sleep when it clears.
- **Topology = elastic 3-tier (see §11).**
- **Mac Studio spec (planned): M5 Ultra, highest RAM — possibly 512 GB.** Implication: the Mac's
  _vertical_ headroom is effectively unlimited for this workload (today's whole footprint is ~0.5 GB).
  The Mac alone can run many instances + huge in-memory cache; it will never be RAM- or CPU-bound.
  So the burst/standby pools are about **(a) failover when the Mac/home network is down, and (b)
  absorbing spikes beyond home-network bandwidth** — NOT about compute capacity. The real ceiling
  becomes **Neon (DB) + home uplink**, which is exactly what the cloud standby + Neon pooling cover.

### Neon connection pooling (multi-origin + elastic burst)

With Mac + Railway + an elastic CF Container pool, many app instances open DB connections — the
classic exhaustion trap. Plan:

- **Every app instance connects to Neon's POOLED endpoint** (`-pooler` host, PgBouncer **transaction
  mode**) via `DATABASE_URL` with `?pgbouncer=true`. The pooler multiplexes thousands of client
  connections into a few Postgres backends, so the elastic fleet scales without exhausting Neon.
- **Keep `DIRECT_URL`** (non-pooled endpoint) for **migrations only** — Prisma already uses it.
- **Set a conservative per-instance `connection_limit`** (e.g. 5) so `instances × limit` stays under
  Neon's backend ceiling even at peak burst.
- **RLS is compatible:** Ebda Store sets `SET LOCAL app.current_client_id` **per transaction**, and `SET
LOCAL` is transaction-scoped → safe under PgBouncer transaction mode (this is the key difference
  from the Hyperdrive hard-stop — Neon's own PgBouncer preserves per-tx GUCs). Verify once with a
  cross-tenant read test, but it should hold.
- Bump Neon compute size if the backend ceiling is ever hit (Neon autoscales); storefront reads are
  already absorbed at the CF edge, so the DB mostly sees writes + auth.

## 11. Elastic burst — "scale at peak, idle the rest" (Ahmad's ask)

You don't choose Mac-only vs both-active — you do **both, on demand.** Three tiers:

1. **Baseline (24/7):** Mac = primary serves all traffic; Railway = warm standby (its Redis is
   the shared store). Cheapest steady state.
2. **Burst (peak hour / spike):** the **CF Load Balancer brings a second pool online** — either
   Railway's app pool and/or a **scale-to-zero CF Container burst pool** — giving 2×+ capacity for
   the surge. The CF Container pool is the ideal elastic element: **$0 when asleep, spins up on
   demand, sleeps again after.**
3. **Back to idle:** burst pool drains + sleeps → cost returns to baseline.

**Trigger = REACTIVE (chosen 2026-06-26):** the LB (or a Worker watching latency/CPU) pulls the
burst pool in when a threshold is crossed and drops it when load clears — "scale only when it
actually needs it." Needs a metric source (CF LB analytics / a health endpoint reporting load).
A scheduled trigger can be layered later for known peaks, but reactive is the default.

**Socket.io prerequisite — ALREADY SATISFIED:** `@socket.io/redis-adapter` is already wired in
`apps/api/src/services/socket.service.ts` (pub/sub fan-out across instances, graceful fallback).
No code work needed; multi-instance is unblocked today.

## 12. Next concrete step (when the Mac arrives)

1. **Clear the Railway "past due" banner** so the standby stays alive.
2. **Stand up Upstash** ($10 Fixed) and set `REDIS_URL` → its `rediss://` URL on every origin
   (Mac, Railway, CF Container pool). Socket.io adapter + BullMQ pick it up with no code change.
3. **Switch Neon to the pooled endpoint** (`?pgbouncer=true`, per-instance `connection_limit≈5`),
   keep `DIRECT_URL` for migrations; run one cross-tenant RLS read test to confirm `SET LOCAL`
   survives the pooler.
4. Stand the Mac up as a second origin behind a **CF Load Balancer** on the SAME Neon + Upstash;
   validate **failover + a reactive burst** on a PREVIEW hostname before touching
   `api.ebda.app`.
