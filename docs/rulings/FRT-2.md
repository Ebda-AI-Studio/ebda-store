# FRT-2

> Section: 2026-10-01 — Finance Reports count store-local days (`fix/finance-reports-store-tz`)

**Ruling FRT-2 — a store with no usable time zone falls back to Asia/Egypt.** `stores.timezone` is
`NOT NULL DEFAULT 'Asia/Egypt'`, so "no setting" means an empty string or a name the runtime
cannot resolve (`resolveStoreTimeZone`, `DEFAULT_STORE_TIME_ZONE`). Asia/Egypt is the platform's
market and matches the invoice renderer's existing fallback (`invoice.service.ts`). The column is
now settable (issue 2411, 2412): `PUT /stores/:id` takes `timezone` (rejected unless
`isValidTimeZone`, so a typo is a 422, never a silent Egypt fallback), the Tax page has a time-zone
card that sends it, and `POST /admin/stores` writes `settings.timezone` to the COLUMN (validated, else
the column default). The old `settings.timezone` JSON key had zero readers and is no longer written
by provisioning or by `StoreService.create`; rows written before this change may still carry it, and
nothing reads it. Pinned by `tests/unit/provisioning-store-timezone.test.ts` and
`tests/unit/store-update-persists-every-accepted-field.test.ts`. Cost if wrong: a future non-Egypt
store whose owner never opens the Tax page still counts Egypt days; a time-zone change applies to
reports run afterwards, so a period already filed under the old zone does not re-run identically.
Amended 2026-10-03 (issues 2431, 2432; owner decision: the store time zone governs reports and tax
periods). `stores.timezone` is the store's ONE zone, not a report-only knob: the storefront also reads
it for checkout delivery-window cutoffs and for every date a customer sees on an order, invoice,
loyalty or wallet screen. The Tax-page card is therefore titled "Store time zone" and its copy (en +
ar) names all of that; no second column was added. Every change through `PUT /stores/:id` that alters
the zone writes a `STORE_TIMEZONE_CHANGED` audit row (`details: { from, to }`, actor, store), so a VAT
period that no longer reproduces can be explained: that row is the mitigation for the cost above.
Pinned by `tests/unit/store-timezone-change-audit.test.ts` and
`tests/unit/admin-store-timezone-setting.test.ts`.
