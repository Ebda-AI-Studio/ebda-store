# FWB Async Orchestration Audit (Builder Reality Audit — Lens E)

**Date:** 2026-07-09
**Scope:** Read-only. Async/queue architecture — `apps/api` checkout path, payment-webhook path, Inngest functions (`apps/api/src/lib/inngest/functions/`), alerting (`alerts.service.ts`), stuck-job sweeps.
**Base:** `main` HEAD `9d67b97525887c8297afed48660b3c1ad404e6d1`.
**Method:** Read actual source (`order.service.ts`, `order.routes.ts`, `webhook.routes.ts`, `payment.factory.ts`, every Inngest function touching the order/payment lifecycle, `alerts-failure-watch.ts`, `queue-depth-watch.ts`, `payment-webhook-stuck-sweep.ts`). Cross-checked against `docs/audits/2026-07-02-reliability.md`, `2026-07-02-observability-dr-cicd.md`, `2026-07-09-builder-reality-audit.md`, and scoped memory (`feedback-inngest-mark-running-first.md`, `feedback-fwb-webhook-event-multiplexing.md`). This is a delta audit — it does not re-litigate F5 (email/SMS queue throughput) or L2 (no queue-depth alert on in-process queues) from `2026-07-02-reliability.md` except to sharpen them with new evidence.

> **Remediation status (2026-07-09):** the Critical + the contained Highs fixed on branch
> `fix/async-orchestration-lens-e`. **E2-1** (Critical): new `order-created-stuck-sweep` Inngest cron
> re-sends `order/created` for paid-but-unnotified orders (recovers email/push/WhatsApp/CAPI/journal)
>
> - P1-alerts if re-send isn't landing — also closes **E3-3**. **E3-2** (High): `order-created-fanout`
>   now re-throws on any `Promise.allSettled` rejection so the dead-letter P1/P0 fires. **E2-2** (High):
>   `applyRefundEffects` in the webhook processor no longer swallows failures (retries + dead-letters a
>   money-adjacent reversal). **E2-3** (Med): payment-failure push failure now surfaces a throttled
>   `info` alert instead of a silent log. Verify: 1134/1134 unit tests, new sweep unit test.
>   **Deferred as strategic follow-ups** (the audit's own "multi-day" bucket): **E2-4** (migrate
>   `updateStatus()`'s 13 fire-and-forget side-effects to an `order/status-changed` Inngest fanout),
>   **E2-5** (wire order-lifecycle email through the orphaned retry queue), **E3-4** (super-admin
>   WebhookEvent list + replay UI).

**Lens (from the source reel, 3 principles):**

- **E1** — fast response, work deferred (no synchronous chaining on the critical path).
- **E2** — reliable background work (real retriable Inngest steps, not silent fire-and-forget).
- **E3** — monitored queue (no silent terminal job failures).

---

## Headline

**FWB already follows E1 well and is not synchronously chained.** Both the order-create request and the payment-webhook request return fast: the order-create path does its DB transaction (inventory decrement, coupon reserve, loyalty redeem, cart clear) and returns immediately, with the `order/created` Inngest enqueue and socket emit both fire-and-forget after the transaction commits; the payment-webhook route persists to a durable inbox row, enqueues to Inngest, and ACKs 200 — the heavy `PaymentService.handleWebhook` mutation runs entirely off the request path in the `payment-webhook-process` Inngest function, exactly as documented in CLAUDE.md. Genuinely no 3rd-party HTTP call (email, WhatsApp, CAPI, OneSignal) is awaited inline before either response is sent.

**E2 and E3 are where the real gaps are, and they cluster into one structural pattern: the platform has TWO different reliability postures for the same class of event, and only one of them is battle-tested.** The payment-webhook path (`WebhookEvent` inbox + `payment-webhook-process` + `payment-webhook-stuck-sweep` + `alerts-failure-watch` P0 escalation) is a genuinely well-designed, three-layer defense against every failure mode: send-fails-inline-fallback, delivered-but-wedged sweep, and exhausted-retry dead-letter alert. The `order/created` fanout — which triggers FOUR downstream Inngest functions (customer/admin email + push, accounting journal, WhatsApp notify, CAPI conversion) — has **none of these three layers**: the enqueue call is bare fire-and-forget with no fallback, there is no stuck-order sweep, and the fanout function itself (`order-created-fanout`) swallows its own step failures via `Promise.allSettled` so it can never trigger the dead-letter alert even when every side effect exhausts its retries. On top of that, `PaymentService.handleWebhook` — which DOES run inside a retriable Inngest step — contains two internal `.catch(...)` swallows (out-of-band refund effects, payment-failure push) that quietly defeat Inngest's own retry/alert guarantee for those two sub-paths. The single sharpest fire-and-forget concentration in the codebase is `OrderService.updateStatus()` (13+ in-process fire-and-forget calls, `order.service.ts:962-1146`), which is architecturally consistent with the pre-Inngest-adoption era and was never migrated to the step-based pattern the `order-created-fanout` function models correctly for the create path.

---

## E1 — Fast response, work deferred

### E1-1. Order-create request path — PASS

**Verdict:** CONFIRMED
**Route:** `POST /stores/:storeId/orders` → `apps/api/src/routes/order.routes.ts:460-487` → `OrderService.create()` (`apps/api/src/services/order.service.ts:210-733`).

Synchronous critical path (all necessary, no 3rd-party calls):

1. `CartService.getOrCreate` — 1 DB read (`:218`)
2. Tax rate lookup — 1 DB read (`:227`)
3. `ShippingService.calculateShipping` — in-process calc, no external call (`:256`)
4. `CouponService.getByCode` — 1 DB read, only if coupon present (`:297`)
5. `LoyaltyService.getRedeemableContext` — 1 DB read, only if points requested (`:336`)
6. `featureService.isFeatureEnabled('inventory.backorder')` — cached feature-flag read, resolved **before** the transaction specifically to avoid an async call inside an interactive Prisma transaction (`:364`, with an explicit comment explaining why)
7. `withMoneyTx(...)` — one DB transaction: atomic conditional inventory decrement per line (`UPDATE … WHERE inventory >= qty`, no `SELECT FOR UPDATE`), order insert, backorder-line creation, atomic loyalty-point redemption, cart-item delete, abandoned-cart recovery check (`:378-686`)

After the transaction commits (`:688` onward), for COD orders only:

- `affiliateService.linkOrderToReferral(...).catch(...)` — fire-and-forget (`:690-693`)
- `inngest.send({ name: 'order/created', ... }).catch(...)` — **not awaited** (`:703-715`)
- `socketService.newOrderNotification(...)` — synchronous but wrapped in try/catch, never blocks (`:717-729`)

`return order;` at `:732` — response returns immediately after. **Zero email/WhatsApp/CAPI/push calls are awaited inline.** For online-payment orders, `data.paymentMethod !== 'cod'` skips the whole notification block (`:702`) by design — those fire later from the webhook, once payment is confirmed (documented at `:695-701`).

### E1-2. Payment-webhook request path — PASS

**Verdict:** CONFIRMED
**Route:** `POST /webhooks/payment/:provider` → `apps/api/src/routes/webhook.routes.ts:438-559` → `enqueueOrProcessWebhook()` (`:224-282`).

Synchronous critical path:

1. HMAC signature verify — in-process crypto (`verifyWebhookSignature` middleware, `:20-46`)
2. `generateIdempotencyKey` — pure function, no I/O (`:331-365`)
3. `checkIdempotency` — 1 DB read (`:484`)
4. `recordInboundWebhook` — 1 DB write, durably persists the raw payload to the `WebhookEvent` inbox **before** anything that can fail (`:238-245`)
5. `await inngest.send({ name: 'payment/webhook.received', ... })` — awaited, but this is a cheap enqueue call, not the mutation itself (`:249-252`)
6. On `inngest.send` failure only: `processWebhookInline()` runs `PaymentService.handleWebhook` synchronously as a fallback — the ONE path where webhook processing does run inline, and it's a deliberate last-resort so no webhook is ever silently dropped (`:254-281`)

Response is `res.json(...)` immediately after step 5/6 returns (`:559`). The heavy mutation — `payment.update`, `recordPaymentEvent`, `applyRefundEffects`, `order.update`, all inside a tenant-scoped interactive transaction — runs entirely inside the `payment-webhook-process` Inngest function, off the request/pool, exactly per the documented rationale (P2024 pool-starvation fix, `feedback-db-pool-starvation-webhook-storm-starves-auth.md`).

### E1-3. Verdict for this lens

**FWB checkout and payment-confirm paths are already async — not synchronously chained.** This principle of the reel is already followed correctly on both request paths audited. No change needed here.

---

## E2 — Reliable background work

### E2-1. `order/created` enqueue is bare fire-and-forget with NO fallback at all 4 call sites — Critical

**Status:** ❌ GAP · **Verdict:** CONFIRMED · **Severity: Critical** (money-books + customer/merchant-notification blast radius, zero detection)

**Evidence — 4 call sites, all identical shape, none awaited, none with a fallback:**

- `apps/api/src/services/order.service.ts:703-715` — COD order-create
- `apps/api/src/routes/order.routes.ts:699-711` — COD mark-paid (admin single order)
- `apps/api/src/routes/order.routes.ts:809-824` — COD mark-paid (admin bulk; wrapped in `Promise.allSettled` across orders, but each individual `.send()` is still `.catch(err => logger.error(...))` only)
- `apps/api/src/services/payment-providers/payment.factory.ts:1176-1192` — online-payment webhook, on `status === 'completed'`

**Gap:** `order/created` is consumed by **four separate Inngest functions**, all triggered off the same event (confirmed via `grep triggers:`):

- `order-created-fanout` (`order-created.ts:30`) — customer confirmation email, admin new-order email, SMS/push dispatcher, admin OneSignal push, Orders-PWA staff push
- `accounting-post-order-journal` (`accounting-post-order-journal.ts:35`) — posts the order's journal entry
- `order-capi-conversion` (`order-capi-conversion.ts:42`) — Meta/marketing conversion event
- `order-whatsapp-notify` (`order-whatsapp-notify.ts:387-389`) — WBS WhatsApp order-paid template

If `inngest.send()` itself fails to enqueue (Inngest outage, `INNGEST_EVENT_KEY` misconfig, network blip Railway↔Inngest — the exact class of incident CLAUDE.md already documents having happened once at the registration level: _"the force-api Inngest app was stuck registered on `https://localhost:4000`"_), **none of the four functions ever run for that order.** The customer gets no confirmation email, the merchant gets no new-order push, WhatsApp confirmation never sends, and — the sharpest consequence — **the order has no accounting journal entry**, silently breaking the books for a real, paid order with no error surfaced anywhere.

**Contrast with the payment-webhook path (E1-2):** that path deliberately `await`s the send and runs `processWebhookInline()` as a documented fallback specifically to prevent this exact failure mode (see the code comment at `webhook.routes.ts:214-222`: _"If inngest.send() throws (Inngest unreachable), DO NOT lose the webhook"_). The `order/created` enqueue has no equivalent — the asymmetry is the finding.

**No sweep exists for this gap.** Confirmed via `grep -rn "orderCreatedNotifiedAt"`: the field is written ONLY inside `order-created-fanout`'s own claim step (`order-created.ts:55-62`) and read nowhere else in the codebase. There is no analogue of `payment-webhook-stuck-sweep.ts`'s pattern (`status='received' AND attempts=0` → re-send) for orders whose `order/created` event never arrived. That sweep's own doc comment explicitly names this exact failure class — _"inngest.send() SUCCEEDS at the route but the event is never delivered … NO function.failed (the consumer never ran)"_ — and says it was fixed **for payment webhooks only**; the identical gap is open for `order/created`.

**Fix:** Either (a) `await` the send and add the same inline-fallback pattern used by `enqueueOrProcessWebhook`, reusing the fanout logic directly when Inngest is unreachable, or (b) add an `Order.orderCreatedNotifiedAt IS NULL AND createdAt < now() - N minutes AND status != 'cancelled'` sweep mirroring `payment-webhook-stuck-sweep.ts`, re-sending the event once per tick. (b) is cheaper and matches the platform's existing sweep idiom.

### E2-2. `applyRefundEffects` failure inside the Inngest-executed webhook processor is silently swallowed — High

**Status:** ❌ GAP · **Verdict:** CONFIRMED · **Severity: High** (money-adjacent: inventory/coupon/loyalty reversal can silently not happen on an out-of-band refund)

**Evidence:** `apps/api/src/services/payment-providers/payment.factory.ts:975-980`

```ts
await OrderService.applyRefundEffects(payment.order.storeId, payment.orderId).catch(err =>
  logger.error(
    { err, orderId: payment.orderId },
    '[PAYMENT WEBHOOK] applyRefundEffects failed for out-of-band refund'
  )
);
```

This call is inside `PaymentService.handleWebhook`, which is invoked from `step.run('process', ...)` in `apps/api/src/lib/inngest/functions/payment-webhook-process.ts:123-174`. The `.catch(...)` swallow means: if `applyRefundEffects` (inventory restore, coupon usage decrement, loyalty reversal, customer refund email) throws — a DB hiccup, a Prisma serialization conflict, anything — the error never propagates out of `step.run`. The step "succeeds," `handleWebhook` returns `{ success: true, ... }`, and `payment-webhook-process`'s `finalize` step marks the `WebhookEvent` row `status: 'processed'` (`payment-webhook-process.ts:228-241`). **Inngest's 3-retry mechanism (`retries: 3`, `:45`) and `alerts-failure-watch`'s P0 dead-letter escalation both never fire**, even though a money-adjacent reversal definitively failed. This is the out-of-band-refund path specifically (someone refunded directly in the MyFatoorah portal) — the merchant's own admin-button refund path (`payment.factory.ts:750-770`) has the same pattern but at least logs a more prominent "inventory/coupon/commission may be inconsistent" warning; neither alerts.

**Fix:** Let this throw propagate (remove the inline `.catch`, or re-throw after logging) so a genuine failure retries via Inngest and — if retries exhaust — escalates through the existing `alerts-failure-watch` → P0 pipeline (already money-path-escalated for `payment-webhook-process` specifically, per `alerts-failure-watch.ts:45`). The idempotency guards already in place (refund-status equality check, `payment.status` gates) make a retry safe.

### E2-3. Payment-failure admin push notification silently swallowed — Medium

**Status:** ❌ GAP · **Verdict:** CONFIRMED · **Severity: Medium** (pure notification, not money — but merchants can miss a failed-payment signal entirely)

**Evidence:** `apps/api/src/services/payment-providers/payment.factory.ts:1212-1227` — `OneSignalService.notifyAdminsOfPaymentFailure(...).catch(err => logger.error(...))`, same swallowed-inside-`step.run` pattern as E2-2, same function.

**Fix:** Same as E2-2 — let it propagate, or explicitly route through `sendAlert` (P2/info level) if a merchant-notification failure shouldn't retry-block the webhook's terminal state.

### E2-4. `OrderService.updateStatus()` — 13+ in-process fire-and-forget side effects, no retry, no alert, no persistence — High

**Status:** ❌ GAP · **Verdict:** CONFIRMED · **Severity: High** (largest single concentration of the anti-pattern in the codebase; covers shipped/confirmed/delivered/cancelled/refunded — every post-purchase merchant-driven status transition)

**Evidence:** all inside `OrderService.updateStatus`, called directly from `PUT /stores/:storeId/orders/:id/status` (`order.routes.ts:490-497`) — **none of these run inside an Inngest step; all run in the live API process**:

| Side effect                                                                                              | Location                     | Trigger status                             |
| -------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| `inngest.send({name:'order/delivered'})`                                                                 | `order.service.ts:960-964`   | delivered                                  |
| `affiliateService.processCommission`                                                                     | `order.service.ts:966-968`   | delivered                                  |
| `LoyaltyService.earnPointsFromPurchase`                                                                  | `order.service.ts:979-989`   | delivered                                  |
| `featureService.isFeatureEnabled('shipping_carriers')` → `shippingCarrierService.createShipmentForOrder` | `order.service.ts:995-1004`  | confirmed                                  |
| `EmailService.sendOrderShipped`                                                                          | `order.service.ts:1030-1039` | shipped                                    |
| `inngest.send({name:'order/shipped'})`                                                                   | `order.service.ts:1043-1047` | shipped                                    |
| `EmailService.sendPaymentSuccess`                                                                        | `order.service.ts:1050-1068` | confirmed                                  |
| `EmailService.sendAdminRefund`                                                                           | `order.service.ts:1073-1077` | refunded                                   |
| `notificationDispatcher.dispatch(...)` ×4                                                                | `order.service.ts:1088-1147` | shipped / delivered / cancelled / refunded |

Every one of these is wrapped only in `.catch(err => logger.error(...))` (or nested `.then()`/`.catch()` chains). The code's own comment at `:1007-1010` explicitly frames this as intentional — _"Status was committed — return to caller as fast as possible … so a slow / unreachable SMTP host or notification provider can't block the admin status-change response (mirrors the OrderService.create fix)"_ — which correctly achieves **E1** (fast admin response) but is the textbook **E2 anti-pattern**: none of these are real queued jobs. If the Resend API is down, if OneSignal 5xxs, if the process is mid-Railway-redeploy when one of these promises is in flight — the side effect is lost with only a Pino log line, no retry, no Telegram alert, no DB row marking it failed for replay.

**Contrast:** the `order/created` path's OWN downstream fanout (`order-created-fanout`, see E3-2) correctly wraps the equivalent create-time side effects (customer email, admin email, dispatcher, 2× OneSignal push) in individual `step.run(...)` calls specifically **because** of this exact class of problem — the function's own doc comment says so (`order-created.ts:14-18`: _"the inline version blocked the checkout response on three external HTTP calls … moving them onto Inngest cuts checkout p95 by ~600ms … and lets us retry on provider hiccups without losing notifications"_). `updateStatus()` was never migrated to the same pattern for post-purchase status transitions.

**Fix:** Extract these into an `order/status-changed` Inngest event + a `step.run`-per-side-effect consumer, mirroring `order-created-fanout`'s structure exactly. `updateStatus()` then only needs to update the DB row and enqueue one event — restoring the fast-response property (E1) while making each side effect a real retriable job (E2).

### E2-5. The durable retry email queue exists but is orphaned — no order-lifecycle email uses it — Medium

**Status:** ❌ GAP · **Verdict:** CONFIRMED (net-new — sharper than the existing 2026-07-02 F5 finding) · **Severity: Medium**

**Evidence:** `apps/api/src/services/email-queue.service.ts` implements a genuine Redis-backed retry queue (`MAX_ATTEMPTS=3`, `RETRY_DELAY_MS`, a `FAILED_KEY` dead list). Its only enqueue entry point is the module-private `queueEmail()` helper (`:231-233`), which calls `emailQueue.enqueue(null, options)`. **`grep -rn "queueEmail\b" apps/api/src` returns zero external callers** — the function is defined and never invoked. Every order-lifecycle transactional email in this audit's scope (`sendOrderShipped`, `sendPaymentSuccess`, `sendAdminRefund` in `updateStatus()`; `sendOrderConfirmation`, `sendAdminNewOrder` in `order-created-fanout`) goes through `EmailService.sendForStore()` → `ResendService.sendBrandedEmail()` (`resend.service.ts:272-307`), which calls the Resend SDK directly and throws on failure with **no retry at all** — not even the in-memory `setTimeout` retry the 2026-07-02 reliability audit's F5 finding examined (that finding's throughput/durability analysis is accurate for the queue's own mechanics but implicitly assumed order emails flow through it; they don't).

**Delta vs `2026-07-02-reliability.md` F5:** F5 flagged the queue's _own_ throughput ceiling (1 email/tick) and non-durable retry-in-`setTimeout`. This finding is a level below that — the queue is never reached by the order/payment lifecycle at all, so F5's mechanics are moot for the code paths this audit covers. The two findings compose: even if F5 were fixed, it wouldn't help until the order-lifecycle emails are wired to `queueEmail()`/`emailQueue.enqueue()` in the first place, or migrated onto Inngest steps per E2-4's fix.

**Fix:** Either wire `EmailService.sendForStore` to enqueue through `emailQueue` instead of calling Resend directly (simplest, reuses existing retry infra), or fold email sends into the `order/status-changed` Inngest step pattern from E2-4's fix (architecturally cleaner, matches `order-created-fanout`).

### E2-6. `order-capi-conversion` — intentional fail-open, not a hidden gap

**Status:** ✅ Documented tradeoff · **Verdict:** CONFIRMED · **Severity: Low (informational only)**

`apps/api/src/lib/inngest/functions/order-capi-conversion.ts:122-124` — the code's own comment states _"sendPurchaseConversion is fail-open internally — this step will not throw from a CAPI error."_ Marketing/analytics-only, no money or customer-trust impact. Noted for completeness, not counted as a defect.

---

## E3 — Monitored queue (no silent terminal job failures)

### E3-1. Global dead-letter alerting exists and is genuinely good — PASS

**Status:** ✅ PASS · **Verdict:** CONFIRMED

`apps/api/src/lib/inngest/functions/alerts-failure-watch.ts` listens on Inngest's own `inngest/function.failed` event — emitted automatically whenever ANY registered function exhausts its configured `retries` — and fires a P1 Telegram alert via `sendAlert`, escalated to **P0** specifically when `functionId === 'payment-webhook-process'` (`:45-53`). This gives platform-wide dead-letter coverage in principle, with money-path escalation already reasoned about. Confirmed no `onFailure` handlers exist anywhere (`grep -rn "onFailure" apps/api/src` → zero hits) — this single catch-all IS the mechanism, by design, not a gap.

### E3-2. `order-created-fanout` defeats E3-1's coverage for itself — High (net-new)

**Status:** ❌ GAP · **Verdict:** CONFIRMED · **Severity: High**

**Evidence:** `apps/api/src/lib/inngest/functions/order-created.ts:186-241` — the five post-checkout side effects (customer confirmation email, admin new-order email, dispatcher fan-out, admin OneSignal push, Orders-PWA push) are each individually wrapped in `step.run(...)` (correct — E2-compliant, each one is a real retriable Inngest step), but the whole set is run under:

```ts
await Promise.allSettled([...]).then(results => {
  results.forEach(r => {
    if (r.status === 'rejected') {
      logger.error({ err: r.reason }, 'order/created step failed');
    }
  });
});
```

`Promise.allSettled` captures every rejection — including a step that has already exhausted Inngest's own step-level retry attempts — and the `.then()` only logs. **The function body never re-throws**, so the function run always completes as "Completed" from Inngest's perspective, regardless of how many of its 5 steps ultimately failed. `inngest/function.failed` is therefore **never emitted for this function**, and `alerts-failure-watch` can never fire for it.

**Contrast within the SAME event's consumer set** (all four trigger off `order/created`):

- `order-whatsapp-notify.ts:340` — `throw err;` on a genuine WBS failure → correctly propagates → correctly escalates.
- `accounting-post-order-journal.ts:77` — `throw err;` → correctly propagates → correctly escalates.
- `order-created-fanout` (this finding) and `order-capi-conversion` (E2-6, by design) — do not.

So for the single most customer/merchant-visible fanout in the platform (the actual "you have a new order" notifications), a fully-exhausted OneSignal outage or Resend outage produces **zero alert, zero dashboard signal beyond a buried Pino log line** — while the WhatsApp and accounting siblings of the same event correctly page an operator.

**Fix:** After the `Promise.allSettled`, if any result is `'rejected'`, re-throw (e.g. `throw new AggregateError(rejected.map(r => r.reason))`) so the function genuinely fails and the existing `alerts-failure-watch` pipeline picks it up — no new alerting infrastructure needed, just don't swallow the aggregate failure.

### E3-3. `queue-depth-watch` only covers `BulkAiJob` — no depth/backlog watch for the order-lifecycle functions — Medium

**Status:** ⚠️ PARTIAL · **Verdict:** CONFIRMED · **Severity: Medium**

`apps/api/src/lib/inngest/functions/queue-depth-watch.ts` (every 15 min) exclusively queries `BulkAiJob` rows stuck in `queued`/`running` (`:44-71`) — it has no equivalent check for orders whose `order/created` fanout never completed, or whose accounting journal was never posted. Combined with E2-1 (no fallback on the enqueue) and E3-2 (the fanout can't self-report failure), an order can end up in a state where **none of the platform's three sweep/alert mechanisms** (`queue-depth-watch`, `payment-webhook-stuck-sweep`, `alerts-failure-watch`) would ever surface it. This is the composite risk the three E2/E3 findings above create together, not an independent bug — listed here because the audit's own framing (E3) asks specifically "what about the OTHER functions" beyond the payment-webhook sweep, and the answer is: nothing watches them for backlog.

**Fix:** the sweep proposed in E2-1's fix (an `Order.orderCreatedNotifiedAt`-staleness check) doubles as this lens's fix — one new Inngest cron closes both E2-1 and E3-3.

### E3-4. No admin UI to view or replay failed `WebhookEvent` rows — Medium

**Status:** ❌ GAP · **Verdict:** CONFIRMED · **Severity: Medium** (violates FWB's own "every data needs a UI" platform rule, on the money-critical payment path specifically)

**Evidence:** `grep -rn "webhookEvent" apps/admin/src` → zero hits. `grep -rn "replayWebhook\|webhook.*replay" apps/api/src/routes` → zero hits. The `WebhookEvent` table has real business meaning to a human operator — it's the durable inbox for every payment-provider webhook, and the code's OWN comments describe manual replay as the intended recovery mechanism: _"'failed' rows are handled by the P0 from alertsFailureWatch + (future) replay sweep, so they're excluded here"_ (`payment-webhook-stuck-sweep.ts:31-32`) and _"the durable row + lastError remain for audit"_ (`payment-webhook-process.ts:206-209`). Today, an operator who receives the P0 Telegram alert for a wedged/failed webhook has no way to inspect or replay it except direct Neon/Prisma-Studio access. `apps/admin/src/app/health` contains only a `route.ts` (a health-check API endpoint, not a dashboard page) — no page renders `WebhookEvent` rows anywhere.

**Fix:** a super-admin page (`/webhooks` or under an existing "System" admin section) listing `WebhookEvent` rows filterable by `status`, with a "Replay" action that re-fires `payment/webhook.received` for a `failed`/`rejected` row — reusing the exact idempotency guards `payment-webhook-process.ts` already has (safe to re-run by design, per its own doc comment).

### E3-5. `BulkAiJob` DOES have an admin UI — confirmed-good contrast

**Status:** ✅ PASS · **Verdict:** CONFIRMED

`apps/admin/src/app/stores/[id]/ai-tools/page.tsx` surfaces `BulkAiJob` status, including the auto-reaped-failure state `queue-depth-watch` writes (`status:'failed'`, `errorMessage` prefixed `auto-reaped by queue-depth-watch: ...`). This satisfies FWB's "every data needs a UI" rule for that table and is the pattern E3-4 should be brought up to.

---

## Tally

| Lens                              | Critical | High  | Medium | Low                 |
| --------------------------------- | -------- | ----- | ------ | ------------------- |
| E1 — Fast response, deferred work | 0        | 0     | 0      | 0                   |
| E2 — Reliable background work     | 1        | 2     | 2      | 0 (1 informational) |
| E3 — Monitored queue              | 0        | 1     | 2      | 0                   |
| **Total**                         | **1**    | **3** | **4**  | **0**               |

E1 has zero findings — both audited request paths are already correctly async. E2-6 (CAPI fail-open) is informational, not counted.

## Top 5 findings ranked by user-facing risk × business impact

1. **[Critical] E2-1 — `order/created` enqueue has zero fallback at all 4 call sites; failure silently drops customer email, admin push, WhatsApp notify, CAPI, AND the order's accounting journal entry, with no sweep detecting it.** `order.service.ts:703-715`, `order.routes.ts:699-711,809-824`, `payment.factory.ts:1176-1192`.
2. **[High] E3-2 — `order-created-fanout` swallows exhausted step failures via `Promise.allSettled`, so it can never trigger the platform's own dead-letter P1/P0 alert — unlike its sibling consumers of the same event.** `order-created.ts:186-241`.
3. **[High] E2-4 — `OrderService.updateStatus()` fires 13+ in-process fire-and-forget side effects (shipped/confirmed/delivered/cancelled/refunded emails, pushes, dispatcher, loyalty, affiliate) with no retry/alert/persistence — the largest concentration of the anti-pattern, never migrated to the Inngest-step pattern `order-created-fanout` models correctly.** `order.service.ts:960-1147`.
4. **[High] E2-2 — `applyRefundEffects` failure on an out-of-band refund is swallowed INSIDE a retriable Inngest step, defeating both the retry and the dead-letter alert for a money-adjacent reversal.** `payment.factory.ts:975-980`.
5. **[Medium] E2-5 / E3-4 — the durable email retry queue is orphaned (zero real callers) and there's no UI to replay a failed payment webhook.** `email-queue.service.ts:231-233`; `apps/admin/src` (absent).

## Quick wins (≤1 day) vs strategic (multi-day)

**Quick wins:**

- E3-2: re-throw on any `Promise.allSettled` rejection in `order-created-fanout` (one function, ~5 lines) — immediately restores dead-letter coverage for the platform's most customer-visible fanout.
- E2-2 / E2-3: remove the two swallowing `.catch(...)` calls inside `PaymentService.handleWebhook` (or re-throw after logging) so genuine failures retry + escalate through the already-built `payment-webhook-process` + `alerts-failure-watch` pipeline.
- E2-1: `await` the `order/created` send + add the same inline-fallback helper pattern already written for `enqueueOrProcessWebhook` (copy the shape, don't invent a new one).

**Strategic (multi-day):**

- E2-4: extract `OrderService.updateStatus()`'s 13+ fire-and-forget side effects into an `order/status-changed` Inngest event + a `step.run`-per-effect consumer, mirroring `order-created-fanout`'s already-correct structure.
- E2-5: wire `EmailService.sendForStore` (or the whole email path) through `emailQueue`/`queueEmail`, or fold it into the E2-4 Inngest migration so it inherits step-level retry for free.
- E3-3 + E2-1 combined fix: one new Inngest cron sweeping `Order.orderCreatedNotifiedAt IS NULL` past a staleness threshold, mirroring `payment-webhook-stuck-sweep.ts`'s exact pattern (re-send once, then P1-alert if still stuck).
- E3-4: a super-admin `WebhookEvent` list + replay page, reusing the idempotency-safe re-send `payment-webhook-process.ts` already documents as safe.

## Is FWB's checkout actually slow / synchronously chained, or already async?

**Already async.** Both audited request paths (order-create, payment-webhook) return fast with no 3rd-party call awaited inline — the E1 principle from the source reel is already implemented correctly and consistently. The gaps this audit found are entirely on the E2/E3 side: work IS deferred correctly, but a meaningful slice of that deferred work (the `order/created` enqueue itself, two swallowed paths inside the payment-webhook consumer, the whole `order-created-fanout` function's failure signal, and all of `updateStatus()`'s side effects) is not _reliably_ deferred or _monitorably_ deferred. The payment-webhook path proves the platform knows how to build this correctly (inbox + offload + stuck-sweep + dead-letter escalation, all four layers); the order-lifecycle paths simply haven't been brought up to that same standard yet.

## Delta vs the 2026-07-02 MASTER + 2026-07-09 Builder Reality audits

**Net-new, not previously logged:**

- E2-1 (order/created enqueue has no fallback/sweep) — not covered by any prior audit; `2026-07-02-reliability.md` and `2026-07-02-observability-dr-cicd.md` both examine the payment-webhook offload in depth but neither traces the order/created enqueue's own failure mode.
- E2-2 / E2-3 (swallowed effects inside the retriable payment-webhook step) — genuinely new; neither prior audit read `payment.factory.ts`'s internal `.catch` calls against the Inngest step boundary.
- E2-4 (`updateStatus()` fire-and-forget inventory) — net-new; `2026-07-02-reliability.md` audited `order.service.ts` for race conditions (F1/F2) but not for async-orchestration reliability of its notification side effects.
- E3-2 (`order-created-fanout`'s `Promise.allSettled` swallow) — net-new; this is the sharpest finding of the audit and wasn't examined by any prior lens.
- E3-4 (no `WebhookEvent` admin UI) — net-new application of FWB's own "every data needs a UI" rule to a table no prior audit checked for UI coverage.

**Sharpens an existing finding:**

- E2-5 (email queue orphaned) sharpens `2026-07-02-reliability.md` finding F5 — F5 correctly diagnosed the queue's own throughput/durability limits but implicitly assumed order-lifecycle emails flow through it; this audit confirms via `grep` that they never reach the queue at all, so F5's fix (drain-N-per-tick, durable retry) doesn't help until the callers are actually wired to `queueEmail()`.
- E3-1 (global dead-letter watch) confirms and extends `2026-07-02-observability-dr-cicd.md`'s "Alerting P0 coverage" confirmed-good note — that audit listed `Inngest failure→P1` as a working channel; this audit traces exactly which functions can and cannot reach that channel (E3-2's finding is the gap in what looked like blanket coverage).

**Not re-litigated (already covered, cited not re-derived):**

- `2026-07-02-reliability.md` F5 (email/SMS in-process queue throughput ceiling) and F6 (abandoned-cart lock TTL) — orthogonal to this lens's scope.
- `2026-07-02-observability-dr-cicd.md` L2 (no queue-depth alert on in-process email/SMS queues) — same root observation as E2-5/E3-3 from a different angle (alerting vs. usage); not re-derived, only cross-referenced.

---

_Audit-only. No source modified. Lens E — derived from a founder-education reel on async orchestration (fast response / deferred work / reliable queue / monitored failures)._
