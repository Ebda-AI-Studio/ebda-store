# FWB Side — WBS Bridge Plan (2026-05-19)

Fires WhatsApp order-lifecycle notifications through the merchant's WBS client
when an order event fires. Per-store opt-in. Calls WBS's new external endpoint.

## Scope

Three events in v1: paid (`order/created` fires), shipped, delivered.
Cancelled is out of scope.

## Files — ordered by dependency

### 1. `packages/database/prisma/schema.prisma`

- Add to `Store` model (after `blogEnabled`):
  ```prisma
  wbsEnabled   Boolean @default(false) @map("wbs_enabled")
  wbsClientId  String? @map("wbs_client_id")
  wbsApiKey    String? @map("wbs_api_key")    // AES-GCM via encryption.service.ts
  wbsTemplates Json?   @map("wbs_templates")  // { orderPaid, orderShipped, orderDelivered }
  ```
- `wbsTemplates` shape: `{ orderPaid?: { name, languageCode }, orderShipped?: {...}, orderDelivered?: {...} }`

### 2. `packages/database/prisma/migrations/<ts>_add_wbs_bridge/migration.sql` (hand-written)

```sql
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS wbs_enabled   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wbs_client_id TEXT,
  ADD COLUMN IF NOT EXISTS wbs_api_key   TEXT,
  ADD COLUMN IF NOT EXISTS wbs_templates JSONB;
```

### 3. `apps/api/src/utils/phone-e164.ts`

- Port `validateAndFormatPhone` from WBS: checks `+[1-9]\d{6,14}`, returns cleaned E.164 or null
- Used by the Inngest fn to skip send when phone is missing/invalid (INFO log, not error)

### 4. `apps/api/src/services/wbs-bridge.service.ts`

- `sendOrderNotification(params)`:
  - Reads `store.wbsEnabled, wbsClientId, wbsApiKey, wbsTemplates`
  - Decrypts `wbsApiKey` via `encryption.decrypt()`
  - Validates E.164 phone
  - Calls WBS `POST /api/v1/external/send-template` with `x-wbs-api-key` header
  - Returns `{ messageId }` or throws typed errors
  - Typed errors: `WbsUnauthorizedError` (401), `WbsTemplateMissingError` (422), `WbsServerError` (5xx)

### 5. `apps/api/src/lib/inngest/client.ts`

- Add event types:
  ```ts
  type OrderShippedEvent = { name: 'order/shipped'; data: { orderId: string; storeId: string } };
  ```
  (order/delivered already exists; order/created already fires for paid)
- Add `OrderShippedEvent` to `AppEvent` union

### 6. `apps/api/src/services/order.service.ts`

- In `updateStatus()`, after `status === 'shipped'` block, add `inngest.send` for `order/shipped`
  (currently only `order/delivered` fires an Inngest event; `shipped` only uses notificationDispatcher)

### 7. `apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts`

- New Inngest function `order-whatsapp-notify`
- Listens to: `order/created`, `order/shipped`, `order/delivered`
- `retries: 2` (per memory rule: transient-retry)
- Per-trigger, maps to template key: `orderPaid / orderShipped / orderDelivered`
- Load order + customer phone (from `order.customer.phone` or `shippingAddress.phone`)
- Validate E.164 — skip with INFO log if invalid/missing
- Read `store.wbsEnabled` + config — skip with INFO log if not enabled
- Call `wbsBridgeService.sendOrderNotification()`
- `WbsUnauthorizedError` → log error + Sentry (no retry, disable store after 3 in a row)
- `WbsTemplateMissingError` → log error + Sentry (no retry)
- `WbsServerError` → rethrow (Inngest retries)
- Variables passed: `{ customerName, orderNumber, orderTotal, currency, storeName, trackingNumber? }`

### 8. `apps/api/src/lib/inngest/functions/index.ts`

- Import + add `orderWhatsAppNotify` to the `inngestFunctions` array

### 9. `apps/api/src/routes/store.routes.ts`

- Add `wbs` integration sub-routes (get + put):
  `GET /stores/:id/integrations/wbs` — returns masked key (`****1234`) + enabled flag + templates + clientId
  `PUT /stores/:id/integrations/wbs` — validates + encrypts key + saves

### 10. `apps/admin/src/app/stores/[id]/integrations/wbs/page.tsx`

- New admin page (dedicated page per rule 4 in CLAUDE.md — ThemeTab ceiling)
- Form: toggle `wbsEnabled`, `wbsClientId` text field, `wbsApiKey` password field
- Per-event section: template name + language code for paid/shipped/delivered
- Save button calls `apiPut(/api/v1/stores/:id/integrations/wbs)`
- Shows masked API key; re-enter to change (standard pattern matching payment-settings)

### 11. FWB admin sidebar

- Add "WhatsApp Notifications" link in the store settings sidebar
  (under `notifications` group or new `integrations` group — check layout.tsx)

### 12. `tests/unit/order-whatsapp-notify.test.ts`

- Vitest unit test
- Mock `prisma.store.findUnique`, `prisma.order.findUnique`, `wbsBridgeService.sendOrderNotification`
- Tests: disabled store skips, missing phone skips, happy path paid/shipped/delivered,
  401 error disables store after 3 attempts, 422 does not retry, 5xx retries

## Security checklist

- `wbsApiKey` encrypted at rest, never returned unmasked in API response
- Never log the raw API key — log `wbsClientId` only
- Rate limit: inherits Inngest's rate limiting, not a direct HTTP path

## Environment variables

- No new env vars needed — uses existing `ENCRYPTION_KEY` and `WBS_BASE_URL`
  (`WBS_BASE_URL` defaults to `https://backend.forcemediakw.com` if not set)
