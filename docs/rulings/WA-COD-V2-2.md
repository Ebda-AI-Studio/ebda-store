# WA-COD-V2-2 - guest-safe order-status link (supersedes the sign-in link of WA-COD-V2-1)

Ruling WA-COD-V2-2 - the COD message's "order details" button opens `https://<store>/o/<token>`, a view-only summary a guest can read without an account.

- Token: `<storeId>.<orderId>.<exp>.<HMAC-SHA256>`, 14 days, constant-time verify, two UUIDs and an expiry (no PII), signed with the DEDICATED secret `ORDER_STATUS_LINK_SECRET` (>= 32 chars; boot fails loud once the WhatsApp queue is bound; listed in `api-required-secrets.json`). Not derived from another key, not the guest view token. The guest view token (SEC-15) still never appears in a URL.
- API `GET /public/order-status/:token`: bad, tampered, expired, another store's token (the request's store must equal the token's) and a vanished order are the same plain 404. Answer: order number, status, items, total, delivery AREA only. Never phone, email, street or notes. Headers: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`. Rate limit 30/min per IP.
- Storefront route `/o/[token]` renders it (noindex). A signed-in owner still has the full page at `/account/orders/<id>`, linked from the summary.
- Evidence: `tests/unit/order-status-link.test.ts`.

Cost if wrong: anyone holding the message within 14 days sees that order's items, total and area (not who or where exactly); rotating the secret kills links already sent.
