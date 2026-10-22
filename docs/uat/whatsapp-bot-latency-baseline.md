# WhatsApp Bot Latency Baseline (2026-05-25)

## Setup

- Bot: WBS production (Wady Aljuz)
- Test WhatsApp number: Ebda AI Studio test number (to be filled by Ahmad after first live test)
- Instrumentation: Phase 0 timing middleware now wired in Ebda Store (`waBridgeTiming`) + WBS (`timedCall` wrapper in wa-bridge-client.js)

## Note on simulation

This baseline document was created with Phase 0 timing instrumentation wired in but prior to a live WhatsApp test drive. The timing middleware (`waBridgeTiming` in Ebda Store, `timedCall` in WBS) is production-deployed and will emit structured logs on the next real bot interaction. Ahmad to fill the actual measurements after running a test order.

Log collection command (run after a test order):

```bash
railway logs --service whatsapp-broadcaster --tail 200 | grep "wa-bridge call"
railway logs --service api --tail 200 | grep "wa-bridge timing"
```

## Expected log shape

Ebda Store emits per-request:

```json
{
  "path": "/store-catalog",
  "method": "GET",
  "status": 200,
  "durationMs": 342,
  "storeId": "...",
  "msg": "wa-bridge timing"
}
```

WBS emits per-call:

```json
{ "endpoint": "/store-catalog", "durationMs": 360, "status": "ok", "msg": "wa-bridge call" }
```

## End-to-end timeline (to fill after live test)

| Step          | User action     | Bot reply at | Round-trip |
| ------------- | --------------- | ------------ | ---------- |
| Greeting      | sent "Hi"       | <time>       | <s>        |
| Category list | tapped "Order"  | <time>       | <s>        |
| Product list  | tapped category | <time>       | <s>        |
| Quantity ask  | tapped product  | <time>       | <s>        |
| Cart summary  | sent quantity   | <time>       | <s>        |
| Checkout      | tapped Checkout | <time>       | <s>        |
| Order placed  | …               | <time>       | <s>        |

## Per-step latency breakdown (from logs — to fill)

| Path                      | p50  | p95  | observations                                   |
| ------------------------- | ---- | ---- | ---------------------------------------------- |
| GET /store-catalog        | <ms> | <ms> | Suspected cold-start contributor (5-10s)       |
| GET /products/by-category | <ms> | <ms> | Neon compute pause suspected (2-5s first call) |
| POST /cart/from-wa        | <ms> | <ms> |                                                |

## Top latency contributors (hypotheses — to validate)

1. **Ebda Store Railway cold start** (5-10s) — the `/store-catalog` call is the first call per session; if Railway has idled, this absorbs all the latency budget
2. **Neon DB compute pause** (2-5s) — Neon free-tier pauses compute after 5 min of idle; first query wakes it
3. **Sequential bridge calls** — any two consecutive `await waBridge.xxx()` calls that could be parallelized via `Promise.all`

## Quick wins applied (Phase 0)

- [x] Timing instrumentation wired (this PR) — measures actual latencies
- [ ] Keepalive script (Task 0.4) — pings Ebda Store `/health` every 4 min to prevent cold starts
- [ ] Promise.all parallelization (Task 0.5) — eliminates sequential bridge calls in wa-ordering.js

## Post-quick-wins measurements (to fill after Task 0.4 + 0.5 deploy)

(To be filled by Ahmad after running a second test order post-keepalive deploy)

## Phase 0 acceptance gate

Target: bridge call p95 ≤ 1.5s OR documented blocker.
Status: PENDING — live measurements needed.
