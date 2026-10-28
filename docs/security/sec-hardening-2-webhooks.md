# SEC-5 / SEC-8: verify payment webhooks before persisting; redact secrets in paths

Audit 2026-10-26 (`M-129`, `M-132`).

## SEC-5: a forged delivery writes nothing

Before: `webhook.routes.ts` resolved the store from the unverified body and called
`enqueueOrProcessWebhook`, which recorded the raw body in the `WebhookEvent` inbox and emitted an
Inngest event BEFORE any HMAC check; the forged delivery was only marked `rejected` later in
`payment-webhook-process`. Anyone who knew a real payment reference could write rows and queue events
for that store.

Now both payment entry points (`/payment/:provider[/s/:storeId]` and the auto-detect `/payment`) call
`deliveryIsAuthentic` after the store is resolved and BEFORE `enqueueOrProcessWebhook`:

- `PaymentService.verifyWebhookDelivery` (extracted from `handleWebhook`, same code, same hmac-fail
  P0 counter) checks the signature over the raw body with the store's own secret.
- A terminal client error (missing/invalid signature, malformed body) is answered `401
INVALID_SIGNATURE` (not 200): a genuine delivery that fails (rotated secret, clock skew) must be
  RETRIED by the gateway, never accepted-and-dropped. Nothing is persisted, queued or audited. Failures
  are counted per store and source IP (20 per 5 minutes, then `429`, still a retry signal). After 3
  failures in 5 minutes for a provider and store a P0 alert fires: "Payment webhook signature failures
  for store <id>" (`PaymentService.verifyWebhookDelivery`). A forger just gets a 401.
- Anything else (database, network: 5xx) is rethrown, so the gateway retries.
- The `already processed` duplicate check now runs AFTER authentication, so a forged body learns
  nothing about which payments exist and writes no audit row.
- `handleWebhook` still verifies again over the stored raw body, so the async path and replays stay
  cryptographic. The body is capped at the `express.raw` default of 100 kB.

Ruling SEC-5b - this narrows RL-2a ("a webhook is SAVED first, replayable from /webhook-events"): a
delivery is saved only AFTER its signature verifies. Evidence: `ebda_webhook_inbox_record` upserts
on `idempotency_key` for every row not yet `processed`, so a forged delivery carrying a real payment
reference would OVERWRITE the raw body and signature of a genuine, still-queued event and make it fail
verification (a stronger attack than the pollution in the audit). RL-2a's real guarantee, never acting
before the signature verifies, is kept (`handleWebhook` re-verifies). Cost if wrong: a genuine
delivery that fails verification (wrong secret) is not stored for replay; because the answer is 401 the
gateway retries it, so it lands once the secret is fixed, and the P0 alert says which store.

Ruling SEC-5a (coordinator, 2026-10-27, replaces the earlier "200 ignored") - every delivery we will
not act on gets the IDENTICAL `401 INVALID_SIGNATURE` and body: a bad signature, a payment no store
owns, and a payment that belongs to another store than the URL names. Evidence: a 200 makes the
provider stop retrying, so a genuine delivery that failed on a secret rotation or clock skew would be
accepted and never recorded (money loss); and a different answer for "known" and "unknown" payment
references would be a payment-existence oracle. With no store to verify against, a fixed-cost dummy
HMAC and the same Redis counter write (on a dummy key) are burned, and EVERY refusal is padded to a
150 ms floor measured from the start of the request (`REJECT_FLOOR_MS`), so the fast no-store branch is
not distinguishable from the real check. A real check already slower than the floor is not padded, so
the floor removes the fast side only; it is a lower bound, not a perfect match. Failures share one per-source-IP bucket (20 per 5 minutes, then
429, still a retry signal). Consequence: a delivery for a payment that is not ours is retried by the
gateway a bounded number of times until it gives up. NOT verified: each gateway's actual retry
schedule on 401. Cost if wrong: extra retry traffic from a gateway that retries unknown references
for a long time; the per-source budget bounds our cost.

## SEC-8: the Bosta webhook token no longer reaches logs or Sentry

`/webhooks/shipping/bosta/:storeId/:token` carries the per-store secret in the path, and the request
logger, Workers Logs, Logpush (30 days) and Sentry kept it.

- `redactPathSecrets` (`@ebda/shared`, `sentry-url-scrub.ts`): the segment after
  `/shipping/bosta/<storeId>/` is masked everywhere (API logs, Sentry, PostHog). In API request logs any
  other path segment of 24+ token characters with at least one digit (not a UUID) is masked too; Sentry
  and PostHog keep readable long slugs. UUID ids stay readable.
- Applied by the API request logger (`request-logger.ts`) and, through `redactSensitiveQuery`, by every
  Sentry event/breadcrumb scrub and PostHog capture that already called it.
- Mitigation that stays: the service also requires a derived custom header, so the path token alone
  cannot forge a call.

Rotation (Ebda generates this secret, so it can be rotated): `scripts/rotate-bosta-webhook-secrets.ts`
rotates it for every store with Bosta. The default is a HARD rotation (the token counts as leaked, so the old one dies at once and in-flight shipments fall back to the poller); `--grace --reason "..."` keeps the old token for in-flight shipments (and lets it update only older, still-open shipments) but is refused when the reason describes a leak. Dry run by default, `--apply` to write. Run it once after this
ships; see `docs/runbooks/rotate-bosta-webhook-secrets.md`. Cloudflare's own invocation logs record the
request URL before our code runs, so tokens logged before the rotation stay in those logs but are dead.
A header-only secret (no token in the path) needs Bosta to support it.

## OPS-22 (Dependabot for npm): not enabled

Ruling OPS-22a (Ahmad's coordinator, 2026-10-27) - no Dependabot version updates for npm for now.
Evidence: CI capacity (every Dependabot PR runs the PR gates on the Umbra runner). The audit gate in
CI plus the weekly audit alert cover known-vulnerable dependencies; `.github/dependabot.yml` keeps only
the `github-actions` ecosystem. Cost if wrong: outdated-but-not-vulnerable dependencies pile up
until someone upgrades them by hand. Revisit when CI capacity allows.

## Ruling WEBHOOK-ORDER-1 (order of checks, supersedes the order described above)

Authenticate FIRST. Implemented by `gateDelivery` in `webhook.routes.ts` for both payment entry points:

1. Missing or bad signature: ONE constant `401 INVALID_SIGNATURE` body (same bytes), before ANY
   lookup, no audit row, padded to the timing floor.
2. Per-store URL (`/payment/:provider/s/:storeId`): the signature is verified with THAT store's
   secret before the payment is looked up. A valid signature for a payment no store can resolve yet
   is `503 + Retry-After: 60` (audit M-050: the Payment row can commit after a fast callback) plus an
   info alert; nothing is stored. A valid signature for a payment of ANOTHER store gets the identical 503 (indistinguishable from an unknown reference, so a caller with store A's secret cannot probe store B's references).
3. Generic URL (`/payment/:provider`, `/payment`): no store is named, so the payment reference must be
   resolved to find a secret. A reference that resolves to nothing cannot be verified and gets the
   same constant 401 (dummy HMAC and Redis write burned); the 503 is therefore only reachable on the
   per-store URL, which is the one the settings page gives merchants. Cost if wrong: a gateway
   configured with the generic URL whose callback beats the Payment row gets 401 and retries like any
   other refusal instead of the 503 hint.
4. Verified and resolved: duplicate check, then persist and enqueue as before.

Tests: `tests/unit/inbound-payment-webhook-routes.test.ts` (bad signature on known vs unknown payment
byte-identical; signature checked before the lookup; valid + unknown = 503 + Retry-After; valid +
known = 200).
