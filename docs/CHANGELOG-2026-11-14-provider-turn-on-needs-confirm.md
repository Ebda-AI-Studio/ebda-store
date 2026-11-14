# Providers can only be turned on through the confirm flow (2026-11-14)

Breaking change for API callers, Ruling PROVIDER-API-1.

- `POST /api/v1/payment-settings/store/:storeId/:provider/toggle` with `enabled: true`, the payment PUT that flips `isEnabled` from false to true, and the carrier PUT (`/api/v1/stores/:storeId/shipping-carriers/configs/:carrier`) with `enabled: true` now answer **409 `CONFIRMATION_REQUIRED`** for every caller except a `super_admin`, when the provider is a payment gateway or shipping carrier (COD and InstaPay are unaffected). Turning a provider **off** is unchanged.
- The only way for a merchant to turn one on is `POST /api/v1/provider-activation/store/:storeId/:provider/activate/preview` (the server runs Test connection) followed by `.../activate/confirm` with the returned `confirmToken` and an `Idempotency-Key` header.
- **API-key callers** (scripts, integrations, the merchant MCP) can therefore no longer turn a payment or shipping provider on until a versioned token path for keys exists. They can still connect, test and turn providers off. Turn a provider on from the dashboard in the meantime.
- A `super_admin` keeps the old routes as an override. Every such enable now leaves an append-only activation ledger row (`activation.activated_admin`), the same as a self-activation, and lifts a "blocked by admin" flag.
- Switching the active mode of a carrier or gateway (`activate` / `mode`) never turns a provider on; it can only keep or clear the enabled flag.
