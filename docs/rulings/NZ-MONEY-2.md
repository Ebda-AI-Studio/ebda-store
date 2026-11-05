# NZ-MONEY-2

> Section: NEON-ZERO money path (2026-11-05)

**Ruling NZ-MONEY-2 - `StoreDO.moneyOp` drains the entity-index outbox before it answers (and the alarm retries); a drain failure never fails the money op. Evidence: `drainEntityIndexOutbox` had no caller in the Worker, so D1 `entity_index` never learnt a DO store's new orders, payments or gateway references (`POST /payments/create` 404, webhooks 503-retried forever). Cost if wrong: one extra local SELECT (and a D1 write per new entity) on each money op's latency; a D1 outage leaves a just-created order unresolvable until the next money op or the daily alarm (the gateway retries its 503).**

Source: `docs/cf/payments-on-do.md` "NEON-ZERO money path".
