# Payment webhook → Inngest offload (pool-starvation structural fix)

**Branch:** `fix/payment-webhook-inngest-offload`
**Date:** 2026-06-23
**Status:** implemented, NOT merged — awaiting Ahmad review (live payments path)

## Problem

`apps/api/src/routes/webhook.routes.ts` runs the heavy payment-processing work
(`PaymentService.handleWebhook`: payment.update + recordPaymentEvent +
OrderService.applyRefundEffects + order.update, inside `runInTenantContext` → a
Prisma interactive `$transaction`, timeout 30s) **inline in the webhook
request**, on the SAME shared `basePrisma` pool that serves auth/login. A burst
of provider webhooks (MyFatoorah/Tap/Hesabe/UPayments) can hold every connection
in the pool (`DB_CONNECTION_LIMIT`, prod 25) → login can't get a connection →
P2024 → "auth broken for all users". Failed webhooks 5xx → provider retries →
death spiral.

See feedback-db-pool-starvation-webhook-storm-starves-auth.md (FWB sibling of
the WBS fix shipped 2026-06-23).

## Goal

Webhook route becomes thin: verify signature presence → parse → derive
idempotency key → check idempotency → **persist the raw event durably** →
`inngest.send()` → **return 200 immediately**. A new Inngest function consumes
the event and runs the existing `handleWebhook` mutation logic in
`runInTenantContext`, on Inngest's own execution path (its request to the
`/api/v1/inngest` serve endpoint — NOT the provider request), then
`markWebhookProcessed`. The long interactive transaction moves off the
provider-request path / shared API pool.

## Architecture — transactional inbox (`WebhookEvent`)

New durable record of every accepted payment webhook, decoupled from payment
resolution (existing `PaymentEvent` requires a `paymentId` FK, so it can't store
a webhook before the Payment is resolved — it's an audit log, not an inbox).

Columns: id, provider, idempotencyKey (UNIQUE), storeId? (resolved upfront,
nullable for platform path), payload (Json, parsed), rawBody (String, exact
bytes for HMAC re-verification), signature (String), status
(received|processing|processed|failed), attempts (Int), lastError?,
resultOrderId?, resultStatus?, timestamps.

**RLS:** NOT tenant-scoped. Written/read cross-tenant (route resolves storeId by
querying; consumer reads it before entering tenant context). Written via
`withRlsBypass`. No RLS policy — mirrors how `checkIdempotency` /
`resolveStoreIdFromWebhookPayload` already run in `withRlsBypass` today.

## Flow (BOTH `/payment/:provider` AND auto-detect `/payment`)

1. verifyWebhookSignature middleware (presence only) — unchanged, in route (needs raw body).
2. Parse raw body, validate provider, derive idempotencyKey (null → 400) — unchanged.
3. checkIdempotency(idempotencyKey) — existing Order.webhookProcessedAt guard. Already processed → 200 (unchanged).
4. resolveStoreIdFromWebhookPayload → storeId? (was already called).
5. NEW recordInboundWebhook — upsert WebhookEvent (unique idempotencyKey) status `received`. Duplicate that races past step 3 upserts onto the SAME row.
6. NEW inngest.send('payment/webhook.received', {webhookEventId, provider, idempotencyKey, storeId}).
   - send ok → 200 immediately. Mutation has NOT run — runs in consumer.
   - send fails → INLINE fallback (current code path) so the webhook is never lost, then 200.
7. NEW Inngest fn `paymentWebhookProcess` (`payment/webhook.received`):
   - load-inbox (withRlsBypass): if status `processed` → no-op return; else mark `processing`.
   - process: re-check Order.webhookProcessedAt; if unprocessed run handleWebhook in runInTenantContext(storeId) (or withRlsBypass platform path) — SAME branching the route used — then markWebhookProcessed. handleWebhook re-verifies HMAC itself (always did) against the stored rawBody.
   - finalize: mark WebhookEvent `processed` + result.
   - throw → Inngest retries (3); row left processing/failed with lastError. Idempotency guards make retries safe.

## HARD REQUIREMENTS — coverage

1. Idempotency end-to-end — 3 layers retained: (a) route checkIdempotency
   (Order.webhookProcessedAt); (b) WebhookEvent.idempotencyKey UNIQUE + status
   guard; (c) handleWebhook internal status-equality no-ops + markWebhookProcessed.
   Inngest retry re-enters `process` but webhookProcessedAt is set → no double-apply.
2. Tenant context + RLS — consumer runs handleWebhook + markWebhookProcessed in
   runInTenantContext(storeId), platform path withRlsBypass, exactly as route did.
3. No lost webhooks — send failure → inline fallback then 200. Consumer failure →
   Inngest retries 3×; else row stays `failed` (durable, replayable). We ACK 200
   only after the event is durably persisted + enqueued.
   TRADEOFF: ACK once persisted+enqueued. If Inngest drops an event outright
   (not transient), the WebhookEvent row is the durable backstop — a replay
   sweep can re-send stale received/processing rows. Replay sweep is a small
   FOLLOW-UP; the row is persisted now so nothing is lost.
4. Signature verification stays in route (presence; needs raw body); the HMAC
   check stays inside handleWebhook (runs in consumer) — rawBody + signature
   carried on WebhookEvent so the consumer verifies the exact bytes.
5. Both handlers share one enqueueOrProcessWebhook helper → identical behaviour.
6. Conventions: inngest client + domain/action.tense name, step.run isolation,
   runInTenantContext / withRlsBypass, hand-written timestamped migration SQL.

## Files

- packages/database/prisma/schema.prisma — WebhookEvent model + Store back-relation.
- packages/database/prisma/migrations/20260623120000_webhook_event_inbox/migration.sql — table + indexes (no RLS; cross-tenant).
- apps/api/src/lib/inngest/client.ts — PaymentWebhookReceivedEvent in AppEvent.
- apps/api/src/lib/inngest/functions/payment-webhook-process.ts — NEW consumer.
- apps/api/src/lib/inngest/functions/index.ts — register it.
- apps/api/src/routes/webhook.routes.ts — recordInboundWebhook + enqueueOrProcessWebhook; both handlers persist+enqueue+200 (inline fallback on send failure).

## Validation

- build @ebda/shared + @ebda/database (prisma generate) BEFORE typecheck.
- per-app tsc -p apps/api/tsconfig.json (NOT root tsc). lint changed files.
- Migration hand-written SQL, idempotent IF NOT EXISTS, applies on next API boot.

## Review fixes applied (pre-push AI review, 2026-06-23)

1. Failure-tail not silent: a payment-webhook-process run that exhausts its 3
   Inngest retries emits inngest/function.failed → the existing alertsFailureWatch
   catch-all now ESCALATES function_id='payment-webhook-process' to **P0** (was
   P1) so a stuck captured-payment pages immediately. The 'failed' WebhookEvent
   row is the durable replay record.
2. attempts counter now increments inside the `process` step (re-runs each
   retry), NOT the memoized mark-processing step — so it reflects real retries.
3. recordInboundWebhook comment corrected (status is preserved on conflict, not
   reset).

## Review fixes round 2 (pre-push AI review #2, 2026-06-23)

4. Undelivered-event gap CLOSED: new `payment-webhook-stuck-sweep` cron (every
   5 min) finds inbox rows stuck in received/processing past STUCK_WEBHOOK_MINUTES
   (default 10). Genuinely-undelivered rows (`received`, attempts=0 → consumer
   never ran, e.g. an inngest.send-ok-but-never-delivered drop) are RE-SENT to
   Inngest; wedged rows (consumer started but stuck) fire a P0 for manual replay.
   This covers the case the function.failed P0 can't (the consumer never ran).
5. Audit fidelity: recordInboundWebhook no longer refreshes
   rawBody/signature/payload on an already-`processed` row — a late re-delivery
   can't corrupt the stored record of what we actually acted on. Implemented as
   findUnique → create-or-(guarded)update instead of a blind upsert.

## NOT done / needs human review

- DB migration adjacent to a live payments path — Ahmad to review SQL.
- Basic replay/safety sweep IS built (payment-webhook-stuck-sweep): re-sends
  undelivered rows + P0-alerts wedged ones. A richer dead-letter UI (operator
  list of failed/wedged webhook_events with a manual replay button — "every data
  has a UI") is a follow-up; recommended before high-volume launch.
- No load test re-run (rule 14) — flagged pre-merge.
- Tap/MyFatoorah no longer self-heal a transient processing error via their own
  5xx-retry (we 200 before processing). The P0 alert + durable inbox replace
  that; confirm this tradeoff is acceptable vs. the pool-starvation risk it removes.
