# SEC-6 / SEC-14 / SEC-15: OG image SSRF, PII export permission, guest order view token

Audit 2026-10-26 (`M-130`, `M-136`, `M-137`).

## SEC-6: merchant-chosen image URLs stay on our media origin

- `isEbdaMediaUrl` (`@ebda/shared`): https only, no credentials, host is `*.r2.dev`, `media.ebda.app`
  or the deployment's own `STORAGE_PUBLIC_URL` host.
- The OG card route (`apps/web/src/app/og/route.tsx`, guard in `lib/og-asset-url.ts`) applied it to
  the SVG branch only; the raster branch is now guarded too. A foreign URL falls back to the name card.
  The web worker reads `NEXT_PUBLIC_MEDIA_ORIGIN` (or `STORAGE_PUBLIC_URL`) for a non-default media host.
- Write path: `StoreService.updateBranding` (`logo`, `logoAr`) and `updateSeo` (`ogImage`) refuse a
  NEW value outside the media origin with `400 MEDIA_URL_REQUIRED` (`lib/media-url-guard.ts`). A value
  equal to what is stored passes, so an existing external logo does not make later saves fail.
  Not changed: `favicon` (not fetched server-side).

Ruling SEC-6a - existing external logo/ogImage values are NOT migrated. They keep working on the
storefront and render a name card in OG images. Cost if wrong: a few stores lose their logo on social
cards until the merchant re-uploads; no data is touched.

## SEC-14: bulk PII exports are an owner action

New permission `customers:export` (`middleware/rbac.ts`): `store_admin` and `super_admin` only. Both
`GET /stores/:id/customers/export.xlsx` and `GET /stores/:id/orders/export.xlsx` require it (the orders
sheet carries every customer's name, phone and address) and write an audit row
(`customers.exported` / `orders.exported`: actor, role, row count, whether filtered). Staff keep the
on-screen lists. The admin Export buttons (customers and orders pages) are hidden from staff.

Ruling SEC-14a - staff lose the orders Excel export too. Evidence: the finding names both exports; the
orders sheet is the same PII. Cost if wrong: a staff member who reconciles from the Excel export asks
the owner for it.

## SEC-15: guest order page needs a signed view token for the address and phone

`POST /public/orders` returns `viewToken` for a guest order (`lib/order-view-token.ts`:
`<orderId>.<exp>.<HMAC>`, 30 days, bound to the order id, HKDF label `ebda:order-view-mac:v1`, or
`ORDER_VIEW_SECRET`). The storefront keeps it in the buyer's own `sessionStorage` (never in the URL)
and sends it as `X-Order-View-Token` on `GET /public/orders/:id`. Without a valid token a guest order
is still returned, but `maskGuestOrderView` builds it from an ALLOWLIST (id, orderNumber, status,
paymentStatus, currency, createdAt, money, items, payments as provider/method, and city/state/country);
notes, extra-amount note, InstaPay details, buyer contact and any future field are absent by default.

Ruling SEC-15a - a signed-in customer's own order and the checkout success page are unchanged; the
masked view is the safe default for a bare UUID. Residual: a buyer who reopens the order in another
browser (no sessionStorage) sees the masked address (the confirmation email has no order link today, so there is
nothing to carry the token; a link would have to sign one). Cost if wrong: a guest sees "J\*\*\*" instead of
their name on a revisit.

## Review follow-ups (Opus review of this branch)

- InstaPay: `GET /payments/instapay/:orderId` drops `proof.receiptId` and `GET .../receipt/:receiptId`
  nulls the payer name, InstaPay address, mobile and bank (`maskReceiptPayerPii`) unless the request
  carries the order's view token. The storefront `ApiClient` now attaches `X-Order-View-Token`
  automatically to `/public/orders/:id` and `/payments/instapay/:id/...` calls.
- `GET /public/orders/:id` never returns `checkoutIp`, the merchant's internal `notes` or the
  `idempotencyKey`, token or not; it sends `Cache-Control: private, no-store` and `Vary: X-Order-View-Token`;
  a missing signing key falls back to the masked view instead of a 500.
- Admin SEO page: the OG image is now uploaded through the media library (`ImageUpload`) instead of a
  free-text URL that the API would refuse with `MEDIA_URL_REQUIRED`.
- Bulk-export audit rows carry `impersonatedBy`, so a support impersonation is attributable.
- `isEbdaMediaUrl` also refuses a non-default port.

Ruling SEC-14b - staff keep `customers:read` / `orders:read` (the paged lists). Evidence: day-to-day
order handling needs them; SEC-14 targets the one-click bulk dump. Cost if wrong: a malicious staff
account can still page through the lists; the audit row and rate limits are the only brake.
