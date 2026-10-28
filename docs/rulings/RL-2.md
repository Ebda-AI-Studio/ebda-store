# RL-2

> Section: 2026-09-25

**Ruling RL-2 — the payment-provider webhook routes (`/api/v1/webhooks/
payment/:provider`, `/api/v1/webhooks/payment`) are NOT exempted from the
global limiter.** Read `webhook.routes.ts`: `verifyWebhookSignature` only
checks that a signature HEADER is non-empty — any string satisfies it. The
real HMAC check (`PaymentService.handleWebhook` → `p.verifyWebhook`,
`payment.factory.ts:964-1005`) runs only AFTER `enqueueOrProcessWebhook` has
already durably persisted the raw payload to the `webhook_events` inbox and
called `inngest.send()` — on the common path (Inngest reachable) that HMAC
check happens later still, asynchronously, inside the Inngest consumer, well
after this route already answered 200. So the route "acts" (a DB write +
queue send, both attacker-reachable resource costs) before verifying
anything — it does not satisfy "verifies before acting", the bar the
Inngest exemption above clears. These routes keep riding the global 200/
15min bucket as their only bound today. The shipping-carrier routes under
the same mount (`/shipping/icarry`, `/shipping/aramex`) DO verify
(`verifyCarrierWebhookSecret`, timing-safe, fail-closed) synchronously
BEFORE calling `shippingCarrierService.processWebhook` — but they are out of
this PR's scope (the reported incident and the task were payment webhooks +
Inngest) and are left untouched. Cost if wrong: unauthenticated garbage POSTs
to the payment webhook routes still cost a `webhook_events` row + an Inngest
enqueue before being rejected, and remain capped only by the shared 200/
15min-per-IP bucket alongside every other mutation from that IP — a
follow-up that reorders verification before persistence (or adds a
dedicated, still-bounded bucket per the pattern used for `/auth/refresh`)
is the natural next step if this is ever measured as a real flood vector.
