# TAX-9

> Section: 2026-10-07 — Egypt VAT gate, phase 1 (branch `feat/vat-gate`; design `docs/plans/done/2026-10-07-egypt-vat-and-eta.md`)

Ruling TAX-9 — routes validate `@ebda/shared` schemas with `safeParse` (`apps/api/src/lib/parse-input.ts`), never `.parse()`. Measured under vitest: a ZodError thrown by a shared schema was NOT `instanceof` the `ZodError` the error handler imports (two module instances), so a bad body answered 500 instead of 400. The helper answers 400 `VALIDATION_ERROR` in the error handler's shape. Not swept repo-wide in this change (pre-existing `updatePlanSchema.parse` etc. in `admin.routes.ts`, owned by another work stream). Cost if wrong: none for the new routes; the existing call sites keep the risk until swept.
