# FWB Reliability Audit — Races, Leaks, Job Correctness, Replica-Safety

Date: 2026-07-02
Scope: `apps/api` (Fastify/Express + Prisma/Neon + Redis + Socket.io + Inngest)
Base: origin/main HEAD `2332c4d5`
Lens: reliability — race conditions, memory leaks, job/cron correctness, replica-safety, DB pool, error handling, anomaly detectors.
Method: read-only. Verified against source; cross-checked prior memory (serializable-tx-retry, cart OR-without-orderBy, jest-setinterval-leak, db-pool-starvation, anomaly-direction-floor). Fixed items were confirmed and are listed as such (not counted).

---

## Summary of counts

| Severity                     | Count |
| ---------------------------- | ----- |
| Critical                     | 0     |
| High                         | 1     |
| Medium                       | 3     |
| Low                          | 3     |
| Verified-fixed (not counted) | 7     |

---

## Findings

### F1 — Coupon `usageLimitPerUser` (per-customer limit) is never enforced

- **Severity:** High
- **Verdict:** CONFIRMED
- **Location:** `apps/api/src/services/order.service.ts:460-473` (reservation), `apps/api/src/services/coupon.service.ts:80-107` (`getByCode` validation), field defined at `coupon.service.ts:15`, written at `:138`/`:179`, zod at `apps/api/src/routes/coupon.routes.ts:27`, admin UI at `apps/admin/.../coupons/_components/CouponFormModal.tsx:223`.
- **Evidence:** `usageLimitPerUser` is collected in the admin form, validated by zod, and persisted, but a full-tree grep (`grep -rn usageLimitPerUser`) shows **no read of it anywhere in the order/coupon validation path**. Only the _global_ `usageLimit` is enforced — race-safely, via the atomic `coupon.updateMany({ where: { usageCount: { lt: usageLimit } }, data: { usageCount: { increment: 1 } } })` at `order.service.ts:466-471`. There is no per-user redemption tracking table and no per-customer count check.
- **Failure scenario:** A merchant creates a "one use per customer" coupon (`usageLimitPerUser=1`). A single customer applies it on every order they place — concurrently or serially — and every checkout succeeds until the _global_ limit (if any) is hit. With no global limit set, one customer drains the entire promotion. This is a money-correctness defect, not merely cosmetic: the merchant's stated constraint is silently a no-op.
- **Fix:** Track redemptions per (couponId, customerId) — either a `CouponRedemption` row written inside the order tx, or a guarded `count` check against `Order` (couponCode + customerId). Enforce it with the same atomic-reservation pattern already used for the global limit (a conditional write, not a read-then-write) so concurrent checkouts by the same customer can't both slip past. Guests (no customerId) should key on shipping email/phone to match the customer-aggregation convention.

---

### F2 — Cart P2002-recovery `findFirst` lacks `orderBy` → stale-cart bug survives on the race path

- **Severity:** Medium
- **Verdict:** CONFIRMED
- **Location:** `apps/api/src/services/cart.service.ts:54-60` (fallback), contrast with the primary lookup at `:29-36`.
- **Evidence:** The primary `getOrCreate` lookup was deliberately given `orderBy: { updatedAt: 'desc' }` (`:35`) with a comment explaining the exact stale-cart bug: when a customer logs in mid-session, BOTH a fresh session cart AND an older customer cart match the `OR: [{ sessionId }, { customerId }]` clause, and without ordering Postgres returns one at random — resurrecting an empty stale cart and causing spurious `EMPTY_CART` on checkout. **The P2002 create-race fallback at `:54` repeats the same `OR` query but omits `orderBy`**, so on the concurrent-create path it can still return the wrong (random) cart.
- **Failure scenario:** Two near-simultaneous requests for the same just-logged-in user both find no cart, both attempt `create`, one wins, the loser catches P2002 and runs the un-ordered `findFirst` — which can return the older empty customer cart instead of the active session cart. The shopper then sees an empty cart or hits `EMPTY_CART` at `POST /orders`. Low-frequency (requires the create race) but it re-opens the exact class the primary fix closed.
- **Fix:** Add `orderBy: { updatedAt: 'desc' }` to the fallback `findFirst` at `:54` (one line). Matches the documented invariant "return the most-recently-touched cart."

---

### F3 — Module-level `setInterval` timers not cleared/unref'd → vitest worker-hang risk + delayed shutdown

- **Severity:** Medium
- **Verdict:** CONFIRMED (leak/hang mechanism); PLAUSIBLE (CI impact, given `maxWorkers:1`)
- **Location:** `apps/api/src/middleware/security.ts:25` (CSRF-token memory cleanup), `apps/api/src/services/view-ingest.service.ts:54` (`_cleanupInterval`, session-debounce cleanup).
- **Evidence:** Both are bare module-load `setInterval(...)` side-effects with no exported handle, no `clearInterval`, and no `.unref()`. `tests/setup.ts` is not shown to clear them. Any test importing these modules (security middleware is imported by `index.ts` and most route tests transitively) keeps the Node event loop alive. This is the exact class flagged in `feedback-jest-module-setinterval-leak` (verified to hang CI 30-45 min elsewhere). Vitest here runs `pool: 'forks', maxWorkers: 1` — a single hung fork blocks the whole run. (The service-class timers — email/sms/abandoned-cart/shipping/loyalty/FBT — are all stored on instance handles with `stop*()` methods and are NOT part of this finding.)
- **Failure scenario (CI):** a suite that imports `security.ts` finishes assertions but the fork never exits; vitest waits, then force-exits — intermittent "worker did not exit" and multi-minute stalls. **Prod:** on `SIGTERM` the event loop stays alive on these two timers, delaying graceful shutdown until Railway's hard-kill.
- **Fix:** Give each a stored handle + an exported `_stop*()` and clear it in the test teardown (`tests/setup.ts` afterAll), OR call `.unref()` on both handles so they never hold the loop open (simplest; safe for cleanup-only timers). `.unref()` also fixes the shutdown delay.

---

### F4 — FBT scheduled recalculation cron is seeded with an empty store list and can never be re-seeded

- **Severity:** Medium
- **Verdict:** PLAUSIBLE
- **Location:** `apps/api/src/index.ts:73` (`recommendationService.startFBTCron(86400000, [])`), `apps/api/src/services/recommendation.service.ts:465-490` (`startFBTCron`).
- **Evidence:** `startFBTCron(intervalMs, storeIds)` captures `storeIds` in the interval closure and loops `for (const storeId of storeIds)`. It is called once at boot with `[]`. It also early-returns if `fbtCronTimer` is already set (`:466-469`), so a later call with a populated list is a no-op. The inline comment says "storeIds populated per-trigger," but the closure over the empty array means the **scheduled** daily recalculation iterates zero stores forever. (Per-store FBT may still be recomputed via an on-demand route/Inngest path — hence PLAUSIBLE, not CONFIRMED — but the daily leader-gated cron as wired does nothing.)
- **Failure scenario:** Multi-replica or single, the daily FBT recompute never runs for any store; "Frequently Bought Together" recommendations silently go stale (drift from actual co-purchase data) with no error surfaced. A merchant's FBT block reflects whenever a manual/trigger recompute last ran.
- **Fix:** Either query the store list inside the tick (`const storeIds = await prisma.store.findMany({ where: { deletedAt: null }, select: { id: true } })` under the existing `withLeaderLock`) instead of closing over a boot-time array, or remove the dead scheduled cron and rely solely on the trigger path. Confirm which path is authoritative before changing.

---

### F5 — Email/SMS queue: one item per tick throughput ceiling + non-durable `setTimeout` retry

- **Severity:** Low
- **Verdict:** CONFIRMED
- **Location:** `apps/api/src/services/email-queue.service.ts:61-105,134` and `apps/api/src/services/sms-queue.service.ts:77-121,192`.
- **Evidence:** `processQueue` does a single `rpop` per tick (`email:1000ms`, `sms:2000ms`) so steady-state throughput is ~1 email/s, ~0.5 SMS/s per replica regardless of backlog. Retry on failure is a fire-and-forget `setTimeout(() => lpush(...), delay)` (`email:134`, `sms:192`) held only in process memory. Consumption itself is replica-safe (atomic `rpop`), and SMS has a DB idempotency guard (`notificationLog.idempotencyKey`, `sms-queue:128`), so this is throughput/durability, not a double-send race.
- **Failure scenario:** A burst (bulk order-status blast, newsletter fan-out) backs the Redis list up; drain is linear at 1/s so the tail is minutes late. If a replica restarts during a retry's backoff window, that in-flight retry is lost (the item was already `rpop`'d off the queue and lives only in the pending `setTimeout`) — email silently never re-queued (SMS is protected by the idempotency log + failed-queue only on terminal failure, so its loss window is narrower).
- **Fix:** Drain N per tick in a loop (bounded), or move to a BullMQ/Inngest-backed queue (already the platform pattern for webhooks). For durability, re-`lpush` immediately with a `visibleAt` timestamp rather than holding the retry in a process-local `setTimeout`.

---

### F6 — Abandoned-cart processing lock TTL (60s) can be shorter than a worst-case run

- **Severity:** Low
- **Verdict:** PLAUSIBLE
- **Location:** `apps/api/src/services/abandoned-cart.service.ts:26` (`LOCK_TTL_SECONDS = 60`), `:104` (15-min interval), `:process()` acquires `redis.acquireLock(LOCK_KEY, 60)`.
- **Evidence:** `process()` runs detection + WBS-bridge HTTP calls + multi-step reminder sends under a 60s Redis lock, on a 15-min interval. For a large store (many abandoned carts, each with a WBS HTTP round-trip) a run can exceed 60s; the lock then expires while the run is still in flight.
- **Failure scenario:** With ≥2 replicas, if run A exceeds 60s the lock expires; the next tick (or a second replica whose tick aligns) can acquire the lock and start a concurrent `process()`, double-sending reminder steps. The 15-min tick spacing makes exact overlap unlikely (mitigating to Low), and step sentinels in Redis dedupe most reminders — but detection/notify is not fully idempotent under overlap.
- **Fix:** Set the lock TTL to comfortably exceed the worst-case run (e.g. derive from the interval like the shipping cron does: `Math.ceil(intervalMs/1000)`), and/or renew the lock (heartbeat) for long runs. Ensure each reminder send is idempotent per (cartId, step).

---

## Verified-FIXED (confirmed present, not counted)

These are prior known reliability risks that the code already handles correctly — verified this pass:

1. **Cart serializable→P2034 storm** — `cart.service.ts` now runs `ReadCommitted` with `retryOnWriteConflict` + `extraRetryCodes: ['P2002']` (`:189`, `:308`, `:198`, `:317`). Matches `feedback-serializable-tx-needs-retry-p2034` / `feedback-checkout-concurrency-scaling`.
2. **Order inventory decrement** — atomic conditional `UPDATE ... WHERE inventory >= qty` via `inventory-decrement` helpers (`order.service.ts:404-406`), no `SELECT FOR UPDATE` early-lock, no oversell.
3. **Coupon global usage limit** — atomic reservation `updateMany({ where: { usageCount: { lt: usageLimit } } })` with `count===0` rollback (`order.service.ts:466-473`); refund path guards `usageCount > 0` before decrement (`:1168`).
4. **Loyalty point redemption** — race-safe atomic `loyaltyPoints.updateMany({ where: { points: { gte } }, data: { decrement } })` inside the order tx (`loyalty.service.ts:674-693`), no read-then-write.
5. **Socket.io replica-safety** — Redis pub/sub adapter attached (`socket.service.ts:83-97`, `@socket.io/redis-adapter`), graceful in-process fallback only when Redis absent.
6. **Profit-anomaly detector** — direction-aware severity (`classifySeverity(delta, direction)`, `profit-anomaly.service.ts:78`) + absolute floors (`COST_SPIKE_MIN_UNITS=50` `:180`, `REFUND_SPIKE_MIN_COUNT=3` `:188`). Matches `feedback-anomaly-detector-direction-and-floor` (v3).
7. **Cron leader-election + DB-pool starvation** — crons use `withLeaderLock` (leader-election.ts, loyalty/FBT) or `redis.acquireLock` (abandoned-cart, shipping) so only one replica runs per tick; payment webhook offloaded to Inngest (`payment-webhook-process`) and `DB_CONNECTION_LIMIT` raised to 25 per `feedback-db-pool-starvation`. Order numbers use crypto-random suffix (`utils/order-number.ts`), no sequential-counter race. Note: dedicated auth pool (defense-in-depth #3) remains open — informational.

---

## Ranked findings table

| #   | Severity | Verdict   | Finding                                                                                                      | Location                                                               |
| --- | -------- | --------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| F1  | High     | CONFIRMED | Coupon `usageLimitPerUser` (per-customer limit) never enforced — silent no-op                                | `order.service.ts:460-473`; `coupon.service.ts:80-107`                 |
| F2  | Medium   | CONFIRMED | Cart P2002-recovery `findFirst` missing `orderBy` → stale-cart / spurious EMPTY_CART on the create-race path | `cart.service.ts:54-60`                                                |
| F3  | Medium   | CONFIRMED | Module-level `setInterval` not cleared/unref'd → vitest worker-hang + delayed shutdown                       | `middleware/security.ts:25`; `services/view-ingest.service.ts:54`      |
| F4  | Medium   | PLAUSIBLE | FBT daily cron seeded with empty store list, can't re-seed → scheduled recompute never runs                  | `index.ts:73`; `recommendation.service.ts:465-490`                     |
| F5  | Low      | CONFIRMED | Email/SMS queue: 1 item/tick throughput ceiling + non-durable `setTimeout` retry (lost on restart)           | `email-queue.service.ts:61-105,134`; `sms-queue.service.ts:77-121,192` |
| F6  | Low      | PLAUSIBLE | Abandoned-cart lock TTL (60s) < worst-case run → concurrent double-run under ≥2 replicas                     | `abandoned-cart.service.ts:26,104`                                     |
