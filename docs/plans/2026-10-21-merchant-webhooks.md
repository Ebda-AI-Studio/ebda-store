# Merchant outgoing webhooks (2026-10-21)

Finish line: a Growth/Business merchant registers an HTTPS endpoint, picks events, receives signed JSON on order/product changes, sees a delivery log, can send a test and resend; an unhealthy endpoint disables itself and tells the merchant.

**Must NOT change:** existing Inngest consumers of order/product events (webhooks only add a listener), SSRF behaviour of `safeFetch` for other callers (only gets more blocks).

## Design
- Tables (`webhook_endpoints`, `webhook_deliveries`): `store_id`, strict RLS + FORCE, grants to `ebda_app`, FK CASCADE on store delete, tenant-guard snapshot regenerated. Migration `20261025000100_merchant_webhooks` (main newest 20261022*, open branches <= 20261024*).
- Sources (no producer edits except low stock): one Inngest fan-out function listens to `order/created` (also yields `order.paid` when payment is completed), `order/status-changed` (shipped/delivered/cancelled), `order/refunded`, `product.upserted` (create/update), `product.deleted`. `inventory.low` hooks the existing 6-hourly low-stock scan (per product, already deduped by its sentinel).
- Fan-out creates one `webhook_deliveries` row per subscribed active endpoint, UNIQUE (endpoint, dedupe key) = idempotent under Inngest replays, then sends `webhook/delivery.requested` through `sendEventAfterCommit` (deferAfterTenantCommit under the hood). Payload is built from the DB at fan-out, stored on the row (resend sends identical bytes, same event id).
- Delivery function: 6 attempts, delays 0 / 1m / 10m / 1h / 6h / 17h (about 24h), `step.sleep` between attempts. Each attempt re-validates the URL (DNS resolved NOW, https only, no private/loopback/link-local/metadata/CGNAT/doc/NAT64 ranges), 10 s timeout, redirects are never followed (3xx = failure), response body read up to 200 chars only.
- Signature: `X-Ebda-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<rawBody>")>`; receiver rejects when |now - t| > 5 min; `X-Ebda-Event-Id` is the idempotency key. Secret `whsec_...` shown once at create / rotate; stored encrypted (`encryption.encrypt`), rotation replaces immediately.
- Health: 10 consecutive failed deliveries (a delivery counts once, after its last attempt) auto-disables the endpoint, writes an in-app notification and emails the owner.
- Retention: last 50 deliveries per endpoint kept (pruned on insert) + daily purge of > 30 days. Payload PII: order id/number, totals, status, items (name, sku, qty, price); customer name/email/phone ONLY when the endpoint has `includeCustomer`.
- API: `/stores/:storeId/webhooks` (list/create/patch/delete/rotate/test/deliveries/resend). Auth chain: authenticate, authorize(store_admin, super_admin), requireStoreAccess (owner), plan gate. Staff (no `store:settings`) are refused.
- Admin: `/stores/[id]/webhooks` page ar/en. Docs: `docs/developers/webhooks.md`.

## Rulings
- WH-1 Plan gating Growth + Business (via `planIncludesWebhooks`). Cost if wrong: Basic merchants get a 402 they should not, or vice versa; one-constant change.
- WH-2 Redirects never followed. Cost if wrong: receivers that 301 http->https paths need to register the final URL.
- WH-3 Rotation is immediate (no dual-secret window). Cost if wrong: a receiver misses signatures until it deploys the new secret.
- WH-4 `order.paid` fires only when the order is paid at `order/created` time (online payments, wallet); COD paid-on-delivery is covered by `order.status_changed`. Cost if wrong: COD merchants expecting `order.paid` get nothing.
