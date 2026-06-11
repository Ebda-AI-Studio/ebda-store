# FWB Side — Connect-by-Key UX Plan (2026-05-19)

UX upgrade on top of the already-shipped bridge. Replaces free-text
client ID + template name fields with a guided two-step connect flow.

## What already exists (don't touch)

- `Store.wbsEnabled / wbsClientId / wbsApiKey / wbsTemplates` columns
- `wbs-bridge.service.ts` with `sendOrderNotification`
- Inngest function `order-whatsapp-notify.ts`
- `GET / PUT /stores/:id/integrations/wbs` routes
- Admin page at `apps/admin/src/app/stores/[id]/integrations/wbs/page.tsx`

## New artefacts

### 1. `fetchMetadata` in `wbs-bridge.service.ts`

New method (not a new file). Hits `GET /api/v1/external/metadata` with the
decrypted API key. Returns typed `MetadataResponse`. Same timeout + error
class pattern as `sendOrderNotification`.

### 2. Updated `GET /stores/:id/integrations/wbs`

If `wbsApiKey` is set, call `fetchMetadata` in parallel. On success include
`connectedTenant: { businessName, phoneNumber, availableTemplates }` in response.
Never block the GET if WBS is down — return `connectedTenant: null` with `error`.

### 3. Updated `PUT /stores/:id/integrations/wbs`

New smart logic:

- Sending `wbsApiKey` only → validate via `fetchMetadata`. 401 → 400 `invalid_api_key`.
  On success → save encrypted key + auto-populate `wbsClientId`.
- Sending `wbsTemplates` only → save directly, no metadata call.
- `wbsEnabled: true` + no key → 400 `must_connect_key_first`.
- `wbsEnabled: false` → save, no validation.

### 4. Updated admin page `wbs/page.tsx`

Two-step guided flow:

- Step 1 (no key): single "Force AI WhatsApp API Key" text field + "Connect" button.
- Step 2 (key set): read-only banner with businessName/phone + "Disconnect",
  4 dropdowns from `availableTemplates`, "Enable" toggle at bottom.

## Files to change

- `apps/api/src/services/wbs-bridge.service.ts` — add `fetchMetadata`
- `apps/api/src/routes/wbs-integration.routes.ts` — update GET + PUT logic
- `apps/admin/src/app/stores/[id]/integrations/wbs/page.tsx` — full rewrite
- `tests/unit/wbs-bridge.test.ts` — new test file

## No schema changes needed

All columns already exist from the prior shipment.
`wbsClientId` was previously entered manually; now auto-populated from metadata.

## Security

- Decrypted API key NEVER in any API response (same existing rule)
- `fetchMetadata` gets called with decrypted key but result is safe metadata
- GET response only includes `keySetAt` (timestamp), never key material
