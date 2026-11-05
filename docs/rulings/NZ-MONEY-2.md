# NZ-MONEY-2

> Section: NEON-ZERO money path (2026-11-05)

**Ruling NZ-MONEY-2 - `StoreDO.moneyOp` writes the op's OWN entity-index rows to D1 before it answers and reads them back (`awaitEntityIndexed`, bounded to 3 s). An op that hands a reference out and whose retry replays the committed section (`paymentCreate`, `instapayInitiate`, a keyed `createOrder`) answers 503 `ENTITY_INDEX_UNAVAILABLE` when they did not land, so the reference is never handed out unroutable; any other op keeps its answer. Rows still queued arm a short alarm (`max(next attempt, now + 30 s)`, env `STORE_DO_INDEX_RETRY_MS`), and the alarm backs the store up only when the nightly backup is due (`_identity.backup_due_at`). Evidence: `drainEntityIndexOutbox` had no caller in the Worker, so D1 `entity_index` never learnt a DO store's new orders, payments or gateway references (`POST /payments/create` 404, webhooks 503-retried forever); review I-2 of PR 455 found the first fix answered success on a failed write with only the nightly alarm to retry. Tests: `money-path.test.ts` (D1 write refused once: 503, retry 200 with the same payment, the alarm writes the row), `workers-do/index-retry-alarm.test.ts`. Cost if wrong: during a D1 write outage checkout and payment creation answer 503 (retryable) instead of handing out references nobody can route.**

Source: `docs/cf/payments-on-do.md` "NEON-ZERO money path".
