# 2026-11-12: a suspended store is read-only in the admin API (TEN-1, TEN-6)

Audit `2026-11-12-backfill-auth-security`. Standard: ebda-foundation PR #28 (live state beats token claims).

- **TEN-1.** `requireStoreAccess` (and `checkStoreAccess(..., { write: true })` for the mixed-audience upload and refund writes) now reads `stores.status` on every request, from the same Postgres or D1 gate row it already used. A `suspended` store refuses every non-GET/HEAD/OPTIONS request for store_admin and staff with **403 `STORE_SUSPENDED`**; `details.messageAr` / `messageEn` carry the copy. Super-admins are not bound. The same middleware owns staff, domains, merchant keys, MCP switch and every other `/stores/:id/...` admin family, so none can drift.
- **Billing reasons.** When `billing_suspended_reason` is set (`unpaid`), the `/stores/:id/billing` routes stay writable so the owner can pay. A platform suspension (reason null) opens nothing. `over_store_limit` keeps its own 402 upsell, decided first.
- **TEN-6.** The over-limit exemption was an unanchored `/billing(/|$)` and matched any segment (`/products/billing`). It is now `isStoreBillingRoute`, anchored at `/stores/:id/billing`, shared by both gates.
- **Admin web.** `BillingStatusBanner` shows a `suspended` alert (`billing.notice.suspendedTitle`, ar + en) for a platform-suspended store; the unpaid banner copy now says the store is read-only.
- **Unchanged.** Reads (including customer exports) stay open on a suspended store; storefront resolution for suspended stores is untouched (`cors-cache`, `store-directory`).
- Tests: `tests/unit/store-suspended-readonly.test.ts` (both gates), `BillingStatusBanner.test.tsx`.
